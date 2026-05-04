/**
 * Google Drive へセッション成果物をアップロードする。
 *
 * フォルダ階層: meetingBot/<guildFolderName>/<YYYY-MM>/<sessionId>/
 *   - AIP-38: マルチ Guild 運用で Guild ごとに出力先が分かれるよう `<guildFolderName>` 層を挿入。
 *   - `<guildFolderName>` は `resolveGuildFolderName(name, guildId)` の結果:
 *       - `config/guilds/<guildId>.json` の `name` が安全文字のみ → `<name>-<guildId>`
 *       - name 未指定 / 空 / 危険文字含み                          → `<guildId>` のみ（warn ログ）
 *       - `guildId` 未指定 / 空                                   → `"default"`
 *
 * 認証: .env の GOOGLE_DRIVE_CREDENTIALS（credentials.json パス）と
 *        GOOGLE_DRIVE_REFRESH_TOKEN を使った OAuth2 リフレッシュフロー。
 * スコープ: https://www.googleapis.com/auth/drive.file
 */

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join as joinPath, resolve as resolvePath } from 'node:path';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { drive_v3 } from 'googleapis';

import { assertDriveConfigured, loadGuildConfig, type GuildConfig } from './config.js';
import { getLogger } from './logger.js';

const log = getLogger('drive');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT_FOLDER_NAME = 'meetingBot';

export interface UploadResult {
  folderUrl: string;
  fileUrls: Record<string, string>;
}

interface OAuthClientSecret {
  installed?: { client_id?: string; client_secret?: string };
  web?: { client_id?: string; client_secret?: string };
}

/**
 * AIP-38: Guild ごとに別 Google アカウントを使えるよう、認証情報の組み合わせ単位でキャッシュする。
 * キーは「credentialsPath|refreshToken」のハッシュ代わりの文字列（同じ env を使う Guild 同士は共有）。
 */
const cachedAuthByKey = new Map<string, OAuth2Client>();
const cachedDriveByKey = new Map<string, drive_v3.Drive>();

function authCacheKey(credentialsPath: string, refreshToken: string): string {
  return `${credentialsPath}|${refreshToken}`;
}

async function loadOAuthClient(cfg: GuildConfig): Promise<OAuth2Client> {
  const { credentialsPath, refreshToken } = assertDriveConfigured(cfg);
  const key = authCacheKey(credentialsPath, refreshToken);
  const cached = cachedAuthByKey.get(key);
  if (cached) return cached;

  const absCredsPath = isAbsolute(credentialsPath)
    ? credentialsPath
    : resolvePath(process.cwd(), credentialsPath);

  let raw: string;
  try {
    raw = await readFile(absCredsPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `credentials.json の読み込みに失敗: ${absCredsPath} (${(err as Error).message})`,
    );
  }

  const parsed = JSON.parse(raw) as OAuthClientSecret;
  const section = parsed.installed ?? parsed.web;
  if (!section?.client_id || !section.client_secret) {
    throw new Error('credentials.json の installed/web に client_id / client_secret が見つかりません');
  }

  const auth = new google.auth.OAuth2(section.client_id, section.client_secret);
  auth.setCredentials({ refresh_token: refreshToken });
  cachedAuthByKey.set(key, auth);
  return auth;
}

async function getDrive(cfg: GuildConfig): Promise<drive_v3.Drive> {
  const { credentialsPath, refreshToken } = assertDriveConfigured(cfg);
  const key = authCacheKey(credentialsPath, refreshToken);
  const cached = cachedDriveByKey.get(key);
  if (cached) return cached;
  const auth = await loadOAuthClient(cfg);
  const drive = google.drive({ version: 'v3', auth });
  cachedDriveByKey.set(key, drive);
  return drive;
}

function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId: string | null,
): Promise<string | null> {
  const conditions = [
    `name='${escapeQueryValue(name)}'`,
    `mimeType='${FOLDER_MIME}'`,
    'trashed=false',
  ];
  if (parentId) conditions.push(`'${parentId}' in parents`);

  const res = await drive.files.list({
    q: conditions.join(' and '),
    fields: 'files(id, name)',
    pageSize: 10,
    spaces: 'drive',
  });
  const files = res.data.files ?? [];
  return files[0]?.id ?? null;
}

