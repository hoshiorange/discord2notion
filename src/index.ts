import 'dotenv/config';
import { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes } from 'discord.js';
import { commands, commandsByName } from './commands/index.js';
import { voiceManager } from './voice.js';

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
    voiceManager.leave();
  }
});

client.on(Events.Error, (err) => {
  console.error('Discord client error:', err);
});

process.on('SIGINT', () => {
  console.log('\n⏹️ SIGINT 受信、シャットダウンします');
  void client.destroy().then(() => process.exit(0));
});
process.on('SIGTERM', () => {
  console.log('\n⏹️ SIGTERM 受信、シャットダウンします');
  void client.destroy().then(() => process.exit(0));
});

await client.login(token);
