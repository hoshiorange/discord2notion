/**
 * Notion 議事録 DB に新規ページを作成し、要約結果と関連リンクを書き込む。
 *
 * 仕様 (AIP-28):
 *   - 認証: `.env` の NOTION_API_KEY / NOTION_DATABASE_ID
 *   - DB プロパティ (11 個。`作成日時` は Notion 自動付与なので書き込まない):
 *       タイトル / 日付 / 会議時間(分) / 参加者 / タグ / ステータス /
 *       決定事項 / ToDo数 / 音声ファイル / 文字起こし
 *   - ページ本文: 概要 / 議題 / 決定事項 / ToDo / 次回までに確認すること
 */

import { Client } from '@notionhq/client';

import type { SummaryResult } from './summarize.js';

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

const VALID_TAGS = new Set(['定例', '顧客MTG', 'プロジェクト', '1on1', 'その他']);
const DEFAULT_STATUS = '完了';
const RICH_TEXT_LIMIT = 2000;

export interface CreateMeetingPageArgs {
  summary: SummaryResult;
  sessionId: string;
  startedAt: Date;
  durationMs: number;
  mp3Url?: string;
  transcriptUrl?: string;
  participants?: string[];
}

export interface CreateMeetingPageResult {
  pageUrl: string;
  pageId: string;
}

function requireEnv(): { apiKey: string; databaseId: string } {
  if (!NOTION_API_KEY) throw new Error('NOTION_API_KEY が .env に設定されていません');
  if (!NOTION_DATABASE_ID) throw new Error('NOTION_DATABASE_ID が .env に設定されていません');
  return { apiKey: NOTION_API_KEY, databaseId: NOTION_DATABASE_ID };
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatTitle(startedAt: Date): string {
  const y = startedAt.getFullYear();
  const m = pad(startedAt.getMonth() + 1);
  const d = pad(startedAt.getDate());
  const hh = pad(startedAt.getHours());
  const mm = pad(startedAt.getMinutes());
  const ss = pad(startedAt.getSeconds());
  return `${y}/${m}/${d} ${hh}:${mm}:${ss}~ 議事録`;
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks;
}

function richText(text: string): { type: 'text'; text: { content: string } }[] {
  if (!text) return [{ type: 'text', text: { content: '' } }];
  return chunkText(text, RICH_TEXT_LIMIT).map((c) => ({
    type: 'text' as const,
    text: { content: c },
  }));
}

function paragraph(text: string): {
  object: 'block';
  type: 'paragraph';
  paragraph: { rich_text: ReturnType<typeof richText> };
} {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: richText(text) },
  };
}

function heading2(text: string): {
  object: 'block';
  type: 'heading_2';
  heading_2: { rich_text: ReturnType<typeof richText> };
} {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: richText(text) },
  };
}

function heading3(text: string): {
  object: 'block';
  type: 'heading_3';
  heading_3: { rich_text: ReturnType<typeof richText> };
} {
  return {
    object: 'block',
    type: 'heading_3',
    heading_3: { rich_text: richText(text) },
  };
}

function bullet(text: string): {
  object: 'block';
  type: 'bulleted_list_item';
  bulleted_list_item: { rich_text: ReturnType<typeof richText> };
} {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: richText(text) },
  };
}

function buildSummaryParagraphs(text: string): ReturnType<typeof paragraph>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [paragraph('（要約なし）')];
  return lines.map((l) => paragraph(l));
}

function formatTodoLine(todo: SummaryResult['todos'][number]): string {
  const owner = todo.owner.trim() || '担当未定';
  const task = todo.task.trim();
  const due = todo.due && todo.due.trim().length > 0 ? `（期限: ${todo.due.trim()}）` : '';
  return `${owner}: ${task}${due}`;
}

