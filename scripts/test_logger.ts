/**
 * AIP-34: src/logger.ts の動作確認スクリプト。
 *
 * 実行例:
 *   npx tsx scripts/test_logger.ts
 *   LOG_LEVEL=debug npx tsx scripts/test_logger.ts
 *   NODE_ENV=production npx tsx scripts/test_logger.ts   # 本番モード（pretty 無効）
 *   LOG_RETAIN_DAYS=0 npx tsx scripts/test_logger.ts     # クリーンアップ動作確認
 *
 * 確認内容:
 *   1. 各レベル (trace/debug/info/warn/error) のログが出る
 *   2. 子ロガー（タグ付き）が出る
 *   3. エラーオブジェクトが err として記録される
 *   4. redact が効く（token / apiKey 等が [REDACTED] になる）
 *   5. logs/<YYYY-MM-DD>.log が生成される
 *   6. cleanupOldLogs() が動く
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { cleanupOldLogs, createLogger, getLogger } from '../src/logger.js';

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const root = createLogger();

  console.log('=== root logger ===');
  root.info('hello from root logger');
  root.warn('warn level message');
  root.error('error level message');

  console.log('=== tagged child loggers ===');
  const voiceLog = getLogger('voice');
  const audioLog = getLogger('audio');
  voiceLog.info('Ready: guild=12345 channel=67890');
  audioLog.info('mixing 3 PCM(s) → mixed.mp3');

  console.log('=== error with err object ===');
  try {
    throw new Error('boom');
  } catch (err) {
    voiceLog.error({ err }, 'caught test error');
  }

  console.log('=== redaction ===');
  root.info(
    {
      user: 'alice',
      token: 'super-secret-token-should-be-redacted',
      apiKey: 'should-also-be-redacted',
      nested: { refreshToken: 'redact-me-too' },
    },
    'logging secrets (should be REDACTED)',
  );

  console.log('=== debug below level (should NOT appear at info) ===');
  root.debug('debug message — only visible if LOG_LEVEL=debug');

  // pino の transport は worker スレッドで動くので、ファイル flush を待つ
  await sleep(2000);

  console.log('=== verify log file output ===');
  const logDir = resolvePath(process.cwd(), process.env.LOG_DIR ?? 'logs');
  if (!existsSync(logDir)) {
    console.error(`[test_logger] log dir does not exist: ${logDir}`);
    process.exit(1);
  }
  const entries = readdirSync(logDir).filter((e) => e.endsWith('.log'));
  console.log(`[test_logger] log dir: ${logDir}`);
  console.log(`[test_logger] *.log files: ${entries.length}`);
  for (const e of entries) {
    const s = statSync(resolvePath(logDir, e));
    console.log(`  - ${e}  ${s.size} bytes  mtime=${s.mtime.toISOString()}`);
  }

  console.log('=== cleanupOldLogs ===');
  const result = await cleanupOldLogs();
  console.log(`削除: ${result.deleted.length} 件`);
  for (const f of result.deleted) console.log(`  [DELETE] ${f}`);
  console.log(`保護: ${result.kept.length} 件`);
  for (const f of result.kept) console.log(`  [KEEP ] ${f}`);

  // worker スレッドの transport を終わらせる
  await sleep(200);
  process.exit(0);
}

main().catch((err) => {
  console.error('[test_logger] 失敗:', err);
  process.exit(1);
});
