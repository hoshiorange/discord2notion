/**
 * Voice チャンネル接続と Opus フレーム受信を管理する。
 *
 * AIP-21: 受信した Opus パケットをユーザー別ファイルに保存。
 *
 * ファイル形式: 独自の length-prefixed packet stream
 *   - 各パケットの先頭 4バイト (Little Endian) にパケットサイズ
 *   - 続く N バイトが生の Opus パケット
 *   - 連続する発話セッションは同じファイルに追記される
 *
 * これにより: ネイティブビルド不要、シンプル、AIP-22 でデコード可能。
 * 拡張子は `.opusraw` （標準の `.opus` / `.ogg` ではないため区別）。
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { join as joinPath, resolve as resolvePath } from 'node:path';
import {
  EndBehaviorType,
  joinVoiceChannel,
  type VoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';

export interface UserStats {
  frameCount: number;
  byteCount: number;
  speakingSessions: number;
}

interface UserFile {
  fileStream: WriteStream;
  filename: string;
}

export interface VoiceSnapshot {
  isActive: boolean;
  channelId: string | null;
  guildId: string | null;
  sessionId: string | null;
  sessionDir: string | null;
  durationMs: number | null;
  perUserStats: Map<string, UserStats>;
}

const RECORDINGS_BASE = resolvePath(process.cwd(), 'recordings');

function getRecordingMaxMinutes(): number {
  const raw = process.env.RECORDING_MAX_MINUTES;
  if (!raw) return 480; // default 8h
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) && v > 0 ? v : 480;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function generateSessionId(): string {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const random = Math.random().toString(36).slice(2, 8);
  return `${dateStr}_${timeStr}_${random}`;
}

export interface VoiceLeaveResult {
  stats: Map<string, UserStats>;
  durationMs: number;
  startedAt: Date | null;
  channelName: string | null;
  sessionId: string | null;
  sessionDir: string | null;
  textChannelId: string | null;
  files: { userId: string; filename: string }[];
}

interface VoiceManagerEvents {
  timeout: [VoiceLeaveResult];
  reconnect_failed: [VoiceLeaveResult];
}

// Phase 1: discord.js v14 の自動再接続を待つ時間
const AUTO_RECOVERY_TRANSITION_TIMEOUT_MS = 5_000;
const AUTO_RECOVERY_READY_TIMEOUT_MS = 30_000;
// Phase 2: 手動 rejoin 後に Ready を待つ時間
const MANUAL_RECONNECT_READY_TIMEOUT_MS = 20_000;

function getReconnectMaxAttempts(): number {
  const raw = process.env.VOICE_RECONNECT_MAX_ATTEMPTS;
  if (!raw) return 3;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v >= 0 ? v : 3;
}

function getReconnectBackoffMs(): number {
  const raw = process.env.VOICE_RECONNECT_BACKOFF_MS;
  if (!raw) return 2000;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : 2000;
}

class VoiceManager extends EventEmitter<VoiceManagerEvents> {
  private connection: VoiceConnection | null = null;
  private startedAt: Date | null = null;
  private guildId: string | null = null;
  private channelId: string | null = null;
  private channelName: string | null = null;
  private textChannelId: string | null = null;
  private sessionId: string | null = null;
  private sessionDir: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private userStats = new Map<string, UserStats>();
  private subscribedUsers = new Set<string>();
  private userFiles = new Map<string, UserFile>();
  private reconnectAttempts = 0;
  private isHandlingDisconnect = false;

  isActive(): boolean {
    return this.connection !== null;
  }

  async join(
    channel: VoiceBasedChannel,
    textChannelId: string | null = null,
  ): Promise<
    | { success: true; channelName: string; sessionId: string; sessionDir: string }
    | { success: false; error: string }
  > {
    if (this.connection) {
      return { success: false, error: '既に VC に接続中です' };
    }

    const sessionId = generateSessionId();
    const sessionDir = joinPath(RECORDINGS_BASE, sessionId);
    try {
      mkdirSync(sessionDir, { recursive: true });
    } catch (err) {
      console.error('[voice] sessionDir 作成失敗:', err);
      return { success: false, error: '録音ディレクトリ作成失敗' };
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    this.connection = connection;
    this.guildId = channel.guild.id;
    this.channelId = channel.id;
    this.channelName = channel.name;
    this.textChannelId = textChannelId;
    this.sessionId = sessionId;
    this.sessionDir = sessionDir;
    this.startedAt = new Date();
    this.userStats.clear();
    this.subscribedUsers.clear();
    this.userFiles.clear();

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void this.handleDisconnect(connection);
    });
    connection.on('error', (err) => {
      console.error('[voice] connection error:', err);
    });
    connection.receiver.speaking.on('start', (userId) => {
      this.handleUserStartSpeaking(userId);
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      console.log(
        `[voice] Ready: guild=${channel.guild.id} channel=${channel.id} (${channel.name}) session=${sessionId}`,
      );
    } catch (err) {
      console.error('[voice] Ready 待機タイムアウト:', err);
      this.cleanup();
      return { success: false, error: 'VC 接続が30秒以内に Ready にならなかったので中断しました' };
    }

    // 録音時間上限タイマー
    const maxMinutes = getRecordingMaxMinutes();
    console.log(`[voice] 録音時間上限: ${maxMinutes} 分`);
    this.timer = setTimeout(
      () => {
        console.log(`[voice] 録音時間上限 ${maxMinutes} 分に到達、自動停止します`);
        const leaveResult = this.leave();
        this.emit('timeout', leaveResult);
      },
      maxMinutes * 60 * 1000,
    );

    return { success: true, channelName: channel.name, sessionId, sessionDir };
  }

  /** ユーザーの書き込み用 WriteStream を取得（無ければ作成）。発話セッション間で共有して追記する。 */
  private getOrCreateUserFile(userId: string): UserFile {
    let entry = this.userFiles.get(userId);
    if (entry) return entry;
    if (!this.sessionDir) {
      throw new Error('sessionDir が未初期化');
    }

    const filename = joinPath(this.sessionDir, `${userId}.opusraw`);
    const fileStream = createWriteStream(filename);
    fileStream.on('error', (err) => {
      console.error(`[voice] fileStream error for ${userId}:`, err);
    });

    entry = { fileStream, filename };
    this.userFiles.set(userId, entry);
    console.log(`[voice] user file opened: ${filename}`);
    return entry;
  }

  /**
   * Voice 切断時の再接続戦略（AIP-32）。
   * Phase 1: discord.js v14 標準の自動再接続を待つ
   * Phase 2: 失敗したら手動 rejoin() を線形バックオフで N 回試行
   * Phase 3: それでもダメなら leave + reconnect_failed イベント発火
   */
  private async handleDisconnect(connection: VoiceConnection): Promise<void> {
    if (this.isHandlingDisconnect) return; // 重複発火を防ぐ
    this.isHandlingDisconnect = true;
    console.log('[voice] disconnected, checking auto-recovery...');
    try {
      if (await this.attemptAutoRecovery(connection)) {
        this.reconnectAttempts = 0;
        return;
      }
      if (await this.attemptManualReconnect(connection)) {
        this.reconnectAttempts = 0;
        return;
      }
      console.error(
        `[voice] reconnect attempts exhausted after ${getReconnectMaxAttempts()} tries, giving up`,
      );
      const leaveResult = this.leave();
      this.emit('reconnect_failed', leaveResult);
    } finally {
      this.isHandlingDisconnect = false;
    }
  }

  /** Phase 1: discord.js v14 標準の自動再接続を待つ。成功なら true。 */
  private async attemptAutoRecovery(connection: VoiceConnection): Promise<boolean> {
    try {
      await Promise.race([
        entersState(
          connection,
          VoiceConnectionStatus.Signalling,
          AUTO_RECOVERY_TRANSITION_TIMEOUT_MS,
        ),
        entersState(
          connection,
          VoiceConnectionStatus.Connecting,
          AUTO_RECOVERY_TRANSITION_TIMEOUT_MS,
        ),
      ]);
      console.log('[voice] auto-recovering (signalling/connecting)...');
      await entersState(connection, VoiceConnectionStatus.Ready, AUTO_RECOVERY_READY_TIMEOUT_MS);
      console.log('[voice] auto-recovery succeeded');
      return true;
    } catch {
      console.log('[voice] auto-recovery failed, attempting manual reconnect');
      return false;
    }
  }

  /** Phase 2: 手動 rejoin を最大 maxAttempts 回、線形バックオフで試行。成功なら true。 */
  private async attemptManualReconnect(connection: VoiceConnection): Promise<boolean> {
    const maxAttempts = getReconnectMaxAttempts();
    const backoffMs = getReconnectBackoffMs();
    while (this.reconnectAttempts < maxAttempts) {
      this.reconnectAttempts++;
      const delay = backoffMs * this.reconnectAttempts;
      console.log(
        `[voice] manual reconnect attempt #${this.reconnectAttempts}/${maxAttempts} (wait ${delay}ms)`,
      );
      await new Promise((r) => setTimeout(r, delay));
      try {
        connection.rejoin();
        await entersState(
          connection,
          VoiceConnectionStatus.Ready,
          MANUAL_RECONNECT_READY_TIMEOUT_MS,
        );
        console.log(`[voice] manual reconnect #${this.reconnectAttempts} succeeded`);
        return true;
      } catch (err) {
        console.error(`[voice] manual reconnect #${this.reconnectAttempts} failed:`, err);
      }
    }
    return false;
  }

  private handleUserStartSpeaking(userId: string): void {
    if (!this.connection) return;

    let stats = this.userStats.get(userId);
    if (!stats) {
      stats = { frameCount: 0, byteCount: 0, speakingSessions: 0 };
      this.userStats.set(userId, stats);
    }
    stats.speakingSessions++;

    if (this.subscribedUsers.has(userId)) {
      return;
    }
    this.subscribedUsers.add(userId);

    console.log(`[voice] start speaking: user=${userId} session=#${stats.speakingSessions}`);

    let userFile: UserFile;
    try {
      userFile = this.getOrCreateUserFile(userId);
    } catch (err) {
      console.error('[voice] failed to create user file:', err);
      this.subscribedUsers.delete(userId);
      return;
    }

    const opusStream = this.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1000,
      },
    });

    opusStream.on('data', (chunk: Buffer) => {
      stats.frameCount++;
      stats.byteCount += chunk.length;
      // length-prefix framing: <4 bytes LE length><opus packet>
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32LE(chunk.length, 0);
      userFile.fileStream.write(lenBuf);
      userFile.fileStream.write(chunk);
    });

    opusStream.on('end', () => {
      this.subscribedUsers.delete(userId);
      console.log(
        `[voice] stop speaking : user=${userId} cumulative=${stats.frameCount} frames / ${stats.byteCount} bytes`,
      );
      // 注意: fileStream は閉じない（次の発話セッションで使い続ける）
    });

    opusStream.on('error', (err) => {
      this.subscribedUsers.delete(userId);
      console.error(`[voice] audio stream error for ${userId}:`, err);
    });
  }

  snapshot(): VoiceSnapshot {
    return {
      isActive: this.isActive(),
      channelId: this.channelId,
      guildId: this.guildId,
      sessionId: this.sessionId,
      sessionDir: this.sessionDir,
      durationMs: this.startedAt ? Date.now() - this.startedAt.getTime() : null,
      perUserStats: new Map(this.userStats),
    };
  }

  channelLabel(): string | null {
    return this.channelName;
  }

  leave(): VoiceLeaveResult {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const durationMs = this.startedAt ? Date.now() - this.startedAt.getTime() : 0;
    const startedAt = this.startedAt ? new Date(this.startedAt.getTime()) : null;
    const stats = new Map(this.userStats);
    const channelName = this.channelName;
    const sessionId = this.sessionId;
    const sessionDir = this.sessionDir;
    const textChannelId = this.textChannelId;

    const files: { userId: string; filename: string }[] = [];
    for (const [userId, entry] of this.userFiles) {
      try {
        entry.fileStream.end();
      } catch (err) {
        console.error(`[voice] fileStream.end failed for ${userId}:`, err);
      }
      files.push({ userId, filename: entry.filename });
      console.log(`[voice] user file closing: ${entry.filename}`);
    }
    this.userFiles.clear();

    this.cleanup();

    return { stats, durationMs, startedAt, channelName, sessionId, sessionDir, textChannelId, files };
  }

  private cleanup(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.connection) {
      this.connection.destroy();
    }
    this.connection = null;
    this.startedAt = null;
    this.guildId = null;
    this.channelId = null;
    this.channelName = null;
    this.textChannelId = null;
    this.sessionId = null;
    this.sessionDir = null;
    this.userStats.clear();
    this.subscribedUsers.clear();
    this.reconnectAttempts = 0;
    this.isHandlingDisconnect = false;
  }
}

export const voiceManager = new VoiceManager();