function buildChildren(summary: SummaryResult): unknown[] {
  const blocks: unknown[] = [];

  blocks.push(heading2('概要'));
  blocks.push(...buildSummaryParagraphs(summary.summary));

  blocks.push(heading2('議題'));
  if (summary.agenda.length === 0) {
    blocks.push(paragraph('（議題なし）'));
  } else {
    for (const item of summary.agenda) {
      blocks.push(heading3(item.topic));
      if (item.points.length === 0) {
        blocks.push(paragraph('（論点なし）'));
      } else {
        for (const p of item.points) blocks.push(bullet(p));
      }
    }
  }

  blocks.push(heading2('決定事項'));
  if (summary.decisions.length === 0) {
    blocks.push(paragraph('（決定事項なし）'));
  } else {
    for (const d of summary.decisions) blocks.push(bullet(d));
  }

  blocks.push(heading2('ToDo'));
  if (summary.todos.length === 0) {
    blocks.push(paragraph('（ToDo なし）'));
  } else {
    for (const t of summary.todos) blocks.push(bullet(formatTodoLine(t)));
  }

  blocks.push(heading2('次回までに確認すること'));
  if (summary.next_actions.length === 0) {
    blocks.push(paragraph('（なし）'));
  } else {
    for (const a of summary.next_actions) blocks.push(bullet(a));
  }

  return blocks;
}

function filterValidTags(tags: string[]): { name: string }[] {
  const filtered: { name: string }[] = [];
  for (const t of tags) {
    if (VALID_TAGS.has(t)) {
      filtered.push({ name: t });
    } else {
      console.warn(`[notion] 未知のタグをスキップ: ${t}`);
    }
  }
  return filtered;
}

function joinDecisions(decisions: string[]): string {
  if (decisions.length === 0) return '';
  return decisions.map((d) => `- ${d}`).join('\n');
}

function buildProperties(args: CreateMeetingPageArgs): Record<string, unknown> {
  const { summary, startedAt, durationMs, mp3Url, transcriptUrl, participants } = args;

  const title = formatTitle(startedAt);
  const minutes = Math.max(0, Math.round(durationMs / 60000));
  const decisionsText = joinDecisions(summary.decisions);
  const tagOptions = filterValidTags(summary.tags);
  const participantOptions = (participants ?? [])
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name }));

  const props: Record<string, unknown> = {
    タイトル: { title: [{ type: 'text', text: { content: title } }] },
    日付: { date: { start: startedAt.toISOString() } },
    '会議時間(分)': { number: minutes },
    タグ: { multi_select: tagOptions },
    ステータス: { status: { name: DEFAULT_STATUS } },
    決定事項: { rich_text: richText(decisionsText) },
    ToDo数: { number: summary.todos.length },
    参加者: { multi_select: participantOptions },
  };

  if (mp3Url && mp3Url.trim().length > 0) {
    props['音声ファイル'] = { url: mp3Url };
  }
  if (transcriptUrl && transcriptUrl.trim().length > 0) {
    props['文字起こし'] = { url: transcriptUrl };
  }

  return props;
}

/** Notion 議事録 DB に新規ページを作成して URL/ID を返す。 */
export async function createMeetingPage(
  args: CreateMeetingPageArgs,
): Promise<CreateMeetingPageResult> {
  const { apiKey, databaseId } = requireEnv();
  const client = new Client({ auth: apiKey });

  const properties = buildProperties(args);
  const children = buildChildren(args.summary);

  console.log(
    `[notion] creating page: session=${args.sessionId} startedAt=${args.startedAt.toISOString()}`,
  );

  const response = await client.pages.create({
    parent: { database_id: databaseId },
    properties: properties as Parameters<typeof client.pages.create>[0]['properties'],
    children: children as Parameters<typeof client.pages.create>[0]['children'],
  });

  const pageId = response.id;
  const pageUrl = 'url' in response && typeof response.url === 'string' ? response.url : '';

  console.log(`[notion] created: ${pageUrl || pageId}`);

  return { pageUrl, pageId };
}
