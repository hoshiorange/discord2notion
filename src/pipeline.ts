/**
 * Phase 5 統合パイプライン: 文字起こし → 要約 → Drive アップロード → Notion ページ生成 を順次実行する。
 *
 * AIP-31:
 * - 各ステージの完了状態を `pipeline-state.json` に永続化
 * - 既存 state があれば失敗したステージから再開
 * - `/resume` コマンドから呼び出し可能
 *
 * MP3 生成はこの関数の前段で済んでいる前提（呼び出し側で `processSession` を実行）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join as joinPath, resolve as resolvePath } from 'node:path';

import type { CreateMeetingPageResult } from './notion.js';
import type { SummaryResult } from './summarize.js';
import type { TranscribeResult } from './transcribe.js';
import type { UploadResult } from './drive.js';
import { createMeetingPage } from './notion.js';
import { getLogger } from './logger.js';
import { loadGuildConfig } from './config.js';
import { summarizeAndSave } from './summarize.js';
import { transcribeAndSave, transcribeUsersAndSave } from './transcribe.js';
import { uploadSession } from './drive.js';

const log = getLogger('pipeline');

export type PipelineStage = 'transcribe' | 'summary' | 'drive' | 'notion';

export const PIPELINE_STAGES: PipelineStage[] = ['transcribe', 'summary', 'drive', 'notion'];

export const PIPELINE_STATE_FILENAME = 'pipeline-state.json';

export const RECORDINGS_BASE = resolvePath(process.cwd(), 'recordings');

export interface PipelineState {
  sessionId: string;
  sessionDir: string;
  startedAtIso: string;
  durationMs: number;
  channelName: string | null;
  textChannelId: string | null;
  /** AIP-38: Guild ID（マルチ Guild 対応）。null は未指定（DM や旧 state 互換）。 */
  guildId: string | null;
  files: { userId: string; filename: string }[];
  participants: string[];
  mixedMp3Path: string;
  /** AIP-37: ユーザー別 WAV（話者識別 transcribe 用）。無ければ mixed.mp3 でフォールバック。 */
  userWavs?: { userId: string; wavPath: string }[];
  /** AIP-37: userId → 表示名のマッピング。無ければ userId をそのまま speaker に使う。 */
  speakerNames?: Record<string, string>;

  /** 完了済みステージ（順番通り）。 */
  completedStages: PipelineStage[];

  // 各ステージの結果
  transcript?: {
    transcriptPath: string;
    segments: number;
    rtFactor: number;
    durationSec: number;
  };
  summary?: { summaryPath: string };
  drive?: UploadResult;
  notion?: CreateMeetingPageResult;

  // 失敗情報
  failedStage?: PipelineStage;
  failedError?: string;

  lastUpdated: string;
}

export interface PipelineInput {
  sessionDir: string;
  sessionId: string;
  startedAt: Date;
  durationMs: number;
  mixedMp3Path: string;
  channelName?: string | null;
  textChannelId?: string | null;
  /** AIP-38: Guild ID（マルチ Guild 対応）。null/未指定なら process.env を使う（後方互換）。 */
  guildId?: string | null;
  files?: { userId: string; filename: string }[];
  participants?: string[];
  /** AIP-37: ユーザー別 WAV。あれば話者識別 transcribe を使う。 */
  userWavs?: { userId: string; wavPath: string }[];
  /** AIP-37: userId → 表示名のマッピング。 */
  speakerNames?: Record<string, string>;
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function statePathFor(sessionDir: string): string {
  return joinPath(sessionDir, PIPELINE_STATE_FILENAME);
}

export async function loadPipelineState(sessionDir: string): Promise<PipelineState | null> {
  const path = statePathFor(sessionDir);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as PipelineState;
  } catch (err) {
    log.error({ err }, `failed to read state ${path}`);
    return null;
  }
}

