import 'dotenv/config';
import { relative } from 'node:path';
import { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes } from 'discord.js';
import { processSession } from './audio.js';
import { cleanupOldSessions } from './cleanup.js';
import { commands, commandsByName } from './commands/index.js';
import { cleanupOldLogs, getLogger } from './logger.js';
import { runPostMp3Pipeline } from './pipeline.js';
import { type VoiceLeaveResult, voiceManager } from './voice.js';

const log = getLogger('app');
const cleanupLog = getLogger('cleanup');
const logsLog = getLogger('logs');
const commandLog = getLogger('command');
const voiceLog = getLogger('voice');
const pipelineLog = getLogger('pipeline');

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const REQUIRED_ENV_VARS = [
  'DISCORD_TOKEN',
  'NOTION_API_KEY',
  'NOTION_DATABASE_ID',
  'GOOGLE_DRIVE_CREDENTIALS',
  'GOOGLE_DRIVE_REFRESH_TOKEN',
] as const;

const missingEnv = REQUIRED_ENV_VARS.filter((k) => {
  const v = process.env[k];
  return !v || v.trim().length === 0;
});
if (missingEnv.length > 0) {
  log.error(
    `必須の環境変数が .env に設定されていません: ${missingEnv.join(', ')}（.env.example を参照してください）`,
  );
  process.exit(1);
}

const token = process.env.DISCORD_TOKEN as string;

const guildId = process.env.DISCORD_GUILD_ID; // optional. あれば Guild 限定登録（即時反映）

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  log.info(`✅ Logged in as ${readyClient.user.tag} (id: ${readyClient.user.id})`);

  const commandData = commands.map((c) => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(readyClient.user.id, guildId), {
        body: commandData,
      });
      log.info(`✅ ${commands.length} 個のコマンドを Guild ${guildId} に登録（即時反映）`);
    } else {
      await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commandData });
      log.info(`✅ ${commands.length} 個のコマンドをグローバル登録（反映に最大1時間）`);
    }
  } catch (err) {
    log.error({ err }, 'スラッシュコマンド登録失敗');
  }

  void runSessionCleanup();
  void runLogCleanup();
  setInterval(() => {
    void runSessionCleanup();
    void runLogCleanup();
  }, CLEANUP_INTERVAL_MS);
});

async function runSessionCleanup(): Promise<void> {
  try {
    const r = await cleanupOldSessions();
    cleanupLog.info(`deleted=${r.deleted.length} kept=${r.kept.length}`);
  } catch (err) {
    cleanupLog.error({ err }, 'session cleanup error');
  }
}

async function runLogCleanup(): Promise<void> {
  try {
    const r = await cleanupOldLogs();
    logsLog.info(`deleted=${r.deleted.length} kept=${r.kept.length}`);
  } catch (err) {
    logsLog.error({ err }, 'log cleanup error');
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commandsByName.get(interaction.commandName);
  if (!command) {
    log.warn(`Unknown command: ${interaction.commandName}`);
    return;
  }

  commandLog.info(`/${interaction.commandName} by ${interaction.user.tag}`);

  try {
    await command.execute(interaction);
  } catch (err) {
    log.error({ err }, `Error in /${interaction.commandName}`);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: '⚠️ コマンド実行中にエラーが発生しました',
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: '⚠️ コマンド実行中にエラーが発生しました',
        flags: MessageFlags.Ephemeral,
      });
    }
  }
});

