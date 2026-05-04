/**
 * AIP-33: cleanupOldSessions の dry-run 動作確認スクリプト。
 *
 * 実行例:
 *   npx tsx scripts/test_cleanup.ts
 *   RECORDINGS_RETAIN_DAYS=0 npx tsx scripts/test_cleanup.ts   # 全完了セッションが対象になる
 *   RECORDINGS_RETAIN_DAYS=365 npx tsx scripts/test_cleanup.ts # 1年保持なら通常は何も削除されない
 *
 * 削除は行わず、削除候補と保護対象（理由付き）を出力する。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { cleanupOldSessions } from '../src/cleanup.js';

async function main(): Promise<void> {
  const recordingsDir = resolvePath(process.cwd(), 'recordings');
  console.log(`[test_cleanup] recordingsDir: ${recordingsDir}`);

  const retainEnv = process.env.RECORDINGS_RETAIN_DAYS;
  console.log(
    `[test_cleanup] RECORDINGS_RETAIN_DAYS=${retainEnv ?? '(unset → default 30)'}`,
  );

  if (!existsSync(recordingsDir)) {
    console.log('[test_cleanup] recordings/ が存在しません。終了します。');
    return;
  }

  const entries = readdirSync(recordingsDir).filter((e) => {
    try {
      return statSync(resolvePath(recordingsDir, e)).isDirectory();
    } catch {
      return false;
    }
  });
  console.log(`[test_cleanup] サブディレクトリ ${entries.length} 件を走査します`);

  const result = await cleanupOldSessions({ dryRun: true });

  console.log('--- dry-run 結果 ---');
  console.log(`削除候補: ${result.deleted.length} 件`);
  for (const id of result.deleted) {
    console.log(`  [DELETE] ${id}`);
  }

  console.log(`保護対象: ${result.kept.length} 件`);
  for (const k of result.kept) {
    console.log(`  [KEEP ] ${k.sessionId}  (${k.reason})`);
  }

  console.log('--- 凡例 ---');
  console.log('  incomplete: pipeline-state.json なし / failedStage あり / 全ステージ未完了');
  console.log('  recent    : 全完了済みだが mtime が retainDays より新しい');
}

main().catch((err) => {
  console.error('[test_cleanup] 失敗:', err);
  process.exit(1);
});
