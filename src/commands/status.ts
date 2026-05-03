import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { voiceManager } from '../voice.js';

export const data = new SlashCommandBuilder()
  .setName('status')
  .setDescription('録音状態と受信統計を表示します');

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}分${seconds.toString().padStart(2, '0')}秒`;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const snapshot = voiceManager.snapshot();

  if (!snapshot.isActive) {
    await interaction.reply({
      content: '🟢 録音していません',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines: string[] = [];
  const channelLabel = voiceManager.channelLabel() ?? snapshot.channelId ?? '不明';
  const duration = snapshot.durationMs !== null ? formatDuration(snapshot.durationMs) : '不明';
  lines.push(`🔴 録音中（${channelLabel} / ${duration} 経過）`);
  if (snapshot.sessionId) {
    lines.push(`セッション: \`${snapshot.sessionId}\``);
  }

  if (snapshot.perUserStats.size === 0) {
    lines.push('まだ発話を検出していません。');
  } else {
    lines.push('受信中:');
    for (const [userId, s] of snapshot.perUserStats) {
      lines.push(
        `- <@${userId}>: ${s.frameCount.toLocaleString()} frames / ${s.byteCount.toLocaleString()} bytes`,
      );
    }
  }

  await interaction.reply({
    content: lines.join('\n'),
    flags: MessageFlags.Ephemeral,
  });
}
