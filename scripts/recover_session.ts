/**
 * 失敗セッションのリカバリスクリプト（AIP-39 / AIP-40）。
 *
 * recordings/<sessionId> 配下の .opusraw を集めて runPostMp3Pipeline に流し、
 * MP3 → 文字起こし → 要約 → Drive → Notion を一気通貫で実行する。
 *
 * 使い方:
 *   npx tsx scripts/recover_session.ts <sessionId> [guildId]
 *
 * guildId 未指定時は process.env の NOTION_API_KEY / GOOGLE_DRIVE_* がそのまま使われる。
 * Guild 別 config を当てたい場合は config/guilds/<guildId>.json が存在する guildId を渡す。
 */

import 'dotenv/config';
import { readdirSync, statSync } from 'node:fs';
import { join as joinPath, resolve as resolvePath } from 'node:path';

import { runPostMp3Pipeline, type PipelineCallbacks } from '../src/pipeline.js';

function parseTimestampFromSessionId(sessionId: string): Date | null {
  // フォーマット: YYYY-MM-DD_HHMMSS_xxxxxx
  const m = sessionId.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})_/);
  if (!m) return null;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
}

async function main(): Promise<void> {
  const sessionId = process.argv[2];
  const guildId = process.argv[3] ?? null;
  if (!sessionId) {
    console.error('Usage: npx tsx scripts/recover_session.ts <sessionId> [guildId]');
    process.exit(1);
  }

  const sessionDir = resolvePath(process.cwd(), 'recordings', sessionId);
  let entries: string[];
  try {
    entries = readdirSync(sessionDir);
  } catch {
    console.error(`Session directory not found: ${sessionDir}`);
    process.exit(1);
  }

  const opusrawFiles = entries
    .filter((f) => f.endsWith('.opusraw'))
    .map((f) => ({
      userId: f.replace(/\.opusraw$/, ''),
      filename: joinPath(sessionDir, f),
    }));

  if (opusrawFiles.length === 0) {
    console.error(`No .opusraw files in ${sessionDir}`);
    process.exit(1);
  }

  // sessionDir の mtime は中間 pcm の削除等で書き換わりうるので使わない。
  // opusraw ファイル群の最大 mtime（= 録音終了時刻）と startedAt の差分を会議時間とする。
  const opusrawMaxMtime = Math.max(
    ...opusrawFiles.map((f) => statSync(f.filename).mtimeMs),
  );
  const dirStat = statSync(sessionDir);
  const startedAt = parseTimestampFromSessionId(sessionId) ?? new Date(dirStat.birthtimeMs);
  const durationMs = Math.max(0, opusrawMaxMtime - startedAt.getTime());

  console.log(`Recovering session ${sessionId}`);
  console.log(`  sessionDir: ${sessionDir}`);
  console.log(`  opusraw files: ${opusrawFiles.length}`);
  for (const f of opusrawFiles) {
    const s = statSync(f.filename);
    console.log(`    - ${f.userId}: ${(s.size / 1024 / 1024).toFixed(1)} MB`);
  }
  console.log(`  startedAt: ${startedAt.toISOString()}`);
  console.log(`  durationMs: ${durationMs} (${(durationMs / 60000).toFixed(1)} min)`);
  console.log(`  guildId: ${guildId ?? '(none — using default .env)'}`);
  console.log();

  const callbacks: PipelineCallbacks = {
    onStageStart: (stage) => {
      console.log(`[${stage}] start`);
    },
    onStageComplete: (stage) => {
      console.log(`[${stage}] complete`);
    },
    onStageFailed: (stage, error) => {
      console.error(`[${stage}] FAILED: ${error.message}`);
    },
  };

  const finalState = await runPostMp3Pipeline(
    {
      sessionDir,
      sessionId,
      startedAt,
      durationMs,
      files: opusrawFiles,
      participants: opusrawFiles.map((f) => f.userId),
      speakerNames: Object.fromEntries(opusrawFiles.map((f) => [f.userId, f.userId])),
      guildId,
      channelName: null,
      textChannelId: null,
    },
    callbacks,
  );

  if (finalState.failedStage) {
    console.error(`\nFailed at stage: ${finalState.failedStage}`);
    console.error(`Error: ${finalState.failedError}`);
    process.exit(1);
  }

  console.log('\nRecovery complete!');
  if (finalState.mp3) console.log(`MP3: ${finalState.mp3.mixedMp3Path}`);
  if (finalState.drive) console.log(`Drive: ${finalState.drive.folderUrl}`);
  if (finalState.notion) console.log(`Notion: ${finalState.notion.pageUrl}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
