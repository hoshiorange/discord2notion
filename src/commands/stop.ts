import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { basename, relative } from 'node:path';
import { getLogger } from '../logger.js';
import {
  type PipelineCallbacks,
  type PipelineStage,
  type PipelineState,
  runPostMp3Pipeline,
} from '../pipeline.js';
import { voiceManager } from '../voice.js';

const log = getLogger('stop');

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('録音を停止し、MP3 → 文字起こし → 要約 → Drive → Notion まで一気通貫で実行します');

const STAGE_LABEL: Record<PipelineStage, string> = {
  mp3: '🔧 MP3 変換',
  transcribe: '📝 文字起こし',
  summary: '📋 要約',
  drive: '☁️ Drive アップロード',
  notion: '📔 Notion ページ作成',
};

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}分${seconds.toString().padStart(2, '0')}秒`;
}

function shortError(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : String(err);
}

async function fetchParticipantNames(
  interaction: ChatInputCommandInteraction,
  userIds: string[],
): Promise<string[]> {
  const names: string[] = [];
  for (const id of userIds) {
    try {
      const user = await interaction.client.users.fetch(id);
      names.push(user.displayName || user.username || id);
    } catch (err) {
      log.warn({ err, userId: id }, 'failed to fetch user');
      names.push(id);
    }
  }
  return names;
}

/** AIP-37: userId → 表示名のマッピングを解決。fetch 失敗時は userId フォールバック。 */
async function fetchSpeakerNames(
  interaction: ChatInputCommandInteraction,
  userIds: string[],
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const id of userIds) {
    try {
      const user = await interaction.client.users.fetch(id);
      map[id] = user.displayName || user.username || id;
    } catch (err) {
      log.warn({ err, userId: id }, 'failed to fetch user (speaker name)');
      map[id] = id;
    }
  }
  return map;
}

function pipelineDoneLine(stage: PipelineStage, state: PipelineState): string {
  switch (stage) {
    case 'mp3':
      return state.mp3
        ? `✅ MP3: \`${relative(process.cwd(), state.mp3.mixedMp3Path)}\` (${state.mp3.durationSec.toFixed(1)}秒で ${state.mp3.inputCount} ユーザー分をミックス)`
        : '✅ MP3 変換完了';
    case 'transcribe':
      return state.transcript
        ? `✅ 文字起こし: \`${relative(process.cwd(), state.transcript.transcriptPath)}\` — ${state.transcript.segments} segments / RT比 ${state.transcript.rtFactor.toFixed(1)}x`
        : '✅ 文字起こし完了';
    case 'summary':
      return state.summary
        ? `✅ 要約: \`${relative(process.cwd(), state.summary.summaryPath)}\``
        : '✅ 要約完了';
    case 'drive':
      return state.drive ? `✅ Drive: ${state.drive.folderUrl}` : '✅ Drive アップロード完了';
    case 'notion':
      return state.notion ? `✅ Notion: ${state.notion.pageUrl}` : '✅ Notion ページ作成完了';
  }
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

  const leaveResult = voiceManager.leave();
  const { stats, durationMs, startedAt, channelName, sessionId, sessionDir, textChannelId, files } =
    leaveResult;

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

  baseLines.push('');

  // === MP3 → 文字起こし → 要約 → Drive → Notion を一気通貫実行 ===
  // AIP-39/40: MP3 もパイプラインステージ化されたので、失敗しても pipeline-state.json が残り /resume で再開可能。
  const userIds = files.map((f) => f.userId);
  const participants = await fetchParticipantNames(interaction, userIds);
  const speakerNames = await fetchSpeakerNames(interaction, userIds);
  const effectiveStartedAt = startedAt ?? new Date(Date.now() - durationMs);

  const callbacks: PipelineCallbacks = {
    onStageStart: async (stage) => {
      await interaction.editReply([...baseLines, `${STAGE_LABEL[stage]} 中...`].join('\n'));
    },
    onStageComplete: async (stage, state) => {
      baseLines.push(pipelineDoneLine(stage, state));
      await interaction.editReply(baseLines.join('\n'));
    },
    onStageFailed: async (stage, error) => {
      log.error({ err: error, stage }, 'pipeline stage failed');
      baseLines.push(`⚠️ ${STAGE_LABEL[stage]} 失敗: ${shortError(error)}`);
      baseLines.push(
        `クォータ復活など解消後に \`/resume\` で再開できます（セッション: \`${sessionId ?? '不明'}\`）`,
      );
      await interaction.editReply(baseLines.join('\n'));
    },
  };

  const finalState = await runPostMp3Pipeline(
    {
      sessionDir,
      sessionId: sessionId ?? 'unknown',
      startedAt: effectiveStartedAt,
      durationMs,
      channelName,
      textChannelId,
      guildId: interaction.guildId,
      files,
      participants,
      speakerNames,
    },
    callbacks,
  );

  if (!finalState.failedStage) {
    baseLines[0] = `⏹️ 全工程完了 ✅（${channelName ?? '不明'} / ${formatDuration(durationMs)}）`;
    await interaction.editReply(baseLines.join('\n'));
  }
}
