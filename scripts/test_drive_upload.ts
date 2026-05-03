/**
 * AIP-27 単体動作確認: src/drive.ts の uploadSession を検証する。
 * 既存セッションの mixed.mp3 / transcript.json をアップロードして結果を表示する。
 */
import 'dotenv/config';
import { uploadSession } from '../src/drive.js';

const sessionDir = 'recordings/2026-05-03_211934_ovek5e';
const filenames = ['mixed.mp3', 'transcript.json'];

async function main(): Promise<void> {
  console.log(`session: ${sessionDir}`);
  console.log(`files  : ${filenames.join(', ')}`);
  console.log();

  const start = Date.now();
  const result = await uploadSession(sessionDir, filenames);
  const elapsed = (Date.now() - start) / 1000;

  console.log();
  console.log('=== Result ===');
  console.log(`folderUrl: ${result.folderUrl}`);
  console.log('fileUrls :');
  for (const [name, url] of Object.entries(result.fileUrls)) {
    console.log(`  - ${name}: ${url}`);
  }
  console.log();
  console.log(`elapsed: ${elapsed.toFixed(2)}s`);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
