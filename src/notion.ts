/**
 * Notion 議事録 DB に新規ページを作成し、要約結果と関連リンクを書き込む。
 *
 * 仕様 (AIP-28):
 *   - 認証: `.env` の NOTION_API_KEY / NOTION_DATABASE_ID
 *   - DB プロパティ (11 個。`作成日時` は Notion 自動付与なので書き込まない):
 *       タイトル / 日付 / 会議時間(分) / 参加者 / タグ / ステータス /
 *       決定事項 / ToDo数 / 音声ファイル / 文字起こし
 *   - ページ本文: 概要 / 議題 / 決定事項 / ToDo / 次回までに確認すること / 発言時間（AIP-37）
 */

import { Client } from '@notionhq/client';

import { getLogger } from './logger.js';
import type { SummaryResult } from './summarize.js';
import type { TranscribeSegment } from './transcribe.js';

const log = getLogger('notion');

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
  /**
   * AIP-37: 議事録本文末尾に「発言時間」セクション（話者別の発言時間サマリ）を追加するための segments。
   * 各 segment の `end - start` を speaker 単位で合算して長い順に表示する。speaker 未設定は「不明」扱い。
   * フル文字起こしは Drive 上の transcript.json を参照する設計（Notion ブロック制限を回避）。
   */
  transcriptSegments?: TranscribeSegment[];
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

/** AIP-37: 秒数を「45 秒」or「12 分 30 秒」フォーマットに整形。5分未満は秒のみ。 */
export function formatSpeakingDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 5 * 60) {
    return `${total} 秒`;
  }
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m} 分 ${s.toString().padStart(2, '0')} 秒`;
}

/** AIP-37: 話者ごとの発言時間 (end-start の合計) を発言時間長い順で計算する。 */
export function aggregateSpeakingTimes(
  segments: TranscribeSegment[],
): { speaker: string; seconds: number }[] {
  const totals = new Map<string, number>();
  for (const seg of segments) {
    const speaker = seg.speaker?.trim() && seg.speaker.trim().length > 0 ? seg.speaker.trim() : '不明';
    const dur = Math.max(0, seg.end - seg.start);
    totals.set(speaker, (totals.get(speaker) ?? 0) + dur);
  }
  return [...totals.entries()]
    .map(([speaker, seconds]) => ({ speaker, seconds }))
    .sort((a, b) => b.seconds - a.seconds);
}

/** AIP-37: 「**話者**: XX 秒」形式の bullet ブロックを作る（話者は bold）。 */
function speakingTimeBullet(speaker: string, durationLabel: string): unknown {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: {
      rich_text: [
        {
          type: 'text',
          text: { content: `${speaker}: ` },
          annotations: { bold: true },
        },
        { type: 'text', text: { content: durationLabel } },
      ],
    },
  };
}

/**
 * AIP-37: transcript segments から「発言時間」セクションのブロックを作る。
 * 話者ごとに発言時間（end - start の合計）を出し、長い順に bullet で列挙。
 */
function buildSpeakingTimeBlocks(segments: TranscribeSegment[]): unknown[] {
  if (segments.length === 0) return [paragraph('（発言なし）')];
  const totals = aggregateSpeakingTimes(segments);
  if (totals.length === 0) return [paragraph('（発言なし）')];
  return totals.map((t) => speakingTimeBullet(t.speaker, formatSpeakingDuration(t.seconds)));
}

function formatTodoLine(todo: SummaryResult['todos'][number]): string {
  const owner = todo.owner.trim() || '担当未定';
  const task = todo.task.trim();
  const due = todo.due && todo.due.trim().length > 0 ? `（期限: ${todo.due.trim()}）` : '';
  return `${owner}: ${task}${due}`;
}

function buildChildren(
  summary: SummaryResult,
  transcriptSegments: TranscribeSegment[] | undefined,
): unknown[] {
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

  // AIP-37: 話者ごとの発言時間サマリ（フル文字起こしは Drive の transcript.json を参照）
  if (transcriptSegments && transcriptSegments.length > 0) {
    blocks.push(heading2('発言時間'));
    blocks.push(...buildSpeakingTimeBlocks(transcriptSegments));
  }

  return blocks;
}

function filterValidTags(tags: string[]): { name: string }[] {
  const filtered: { name: string }[] = [];
  for (const t of tags) {
    if (VALID_TAGS.has(t)) {
      filtered.push({ name: t });
    } else {
      log.warn(`未知のタグをスキップ: ${t}`);
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
  const children = buildChildren(args.summary, args.transcriptSegments);

  log.info(
    `creating page: session=${args.sessionId} startedAt=${args.startedAt.toISOString()}`,
  );

  const response = await client.pages.create({
    parent: { database_id: databaseId },
    properties: properties as Parameters<typeof client.pages.create>[0]['properties'],
    children: children as Parameters<typeof client.pages.create>[0]['children'],
  });

  const pageId = response.id;
  const pageUrl = 'url' in response && typeof response.url === 'string' ? response.url : '';

  log.info(`created: ${pageUrl || pageId}`);

  return { pageUrl, pageId };
}
