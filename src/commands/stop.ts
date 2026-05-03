import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { basename, relative } from 'node:path';
import { voiceManager } from '../voice.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('録音を停止して受信統計と保存ファイルを表示します');

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

  const { stats, durationMs, channelName, sessionId, sessionDir, files } = voiceManager.leave();

  const lines: string[] = [
    `⏹️ 録音を停止しました（${channelName ?? '不明'} / ${formatDuration(durationMs)}）`,
  ];

  if (sessionId) {
    lines.push(`セッション ID: \`${sessionId}\``);
  }
  if (sessionDir) {
    const rel = relative(process.cwd(), sessionDir);
    lines.push(`保存先: \`${rel}\``);
  }

  if (files.length === 0) {
    lines.push('発話を検出したユーザーはいませんでした。');
  } else {
    lines.push(`### 保存ファイル（${files.length}）`);
    for (const f of files) {
      const userStats = stats.get(f.userId);
      const frames = userStats?.frameCount ?? 0;
      const bytes = userStats?.byteCount ?? 0;
      lines.push(
        `- <@${f.userId}>: \`${basename(f.filename)}\` — ${frames.toLocaleString()} frames / ${bytes.toLocaleString()} bytes`,
      );
    }
  }

  await interaction.reply(lines.join('\n'));
}
