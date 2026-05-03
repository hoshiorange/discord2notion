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

class VoiceManager {
  private connection: VoiceConnection | null = null;
  private startedAt: Date | null = null;
  private guildId: string | null = null;
  private channelId: string | null = null;
  private channelName: string | null = null;
  private sessionId: string | null = null;
  private sessionDir: string | null = null;
  private userStats = new Map<string, UserStats>();
  private subscribedUsers = new Set<string>();
  private userFiles = new Map<string, UserFile>();

  isActive(): boolean {
    return this.connection !== null;
  }

  async join(
    channel: VoiceBasedChannel,
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
    this.sessionId = sessionId;
    this.sessionDir = sessionDir;
    this.startedAt = new Date();
    this.userStats.clear();
    this.subscribedUsers.clear();
    this.userFiles.clear();

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      console.log('[voice] disconnected');
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

  leave(): {
    stats: Map<string, UserStats>;
    durationMs: number;
    channelName: string | null;
    sessionId: string | null;
    sessionDir: string | null;
    files: { userId: string; filename: string }[];
  } {
    const durationMs = this.startedAt ? Date.now() - this.startedAt.getTime() : 0;
    const stats = new Map(this.userStats);
    const channelName = this.channelName;
    const sessionId = this.sessionId;
    const sessionDir = this.sessionDir;

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

    return { stats, durationMs, channelName, sessionId, sessionDir, files };
  }

  private cleanup(): void {
    if (this.connection) {
      this.connection.destroy();
    }
    this.connection = null;
    this.startedAt = null;
    this.guildId = null;
    this.channelId = null;
    this.channelName = null;
    this.sessionId = null;
    this.sessionDir = null;
    this.userStats.clear();
    this.subscribedUsers.clear();
  }
}

export const voiceManager = new VoiceManager();
