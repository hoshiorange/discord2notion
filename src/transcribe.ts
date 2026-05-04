/**
 * Python Whisper CLI (`scripts/transcribe.py`) を子プロセスで叩いて文字起こし結果を取得する。
 *
 * 仕様:
 *   - 失敗時は1回だけ自動リトライ
 *   - タイムアウトは `TRANSCRIBE_TIMEOUT_MS`（既定 10 分）
 *   - Python は `PYTHON_BIN` 環境変数 → `.venv/Scripts/python.exe` → `python` の順で解決
 *   - stderr は逐次バッファ + ログ転送（`[transcribe.py] ...` プレフィックス）
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join as joinPath, resolve as resolvePath } from 'node:path';
import { getLogger } from './logger.js';

const log = getLogger('transcribe');
const pyLog = getLogger('transcribe.py');

export interface TranscribeSegment {
  start: number;
  end: number;
  text: string;
  /**
   * 発言者の表示名（または userId フォールバック）。
   * AIP-37: ユーザー別 transcribe で付与される。一括 transcribe（旧フロー）では undefined。
   */
  speaker?: string;
}

export interface TranscribeResult {
  audio_path: string;
  model: string;
  device: string;
  language: string;
  language_probability: number;
  duration_sec: number;
  elapsed_sec: number;
  realtime_factor: number;
  segments: TranscribeSegment[];
}

/** AIP-37: ユーザー別 transcribe をマージした結果。 */
export interface MultiSpeakerTranscribeResult {
  /** 各ユーザーの transcribe 元データ（参考用、Whisper info を含む）。 */
  perUser: { userId: string; speaker: string; result: TranscribeResult }[];
  /** タイムスタンプ昇順にマージされた segment 一覧。各 segment に speaker が入る。 */
  segments: TranscribeSegment[];
  /** 全体の最大 duration（最も長いユーザー音声の長さ）。 */
  duration_sec: number;
  /** 全ユーザーの合計 elapsed。 */
  elapsed_sec: number;
  /** 全体の RT 比（duration_sec / elapsed_sec）。 */
  realtime_factor: number;
}

const PROJECT_ROOT = process.cwd();
const SCRIPT_PATH = resolvePath(PROJECT_ROOT, 'scripts/transcribe.py');

function getPythonBin(): string {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venvPython = resolvePath(PROJECT_ROOT, '.venv/Scripts/python.exe');
  if (existsSync(venvPython)) return venvPython;
  return 'python';
}

function getTimeoutMs(): number {
  const raw = process.env.TRANSCRIBE_TIMEOUT_MS;
  if (!raw) return 10 * 60 * 1000;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : 10 * 60 * 1000;
}

