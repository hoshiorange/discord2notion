import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { voiceManager } from '../voice.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('録音を停止して受信統計を表示します');

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

  const { stats, durationMs, channelName } = voiceManager.leave();

  const lines: string[] = [
    `⏹️ 録音を停止しました（${channelName ?? '不明なチャンネル'} / ${formatDuration(durationMs)}）`,
  ];

  if (stats.size === 0) {
    lines.push('発話を検出したユーザーはいませんでした。');
  } else {
    lines.push('### 受信統計（Opus）');
    for (const [userId, s] of stats) {
      lines.push(
        `- <@${userId}>: ${s.frameCount.toLocaleString()} frames / ${s.byteCount.toLocaleString()} bytes / ${s.speakingSessions} sessions`,
      );
    }
  }

  await interaction.reply(lines.join('\n'));
}
