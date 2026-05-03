import 'dotenv/config';
import { relative } from 'node:path';
import { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes } from 'discord.js';
import { processSession } from './audio.js';
import { commands, commandsByName } from './commands/index.js';
import { transcribeAndSave } from './transcribe.js';
import { type VoiceLeaveResult, voiceManager } from './voice.js';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('ERROR: DISCORD_TOKEN が .env にありません');
  process.exit(1);
}

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
  console.log(`✅ Logged in as ${readyClient.user.tag} (id: ${readyClient.user.id})`);

  const commandData = commands.map((c) => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(readyClient.user.id, guildId), {
        body: commandData,
      });
      console.log(`✅ ${commands.length} 個のコマンドを Guild ${guildId} に登録（即時反映）`);
    } else {
      await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commandData });
      console.log(`✅ ${commands.length} 個のコマンドをグローバル登録（反映に最大1時間）`);
    }
  } catch (err) {
    console.error('スラッシュコマンド登録失敗:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commandsByName.get(interaction.commandName);
  if (!command) {
    console.warn(`Unknown command: ${interaction.commandName}`);
    return;
  }

  console.log(`[command] /${interaction.commandName} by ${interaction.user.tag}`);

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`Error in /${interaction.commandName}:`, err);
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
    console.log('[voice] Bot が外部要因で VC から離脱、状態をクリーンアップ');
    voiceManager.leave();
    return;
  }

  // 人間が抜けた場合：残ってる人間が0なら自動退出
  const channel = oldState.channel;
  if (!channel) return;
  const humansLeft = channel.members.filter((m) => !m.user.bot).size;
  const memberTag = oldState.member?.user.tag ?? oldState.id;
  console.log(`[voice] ${memberTag} が ${channel.name} から離脱、残り ${humansLeft} 人`);

  if (humansLeft === 0) {
    console.log('[voice] 全員離脱したので自動退出します');
    const leaveResult = voiceManager.leave();

    // ファイルがあれば fire-and-forget で MP3 変換 + 元テキストチャンネルに通知
    if (leaveResult.files.length > 0 && leaveResult.sessionDir) {
      void backgroundConvert(leaveResult, 'auto-leave');
    }
  }
});

type ConvertReason = 'auto-leave' | 'timeout';

async function backgroundConvert(
  leaveResult: VoiceLeaveResult,
  reason: ConvertReason,
): Promise<void> {
  const { sessionDir, textChannelId, files } = leaveResult;
  if (!sessionDir) return;
  const tag = reason === 'timeout' ? '[timeout]' : '[auto-leave]';
  const notifyPrefix = reason === 'timeout' ? '⏰ 録音時間上限に到達したので自動停止' : '🎵 自動退出';

  let notifyChannel: { send: (content: string) => Promise<unknown> } | null = null;
  if (textChannelId) {
    try {
      const ch = await client.channels.fetch(textChannelId);
      if (ch && ch.isTextBased() && 'send' in ch && typeof ch.send === 'function') {
        notifyChannel = ch as { send: (content: string) => Promise<unknown> };
      }
    } catch (err) {
      console.error(`${tag} failed to fetch text channel:`, err);
    }
  }

  // Step 1: MP3 mix
  let mixedMp3: string | null = null;
  let mp3Info = '';
  try {
    const result = await processSession(sessionDir, files);
    if (!result.mixedMp3) {
      console.log(`${tag} no audio to mix`);
      return;
    }
    mixedMp3 = result.mixedMp3;
    const relPath = relative(process.cwd(), mixedMp3);
    mp3Info = `🎵 \`${relPath}\` (${result.durationSec.toFixed(1)}秒で ${result.inputCount} ユーザー分をミックス)`;
    console.log(`${tag} MP3 生成完了: ${relPath}`);
  } catch (err) {
    console.error(`${tag} processSession error:`, err);
    const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
    await notifyChannel?.send(`⚠️ ${notifyPrefix} 後の MP3 変換に失敗しました: ${msg}`);
    return;
  }

  // Step 2: transcribe
  try {
    const transcript = await transcribeAndSave(mixedMp3);
    const r = transcript.result;
    const transcriptRel = relative(process.cwd(), transcript.transcriptPath);
    console.log(`${tag} transcribe 完了: ${r.segments.length} segments`);
    await notifyChannel?.send(
      [
        `${notifyPrefix} 後の処理が完了しました`,
        mp3Info,
        `📝 \`${transcriptRel}\` — ${r.segments.length} segments / ${r.duration_sec.toFixed(1)}秒の音声を ${r.elapsed_sec.toFixed(1)}秒で（RT比 ${r.realtime_factor.toFixed(1)}x）`,
      ].join('\n'),
    );
  } catch (err) {
    console.error(`${tag} transcribe error:`, err);
    const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
    await notifyChannel?.send(
      [
        `${notifyPrefix} 後の MP3 は生成済みですが文字起こしに失敗しました`,
        mp3Info,
        `⚠️ ${msg}`,
      ].join('\n'),
    );
  }
}

// 録音時間上限到達時に発火
voiceManager.on('timeout', (leaveResult) => {
  void backgroundConvert(leaveResult, 'timeout');
});

client.on(Events.Error, (err) => {
  console.error('Discord client error:', err);
});

let isShuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n⏹️ ${signal} 受信、シャットダウンします`);

  // 録音中ならファイルをフラッシュして可能なら MP3 まで生成する
  if (voiceManager.isActive()) {
    console.log('[shutdown] 録音中のためファイルをフラッシュ中...');
    const leaveResult = voiceManager.leave();
    // ファイルストリームの flush 待ち（OS のバッファ反映時間）
    await new Promise((r) => setTimeout(r, 500));

    if (leaveResult.files.length > 0 && leaveResult.sessionDir) {
      console.log('[shutdown] MP3 変換中...');
      try {
        const result = await processSession(leaveResult.sessionDir, leaveResult.files);
        if (result.mixedMp3) {
          console.log(`[shutdown] MP3 生成完了: ${relative(process.cwd(), result.mixedMp3)}`);
        }
      } catch (err) {
        console.error('[shutdown] MP3 変換失敗:', err);
      }
    }
  }

  try {
    await client.destroy();
  } catch (err) {
    console.error('[shutdown] client.destroy() error:', err);
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