async function spawnTranscribe(audioPath: string): Promise<TranscribeResult> {
  const python = getPythonBin();
  const timeoutMs = getTimeoutMs();

  return new Promise((resolve, reject) => {
    log.info(`spawn: ${python} ${SCRIPT_PATH} ${audioPath}`);
    const proc = spawn(python, [SCRIPT_PATH, audioPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderr += text;
      for (const line of text.split('\n')) {
        if (line.trim()) pyLog.info(line);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      log.error(`timeout after ${timeoutMs}ms, sending SIGTERM`);
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    }, timeoutMs);

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`transcribe.py timeout after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`transcribe.py exited with code ${code}\n${stderr.slice(-500)}`));
        return;
      }
      try {
        const result = JSON.parse(stdout) as TranscribeResult;
        resolve(result);
      } catch (err) {
        reject(
          new Error(
            `failed to parse stdout as JSON: ${(err as Error).message}\nstdout head: ${stdout.slice(0, 500)}`,
          ),
        );
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Whisper 文字起こしを1回試行、失敗時は1回だけ再試行する。 */
export async function transcribe(audioPath: string): Promise<TranscribeResult> {
  try {
    return await spawnTranscribe(audioPath);
  } catch (err) {
    log.error({ err }, '1st attempt failed');
    log.info('retrying once...');
    return await spawnTranscribe(audioPath);
  }
}

/** 文字起こしを実行し、同ディレクトリに `transcript.json` として整形保存する。 */
export async function transcribeAndSave(audioPath: string): Promise<{
  result: TranscribeResult;
  transcriptPath: string;
}> {
  const result = await transcribe(audioPath);
  const transcriptPath = joinPath(dirname(audioPath), 'transcript.json');
  await writeFile(transcriptPath, JSON.stringify(result, null, 2), 'utf-8');
  log.info(`saved: ${transcriptPath}`);
  return { result, transcriptPath };
}

/**
 * AIP-37: ユーザー別 WAV を順次 transcribe し、speaker フィールド付き segments にマージする。
 *
 * - GPU メモリ事情から直列実行（大きいモデル + 複数ユーザー並列は RTX 3060 12GB だと厳しい）
 * - 1ユーザーで失敗しても他ユーザーは続行（部分的な議事録でも価値があるため）
 * - speaker は `speakerNames[userId]` を優先、無ければ userId を使う
 */
export async function transcribeUsers(
  userWavs: { userId: string; wavPath: string }[],
  speakerNames: Record<string, string> = {},
): Promise<MultiSpeakerTranscribeResult> {
  if (userWavs.length === 0) {
    throw new Error('userWavs is empty');
  }

  const perUser: MultiSpeakerTranscribeResult['perUser'] = [];
  const merged: TranscribeSegment[] = [];
  let maxDuration = 0;
  let totalElapsed = 0;

  for (const { userId, wavPath } of userWavs) {
    const speaker = speakerNames[userId]?.trim() || userId;
    log.info(`transcribing user=${userId} speaker=${speaker} path=${wavPath}`);
    let result: TranscribeResult;
    try {
      result = await transcribe(wavPath);
    } catch (err) {
      log.error({ err, userId, wavPath }, 'user transcribe failed, skipping');
      continue;
    }
    perUser.push({ userId, speaker, result });
    if (result.duration_sec > maxDuration) maxDuration = result.duration_sec;
    totalElapsed += result.elapsed_sec;
    for (const seg of result.segments) {
      merged.push({ start: seg.start, end: seg.end, text: seg.text, speaker });
    }
  }

  if (perUser.length === 0) {
    throw new Error('all user transcribes failed');
  }

  merged.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return a.end - b.end;
  });

  const rtFactor = totalElapsed > 0 ? maxDuration / totalElapsed : 0;
  return {
    perUser,
    segments: merged,
    duration_sec: maxDuration,
    elapsed_sec: totalElapsed,
    realtime_factor: rtFactor,
  };
}

/**
 * ユーザー別 transcribe を実行し、`transcript.json` 形式（TranscribeResult 互換 + speaker）で保存する。
 * 既存の Notion / Drive 連携が `transcript.json` を直接読む箇所は変更不要にするための互換シム。
 */
export async function transcribeUsersAndSave(
  userWavs: { userId: string; wavPath: string }[],
  outputDir: string,
  speakerNames: Record<string, string> = {},
): Promise<{
  result: TranscribeResult;
  transcriptPath: string;
  multi: MultiSpeakerTranscribeResult;
}> {
  const multi = await transcribeUsers(userWavs, speakerNames);
  // TranscribeResult 互換の最上位 JSON を作る（audio_path はマージ元の代表として最初のユーザーを使う）
  const head = multi.perUser[0];
  if (!head) {
    throw new Error('multi.perUser is empty');
  }
  const result: TranscribeResult = {
    audio_path: head.result.audio_path,
    model: head.result.model,
    device: head.result.device,
    language: head.result.language,
    language_probability: head.result.language_probability,
    duration_sec: multi.duration_sec,
    elapsed_sec: multi.elapsed_sec,
    realtime_factor: multi.realtime_factor,
    segments: multi.segments,
  };
  const transcriptPath = joinPath(outputDir, 'transcript.json');
  await writeFile(transcriptPath, JSON.stringify(result, null, 2), 'utf-8');
  log.info(
    `saved (multi-speaker): ${transcriptPath} — ${multi.perUser.length} speaker(s), ${result.segments.length} segments`,
  );
  return { result, transcriptPath, multi };
}