async function findFileInFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId: string,
): Promise<string | null> {
  const conditions = [
    `name='${escapeQueryValue(name)}'`,
    `mimeType!='${FOLDER_MIME}'`,
    `'${parentId}' in parents`,
    'trashed=false',
  ];

  const res = await drive.files.list({
    q: conditions.join(' and '),
    fields: 'files(id, name)',
    pageSize: 10,
    spaces: 'drive',
  });
  const files = res.data.files ?? [];
  return files[0]?.id ?? null;
}

async function createFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId: string | null,
): Promise<string> {
  const requestBody: drive_v3.Schema$File = {
    name,
    mimeType: FOLDER_MIME,
  };
  if (parentId) requestBody.parents = [parentId];

  const res = await drive.files.create({
    requestBody,
    fields: 'id',
  });
  const id = res.data.id;
  if (!id) throw new Error(`フォルダ作成後に id が取得できませんでした: ${name}`);
  return id;
}

async function ensureFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId: string | null,
): Promise<string> {
  const existing = await findFolder(drive, name, parentId);
  if (existing) return existing;
  return createFolder(drive, name, parentId);
}

function inferMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.md')) return 'text/markdown';
  return 'application/octet-stream';
}

async function uploadFile(
  drive: drive_v3.Drive,
  parentId: string,
  filePath: string,
  force: boolean,
): Promise<{ id: string; webViewLink: string; updated: boolean }> {
  const name = basename(filePath);
  const mimeType = inferMimeType(name);

  const existingId = force ? null : await findFileInFolder(drive, name, parentId);

  if (existingId) {
    const res = await drive.files.update({
      fileId: existingId,
      media: { mimeType, body: createReadStream(filePath) },
      fields: 'id, webViewLink',
    });
    const id = res.data.id ?? existingId;
    const webViewLink = res.data.webViewLink ?? `https://drive.google.com/file/d/${id}/view`;
    return { id, webViewLink, updated: true };
  }

  const res = await drive.files.create({
    requestBody: { name, parents: [parentId] },
    media: { mimeType, body: createReadStream(filePath) },
    fields: 'id, webViewLink',
  });
  const id = res.data.id;
  if (!id) throw new Error(`ファイルアップロード後に id が取得できませんでした: ${name}`);
  const webViewLink = res.data.webViewLink ?? `https://drive.google.com/file/d/${id}/view`;
  return { id, webViewLink, updated: false };
}

