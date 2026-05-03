/**
 * Phase 5 統合パイプライン: 文字起こし → 要約 → Drive アップロード → Notion ページ生成 を順次実行する。
 *
 * MP3 生成はこの関数の前段で済んでいる前提（呼び出し側で `processSession` を実行）。
 *
 * 各ステップの失敗は外側へ伝播せず、`PipelineProgress` に部分成果として記録する。
 * 呼び出し側は `progress.failedStage` を見て切り分け通知をする。
 */

import { basename } from 'node:path';
import type { CreateMeetingPageResult } from './notion.js';
import type { SummaryResult } from './summarize.js';
import type { TranscribeResult } from './transcribe.js';
import type { UploadResult } from './drive.js';
import { createMeetingPage } from './notion.js';
import { summarizeAndSave } from './summarize.js';
import { transcribeAndSave } from './transcribe.js';
import { uploadSession } from './drive.js';

export type PipelineStage = 'transcribe' | 'summary' | 'drive' | 'notion';

export interface PipelineProgress {
  transcript?: { result: TranscribeResult; transcriptPath: string };
  summary?: { result: SummaryResult; summaryPath: string };
  drive?: UploadResult;
  notion?: CreateMeetingPageResult;
  failedStage?: PipelineStage;
  failedError?: Error;
}

export interface PipelineInput {
  sessionDir: string;
  sessionId: string;
  startedAt: Date;
  durationMs: number;
  mixedMp3Path: string;
  participants?: string[];
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * MP3 生成済みのセッションに対して、文字起こし→要約→Drive→Notion を順次実行する。
 * 途中で失敗したらそこで停止し、それまでの成果を返す。
 */
export async function runPostMp3Pipeline(input: PipelineInput): Promise<PipelineProgress> {
  const progress: PipelineProgress = {};

  // Step 1: transcribe
  try {
    progress.transcript = await transcribeAndSave(input.mixedMp3Path);
  } catch (err) {
    console.error('[pipeline] transcribe failed:', err);
    progress.failedStage = 'transcribe';
    progress.failedError = asError(err);
    return progress;
  }

  // Step 2: summarize
  try {
    progress.summary = await summarizeAndSave(progress.transcript.transcriptPath);
  } catch (err) {
    console.error('[pipeline] summarize failed:', err);
    progress.failedStage = 'summary';
    progress.failedError = asError(err);
    return progress;
  }

  // Step 3: drive upload
  try {
    progress.drive = await uploadSession(input.sessionDir, [
      basename(input.mixedMp3Path),
      basename(progress.transcript.transcriptPath),
      basename(progress.summary.summaryPath),
    ]);
  } catch (err) {
    console.error('[pipeline] drive upload failed:', err);
    progress.failedStage = 'drive';
    progress.failedError = asError(err);
    return progress;
  }

  // Step 4: notion page
  try {
    const mp3Url = progress.drive.fileUrls[basename(input.mixedMp3Path)];
    const transcriptUrl = progress.drive.fileUrls[basename(progress.transcript.transcriptPath)];
    progress.notion = await createMeetingPage({
      summary: progress.summary.result,
      sessionId: input.sessionId,
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      mp3Url,
      transcriptUrl,
      participants: input.participants,
    });
  } catch (err) {
    console.error('[pipeline] notion page failed:', err);
    progress.failedStage = 'notion';
    progress.failedError = asError(err);
    return progress;
  }

  return progress;
}
