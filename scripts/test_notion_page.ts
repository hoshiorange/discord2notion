/**
 * AIP-28 単体動作確認: src/notion.ts の createMeetingPage を実機で叩く。
 *
 * 使い方:
 *   npx tsx scripts/test_notion_page.ts [path/to/summary.json]
 *
 * 引数省略時は最新の `recordings/<session>/summary.json` を自動探索、
 * 見つからない場合はダミー SummaryResult で動作検証する。
 */

import 'dotenv/config';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';

import { createMeetingPage } from '../src/notion.js';
import type { SummaryResult } from '../src/summarize.js';

const DUMMY_SUMMARY: SummaryResult = {
  title: 'AIP-28 動作検証ダミー会議',
  tags: ['その他'],
  summary:
    'AIP-28 の動作検証用ダミー要約。\nNotion ページ生成のテストとして使用。\n本物の会議内容ではない。',
  agenda: [
    {
      topic: 'Notion 連携実装の確認',
      points: ['プロパティ書き込みが期待通りか', '本文ブロックが構造化されているか'],
    },
    {
      topic: 'Drive リンクの埋め込み',
      points: ['mp3Url / transcriptUrl がプロパティに入るか'],
    },
  ],
  decisions: [
    '`createMeetingPage` を AIP-29 の統合フローから呼び出す',
    'タグの DB 値乖離は AIP-29 で整合させる',
  ],
  todos: [
    { owner: 'worker-notion', task: 'src/notion.ts 実装と検証', due: null },
    { owner: 'team-lead', task: 'AIP-29 のスケジューリング', due: '2026-05-10' },
  ],
  next_actions: ['AIP-29 で processSession への組み込み', 'タグ語彙の整理'],
};

function findLatestSummaryJson(): string | null {
  const recordingsDir = joinPath(process.cwd(), 'recordings');
  if (!existsSync(recordingsDir)) return null;

  const sessions = readdirSync(recordingsDir)
    .map((name) => ({ name, full: joinPath(recordingsDir, name) }))
    .filter((e) => {
      try {
        return statSync(e.full).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => {
      const aMtime = statSync(a.full).mtimeMs;
      const bMtime = statSync(b.full).mtimeMs;
      return bMtime - aMtime;
    });

  for (const s of sessions) {
    const candidate = joinPath(s.full, 'summary.json');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function loadSummary(): Promise<{ summary: SummaryResult; source: string }> {
  const arg = process.argv[2];
  if (arg) {
    const text = await readFile(arg, 'utf-8');
    return { summary: JSON.parse(text) as SummaryResult, source: arg };
  }
  const auto = findLatestSummaryJson();
  if (auto) {
    const text = await readFile(auto, 'utf-8');
    return { summary: JSON.parse(text) as SummaryResult, source: auto };
  }
  return { summary: DUMMY_SUMMARY, source: '(dummy)' };
}

async function main(): Promise<void> {
  const { summary, source } = await loadSummary();
  console.log(`summary source : ${source}`);
  console.log(`title          : ${summary.title}`);
  console.log(`tags           : ${summary.tags.join(', ')}`);
  console.log(`agenda items   : ${summary.agenda.length}`);
  console.log(`decisions      : ${summary.decisions.length}`);
  console.log(`todos          : ${summary.todos.length}`);
  console.log(`next_actions   : ${summary.next_actions.length}`);
  console.log();

  const startedAt = new Date();
  const durationMs = 30 * 60 * 1000;

  const start = Date.now();
  const { pageUrl, pageId } = await createMeetingPage({
    summary,
    sessionId: `test-${start}`,
    startedAt,
    durationMs,
    mp3Url: 'https://drive.google.com/file/d/dummy-mp3/view',
    transcriptUrl: 'https://drive.google.com/file/d/dummy-transcript/view',
  });
  const elapsed = (Date.now() - start) / 1000;

  console.log();
  console.log('=== Result ===');
  console.log(`page id       : ${pageId}`);
  console.log(`page url      : ${pageUrl}`);
  console.log(`elapsed (wall): ${elapsed.toFixed(2)}s`);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
