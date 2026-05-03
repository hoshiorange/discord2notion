import {
  ChannelType,
  type ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { voiceManager } from '../voice.js';

export const data = new SlashCommandBuilder()
  .setName('start')
  .setDescription('VC に参加して録音を開始します（ユーザー別 Ogg/Opus ファイルに保存）');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (voiceManager.isActive()) {
    await interaction.reply({
      content: '⚠️ 既に録音中です。停止するには `/stop` を使ってください。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member;
  if (!(member instanceof GuildMember)) {
    await interaction.reply({
      content: '⚠️ サーバー内でのみ実行可能です。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const voiceChannel = member.voice.channel;
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: '⚠️ ボイスチャンネルに参加してから実行してください。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 3秒の interaction 応答窓を確保するため即座に reply
  await interaction.reply(`🔵 接続中... (${voiceChannel.name})`);

  try {
    const result = await voiceManager.join(voiceChannel, interaction.channelId);
    if (result.success) {
      await interaction.editReply(
        `🔴 録音を開始しました（${result.channelName}）\n` +
          `セッション ID: \`${result.sessionId}\`\n` +
          `/stop で停止します`,
      );
    } else {
      await interaction.editReply(`⚠️ ${result.error}`);
    }
  } catch (err) {
    console.error('[start] join error:', err);
    try {
      await interaction.editReply('⚠️ VC 接続中に予期せぬエラーが発生しました');
    } catch (innerErr) {
      console.error('[start] editReply failed:', innerErr);
    }
  }
}
