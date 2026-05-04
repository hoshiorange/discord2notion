/**
 * AIP-38: Guild ごとに Notion / Google Drive の認証情報を切り替える設定ローダー。
 *
 * 配置規約:
 *   config/
 *     └─ guilds/
 *         └─ <guildId>.json    # この Guild 専用の設定（存在 = 登録扱い）
 *
 * 1 ファイル＝ 1 Guild の JSON で、共通 `.env`（process.env 経由）を上書きする。
 *
 * JSON スキーマ（すべて optional。書いたキーだけ Guild 側で上書きされる）:
 *   {
 *     "name": "仕事",                                  // 任意。ログ表示用ラベル
 *     "notionApiKey": "secret_xxx",
 *     "notionDatabaseId": "xxxxxxxxxxxx",
 *     "googleDriveCredentials": "credentials.guild-xxx.json",
 *     "googleDriveRefreshToken": "1//xxx"
 *   }
 *
 * 動作:
 *   - `config/guilds/<guildId>.json` が存在 → process.env と JSON を merge（Guild 側優先）
 *   - 存在しない / `guildId === null` → process.env をそのまま使う（後方互換）
 *
 * 設計上の注意:
 *   - 複数 Guild が並行動作するため `process.env` 自体は書き換えない
 *   - 同一ファイルの再読込を避けるため簡易キャッシュを持つ
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { getLogger } from './logger.js';

const log = getLogger('config');

export interface GuildConfig {
  /** 解決元の Guild ID。`config/guilds/<guildId>.json` 未配置や guildId=null の場合も呼び出し時の値を保持。 */
  guildId: string | null;
  /** ログ・運用時の人間ラベル（任意）。JSON の `name` フィールド由来。 */
  guildName?: string;
  notionApiKey: string | undefined;
  notionDatabaseId: string | undefined;
  googleDriveCredentials: string | undefined;
  googleDriveRefreshToken: string | undefined;
}

interface GuildJsonFile {
  name?: string;
  notionApiKey?: string;
  notionDatabaseId?: string;
  googleDriveCredentials?: string;
  googleDriveRefreshToken?: string;
}

const GUILDS_DIR_DEFAULT = resolvePath(process.cwd(), 'config', 'guilds');

let guildsDir: string = GUILDS_DIR_DEFAULT;
const cachedJsonByGuildId = new Map<string, GuildJsonFile | null>();

/** テスト用: `config/guilds/` の読込ディレクトリを差し替える。キャッシュもクリア。 */
export function setGuildsDirForTesting(dir: string | null): void {
  guildsDir = dir ?? GUILDS_DIR_DEFAULT;
  cachedJsonByGuildId.clear();
}

function guildJsonPath(guildId: string): string {
  return resolvePath(guildsDir, `${guildId}.json`);
}

function loadGuildJson(guildId: string): GuildJsonFile | null {
  if (cachedJsonByGuildId.has(guildId)) {
    return cachedJsonByGuildId.get(guildId) ?? null;
  }
  const path = guildJsonPath(guildId);
  if (!existsSync(path)) {
    cachedJsonByGuildId.set(guildId, null);
    return null;
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as GuildJsonFile;
    cachedJsonByGuildId.set(guildId, parsed);
    return parsed;
  } catch (err) {
    log.error(
      { err },
      `failed to read ${path}, falling back to default .env for guild ${guildId}`,
    );
    cachedJsonByGuildId.set(guildId, null);
    return null;
  }
}

