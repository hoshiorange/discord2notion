/**
 * AIP-25 単体動作確認: src/transcribe.ts の TypeScript ラッパー検証。
 * 既存の mixed.mp3 を使って transcribeAndSave を呼び、結果を表示する。
 */
import { transcribeAndSave } from '../src/transcribe.js';

const audioPath = 'recordings/2026-05-03_211934_ovek5e/mixed.mp3';

async function main(): Promise<void> {
  console.log(`audio: ${audioPath}`);
  const start = Date.now();
  const { result, transcriptPath } = await transcribeAndSave(audioPath);
  const elapsed = (Date.now() - start) / 1000;

  console.log();
  console.log('=== Result ===');
  console.log(`transcript saved: ${transcriptPath}`);
  console.log(`segments       : ${result.segments.length}`);
  console.log(`duration       : ${result.duration_sec.toFixed(2)}s`);
  console.log(`elapsed (script): ${result.elapsed_sec.toFixed(2)}s`);
  console.log(`elapsed (wall) : ${elapsed.toFixed(2)}s`);
  console.log(`rt factor      : ${result.realtime_factor.toFixed(2)}x`);
  console.log();
  console.log('=== First 3 segments ===');
  for (const seg of result.segments.slice(0, 3)) {
    console.log(`  [${seg.start.toFixed(2)}-${seg.end.toFixed(2)}] ${seg.text}`);
  }
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
