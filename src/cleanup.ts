/**
 * AIP-33: 古い recordings/ セッションの自動クリーンアップ。
 *
 * 削除条件（AND）:
 *   1. `recordings/<sessionId>/pipeline-state.json` が存在し、
 *      `completedStages` が全ステージ（transcribe / summary / drive / notion）を含む。
 *   2. セッションディレクトリの mtime が retainDays 日より前。
 *
 * 上記を満たすセッションのみ `fs.rm(dir, { recursive: true })` で削除。
 * それ以外は保護し、理由を `kept` に記録する。
 */

import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join as joinPath, resolve as resolvePath } from 'node:path';

import {
  PIPELINE_STAGES,
  RECORDINGS_BASE,
  loadPipelineState,
  type PipelineState,
} from './pipeline.js';

const DEFAULT_RETAIN_DAYS = 30;

export interface CleanupOptions {
  /** 既定: env `RECORDINGS_RETAIN_DAYS`、未設定/不正値なら 30。 */
  retainDays?: number;
  /** true なら削除を行わず候補と保護理由のみを返す。既定 false。 */
  dryRun?: boolean;
  /** テスト用にディレクトリを差し替える。既定 `<cwd>/recordings`。 */
  recordingsDir?: string;
}

export type KeptReason = 'incomplete' | 'recent';

export interface CleanupResult {
  deleted: string[];
  kept: { sessionId: string; reason: KeptReason }[];
}

function resolveRetainDays(input: number | undefined): number {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
    return input;
  }
  const raw = process.env.RECORDINGS_RETAIN_DAYS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_RETAIN_DAYS;
}

function isPipelineFullyComplete(state: PipelineState): boolean {
  return PIPELINE_STAGES.every((s) => state.completedStages.includes(s));
}

export async function cleanupOldSessions(opts?: CleanupOptions): Promise<CleanupResult> {
  const retainDays = resolveRetainDays(opts?.retainDays);
  const dryRun = opts?.dryRun ?? false;
  const recordingsDir = opts?.recordingsDir
    ? resolvePath(opts.recordingsDir)
    : RECORDINGS_BASE;

  const result: CleanupResult = { deleted: [], kept: [] };

  if (!existsSync(recordingsDir)) {
    return result;
  }

  const cutoffMs = Date.now() - retainDays * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = await readdir(recordingsDir);
  } catch (err) {
    console.error(`[cleanup] failed to read ${recordingsDir}:`, err);
    return result;
  }

  for (const entry of entries) {
    const sessionDir = joinPath(recordingsDir, entry);

    let dirStat: Awaited<ReturnType<typeof stat>>;
    try {
      dirStat = await stat(sessionDir);
    } catch (err) {
      console.warn(`[cleanup] stat failed for ${sessionDir}:`, err);
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    const state = await loadPipelineState(sessionDir);
    if (!state || !isPipelineFullyComplete(state) || state.failedStage) {
      result.kept.push({ sessionId: entry, reason: 'incomplete' });
      continue;
    }

    if (dirStat.mtimeMs >= cutoffMs) {
      result.kept.push({ sessionId: entry, reason: 'recent' });
      continue;
    }

    if (dryRun) {
      result.deleted.push(entry);
      continue;
    }

    try {
      await rm(sessionDir, { recursive: true, force: true });
      result.deleted.push(entry);
    } catch (err) {
      console.error(`[cleanup] failed to remove ${sessionDir}:`, err);
      result.kept.push({ sessionId: entry, reason: 'incomplete' });
    }
  }

  return result;
}