// Bot が居る VC から人がいなくなったら自動退出する
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const snap = voiceManager.snapshot();
  if (!snap.isActive || !snap.channelId) return;

  // Bot の VC から離脱した時のみ処理（他チャンネルのイベントは無視）
  const leftBotChannel =
    oldState.channelId === snap.channelId && newState.channelId !== snap.channelId;
  if (!leftBotChannel) return;

  const botUserId = client.user?.id;

  // Bot 自身が外部要因（kick / move）で VC から外された場合は内部状態を片付ける
  if (oldState.id === botUserId) {
    voiceLog.info('Bot が外部要因で VC から離脱、状態をクリーンアップ');
    voiceManager.leave();
    return;
  }

  // 人間が抜けた場合：残ってる人間が0なら自動退出
  const channel = oldState.channel;
  if (!channel) return;
  const humansLeft = channel.members.filter((m) => !m.user.bot).size;
  const memberTag = oldState.member?.user.tag ?? oldState.id;
  voiceLog.info(`${memberTag} が ${channel.name} から離脱、残り ${humansLeft} 人`);

  if (humansLeft === 0) {
    voiceLog.info('全員離脱したので自動退出します');
    const leaveResult = voiceManager.leave();

    // ファイルがあれば fire-and-forget で MP3 変換 + 元テキストチャンネルに通知
    if (leaveResult.files.length > 0 && leaveResult.sessionDir) {
      void backgroundConvert(leaveResult, 'auto-leave');
    }
  }
});

type ConvertReason = 'auto-leave' | 'timeout' | 'reconnect-failed';

async function fetchParticipantNames(userIds: string[]): Promise<string[]> {
  const names: string[] = [];
  for (const id of userIds) {
    try {
      const user = await client.users.fetch(id);
      const name = user.displayName || user.username || id;
      names.push(name);
    } catch (err) {
      pipelineLog.warn({ err, userId: id }, 'failed to fetch user');
      names.push(id);
    }
  }
  return names;
}

/** AIP-37: userId → 表示名のマッピングを解決。fetch 失敗時は userId フォールバック。 */
async function fetchSpeakerNames(userIds: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const id of userIds) {
    try {
      const user = await client.users.fetch(id);
      map[id] = user.displayName || user.username || id;
    } catch (err) {
      pipelineLog.warn({ err, userId: id }, 'failed to fetch user (speaker name)');
      map[id] = id;
    }
  }
  return map;
}

