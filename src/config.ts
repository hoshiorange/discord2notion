/**
 * AIP-38: Guild ごとに Notion / Google Drive の認証情報を切り替える設定ローダー。
 *
 * 動作:
 *  - `config/guilds.json` で Guild ID → env file をマッピング
 *  - 共通 `.env`（既に `dotenv/config` で `process.env` に展開済み）と Guild 別 env file を merge し、
 *    Guild 側の値で上書きした GuildConfig を返す
 *  - guilds.json 未配置 / 未登録 Guild / `guildId === null` の場合は process.env の値だけを使う（後方互換）
 *
 * 設計上の注意:
 *  - 複数 Guild が並行で動くため `process.env` 自体は書き換えない
 *  - 同じ envFile を複数回読まないよう簡易キャッシュ
 */

import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { parse as parseDotenv } from 'dotenv';

import { getLogger } from './logger.js';

const log = getLogger('config');

export interface GuildConfig {
  /** 解決元の Guild ID（未登録 / null の場合は null）。 */
  guildId: string | null;
  /** ログ等に表示する人間ラベル（任意）。 */
  guildName?: string;
  notionApiKey: string | undefined;
  notionDatabaseId: string | undefined;
  googleDriveCredentials: string | undefined;
  googleDriveRefreshToken: string | undefined;
}

interface GuildsJsonEntry {
  name?: string;
  envFile: string;
}

interface GuildsJson {
  default?: string;
  guilds?: Record<string, GuildsJsonEntry>;
}

const GUILDS_JSON_PATH_DEFAULT = resolvePath(process.cwd(), 'config', 'guilds.json');

let cachedGuildsJson: GuildsJson | null | undefined; // undefined: 未読込, null: 配置なし
let guildsJsonPath: string = GUILDS_JSON_PATH_DEFAULT;
const cachedEnvFiles = new Map<string, Record<string, string>>();

/** テスト用: guilds.json の読込パスを差し替える。キャッシュもクリア。 */
export function setGuildsJsonPathForTesting(path: string | null): void {
  guildsJsonPath = path ?? GUILDS_JSON_PATH_DEFAULT;
  cachedGuildsJson = undefined;
  cachedEnvFiles.clear();
}

function loadGuildsJson(): GuildsJson | null {
  if (cachedGuildsJson !== undefined) return cachedGuildsJson;
  if (!existsSync(guildsJsonPath)) {
    cachedGuildsJson = null;
    return null;
  }
  try {
    const raw = readFileSync(guildsJsonPath, 'utf-8');
    cachedGuildsJson = JSON.parse(raw) as GuildsJson;
    return cachedGuildsJson;
  } catch (err) {
    log.error({ err }, `failed to read ${guildsJsonPath}, falling back to default .env`);
    cachedGuildsJson = null;
    return null;
  }
}

function loadEnvFile(envFile: string): Record<string, string> {
  const absPath = isAbsolute(envFile) ? envFile : resolvePath(process.cwd(), envFile);
  const cached = cachedEnvFiles.get(absPath);
  if (cached) return cached;
  if (!existsSync(absPath)) {
    log.warn(`env file not found: ${absPath}, falling back to default`);
    cachedEnvFiles.set(absPath, {});
    return {};
  }
  try {
    const raw = readFileSync(absPath, 'utf-8');
    const parsed = parseDotenv(raw);
    cachedEnvFiles.set(absPath, parsed);
    return parsed;
  } catch (err) {
    log.error({ err }, `failed to parse env file ${absPath}`);
    cachedEnvFiles.set(absPath, {});
    return {};
  }
}

function buildConfigFromEnv(
  guildId: string | null,
  guildName: string | undefined,
  overrides: Record<string, string>,
): GuildConfig {
  const pick = (key: string): string | undefined => {
    const v = overrides[key];
    if (v !== undefined && v.length > 0) return v;
    const fromProcess = process.env[key];
    return fromProcess && fromProcess.length > 0 ? fromProcess : undefined;
  };

  return {
    guildId,
    guildName,
    notionApiKey: pick('NOTION_API_KEY'),
    notionDatabaseId: pick('NOTION_DATABASE_ID'),
    googleDriveCredentials: pick('GOOGLE_DRIVE_CREDENTIALS'),
    googleDriveRefreshToken: pick('GOOGLE_DRIVE_REFRESH_TOKEN'),
  };
}

/**
 * Guild ID から GuildConfig を解決する。
 * - guilds.json が無い / Guild が未登録 / guildId が null → process.env の値を使う（後方互換）
 * - 登録あり → 共通 process.env と Guild 別 env file を merge（Guild 側優先）
 */
export function loadGuildConfig(guildId: string | null): GuildConfig {
  const json = loadGuildsJson();

  if (!guildId || !json?.guilds) {
    return buildConfigFromEnv(guildId, undefined, {});
  }

  const entry = json.guilds[guildId];
  if (!entry) {
    log.info(`guild ${guildId} is not registered in guilds.json, using default .env`);
    return buildConfigFromEnv(guildId, undefined, {});
  }

  const overrides = loadEnvFile(entry.envFile);
  log.info(
    `guild ${guildId}${entry.name ? ` (${entry.name})` : ''} using env file: ${entry.envFile}`,
  );
  return buildConfigFromEnv(guildId, entry.name, overrides);
}

/** GuildConfig が必要キーをすべて持っているか検査（notion/drive で使う側のヘルパー）。 */
export function assertNotionConfigured(cfg: GuildConfig): {
  apiKey: string;
  databaseId: string;
} {
  if (!cfg.notionApiKey) {
    throw new Error(
      `NOTION_API_KEY が未設定です（guildId=${cfg.guildId ?? 'default'}）。.env または .env.guild-<guildId> を確認してください`,
    );
  }
  if (!cfg.notionDatabaseId) {
    throw new Error(
      `NOTION_DATABASE_ID が未設定です（guildId=${cfg.guildId ?? 'default'}）。.env または .env.guild-<guildId> を確認してください`,
    );
  }
  return { apiKey: cfg.notionApiKey, databaseId: cfg.notionDatabaseId };
}

export function assertDriveConfigured(cfg: GuildConfig): {
  credentialsPath: string;
  refreshToken: string;
} {
  if (!cfg.googleDriveCredentials) {
    throw new Error(
      `GOOGLE_DRIVE_CREDENTIALS が未設定です（guildId=${cfg.guildId ?? 'default'}）`,
    );
  }
  if (!cfg.googleDriveRefreshToken) {
    throw new Error(
      `GOOGLE_DRIVE_REFRESH_TOKEN が未設定です（guildId=${cfg.guildId ?? 'default'}）`,
    );
  }
  return {
    credentialsPath: cfg.googleDriveCredentials,
    refreshToken: cfg.googleDriveRefreshToken,
  };
}