function pickWithEnv(jsonValue: string | undefined, envKey: string): string | undefined {
  if (jsonValue !== undefined && jsonValue.length > 0) return jsonValue;
  const fromEnv = process.env[envKey];
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

/**
 * Guild ID から GuildConfig を解決する。
 * - `config/guilds/<guildId>.json` が存在 → 共通 `.env` と merge（Guild 側優先）
 * - 存在しない / guildId が null → process.env の値だけを返す（後方互換）
 */
export function loadGuildConfig(guildId: string | null): GuildConfig {
  if (!guildId) {
    return {
      guildId: null,
      notionApiKey: pickWithEnv(undefined, 'NOTION_API_KEY'),
      notionDatabaseId: pickWithEnv(undefined, 'NOTION_DATABASE_ID'),
      googleDriveCredentials: pickWithEnv(undefined, 'GOOGLE_DRIVE_CREDENTIALS'),
      googleDriveRefreshToken: pickWithEnv(undefined, 'GOOGLE_DRIVE_REFRESH_TOKEN'),
    };
  }

  const json = loadGuildJson(guildId);
  if (!json) {
    log.info(`guild ${guildId} has no config/guilds/${guildId}.json, using default .env`);
    return {
      guildId,
      notionApiKey: pickWithEnv(undefined, 'NOTION_API_KEY'),
      notionDatabaseId: pickWithEnv(undefined, 'NOTION_DATABASE_ID'),
      googleDriveCredentials: pickWithEnv(undefined, 'GOOGLE_DRIVE_CREDENTIALS'),
      googleDriveRefreshToken: pickWithEnv(undefined, 'GOOGLE_DRIVE_REFRESH_TOKEN'),
    };
  }

  log.info(
    `guild ${guildId}${json.name ? ` (${json.name})` : ''} using config/guilds/${guildId}.json`,
  );
  return {
    guildId,
    guildName: json.name,
    notionApiKey: pickWithEnv(json.notionApiKey, 'NOTION_API_KEY'),
    notionDatabaseId: pickWithEnv(json.notionDatabaseId, 'NOTION_DATABASE_ID'),
    googleDriveCredentials: pickWithEnv(json.googleDriveCredentials, 'GOOGLE_DRIVE_CREDENTIALS'),
    googleDriveRefreshToken: pickWithEnv(json.googleDriveRefreshToken, 'GOOGLE_DRIVE_REFRESH_TOKEN'),
  };
}

/** Notion 利用側のヘルパー: 必要キーが揃ってなければ分かりやすいエラーで落とす。 */
export function assertNotionConfigured(cfg: GuildConfig): {
  apiKey: string;
  databaseId: string;
} {
  if (!cfg.notionApiKey) {
    throw new Error(
      `NOTION_API_KEY が未設定です（guildId=${cfg.guildId ?? 'default'}）。.env または config/guilds/${cfg.guildId ?? '<guildId>'}.json を確認してください`,
    );
  }
  if (!cfg.notionDatabaseId) {
    throw new Error(
      `NOTION_DATABASE_ID が未設定です（guildId=${cfg.guildId ?? 'default'}）。.env または config/guilds/${cfg.guildId ?? '<guildId>'}.json を確認してください`,
    );
  }
  return { apiKey: cfg.notionApiKey, databaseId: cfg.notionDatabaseId };
}

/** Drive 利用側のヘルパー: 必要キーが揃ってなければ分かりやすいエラーで落とす。 */
export function assertDriveConfigured(cfg: GuildConfig): {
  credentialsPath: string;
  refreshToken: string;
} {
  if (!cfg.googleDriveCredentials) {
    throw new Error(
      `GOOGLE_DRIVE_CREDENTIALS が未設定です（guildId=${cfg.guildId ?? 'default'}）。.env または config/guilds/${cfg.guildId ?? '<guildId>'}.json を確認してください`,
    );
  }
  if (!cfg.googleDriveRefreshToken) {
    throw new Error(
      `GOOGLE_DRIVE_REFRESH_TOKEN が未設定です（guildId=${cfg.guildId ?? 'default'}）。.env または config/guilds/${cfg.guildId ?? '<guildId>'}.json を確認してください`,
    );
  }
  return {
    credentialsPath: cfg.googleDriveCredentials,
    refreshToken: cfg.googleDriveRefreshToken,
  };
}