async function backgroundConvert(
  leaveResult: VoiceLeaveResult,
  reason: ConvertReason,
): Promise<void> {
  const {
    sessionDir,
    textChannelId,
    files,
    sessionId,
    durationMs,
    startedAt,
    channelName,
    guildId,
  } = leaveResult;
  if (!sessionDir) return;
  const tag =
    reason === 'timeout'
      ? 'timeout'
      : reason === 'reconnect-failed'
        ? 'reconnect-failed'
        : 'auto-leave';
  const tlog = getLogger(tag);
  const notifyPrefix =
    reason === 'timeout'
      ? '⏰ 録音時間上限に到達したので自動停止'
      : reason === 'reconnect-failed'
        ? '⚠️ Voice 接続が回復しなかったので録音停止'
        : '🎵 自動退出';

  let notifyChannel: { send: (content: string) => Promise<unknown> } | null = null;
  if (textChannelId) {
    try {
      const ch = await client.channels.fetch(textChannelId);
      if (ch && ch.isTextBased() && 'send' in ch && typeof ch.send === 'function') {
        notifyChannel = ch as { send: (content: string) => Promise<unknown> };
      }
    } catch (err) {
      tlog.error({ err }, 'failed to fetch text channel');
    }
  }

  // Step 1: MP3 mix（AIP-37: ユーザー別 WAV も同時生成）
  let mixedMp3: string | null = null;
  let mp3Info = '';
  let userWavs: { userId: string; wavPath: string }[] = [];
  try {
    const result = await processSession(sessionDir, files);
    if (!result.mixedMp3) {
      tlog.info('no audio to mix');
      return;
    }
    mixedMp3 = result.mixedMp3;
    userWavs = result.userWavs;
    const relPath = relative(process.cwd(), mixedMp3);
    mp3Info = `🎵 \`${relPath}\` (${result.durationSec.toFixed(1)}秒で ${result.inputCount} ユーザー分をミックス)`;
    tlog.info(`MP3 生成完了: ${relPath}, userWavs=${userWavs.length}`);
  } catch (err) {
    tlog.error({ err }, 'processSession error');
    const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
    await notifyChannel?.send(`⚠️ ${notifyPrefix} 後の MP3 変換に失敗しました: ${msg}`);
    return;
  }

  // Step 2-5: transcribe → summary → drive → notion をパイプラインで実行
  const userIds = files.map((f) => f.userId);
  const participants = await fetchParticipantNames(userIds);
  const speakerNames = await fetchSpeakerNames(userIds);
  const effectiveStartedAt = startedAt ?? new Date(Date.now() - durationMs);
  const finalState = await runPostMp3Pipeline({
    sessionDir,
    sessionId: sessionId ?? 'unknown',
    startedAt: effectiveStartedAt,
    durationMs,
    mixedMp3Path: mixedMp3,
    channelName,
    textChannelId,
    guildId,
    files,
    participants,
    userWavs,
    speakerNames,
  });

  const lines: string[] = [`${notifyPrefix} 後の処理が完了しました`, mp3Info];
  if (finalState.transcript) {
    const t = finalState.transcript;
    lines.push(
      `📝 transcript: \`${relative(process.cwd(), t.transcriptPath)}\` — ${t.segments} segments / RT比 ${t.rtFactor.toFixed(1)}x`,
    );
  }
  if (finalState.summary) {
    lines.push(`📋 summary: \`${relative(process.cwd(), finalState.summary.summaryPath)}\``);
  }
  if (finalState.drive) {
    lines.push(`☁️ Drive: ${finalState.drive.folderUrl}`);
  }
  if (finalState.notion) {
    lines.push(`📔 Notion: ${finalState.notion.pageUrl}`);
  }
  if (finalState.failedStage) {
    const errMsg = finalState.failedError?.slice(0, 200) ?? '不明エラー';
    lines.push(`⚠️ ${finalState.failedStage} で失敗: ${errMsg}`);
    lines.push(
      `クォータ復活など解消後に \`/resume session_id:${finalState.sessionId}\` で再開できます`,
    );
  } else {
    lines[0] = `${notifyPrefix} 後の処理が完走しました ✅`;
  }
  await notifyChannel?.send(lines.join('\n'));
}

// 録音時間上限到達時に発火
voiceManager.on('timeout', (leaveResult) => {
  void backgroundConvert(leaveResult, 'timeout');
});

// Voice 再接続が完全に失敗した時に発火
voiceManager.on('reconnect_failed', (leaveResult) => {
  void backgroundConvert(leaveResult, 'reconnect-failed');
});

client.on(Events.Error, (err) => {
  log.error({ err }, 'Discord client error');
});

const shutdownLog = getLogger('shutdown');

let isShuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  shutdownLog.info(`⏹️ ${signal} 受信、シャットダウンします`);

  // 録音中ならファイルをフラッシュして可能なら MP3 まで生成する
  if (voiceManager.isActive()) {
    shutdownLog.info('録音中のためファイルをフラッシュ中...');
    const leaveResult = voiceManager.leave();
    // ファイルストリームの flush 待ち（OS のバッファ反映時間）
    await new Promise((r) => setTimeout(r, 500));

    if (leaveResult.files.length > 0 && leaveResult.sessionDir) {
      shutdownLog.info('MP3 変換中...');
      try {
        const result = await processSession(leaveResult.sessionDir, leaveResult.files);
        if (result.mixedMp3) {
          shutdownLog.info(`MP3 生成完了: ${relative(process.cwd(), result.mixedMp3)}`);
        }
      } catch (err) {
        shutdownLog.error({ err }, 'MP3 変換失敗');
      }
    }
  }

  try {
    await client.destroy();
  } catch (err) {
    shutdownLog.error({ err }, 'client.destroy() error');
  }
  process.exit(0);
}

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});

await client.login(token);
