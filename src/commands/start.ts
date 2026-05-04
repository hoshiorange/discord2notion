import {
  ChannelType,
  type ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { getLogger } from '../logger.js';
import { voiceManager } from '../voice.js';

const log = getLogger('start');

export const data = new SlashCommandBuilder()
  .setName('start')
  .setDescription('VC に参加して録音を開始します（ユーザー別 Ogg/Opus ファイルに保存）');

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}分${seconds.toString().padStart(2, '0')}秒`;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (voiceManager.isActive()) {
    const snap = voiceManager.snapshot();
    const channelLabel = voiceManager.channelLabel() ?? snap.channelId ?? '不明';
    const lines: string[] = [
      '⚠️ 既に録音中です。新しい録音を始める前に `/stop` で現在の録音を停止してください。',
      '',
      '現在の録音セッション:',
      `- チャンネル: ${channelLabel}${snap.channelId ? ` (<#${snap.channelId}>)` : ''}`,
    ];
    if (snap.guildId) lines.push(`- ギルド: \`${snap.guildId}\``);
    if (snap.sessionId) lines.push(`- セッション ID: \`${snap.sessionId}\``);
    if (snap.durationMs !== null) lines.push(`- 経過時間: ${formatDuration(snap.durationMs)}`);
    await interaction.reply({
      content: lines.join('\n'),
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
    log.error({ err }, 'join error');
    try {
      await interaction.editReply('⚠️ VC 接続中に予期せぬエラーが発生しました');
    } catch (innerErr) {
      log.error({ err: innerErr }, 'editReply failed');
    }
  }
}
