/**
 * AIP-38: マルチ Guild 設定の単体検証スクリプト。
 *
 * 実 API（Notion / Google Drive）は一切叩かない。loadGuildConfig() が
 * 想定通り Guild ID から env file を解決して値を返すかだけを確認する。
 *
 * 実行: `npx tsx scripts/test_multiguild_config.ts`
 *
 * 検証ケース:
 *   1. config/guilds.json 未配置 + guildId=null              → process.env が使われる（後方互換）
 *   2. config/guilds.json 未配置 + guildId="123..."          → process.env が使われる（後方互換）
 *   3. config/guilds.json あり、未登録 Guild                  → process.env が使われる
 *   4. config/guilds.json あり、登録 Guild の envFile 存在    → Guild 側の値で上書きされる
 *   5. config/guilds.json あり、登録 Guild の envFile 不在    → process.env が使われる（警告ログのみ）
 *   6. Guild 別 env で一部キーのみ上書き                       → 上書きしたキーだけ Guild 側、それ以外は共通
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, resolve as resolvePath } from 'node:path';

// 重要: src/config.ts は実 API を叩かないため import しても副作用なし。
import { loadGuildConfig, setGuildsJsonPathForTesting } from '../src/config.js';

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

function main(): void {
  const workDir = mkdtempSync(joinPath(tmpdir(), 'multiguild-test-'));
  // eslint-disable-next-line no-console
  console.log(`work dir: ${workDir}\n`);

  const guildsJsonPath = joinPath(workDir, 'config', 'guilds.json');
  const guildAEnvPath = joinPath(workDir, '.env.guild-AAA');
  const guildBEnvPath = joinPath(workDir, '.env.guild-BBB');

  try {
    // ====== Case 1: guilds.json 無し + guildId=null（後方互換） ======
    setGuildsJsonPathForTesting(guildsJsonPath); // まだファイル無い
    withProcessEnv(
      {
        NOTION_API_KEY: 'common-notion-key',
        NOTION_DATABASE_ID: 'common-notion-db',
        GOOGLE_DRIVE_CREDENTIALS: 'common-creds.json',
        GOOGLE_DRIVE_REFRESH_TOKEN: 'common-refresh',
      },
      () => {
        const cfg = loadGuildConfig(null);
        check(
          'case 1: guilds.json 未配置 + guildId=null → process.env が使われる',
          cfg.notionApiKey === 'common-notion-key' &&
            cfg.notionDatabaseId === 'common-notion-db' &&
            cfg.googleDriveCredentials === 'common-creds.json' &&
            cfg.googleDriveRefreshToken === 'common-refresh' &&
            cfg.guildId === null,
          `notionApiKey=${cfg.notionApiKey} guildId=${cfg.guildId}`,
        );
      },
    );

    // ====== Case 2: guilds.json 無し + guildId="111"（後方互換） ======
    setGuildsJsonPathForTesting(guildsJsonPath); // まだファイル無い
    withProcessEnv(
      {
        NOTION_API_KEY: 'common-notion-key',
        NOTION_DATABASE_ID: 'common-notion-db',
        GOOGLE_DRIVE_CREDENTIALS: 'common-creds.json',
        GOOGLE_DRIVE_REFRESH_TOKEN: 'common-refresh',
      },
      () => {
        const cfg = loadGuildConfig('111');
        check(
          'case 2: guilds.json 未配置 + guildId=111 → process.env が使われる',
          cfg.notionApiKey === 'common-notion-key' && cfg.guildId === '111',
          `notionApiKey=${cfg.notionApiKey} guildId=${cfg.guildId}`,
        );
      },
    );

    // ====== Case 3: guilds.json 配置 + 未登録 Guild ======
    mkdirSync(joinPath(workDir, 'config'), { recursive: true });
    writeFileSync(
      guildsJsonPath,
      JSON.stringify({
        default: '.env',
        guilds: {
          AAA: { name: '仕事', envFile: guildAEnvPath },
        },
      }),
      'utf-8',
    );
    setGuildsJsonPathForTesting(guildsJsonPath);
    withProcessEnv(
      {
        NOTION_API_KEY: 'common-notion-key',
        NOTION_DATABASE_ID: 'common-notion-db',
        GOOGLE_DRIVE_CREDENTIALS: 'common-creds.json',
        GOOGLE_DRIVE_REFRESH_TOKEN: 'common-refresh',
      },
      () => {
        const cfg = loadGuildConfig('UNKNOWN_GUILD');
        check(
          'case 3: guilds.json あり + 未登録 Guild → process.env が使われる',
          cfg.notionApiKey === 'common-notion-key' && cfg.guildName === undefined,
          `notionApiKey=${cfg.notionApiKey} guildName=${cfg.guildName}`,
        );
      },
    );

    // ====== Case 4: 登録 Guild + envFile 存在 → Guild 側上書き ======
    writeFileSync(
      guildAEnvPath,
      [
        'NOTION_API_KEY=guildA-notion-key',
        'NOTION_DATABASE_ID=guildA-notion-db',
        'GOOGLE_DRIVE_CREDENTIALS=guildA-creds.json',
        'GOOGLE_DRIVE_REFRESH_TOKEN=guildA-refresh',
      ].join('\n'),
      'utf-8',
    );
    setGuildsJsonPathForTesting(guildsJsonPath);
    withProcessEnv(
      {
        NOTION_API_KEY: 'common-notion-key',
        NOTION_DATABASE_ID: 'common-notion-db',
        GOOGLE_DRIVE_CREDENTIALS: 'common-creds.json',
        GOOGLE_DRIVE_REFRESH_TOKEN: 'common-refresh',
      },
      () => {
        const cfg = loadGuildConfig('AAA');
        check(
          'case 4: 登録 Guild + envFile 存在 → Guild 側で全上書き',
          cfg.notionApiKey === 'guildA-notion-key' &&
            cfg.notionDatabaseId === 'guildA-notion-db' &&
            cfg.googleDriveCredentials === 'guildA-creds.json' &&
            cfg.googleDriveRefreshToken === 'guildA-refresh' &&
            cfg.guildId === 'AAA' &&
            cfg.guildName === '仕事',
          `notionApiKey=${cfg.notionApiKey} guildName=${cfg.guildName}`,
        );
      },
    );

    // ====== Case 5: 登録 Guild + envFile 不在 → 警告のみ、process.env 利用 ======
    writeFileSync(
      guildsJsonPath,
      JSON.stringify({
        guilds: {
          BBB: { envFile: guildBEnvPath }, // ファイルは作らない
        },
      }),
      'utf-8',
    );
    setGuildsJsonPathForTesting(guildsJsonPath);
    withProcessEnv(
      {
        NOTION_API_KEY: 'common-notion-key',
        NOTION_DATABASE_ID: 'common-notion-db',
        GOOGLE_DRIVE_CREDENTIALS: 'common-creds.json',
        GOOGLE_DRIVE_REFRESH_TOKEN: 'common-refresh',
      },
      () => {
        const cfg = loadGuildConfig('BBB');
        check(
          'case 5: 登録 Guild + envFile 不在 → process.env が使われる',
          cfg.notionApiKey === 'common-notion-key' && cfg.guildId === 'BBB',
          `notionApiKey=${cfg.notionApiKey} guildId=${cfg.guildId}`,
        );
      },
    );

    // ====== Case 6: Guild 別 env で一部キーのみ上書き ======
    writeFileSync(
      guildBEnvPath,
      [
        'NOTION_API_KEY=guildB-notion-key',
        // NOTION_DATABASE_ID は書かない → 共通から引き継ぎ
      ].join('\n'),
      'utf-8',
    );
    setGuildsJsonPathForTesting(guildsJsonPath);
    withProcessEnv(
      {
        NOTION_API_KEY: 'common-notion-key',
        NOTION_DATABASE_ID: 'common-notion-db',
        GOOGLE_DRIVE_CREDENTIALS: 'common-creds.json',
        GOOGLE_DRIVE_REFRESH_TOKEN: 'common-refresh',
      },
      () => {
        const cfg = loadGuildConfig('BBB');
        check(
          'case 6: Guild 別 env で一部キーのみ上書き → 部分マージ',
          cfg.notionApiKey === 'guildB-notion-key' &&
            cfg.notionDatabaseId === 'common-notion-db' &&
            cfg.googleDriveCredentials === 'common-creds.json' &&
            cfg.googleDriveRefreshToken === 'common-refresh',
          `notion=${cfg.notionApiKey}/${cfg.notionDatabaseId}`,
        );
      },
    );

    // ====== summary ======
    const passed = reports.filter((r) => r.pass).length;
    const failed = reports.length - passed;
    // eslint-disable-next-line no-console
    console.log(`\n=== summary: ${passed} passed / ${failed} failed (total ${reports.length}) ===`);
    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    setGuildsJsonPathForTesting(null);
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`cleanup warning: ${(err as Error).message}`);
    }
    if (existsSync(resolvePath(process.cwd(), 'config', 'guilds.json'))) {
      // eslint-disable-next-line no-console
      console.warn(
        '注意: プロジェクト直下に config/guilds.json が実在します。テストはそれを書き換えていませんが、実運用では gitignore 済みである点を念押し確認してください。',
      );
    }
  }
}

main();
