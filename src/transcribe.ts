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

export interface TranscribeSegment {
  start: number;
  end: number;
  text: string;
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
    console.log(`[transcribe] spawn: ${python} ${SCRIPT_PATH} ${audioPath}`);
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
        if (line.trim()) console.log(`[transcribe.py] ${line}`);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[transcribe] timeout after ${timeoutMs}ms, sending SIGTERM`);
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
    console.error('[transcribe] 1st attempt failed:', err);
    console.log('[transcribe] retrying once...');
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
  console.log(`[transcribe] saved: ${transcriptPath}`);
  return { result, transcriptPath };
}
