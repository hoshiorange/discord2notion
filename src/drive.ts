/**
 * Google Drive へセッション成果物をアップロードする。
 *
 * フォルダ階層: meetingBot/<YYYY-MM>/<sessionId>/
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

let cachedAuth: OAuth2Client | null = null;
let cachedDrive: drive_v3.Drive | null = null;

async function loadOAuthClient(): Promise<OAuth2Client> {
  if (cachedAuth) return cachedAuth;

  const credentialsPath = process.env.GOOGLE_DRIVE_CREDENTIALS;
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  if (!credentialsPath) {
    throw new Error('GOOGLE_DRIVE_CREDENTIALS が .env に設定されていません');
  }
  if (!refreshToken) {
    throw new Error('GOOGLE_DRIVE_REFRESH_TOKEN が .env に設定されていません');
  }

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
  cachedAuth = auth;
  return auth;
}

async function getDrive(): Promise<drive_v3.Drive> {
  if (cachedDrive) return cachedDrive;
  const auth = await loadOAuthClient();
  cachedDrive = google.drive({ version: 'v3', auth });
  return cachedDrive;
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
}

/**
 * セッションディレクトリ内の指定ファイル群を Drive にアップロードする。
 * 階層: meetingBot/<YYYY-MM>/<sessionDir のベース名>/
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

  const drive = await getDrive();

  try {
    const rootId = await ensureFolder(drive, ROOT_FOLDER_NAME, null);
    const monthId = await ensureFolder(drive, monthFolderName(new Date()), rootId);
    const sessionFolderId = await ensureFolder(drive, sessionId, monthId);

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
