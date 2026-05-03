import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { recordingState } from '../state.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('録音を停止します');

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}分${seconds.toString().padStart(2, '0')}秒`;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const { wasRecording, durationMs } = recordingState.stop();
  if (!wasRecording) {
    await interaction.reply({
      content: '⚠️ 録音していません。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const duration = durationMs !== null ? formatDuration(durationMs) : '不明';
  await interaction.reply(`⏹️ 録音を停止しました（${duration}）`);
}
