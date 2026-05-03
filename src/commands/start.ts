import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { recordingState } from '../state.js';

export const data = new SlashCommandBuilder()
  .setName('start')
  .setDescription('録音を開始します（Phase 2 はモック動作）');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const ok = recordingState.start();
  if (!ok) {
    await interaction.reply({
      content: '⚠️ 既に録音中です。停止するには `/stop` を使ってください。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply('🔴 録音を開始しました（モック）');
}
