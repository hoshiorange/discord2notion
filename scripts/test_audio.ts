/**
 * AIP-22 単体動作確認スクリプト。
 * 既存の .opusraw を読んでミックス済み MP3 を生成する。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { processSession } from '../src/audio.js';

const SESSION_DIR = 'recordings/2026-05-03_211934_ovek5e';

async function main(): Promise<void> {
  const entries = await fs.readdir(SESSION_DIR);
  const opusrawFiles = entries
    .filter((e) => e.endsWith('.opusraw'))
    .map((e) => ({ userId: e.replace(/\.opusraw$/, ''), filename: join(SESSION_DIR, e) }));

  console.log(`session dir: ${SESSION_DIR}`);
  console.log(`opusraw files: ${opusrawFiles.length}`);
  for (const f of opusrawFiles) {
    const stat = await fs.stat(f.filename);
    console.log(`  - ${f.userId}: ${stat.size} bytes`);
  }
  console.log();

  const result = await processSession(SESSION_DIR, opusrawFiles);
  console.log();
  console.log('result:', result);

  if (result.mixedMp3) {
    const stat = await fs.stat(result.mixedMp3);
    console.log(`mixed.mp3 size: ${stat.size} bytes`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
