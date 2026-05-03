/**
 * src/summarize.ts の動作確認スクリプト。
 *
 * 使い方:
 *   npx tsx scripts/test_summarize.ts
 *     -> recordings/ 配下から最新の transcript.json を自動検出して要約
 *
 *   npx tsx scripts/test_summarize.ts <transcript.json のパス>
 *     -> 指定した transcript.json を要約
 *
 * 出力:
 *   transcript.json と同ディレクトリに summary.json を保存
 */

import { existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join as joinPath, resolve as resolvePath } from 'node:path';

import { summarizeAndSave } from '../src/summarize.js';

const PROJECT_ROOT = process.cwd();
const RECORDINGS_DIR = resolvePath(PROJECT_ROOT, 'recordings');

async function pickLatestTranscript(): Promise<string | null> {
  if (!existsSync(RECORDINGS_DIR)) return null;
  const entries = await readdir(RECORDINGS_DIR, { withFileTypes: true });
  const candidates: { path: string; mtime: number }[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const transcriptPath = joinPath(RECORDINGS_DIR, ent.name, 'transcript.json');
    if (!existsSync(transcriptPath)) continue;
    const st = statSync(transcriptPath);
    candidates.push({ path: transcriptPath, mtime: st.mtimeMs });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]!.path;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  let transcriptPath: string;

  if (arg) {
    transcriptPath = isAbsolute(arg) ? arg : resolvePath(PROJECT_ROOT, arg);
    if (!existsSync(transcriptPath)) {
      console.error(`[test_summarize] transcript not found: ${transcriptPath}`);
      process.exit(1);
    }
  } else {
    const latest = await pickLatestTranscript();
    if (!latest) {
      console.error(
        '[test_summarize] recordings/<sessionId>/transcript.json が見つかりません。' +
          ' 引数で transcript.json のパスを指定してください。',
      );
      process.exit(1);
    }
    transcriptPath = latest;
  }

  console.log(`[test_summarize] target: ${transcriptPath}`);

  const start = Date.now();
  const { result, summaryPath } = await summarizeAndSave(transcriptPath);
  const elapsedSec = (Date.now() - start) / 1000;

  console.log('=' .repeat(60));
  console.log('[test_summarize] SUMMARY');
  console.log('=' .repeat(60));
  console.log(`title       : ${result.title}`);
  console.log(`tags        : ${result.tags.join(', ')}`);
  console.log(`summary     : ${result.summary.replace(/\n/g, ' / ')}`);
  console.log(`agenda      : ${result.agenda.length} item(s)`);
  console.log(`decisions   : ${result.decisions.length} item(s)`);
  console.log(`todos       : ${result.todos.length} item(s)`);
  console.log(`next_actions: ${result.next_actions.length} item(s)`);
  console.log('=' .repeat(60));
  console.log(`[test_summarize] saved : ${summaryPath}`);
  console.log(`[test_summarize] elapsed: ${elapsedSec.toFixed(2)}s`);
}

main().catch((err) => {
  console.error('[test_summarize] FAILED:', err);
  process.exit(1);
});
