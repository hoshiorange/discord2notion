/**
 * Claude Code ヘッドレス (`claude -p`) を子プロセスで叩いて、
 * `transcript.json` から議事録要約 JSON を生成する。
 *
 * 仕様:
 *   - 失敗時は1回だけ自動リトライ
 *   - タイムアウトは `SUMMARIZE_TIMEOUT_MS`（既定 10 分）
 *   - stdin は DEVNULL に明示リダイレクト（claude の対話入力待ちを避ける）
 *   - stderr は逐次バッファ + ログ転送（`[claude] ...` プレフィックス）
 *   - claude の stdout から JSON 部分を抽出してパース
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join as joinPath } from 'node:path';

import type { TranscribeResult, TranscribeSegment } from './transcribe.js';

export interface SummaryAgendaItem {
  topic: string;
  points: string[];
}

export interface SummaryTodo {
  owner: string;
  task: string;
  due?: string | null;
}

export interface SummaryResult {
  title: string;
  tags: string[];
  summary: string;
  agenda: SummaryAgendaItem[];
  decisions: string[];
  todos: SummaryTodo[];
  next_actions: string[];
}

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

function getTimeoutMs(): number {
  const raw = process.env.SUMMARIZE_TIMEOUT_MS;
  if (!raw) return 10 * 60 * 1000;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : 10 * 60 * 1000;
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function buildTranscriptText(segments: TranscribeSegment[]): string {
  return segments
    .map((seg) => `[${formatTimestamp(seg.start)}] ${seg.text.trim()}`)
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

function buildPrompt(transcriptText: string): string {
  return `以下は Discord ボイスチャンネルでの会議の文字起こし（自動生成、タイムスタンプ付き）です。
これを構造化された議事録 JSON として返してください。

# 重要な指示
- 出力は **JSON オブジェクトのみ**（コードフェンス \`\`\` や説明文・前置きは一切付けない）
- 人物名は文字起こしに登場する形のまま使い、推測で補完しない
- 該当情報がない配列項目は空配列 [] で返す
- \`title\` は30字以内
- \`tags\` は ["定例", "顧客MTG", "プロジェクト", "1on1", "その他"] のいずれか1つを必ず含む配列
- \`summary\` は3行以内、改行区切り

# 出力スキーマ
{
  "title": "会議タイトル候補（30字以内）",
  "tags": ["定例" など1要素"],
  "summary": "概要（3行以内）",
  "agenda": [{"topic": "議題名", "points": ["論点1", "論点2"]}],
  "decisions": ["決定事項1"],
  "todos": [{"owner": "担当者", "task": "タスク内容", "due": "期限 or null"}],
  "next_actions": ["次回確認事項1"]
}

# 文字起こし
${transcriptText}
`;
}

function extractJson(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{')) return trimmed;

  // ```json ... ``` フェンス対応（指示で禁止しているが念のため）
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch && fenceMatch[1]) return fenceMatch[1].trim();

  // 最初の '{' から最後の '}' までを抜き出す
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    return trimmed.slice(first, last + 1);
  }

  return trimmed;
}

function validateSummary(value: unknown): SummaryResult {
  if (!value || typeof value !== 'object') {
    throw new Error('summary JSON is not an object');
  }
  const obj = value as Record<string, unknown>;

  const requireString = (key: string): string => {
    const v = obj[key];
    if (typeof v !== 'string') {
      throw new Error(`summary.${key} must be string, got ${typeof v}`);
    }
    return v;
  };
  const requireStringArray = (key: string): string[] => {
    const v = obj[key];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      throw new Error(`summary.${key} must be string[]`);
    }
    return v;
  };

  const agendaRaw = obj.agenda;
  if (!Array.isArray(agendaRaw)) {
    throw new Error('summary.agenda must be array');
  }
  const agenda: SummaryAgendaItem[] = agendaRaw.map((item, i) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`summary.agenda[${i}] must be object`);
    }
    const a = item as Record<string, unknown>;
    if (typeof a.topic !== 'string') {
      throw new Error(`summary.agenda[${i}].topic must be string`);
    }
    if (!Array.isArray(a.points) || !a.points.every((p) => typeof p === 'string')) {
      throw new Error(`summary.agenda[${i}].points must be string[]`);
    }
    return { topic: a.topic, points: a.points as string[] };
  });

  const todosRaw = obj.todos;
  if (!Array.isArray(todosRaw)) {
    throw new Error('summary.todos must be array');
  }
  const todos: SummaryTodo[] = todosRaw.map((item, i) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`summary.todos[${i}] must be object`);
    }
    const t = item as Record<string, unknown>;
    if (typeof t.owner !== 'string') {
      throw new Error(`summary.todos[${i}].owner must be string`);
    }
    if (typeof t.task !== 'string') {
      throw new Error(`summary.todos[${i}].task must be string`);
    }
    let due: string | null | undefined;
    if (t.due === undefined || t.due === null) {
      due = t.due as null | undefined;
    } else if (typeof t.due === 'string') {
      due = t.due;
    } else {
      throw new Error(`summary.todos[${i}].due must be string|null|undefined`);
    }
    return { owner: t.owner, task: t.task, due };
  });

  return {
    title: requireString('title'),
    tags: requireStringArray('tags'),
    summary: requireString('summary'),
    agenda,
    decisions: requireStringArray('decisions'),
    todos,
    next_actions: requireStringArray('next_actions'),
  };
}

async function spawnClaude(prompt: string): Promise<SummaryResult> {
  const timeoutMs = getTimeoutMs();

  return new Promise((resolve, reject) => {
    console.log(`[summarize] spawn: ${CLAUDE_BIN} -p (prompt ${prompt.length} chars)`);
    const proc = spawn(CLAUDE_BIN, ['-p', prompt], {
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
        if (line.trim()) console.log(`[claude] ${line}`);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[summarize] timeout after ${timeoutMs}ms, sending SIGTERM`);
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    }, timeoutMs);

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`claude -p timeout after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`claude -p exited with code ${code}\n${stderr.slice(-500)}`));
        return;
      }
      try {
        const jsonText = extractJson(stdout);
        const parsed = JSON.parse(jsonText) as unknown;
        const result = validateSummary(parsed);
        resolve(result);
      } catch (err) {
        reject(
          new Error(
            `failed to parse claude stdout as SummaryResult: ${(err as Error).message}\nstdout head: ${stdout.slice(0, 500)}`,
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

/** transcript.json を読み、claude -p で要約を1回試行、失敗時は1回だけ再試行する。 */
export async function summarize(transcriptPath: string): Promise<SummaryResult> {
  const raw = await readFile(transcriptPath, 'utf-8');
  const transcript = JSON.parse(raw) as TranscribeResult;
  if (!Array.isArray(transcript.segments)) {
    throw new Error(`transcript.segments missing or not array in ${transcriptPath}`);
  }
  const transcriptText = buildTranscriptText(transcript.segments);
  if (transcriptText.trim().length === 0) {
    throw new Error(`transcript.segments produced empty text in ${transcriptPath}`);
  }
  const prompt = buildPrompt(transcriptText);

  try {
    return await spawnClaude(prompt);
  } catch (err) {
    console.error('[summarize] 1st attempt failed:', err);
    console.log('[summarize] retrying once...');
    return await spawnClaude(prompt);
  }
}

/** 要約を実行し、transcript.json と同ディレクトリに `summary.json` として整形保存する。 */
export async function summarizeAndSave(transcriptPath: string): Promise<{
  result: SummaryResult;
  summaryPath: string;
}> {
  const result = await summarize(transcriptPath);
  const summaryPath = joinPath(dirname(transcriptPath), 'summary.json');
  await writeFile(summaryPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`[summarize] saved: ${summaryPath}`);
  return { result, summaryPath };
}
