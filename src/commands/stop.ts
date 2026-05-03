import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { basename, relative } from 'node:path';
import { processSession } from '../audio.js';
import { createMeetingPage } from '../notion.js';
import { summarizeAndSave } from '../summarize.js';
import { transcribeAndSave } from '../transcribe.js';
import { uploadSession } from '../drive.js';
import { voiceManager } from '../voice.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('録音を停止し、MP3 → 文字起こし → 要約 → Drive → Notion まで一気通貫で実行します');

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}分${seconds.toString().padStart(2, '0')}秒`;
}

function shortError(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : String(err);
}

async function fetchParticipantNames(
  interaction: ChatInputCommandInteraction,
  userIds: string[],
): Promise<string[]> {
  const names: string[] = [];
  for (const id of userIds) {
    try {
      const user = await interaction.client.users.fetch(id);
      names.push(user.displayName || user.username || id);
    } catch (err) {
      console.warn(`[stop] failed to fetch user ${id}:`, err);
      names.push(id);
    }
  }
  return names;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!voiceManager.isActive()) {
    await interaction.reply({
      content: '⚠️ 録音していません。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply('⏹️ 録音を停止しています...');

  const leaveResult = voiceManager.leave();
  const { stats, durationMs, startedAt, channelName, sessionId, sessionDir, files } = leaveResult;

  const baseLines: string[] = [
    `⏹️ 録音を停止しました（${channelName ?? '不明'} / ${formatDuration(durationMs)}）`,
  ];
  if (sessionId) baseLines.push(`セッション ID: \`${sessionId}\``);
  if (sessionDir) baseLines.push(`保存先: \`${relative(process.cwd(), sessionDir)}\``);

  if (files.length === 0) {
    baseLines.push('発話を検出したユーザーはいませんでした。');
    await interaction.editReply(baseLines.join('\n'));
    return;
  }

  baseLines.push(`### 保存ファイル（${files.length}）`);
  for (const f of files) {
    const userStats = stats.get(f.userId);
    const frames = userStats?.frameCount ?? 0;
    const bytes = userStats?.byteCount ?? 0;
    baseLines.push(
      `- <@${f.userId}>: \`${basename(f.filename)}\` — ${frames.toLocaleString()} frames / ${bytes.toLocaleString()} bytes`,
    );
  }

  if (!sessionDir) {
    await interaction.editReply(baseLines.join('\n'));
    return;
  }

  // === Step 1: MP3 mix ===
  await interaction.editReply([...baseLines, '', '🔧 MP3 に変換中...'].join('\n'));

  let mixedMp3: string | null = null;
  try {
    const result = await processSession(sessionDir, files);
    mixedMp3 = result.mixedMp3;
    if (!mixedMp3) {
      await interaction.editReply([...baseLines, '', '⚠️ ミックスする音声がありませんでした'].join('\n'));
      return;
    }
    baseLines.push('');
    baseLines.push(
      `✅ MP3: \`${relative(process.cwd(), mixedMp3)}\` (${result.durationSec.toFixed(1)}秒で ${result.inputCount} ユーザー分をミックス)`,
    );
  } catch (err) {
    console.error('[stop] processSession error:', err);
    await interaction.editReply(
      [...baseLines, '', `⚠️ MP3 変換失敗: ${shortError(err)}`].join('\n'),
    );
    return;
  }

  // === Step 2: transcribe ===
  await interaction.editReply([...baseLines, '📝 文字起こし中...'].join('\n'));

  let transcriptPath: string | null = null;
  try {
    const transcript = await transcribeAndSave(mixedMp3);
    transcriptPath = transcript.transcriptPath;
    const r = transcript.result;
    baseLines.push(
      `✅ 文字起こし: \`${relative(process.cwd(), transcriptPath)}\` — ${r.segments.length} segments / RT比 ${r.realtime_factor.toFixed(1)}x`,
    );
  } catch (err) {
    console.error('[stop] transcribe error:', err);
    baseLines.push(`⚠️ 文字起こし失敗: ${shortError(err)}`);
    await interaction.editReply(baseLines.join('\n'));
    return;
  }

  // === Step 3: summarize ===
  await interaction.editReply([...baseLines, '📋 要約中...'].join('\n'));

  let summaryResult: Awaited<ReturnType<typeof summarizeAndSave>> | null = null;
  try {
    summaryResult = await summarizeAndSave(transcriptPath);
    baseLines.push(`✅ 要約: \`${relative(process.cwd(), summaryResult.summaryPath)}\``);
  } catch (err) {
    console.error('[stop] summarize error:', err);
    baseLines.push(`⚠️ 要約失敗: ${shortError(err)}`);
    await interaction.editReply(baseLines.join('\n'));
    return;
  }

  // === Step 4: Drive upload ===
  await interaction.editReply([...baseLines, '☁️ Drive へアップロード中...'].join('\n'));

  let driveResult: Awaited<ReturnType<typeof uploadSession>> | null = null;
  try {
    driveResult = await uploadSession(sessionDir, [
      basename(mixedMp3),
      basename(transcriptPath),
      basename(summaryResult.summaryPath),
    ]);
    baseLines.push(`✅ Drive: ${driveResult.folderUrl}`);
  } catch (err) {
    console.error('[stop] drive upload error:', err);
    baseLines.push(`⚠️ Drive アップロード失敗: ${shortError(err)}`);
    await interaction.editReply(baseLines.join('\n'));
    return;
  }

  // === Step 5: Notion page ===
  await interaction.editReply([...baseLines, '📔 Notion ページ作成中...'].join('\n'));

  try {
    const participants = await fetchParticipantNames(
      interaction,
      files.map((f) => f.userId),
    );
    const effectiveStartedAt = startedAt ?? new Date(Date.now() - durationMs);
    const notion = await createMeetingPage({
      summary: summaryResult.result,
      sessionId: sessionId ?? 'unknown',
      startedAt: effectiveStartedAt,
      durationMs,
      mp3Url: driveResult.fileUrls[basename(mixedMp3)],
      transcriptUrl: driveResult.fileUrls[basename(transcriptPath)],
      participants,
    });
    baseLines.push(`✅ Notion: ${notion.pageUrl}`);
    baseLines[0] = `⏹️ 全工程完了 ✅（${channelName ?? '不明'} / ${formatDuration(durationMs)}）`;
    await interaction.editReply(baseLines.join('\n'));
  } catch (err) {
    console.error('[stop] notion error:', err);
    baseLines.push(`⚠️ Notion ページ作成失敗: ${shortError(err)}`);
    await interaction.editReply(baseLines.join('\n'));
  }
}
