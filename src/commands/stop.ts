import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { basename, relative } from 'node:path';
import { processSession } from '../audio.js';
import { transcribeAndSave } from '../transcribe.js';
import { voiceManager } from '../voice.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('録音を停止し、Opus → MP3 → 文字起こしまで自動実行します');

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}分${seconds.toString().padStart(2, '0')}秒`;
}

function shortError(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : String(err);
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

  const { stats, durationMs, channelName, sessionId, sessionDir, files } = voiceManager.leave();

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
      `✅ MP3 生成完了: \`${relative(process.cwd(), mixedMp3)}\` (${result.durationSec.toFixed(1)}秒で ${result.inputCount} ユーザー分をミックス)`,
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

  try {
    const transcript = await transcribeAndSave(mixedMp3);
    const r = transcript.result;
    baseLines.push(
      `✅ 文字起こし完了: \`${relative(process.cwd(), transcript.transcriptPath)}\` — ${r.segments.length} segments / ${r.duration_sec.toFixed(1)}秒の音声を ${r.elapsed_sec.toFixed(1)}秒で（RT比 ${r.realtime_factor.toFixed(1)}x）`,
    );
    await interaction.editReply(baseLines.join('\n'));
  } catch (err) {
    console.error('[stop] transcribe error:', err);
    baseLines.push(`⚠️ 文字起こし失敗: ${shortError(err)}`);
    await interaction.editReply(baseLines.join('\n'));
  }
}