function monthFolderName(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export interface UploadOptions {
  /** true なら既存同名ファイルがあっても新規作成する（デフォルト false: 既存があれば上書き） */
  force?: boolean;
  /**
   * AIP-38: Guild 別の認証情報。未指定なら process.env から解決（後方互換）。
   */
  guildConfig?: GuildConfig;
  /**
   * AIP-38: フォルダ階層に挿入する Guild ID。指定なし / null / 空文字なら "default" を使用。
   * 階層は `meetingBot/<guildId or "default">/<YYYY-MM>/<sessionId>/` になる。
   */
  guildId?: string | null;
  /**
   * AIP-38: フォルダ名に付与する人間可読ラベル（`config/guilds/<guildId>.json` の `name`）。
   * 安全文字のみで構成されていれば `<name>-<guildId>` のフォルダ名になる。NG 文字含み・空・未指定なら
   * `<guildId>` のみにフォールバック（warn ログ付き）。
   */
  guildName?: string;
}

const DEFAULT_GUILD_FOLDER = 'default';

/**
 * AIP-38: フォルダ名に許可する文字（Unicode カテゴリで判定）。
 *  - `\p{L}`:   アルファベット系（日本語・漢字・ひらがな・カタカナ含む全文字）
 *  - `\p{N}`:   数字系
 *  - ` `:       半角スペース
 *  - `　`:  全角スペース
 *  - `-` `_`:   ハイフン・アンダースコア
 *
 * NG 文字（含まれていたらフォールバック）:
 *  - パス区切り `/`, `\`
 *  - Windows 予約 `: * ? " < > |`
 *  - 制御文字 `\n`, `\t`, `\r` 等（`\s` 一括ではなく実空白だけ許可することで除外）
 *  - 絵文字（記号扱いなので `\p{L}\p{N}` どちらにも該当しない）
 */
const SAFE_NAME_PATTERN = /^[\p{L}\p{N} 　\-_]+$/u;

/**
 * AIP-38: Guild フォルダ名を解決する。
 *  - `name` が安全文字のみ → `<name>-<guildId>` を返す
 *  - `name` が未指定 / 空 / NG 文字含み → `<guildId>` のみ（NG の場合は warn ログ）
 *  - `guildId` 未指定 / 空 → `"default"` にフォールバック（AIP-38 既存挙動）
 *
 * 純関数として export してテストから直接呼び出せるようにしておく。
 */
export function resolveGuildFolderName(
  name: string | undefined,
  guildId: string | null | undefined,
): string {
  const id = guildId && guildId.trim().length > 0 ? guildId : DEFAULT_GUILD_FOLDER;
  if (!name) return id;
  const trimmed = name.trim();
  if (trimmed.length === 0) return id;
  if (!SAFE_NAME_PATTERN.test(trimmed)) {
    log.warn(
      `Drive folder name fallback: name="${name}" に使用できない文字が含まれるため "${id}" のみを使用します`,
    );
    return id;
  }
  return `${trimmed}-${id}`;
}

/**
 * セッションディレクトリ内の指定ファイル群を Drive にアップロードする。
 * 階層: meetingBot/<guildId or "default">/<YYYY-MM>/<sessionDir のベース名>/
 *
 * 同フォルダ内に同名ファイルが既にあれば既定で `files.update` による上書きを行う。
 * `options.force=true` を渡すと常に新規作成する（重複が発生する点に注意）。
 */
export async function uploadSession(
  sessionDir: string,
  filenames: string[],
  options: UploadOptions = {},
): Promise<UploadResult> {
  const absSessionDir = resolvePath(sessionDir);
  const sessionId = basename(absSessionDir);
  if (!sessionId) {
    throw new Error(`sessionDir からセッションIDを抽出できません: ${sessionDir}`);
  }

  // 事前にローカルファイルの存在を全部検証してから API 叩く
  const targets: { absPath: string; name: string }[] = [];
  for (const filename of filenames) {
    const absPath = isAbsolute(filename) ? filename : joinPath(absSessionDir, filename);
    try {
      const s = await stat(absPath);
      if (!s.isFile()) throw new Error(`ファイルではありません: ${absPath}`);
    } catch (err) {
      throw new Error(`アップロード対象が見つかりません: ${absPath} (${(err as Error).message})`);
    }
    targets.push({ absPath, name: basename(absPath) });
  }

  const cfg = options.guildConfig ?? loadGuildConfig(null);
  const drive = await getDrive(cfg);

  try {
    const rootId = await ensureFolder(drive, ROOT_FOLDER_NAME, null);
    const guildFolder = resolveGuildFolderName(options.guildName, options.guildId);
    const guildFolderId = await ensureFolder(drive, guildFolder, rootId);
    const monthId = await ensureFolder(drive, monthFolderName(new Date()), guildFolderId);
    const sessionFolderId = await ensureFolder(drive, sessionId, monthId);
    log.info(
      `target hierarchy: ${ROOT_FOLDER_NAME}/${guildFolder}/${monthFolderName(new Date())}/${sessionId}`,
    );

    const force = options.force ?? false;
    const fileUrls: Record<string, string> = {};
    for (const target of targets) {
      const { webViewLink, updated } = await uploadFile(
        drive,
        sessionFolderId,
        target.absPath,
        force,
      );
      fileUrls[target.name] = webViewLink;
      log.info(`${updated ? 'updated' : 'uploaded'}: ${target.name} -> ${webViewLink}`);
    }

    const folderUrl = `https://drive.google.com/drive/folders/${sessionFolderId}`;
    return { folderUrl, fileUrls };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, `upload failed: ${message}`);
    throw err instanceof Error ? err : new Error(message);
  }
}
