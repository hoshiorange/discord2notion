/**
 * AIP-38: マルチ Guild 設定（B 案: JSON 形式）の単体検証スクリプト。
 *
 * 実 API（Notion / Google Drive）は一切叩かない。loadGuildConfig() が
 * 想定通り Guild ID から `config/guilds/<guildId>.json` を解決して値を返すかだけを確認する。
 *
 * 実行: `npx tsx scripts/test_multiguild_config.ts`
 *
 * 検証ケース:
 *   1. config/guilds/ 未配置 + guildId=null                       → process.env が使われる（後方互換）
 *   2. config/guilds/ 未配置 + guildId="111..."                   → process.env が使われる（後方互換）
 *   3. config/guilds/ あり + 未登録 Guild                          → process.env が使われる
 *   4. config/guilds/<guildId>.json 存在 + 全キー指定               → Guild 側で全上書き、name 反映
 *   5. config/guilds/<guildId>.json 不正 JSON                      → エラーログ → process.env フォールバック
 *   6. config/guilds/<guildId>.json で一部キーのみ指定              → 部分マージ（残りは共通 env）
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, resolve as resolvePath } from 'node:path';

// 重要: src/config.ts は実 API を叩かないため import しても副作用なし。
import { loadGuildConfig, setGuildsDirForTesting } from '../src/config.js';

interface CaseReport {
  name: string;
  pass: boolean;
  detail: string;
}

const reports: CaseReport[] = [];

function check(name: string, condition: boolean, detail: string): void {
  reports.push({ name, pass: condition, detail });
  const tag = condition ? '  PASS' : '  FAIL';
  // eslint-disable-next-line no-console
  console.log(`${tag} ${name} :: ${detail}`);
}

/** process.env の前提値を一旦退避し、検証用の値で上書き → 検証完了後に復元する。 */
function withProcessEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T,
): T {
  const keys = Object.keys(overrides);
  const previous: Record<string, string | undefined> = {};
  for (const k of keys) previous[k] = process.env[k];
  for (const k of keys) {
    const v = overrides[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      const prev = previous[k];
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

const COMMON_ENV: Record<string, string> = {
  NOTION_API_KEY: 'common-notion-key',
  NOTION_DATABASE_ID: 'common-notion-db',
  GOOGLE_DRIVE_CREDENTIALS: 'common-creds.json',
  GOOGLE_DRIVE_REFRESH_TOKEN: 'common-refresh',
};

function writeGuildJson(dir: string, guildId: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(joinPath(dir, `${guildId}.json`), body, 'utf-8');
}

function main(): void {
  const workDir = mkdtempSync(joinPath(tmpdir(), 'multiguild-test-'));
  // eslint-disable-next-line no-console
  console.log(`work dir: ${workDir}\n`);

  const guildsDir = joinPath(workDir, 'config', 'guilds');

  try {
    // ====== Case 1: guilds dir 未配置 + guildId=null ======
    setGuildsDirForTesting(guildsDir); // ディレクトリすら無い
    withProcessEnv(COMMON_ENV, () => {
      const cfg = loadGuildConfig(null);
      check(
        'case 1: config/guilds/ 未配置 + guildId=null → process.env',
        cfg.notionApiKey === 'common-notion-key' &&
          cfg.notionDatabaseId === 'common-notion-db' &&
          cfg.googleDriveCredentials === 'common-creds.json' &&
          cfg.googleDriveRefreshToken === 'common-refresh' &&
          cfg.guildId === null &&
          cfg.guildName === undefined,
        `notionApiKey=${cfg.notionApiKey} guildId=${cfg.guildId}`,
      );
    });

    // ====== Case 2: guilds dir 未配置 + guildId 指定 ======
    setGuildsDirForTesting(guildsDir);
    withProcessEnv(COMMON_ENV, () => {
      const cfg = loadGuildConfig('111');
      check(
        'case 2: config/guilds/ 未配置 + guildId=111 → process.env',
        cfg.notionApiKey === 'common-notion-key' && cfg.guildId === '111',
        `notionApiKey=${cfg.notionApiKey} guildId=${cfg.guildId}`,
      );
    });

    // ====== Case 3: guilds dir あり + 未登録 Guild ======
    // 別 Guild の JSON を作っておく（対象 Guild は未配置）
    writeGuildJson(
      guildsDir,
      'AAA',
      JSON.stringify({ name: '仕事', notionApiKey: 'guildA-notion-key' }),
    );
    setGuildsDirForTesting(guildsDir);
    withProcessEnv(COMMON_ENV, () => {
      const cfg = loadGuildConfig('UNKNOWN_GUILD');
      check(
        'case 3: 未登録 Guild → process.env',
        cfg.notionApiKey === 'common-notion-key' && cfg.guildName === undefined,
        `notionApiKey=${cfg.notionApiKey} guildName=${cfg.guildName}`,
      );
    });

    // ====== Case 4: <guildId>.json 存在 + 全キー指定 → Guild 側全上書き ======
    writeGuildJson(
      guildsDir,
      'AAA',
      JSON.stringify({
        name: '仕事',
        notionApiKey: 'guildA-notion-key',
        notionDatabaseId: 'guildA-notion-db',
        googleDriveCredentials: 'guildA-creds.json',
        googleDriveRefreshToken: 'guildA-refresh',
      }),
    );
    setGuildsDirForTesting(guildsDir); // キャッシュリセット
    withProcessEnv(COMMON_ENV, () => {
      const cfg = loadGuildConfig('AAA');
      check(
        'case 4: 全キー指定 JSON → Guild 側で全上書き、name 反映',
        cfg.notionApiKey === 'guildA-notion-key' &&
          cfg.notionDatabaseId === 'guildA-notion-db' &&
          cfg.googleDriveCredentials === 'guildA-creds.json' &&
          cfg.googleDriveRefreshToken === 'guildA-refresh' &&
          cfg.guildId === 'AAA' &&
          cfg.guildName === '仕事',
        `notion=${cfg.notionApiKey}/${cfg.notionDatabaseId} drive=${cfg.googleDriveCredentials}/${cfg.googleDriveRefreshToken} name=${cfg.guildName}`,
      );
    });

    // ====== Case 5: 不正 JSON → エラーログ + process.env フォールバック ======
    writeGuildJson(guildsDir, 'BROKEN', '{ "name": "壊れ", '); // 末尾不正
    setGuildsDirForTesting(guildsDir);
    withProcessEnv(COMMON_ENV, () => {
      const cfg = loadGuildConfig('BROKEN');
      check(
        'case 5: 不正 JSON → process.env フォールバック',
        cfg.notionApiKey === 'common-notion-key' &&
          cfg.guildId === 'BROKEN' &&
          cfg.guildName === undefined,
        `notionApiKey=${cfg.notionApiKey} guildName=${cfg.guildName}`,
      );
    });

    // ====== Case 6: 一部キーのみ指定 → 部分マージ ======
    writeGuildJson(
      guildsDir,
      'BBB',
      JSON.stringify({
        // name なし、notionApiKey のみ指定
        notionApiKey: 'guildB-notion-key',
      }),
    );
    setGuildsDirForTesting(guildsDir);
    withProcessEnv(COMMON_ENV, () => {
      const cfg = loadGuildConfig('BBB');
      check(
        'case 6: 一部キーのみ指定 → 部分マージ',
        cfg.notionApiKey === 'guildB-notion-key' &&
          cfg.notionDatabaseId === 'common-notion-db' &&
          cfg.googleDriveCredentials === 'common-creds.json' &&
          cfg.googleDriveRefreshToken === 'common-refresh' &&
          cfg.guildName === undefined,
        `notion=${cfg.notionApiKey}/${cfg.notionDatabaseId} guildName=${cfg.guildName}`,
      );
    });

    // ====== summary ======
    const passed = reports.filter((r) => r.pass).length;
    const failed = reports.length - passed;
    // eslint-disable-next-line no-console
    console.log(`\n=== summary: ${passed} passed / ${failed} failed (total ${reports.length}) ===`);
    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    setGuildsDirForTesting(null);
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`cleanup warning: ${(err as Error).message}`);
    }
    if (existsSync(resolvePath(process.cwd(), 'config', 'guilds'))) {
      // eslint-disable-next-line no-console
      console.warn(
        '注意: プロジェクト直下に config/guilds/ が実在します。テストは独立した tmp ディレクトリで動作しますが、実運用では gitignore 済みの点を再確認してください。',
      );
    }
  }
}

main();
