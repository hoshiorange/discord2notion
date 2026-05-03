/**
 * Voice チャンネル接続と Opus フレーム受信を管理する。
 *
 * AIP-20: 動作確認（受信できているかを目視確認するため、フレーム数・バイト数を集計）
 * Phase 3 でファイル書き出しに置き換える予定。
 */

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

export interface VoiceSnapshot {
  isActive: boolean;
  channelId: string | null;
  guildId: string | null;
  durationMs: number | null;
  perUserStats: Map<string, UserStats>;
}

class VoiceManager {
  private connection: VoiceConnection | null = null;
  private startedAt: Date | null = null;
  private guildId: string | null = null;
  private channelId: string | null = null;
  private channelName: string | null = null;
  private userStats = new Map<string, UserStats>();
  private subscribedUsers = new Set<string>();

  isActive(): boolean {
    return this.connection !== null;
  }

  async join(channel: VoiceBasedChannel): Promise<{ success: true; channelName: string } | { success: false; error: string }> {
    if (this.connection) {
      return { success: false, error: '既に VC に接続中です' };
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
    this.startedAt = new Date();
    this.userStats.clear();
    this.subscribedUsers.clear();

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
      console.log(`[voice] Ready: guild=${channel.guild.id} channel=${channel.id} (${channel.name})`);
    } catch (err) {
      console.error('[voice] Ready 待機タイムアウト:', err);
      this.cleanup();
      return { success: false, error: 'VC 接続が30秒以内に Ready にならなかったので中断しました' };
    }

    return { success: true, channelName: channel.name };
  }

  private handleUserStartSpeaking(userId: string): void {
    if (!this.connection) return;

    let stats = this.userStats.get(userId);
    if (!stats) {
      stats = { frameCount: 0, byteCount: 0, speakingSessions: 0 };
      this.userStats.set(userId, stats);
    }
    stats.speakingSessions++;

    // 既に同ユーザーの subscribe がアクティブな場合はスキップ（AfterSilence で end したら再 subscribe）
    if (this.subscribedUsers.has(userId)) {
      return;
    }
    this.subscribedUsers.add(userId);

    console.log(`[voice] start speaking: user=${userId} session=#${stats.speakingSessions}`);

    const audioStream = this.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1000,
      },
    });

    audioStream.on('data', (chunk: Buffer) => {
      stats.frameCount++;
      stats.byteCount += chunk.length;
    });

    audioStream.on('end', () => {
      this.subscribedUsers.delete(userId);
      console.log(
        `[voice] stop speaking : user=${userId} cumulative=${stats.frameCount} frames / ${stats.byteCount} bytes`,
      );
    });

    audioStream.on('error', (err) => {
      this.subscribedUsers.delete(userId);
      console.error(`[voice] audio stream error for ${userId}:`, err);
    });
  }

  snapshot(): VoiceSnapshot {
    return {
      isActive: this.isActive(),
      channelId: this.channelId,
      guildId: this.guildId,
      durationMs: this.startedAt ? Date.now() - this.startedAt.getTime() : null,
      perUserStats: new Map(this.userStats),
    };
  }

  channelLabel(): string | null {
    return this.channelName;
  }

  leave(): { stats: Map<string, UserStats>; durationMs: number; channelName: string | null } {
    const durationMs = this.startedAt ? Date.now() - this.startedAt.getTime() : 0;
    const stats = new Map(this.userStats);
    const channelName = this.channelName;

    this.cleanup();

    return { stats, durationMs, channelName };
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
    this.userStats.clear();
    this.subscribedUsers.clear();
  }
}

export const voiceManager = new VoiceManager();
