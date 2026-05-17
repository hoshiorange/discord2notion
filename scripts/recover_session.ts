/**
 * 失敗セッションのリカバリスクリプト（AIP-39 / AIP-40）。
 *
 * recordings/<sessionId> 配下の .opusraw を集めて runPostMp3Pipeline に流し、
 * MP3 → 文字起こし → 要約 → Drive → Notion を一気通貫で実行する。
 *
 * 使い方:
 *   npx tsx scripts/recover_session.ts <sessionId> [guildId] [options]
 *
 * Options:
 *   --speaker <userId>=<name>   speakerNames に追加（複数指定可）
 *   --duration-min <分>         会議時間を分単位で明示指定（既定: opusraw の mtime から推定）
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

interface CliArgs {
  sessionId: string;
  guildId: string | null;
  speakerOverrides: Record<string, string>;
  durationMinOverride: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const speakerOverrides: Record<string, string> = {};
  let durationMinOverride: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--speaker') {
      const v = argv[++i];
      if (!v || !v.includes('=')) {
        throw new Error(`--speaker は <userId>=<name> 形式で指定: ${v}`);
      }
      const idx = v.indexOf('=');
      speakerOverrides[v.slice(0, idx).trim()] = v.slice(idx + 1).trim();
    } else if (a === '--duration-min') {
      const v = argv[++i];
      const n = Number.parseFloat(v ?? '');
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--duration-min は正の数値: ${v}`);
      }
      durationMinOverride = n;
    } else if (a?.startsWith('--')) {
      throw new Error(`未知のオプション: ${a}`);
    } else if (a) {
      positional.push(a);
    }
  }

  const sessionId = positional[0];
  if (!sessionId) {
    throw new Error('sessionId が指定されていません');
  }
  return {
    sessionId,
    guildId: positional[1] ?? null,
    speakerOverrides,
    durationMinOverride,
  };
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error(
      'Usage: npx tsx scripts/recover_session.ts <sessionId> [guildId] '
        + '[--speaker <userId>=<name> ...] [--duration-min <分>]',
    );
    process.exit(1);
  }

  const { sessionId, guildId, speakerOverrides, durationMinOverride } = args;

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
  const durationMs = durationMinOverride !== null
    ? Math.round(durationMinOverride * 60 * 1000)
    : Math.max(0, opusrawMaxMtime - startedAt.getTime());

  // speakerNames: 引数で渡されたものを優先、無ければ userId をそのまま speaker に
  const speakerNames: Record<string, string> = {};
  for (const f of opusrawFiles) {
    speakerNames[f.userId] = speakerOverrides[f.userId] ?? f.userId;
  }
  const participants = opusrawFiles.map((f) => speakerNames[f.userId] ?? f.userId);

  console.log(`Recovering session ${sessionId}`);
  console.log(`  sessionDir: ${sessionDir}`);
  console.log(`  opusraw files: ${opusrawFiles.length}`);
  for (const f of opusrawFiles) {
    const s = statSync(f.filename);
    console.log(
      `    - ${f.userId} (${speakerNames[f.userId]}): ${(s.size / 1024 / 1024).toFixed(1)} MB`,
    );
  }
  console.log(`  startedAt: ${startedAt.toISOString()}`);
  console.log(
    `  durationMs: ${durationMs} (${(durationMs / 60000).toFixed(1)} min)`
      + (durationMinOverride !== null ? ' [overridden by --duration-min]' : ''),
  );
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
      participants,
      speakerNames,
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
