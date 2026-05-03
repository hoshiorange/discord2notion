import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { basename, relative } from 'node:path';
import { processSession } from '../audio.js';
import { voiceManager } from '../voice.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('録音を停止し、Opus を MP3 に変換・ミックスします');

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}分${seconds.toString().padStart(2, '0')}秒`;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!voiceManager.isActive()) {
    await interaction.reply({
      content: '⚠️ 録音していません。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 即座に reply（3秒の応答窓を確保）
  await interaction.reply('⏹️ 録音を停止しています...');

  const { stats, durationMs, channelName, sessionId, sessionDir, files } = voiceManager.leave();

  const lines: string[] = [
    `⏹️ 録音を停止しました（${channelName ?? '不明'} / ${formatDuration(durationMs)}）`,
  ];
  if (sessionId) lines.push(`セッション ID: \`${sessionId}\``);
  if (sessionDir) lines.push(`保存先: \`${relative(process.cwd(), sessionDir)}\``);

  if (files.length === 0) {
    lines.push('発話を検出したユーザーはいませんでした。');
    await interaction.editReply(lines.join('\n'));
    return;
  }

  // ファイル一覧表示
  lines.push(`### 保存ファイル（${files.length}）`);
  for (const f of files) {
    const userStats = stats.get(f.userId);
    const frames = userStats?.frameCount ?? 0;
    const bytes = userStats?.byteCount ?? 0;
    lines.push(
      `- <@${f.userId}>: \`${basename(f.filename)}\` — ${frames.toLocaleString()} frames / ${bytes.toLocaleString()} bytes`,
    );
  }

  // 中間進捗を更新
  lines.push('');
  lines.push('🔧 MP3 に変換中...');
  await interaction.editReply(lines.join('\n'));

  if (!sessionDir) {
    return;
  }

  // 変換
  try {
    const result = await processSession(sessionDir, files);
    if (result.mixedMp3) {
      // 「変換中」の行を成功メッセージに置換
      lines.pop(); // 空行
      lines.pop();
      lines.push('');
      lines.push(
        `✅ MP3 生成完了（${result.durationSec.toFixed(1)}秒で ${result.inputCount} ユーザー分をミックス）`,
      );
      lines.push(`🎵 \`${relative(process.cwd(), result.mixedMp3)}\``);
    } else {
      lines.pop();
      lines.pop();
      lines.push('');
      lines.push('⚠️ ミックスする音声がありませんでした');
    }
  } catch (err) {
    lines.pop();
    lines.pop();
    lines.push('');
    lines.push(`⚠️ 変換に失敗しました: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    console.error('[stop] processSession error:', err);
  }

  await interaction.editReply(lines.join('\n'));
}
