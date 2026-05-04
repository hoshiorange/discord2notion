/**
 * 録音セッションの音声処理を担当する。
 *
 * AIP-22:
 *   1. `.opusraw` (length-prefixed Opus packets) を読み取り、prism-media の opus.Decoder で PCM に展開
 *   2. 各ユーザーの PCM 一時ファイルを生成
 *   3. FFmpeg の `amix` フィルタで複数ユーザーをミックスし、MP3 出力
 *   4. PCM 一時ファイルを削除
 *
 * 既知の制約:
 *   - 各 .opusraw には絶対時刻（録音開始からの経過時間）が記録されていないため、
 *     ミックス時にユーザー間の発話タイミングが揃わない（全員 t=0 から並列再生）。
 *   - 個々のユーザー音声は時系列が連続しているので、Phase 5 の文字起こし用途には支障なし。
 *   - 会議として聞き直す用途で違和感が出る場合は、Phase 6 でタイムスタンプ付き形式に拡張。
 */

import { spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import { open as fsOpen } from 'node:fs/promises';
import { basename, join as joinPath } from 'node:path';
import { opus } from 'prism-media';
import { getLogger } from './logger.js';

const log = getLogger('audio');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SIZE = 960; // 20ms @ 48kHz

const MAX_OPUS_PACKET_SIZE = 4000; // 安全マージン込み

export interface ProcessSessionResult {
  mixedMp3: string | null;
  durationSec: number;
  inputCount: number;
}

/**
 * `.opusraw` ファイルからパケットを読み取り、Opus Decoder にフィードして PCM ファイルに書き出す。
 */
async function decodeOpusrawToPcmFile(opusrawPath: string, pcmPath: string): Promise<void> {
  const decoder = new opus.Decoder({
    frameSize: FRAME_SIZE,
    channels: CHANNELS,
    rate: SAMPLE_RATE,
  });
  const pcmStream = createWriteStream(pcmPath);

  const writeDone = new Promise<void>((resolve, reject) => {
    pcmStream.on('finish', resolve);
    pcmStream.on('error', reject);
    decoder.on('error', reject);
  });

  decoder.pipe(pcmStream);

  const fh = await fsOpen(opusrawPath, 'r');
  try {
    const lenBuf = Buffer.alloc(4);
    while (true) {
      const r1 = await fh.read({ buffer: lenBuf, position: null });
      if (r1.bytesRead === 0) break;
      if (r1.bytesRead !== 4) {
        throw new Error(`truncated length prefix in ${opusrawPath}`);
      }

      const len = lenBuf.readUInt32LE(0);
      if (len === 0 || len > MAX_OPUS_PACKET_SIZE) {
        throw new Error(`invalid packet length ${len} in ${opusrawPath}`);
      }

      const packet = Buffer.alloc(len);
      const r2 = await fh.read({ buffer: packet, position: null });
      if (r2.bytesRead !== len) {
        throw new Error(`truncated packet (expected ${len}, got ${r2.bytesRead}) in ${opusrawPath}`);
      }

      decoder.write(packet);
    }
  } finally {
    await fh.close();
  }

  decoder.end();
  await writeDone;
}

/** 複数の PCM (s16le) を amix でミックスし MP3 出力。1入力なら直接エンコード。 */
async function mixPcmToMp3(pcmPaths: string[], outputMp3: string): Promise<void> {
  if (pcmPaths.length === 0) {
    throw new Error('no PCM inputs to mix');
  }

  const args: string[] = [];
  for (const pcm of pcmPaths) {
    args.push('-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-i', pcm);
  }
  if (pcmPaths.length > 1) {
    args.push(
      '-filter_complex',
      `amix=inputs=${pcmPaths.length}:duration=longest:normalize=0`,
    );
  }
  args.push('-c:a', 'libmp3lame', '-q:a', '2', '-y', outputMp3);

  log.info(`ffmpeg ${args.join(' ')}`);

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.on('exit', (code) => resolve(code ?? -1));
    proc.on('error', reject);
  });

  if (exitCode !== 0) {
    const tail = stderr.slice(-1000);
    throw new Error(`ffmpeg exited with code ${exitCode}\n${tail}`);
  }
}

/**
 * セッションの全 .opusraw を変換しミックスして mixed.mp3 を生成する。中間 .pcm は削除。
 */
export async function processSession(
  sessionDir: string,
  opusrawFiles: { userId: string; filename: string }[],
): Promise<ProcessSessionResult> {
  const start = Date.now();

  if (opusrawFiles.length === 0) {
    return { mixedMp3: null, durationSec: 0, inputCount: 0 };
  }

  const pcmPaths: string[] = [];
  for (const f of opusrawFiles) {
    const pcm = joinPath(sessionDir, `${f.userId}.pcm`);
    log.info(`decoding ${basename(f.filename)} → ${basename(pcm)}`);
    try {
      await decodeOpusrawToPcmFile(f.filename, pcm);
      pcmPaths.push(pcm);
    } catch (err) {
      log.error({ err, file: f.filename }, 'decode failed');
      // このユーザーはスキップして他は処理
    }
  }

  if (pcmPaths.length === 0) {
    return { mixedMp3: null, durationSec: (Date.now() - start) / 1000, inputCount: 0 };
  }

  const mixedMp3 = joinPath(sessionDir, 'mixed.mp3');
  log.info(`mixing ${pcmPaths.length} PCM(s) → ${basename(mixedMp3)}`);
  await mixPcmToMp3(pcmPaths, mixedMp3);

  // 中間 PCM 削除
  for (const pcm of pcmPaths) {
    try {
      await fs.unlink(pcm);
    } catch (err) {
      log.warn({ err, pcm }, 'failed to delete pcm');
    }
  }

  return {
    mixedMp3,
    durationSec: (Date.now() - start) / 1000,
    inputCount: pcmPaths.length,
  };
}