export async function savePipelineState(state: PipelineState): Promise<void> {
  state.lastUpdated = new Date().toISOString();
  const path = statePathFor(state.sessionDir);
  try {
    await writeFile(path, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    log.error({ err }, `failed to write state ${path}`);
  }
}

function createInitialState(input: PipelineInput): PipelineState {
  return {
    sessionId: input.sessionId,
    sessionDir: input.sessionDir,
    startedAtIso: input.startedAt.toISOString(),
    durationMs: input.durationMs,
    channelName: input.channelName ?? null,
    textChannelId: input.textChannelId ?? null,
    guildId: input.guildId ?? null,
    files: input.files ?? [],
    participants: input.participants ?? [],
    mixedMp3Path: input.mixedMp3Path,
    userWavs: input.userWavs,
    speakerNames: input.speakerNames,
    completedStages: [],
    lastUpdated: new Date().toISOString(),
  };
}

/** 既存 state があれば失敗状態をクリアして引き継ぐ、無ければ初期化。 */
async function getOrInitState(input: PipelineInput): Promise<PipelineState> {
  const existing = await loadPipelineState(input.sessionDir);
  if (!existing) {
    const fresh = createInitialState(input);
    await savePipelineState(fresh);
    return fresh;
  }
  // resume: clear failure flags but preserve completed stages and results
  delete existing.failedStage;
  delete existing.failedError;
  // 入力で参加者が新たに与えられていれば更新
  if (input.participants && input.participants.length > 0) {
    existing.participants = input.participants;
  }
  if (input.textChannelId) existing.textChannelId = input.textChannelId;
  // AIP-37: userWavs / speakerNames は新規入力で更新（resume 時にディスク上の WAV が消えてる可能性を許容）
  if (input.userWavs) existing.userWavs = input.userWavs;
  if (input.speakerNames) existing.speakerNames = input.speakerNames;
  // AIP-38: guildId は新規入力で上書き（resume 時に呼び出し側の interaction.guildId を使う）
  if (input.guildId !== undefined) existing.guildId = input.guildId;
  await savePipelineState(existing);
  return existing;
}

function isCompleted(state: PipelineState, stage: PipelineStage): boolean {
  return state.completedStages.includes(stage);
}

function markCompleted(state: PipelineState, stage: PipelineStage): void {
  if (!state.completedStages.includes(stage)) {
    state.completedStages.push(stage);
  }
}

async function recordFailure(
  state: PipelineState,
  stage: PipelineStage,
  err: unknown,
): Promise<PipelineState> {
  const e = asError(err);
  log.error({ err: e }, `${stage} failed`);
  state.failedStage = stage;
  state.failedError = e.message;
  await savePipelineState(state);
  return state;
}

export type PipelineProgressCallback = (state: PipelineState) => Promise<void> | void;

export interface PipelineCallbacks {
  /** ステージ開始時に呼ばれる（既存完了済みのものは呼ばれない）。 */
  onStageStart?: (stage: PipelineStage, state: PipelineState) => Promise<void> | void;
  /** ステージ成功で state 更新後。 */
  onStageComplete?: (stage: PipelineStage, state: PipelineState) => Promise<void> | void;
  /** ステージ失敗時に呼ばれる。 */
  onStageFailed?: (stage: PipelineStage, error: Error, state: PipelineState) => Promise<void> | void;
}

async function runStage(
  stage: PipelineStage,
  state: PipelineState,
  callbacks: PipelineCallbacks | undefined,
  fn: () => Promise<void>,
): Promise<{ ok: true } | { ok: false }> {
  if (isCompleted(state, stage)) return { ok: true };
  await callbacks?.onStageStart?.(stage, state);
  try {
    await fn();
    markCompleted(state, stage);
    await savePipelineState(state);
    await callbacks?.onStageComplete?.(stage, state);
    return { ok: true };
  } catch (err) {
    const e = asError(err);
    await recordFailure(state, stage, e);
    await callbacks?.onStageFailed?.(stage, e, state);
    return { ok: false };
  }
}

/**
 * パイプライン実行（新規 or 再開）。失敗ステージを state に記録し、すべての成果を返す。
 * `callbacks` を渡すと各ステージの開始/完了/失敗時にフックできる（progressive UX 用）。
 */
export async function runPostMp3Pipeline(
  input: PipelineInput,
  callbacks?: PipelineCallbacks,
): Promise<PipelineState> {
  const state = await getOrInitState(input);

  // Step 1: transcribe
  // AIP-37: userWavs があり、ディスクに実在するものが1つ以上あればユーザー別 transcribe（話者識別）。
  // 無ければ従来通り mixed.mp3 を一括 transcribe（後方互換）。
  const r1 = await runStage('transcribe', state, callbacks, async () => {
    const usableUserWavs = (state.userWavs ?? []).filter((u) => existsSync(u.wavPath));
    if (usableUserWavs.length > 0) {
      log.info(
        `transcribe (multi-speaker): ${usableUserWavs.length} user WAV(s) → transcript.json`,
      );
      const r = await transcribeUsersAndSave(
        usableUserWavs,
        input.sessionDir,
        state.speakerNames ?? {},
      );
      state.transcript = {
        transcriptPath: r.transcriptPath,
        segments: r.result.segments.length,
        rtFactor: r.result.realtime_factor,
        durationSec: r.result.duration_sec,
      };
    } else {
      log.info('transcribe (single): mixed.mp3 一括（userWavs なし、後方互換フロー）');
      const r = await transcribeAndSave(input.mixedMp3Path);
      state.transcript = {
        transcriptPath: r.transcriptPath,
        segments: r.result.segments.length,
        rtFactor: r.result.realtime_factor,
        durationSec: r.result.duration_sec,
      };
    }
  });
  if (!r1.ok) return state;

  // Step 2: summarize
  const r2 = await runStage('summary', state, callbacks, async () => {
    if (!state.transcript) throw new Error('transcript stage missing');
    const r = await summarizeAndSave(state.transcript.transcriptPath);
    state.summary = { summaryPath: r.summaryPath };
  });
  if (!r2.ok) return state;

  // AIP-38: Guild 別 config を解決（state に保存されている guildId を信頼。resume でも一貫）
  const guildConfig = loadGuildConfig(state.guildId);

  // Step 3: drive upload
  const r3 = await runStage('drive', state, callbacks, async () => {
    if (!state.transcript || !state.summary) {
      throw new Error('prerequisite stage missing');
    }
    const r = await uploadSession(
      input.sessionDir,
      [
        basename(input.mixedMp3Path),
        basename(state.transcript.transcriptPath),
        basename(state.summary.summaryPath),
      ],
      { guildConfig },
    );
    state.drive = r;
  });
  if (!r3.ok) return state;

  // Step 4: notion page
  await runStage('notion', state, callbacks, async () => {
    if (!state.transcript || !state.summary || !state.drive) {
      throw new Error('prerequisite stage missing');
    }
    const summaryRaw = await readFile(state.summary.summaryPath, 'utf-8');
    const summary = JSON.parse(summaryRaw) as SummaryResult;
    // AIP-37: transcript.json から segments を読んで Notion 本文に話者付き発言を埋め込む
    const transcriptRaw = await readFile(state.transcript.transcriptPath, 'utf-8');
    const transcript = JSON.parse(transcriptRaw) as TranscribeResult;
    const mp3Url = state.drive.fileUrls[basename(input.mixedMp3Path)];
    const transcriptUrl = state.drive.fileUrls[basename(state.transcript.transcriptPath)];
    const r = await createMeetingPage({
      summary,
      sessionId: state.sessionId,
      startedAt: new Date(state.startedAtIso),
      durationMs: state.durationMs,
      mp3Url,
      transcriptUrl,
      participants: state.participants,
      transcriptSegments: transcript.segments,
      guildConfig,
    });
    state.notion = r;
  });

  return state;
}

/** 既存 state から PipelineInput を再構成（/resume 用）。 */
export function inputFromState(state: PipelineState): PipelineInput {
  return {
    sessionDir: state.sessionDir,
    sessionId: state.sessionId,
    startedAt: new Date(state.startedAtIso),
    durationMs: state.durationMs,
    mixedMp3Path: state.mixedMp3Path,
    channelName: state.channelName,
    textChannelId: state.textChannelId,
    guildId: state.guildId,
    files: state.files,
    participants: state.participants,
    userWavs: state.userWavs,
    speakerNames: state.speakerNames,
  };
}

/** すべてのステージが完了済みか。 */
export function isFullyComplete(state: PipelineState): boolean {
  return PIPELINE_STAGES.every((s) => state.completedStages.includes(s));
}

export interface IncompleteSession {
  sessionDir: string;
  state: PipelineState;
}

/**
 * recordings/ 配下を走査して未完セッション一覧を返す。
 * - failedStage がある
 * - または完全完了していない
 */
export async function findIncompleteSessions(
  recordingsBaseDir: string = RECORDINGS_BASE,
): Promise<IncompleteSession[]> {
  if (!existsSync(recordingsBaseDir)) return [];

  const entries = readdirSync(recordingsBaseDir);
  const incomplete: IncompleteSession[] = [];

  for (const entry of entries) {
    const sessionDir = joinPath(recordingsBaseDir, entry);
    try {
      const s = statSync(sessionDir);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    const state = await loadPipelineState(sessionDir);
    if (!state) continue;
    if (isFullyComplete(state) && !state.failedStage) continue;
    incomplete.push({ sessionDir, state });
  }

  // 新しい順にソート（lastUpdated 降順）
  incomplete.sort((a, b) =>
    (b.state.lastUpdated ?? '').localeCompare(a.state.lastUpdated ?? ''),
  );

  return incomplete;
}
