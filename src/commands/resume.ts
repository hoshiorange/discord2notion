import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { relative } from 'node:path';
import {
  type PipelineCallbacks,
  type PipelineStage,
  type PipelineState,
  findIncompleteSessions,
  inputFromState,
  isFullyComplete,
  loadPipelineState,
  RECORDINGS_BASE,
  runPostMp3Pipeline,
} from '../pipeline.js';

export const data = new SlashCommandBuilder()
  .setName('resume')
  .setDescription('途中で失敗したパイプラインを再開します')
  .addStringOption((opt) =>
    opt
      .setName('session_id')
      .setDescription('再開対象のセッションID。未指定なら最新の未完セッション')
      .setRequired(false),
  );

const STAGE_LABEL: Record<PipelineStage, string> = {
  transcribe: '📝 文字起こし',
  summary: '📋 要約',
  drive: '☁️ Drive アップロード',
  notion: '📔 Notion ページ作成',
};

function shortError(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : String(err);
}

function pipelineDoneLine(stage: PipelineStage, state: PipelineState): string {
  switch (stage) {
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
  const argSessionId = interaction.options.getString('session_id');

  let targetSessionDir: string | null = null;
  let targetState: PipelineState | null = null;

  if (argSessionId) {
    // 指定セッションを探す
    const candidateDir = `${RECORDINGS_BASE}/${argSessionId}`;
    const state = await loadPipelineState(candidateDir);
    if (!state) {
      await interaction.reply({
        content: `⚠️ セッション \`${argSessionId}\` の pipeline-state.json が見つかりません。\n`
          + 'recordings/ 配下に対象ディレクトリがあるか確認してください。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    targetSessionDir = candidateDir;
    targetState = state;
  } else {
    // 最新の未完セッションを取得
    const incomplete = await findIncompleteSessions();
    if (incomplete.length === 0) {
      await interaction.reply({
        content: '🟢 再開対象の未完セッションはありません。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const latest = incomplete[0];
    if (!latest) {
      await interaction.reply({
        content: '🟢 再開対象の未完セッションはありません。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    targetSessionDir = latest.sessionDir;
    targetState = latest.state;
  }

  if (isFullyComplete(targetState) && !targetState.failedStage) {
    await interaction.reply({
      content: `✅ セッション \`${targetState.sessionId}\` は既に全ステージ完了済みです。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 初期応答
  const baseLines: string[] = [
    `🔁 セッション \`${targetState.sessionId}\` を再開します`,
    `保存先: \`${relative(process.cwd(), targetSessionDir)}\``,
    `完了済み: ${targetState.completedStages.length === 0 ? '（なし）' : targetState.completedStages.map((s) => STAGE_LABEL[s]).join(' / ')}`,
  ];
  if (targetState.failedStage) {
    baseLines.push(`前回失敗: ${STAGE_LABEL[targetState.failedStage]} (${targetState.failedError ?? ''})`);
  }

  await interaction.reply(baseLines.join('\n'));

  const sessionId = targetState.sessionId;
  const callbacks: PipelineCallbacks = {
    onStageStart: async (stage) => {
      await interaction.editReply([...baseLines, '', `${STAGE_LABEL[stage]} 中...`].join('\n'));
    },
    onStageComplete: async (stage, state) => {
      baseLines.push(pipelineDoneLine(stage, state));
      await interaction.editReply(baseLines.join('\n'));
    },
    onStageFailed: async (stage, error) => {
      baseLines.push(`⚠️ ${STAGE_LABEL[stage]} 失敗: ${error.message.slice(0, 200)}`);
      baseLines.push(
        `解消後に再度 \`/resume session_id:${sessionId}\` で再開できます`,
      );
      await interaction.editReply(baseLines.join('\n'));
    },
  };

  try {
    const finalState = await runPostMp3Pipeline(inputFromState(targetState), callbacks);
    if (!finalState.failedStage) {
      baseLines[0] = `🔁 セッション \`${sessionId}\` の再開が完了 ✅`;
      await interaction.editReply(baseLines.join('\n'));
    }
  } catch (err) {
    console.error('[resume] error:', err);
    baseLines.push(`⚠️ 再開処理中に予期せぬエラー: ${shortError(err)}`);
    try {
      await interaction.editReply(baseLines.join('\n'));
    } catch {
      // ignore
    }
  }
}
