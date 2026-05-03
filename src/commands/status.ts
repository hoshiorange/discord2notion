import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { recordingState } from '../state.js';

export const data = new SlashCommandBuilder()
  .setName('status')
  .setDescription('録音状態を表示します');

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}分${seconds.toString().padStart(2, '0')}秒`;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const status = recordingState.status();
  const reply = status.isRecording
    ? `🔴 録音中（${status.durationMs !== null ? formatDuration(status.durationMs) : '不明'} 経過）`
    : '🟢 録音していません';
  await interaction.reply({ content: reply, flags: MessageFlags.Ephemeral });
}
