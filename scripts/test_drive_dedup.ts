/**
 * AIP-35 動作確認: uploadSession を2回連続実行し、Drive 上で同名重複が発生しないことを検証する。
 *
 * クリーンな前提を作るため、毎回ユニークな疑似セッションディレクトリ
 * (recordings/aip35-<timestamp>) を一時生成して検証する。
 *
 * AIP-38 追従: 階層に Guild ID 層が入ったため、本番出力先（meetingBot/<実 guildId>/...）
 * を汚さないよう `guildId: "test_dedup"` を渡し、`meetingBot/test_dedup/<YYYY-MM>/<sessionId>/`
 * に書き出す。検証後はそのセッションフォルダごとゴミ箱送りにする。
 *
 * 期待挙動:
 *   1回目 → create（新規作成）。フォルダ内に各ファイルが1個ずつ。
 *   2回目 → update（同 fileId に上書き）。ファイル数は変わらず1個ずつ。
 */
import 'dotenv/config';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { readFile } from 'node:fs/promises';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { uploadSession } from '../src/drive.js';

const sourceSession = 'recordings/2026-05-03_211934_ovek5e';
const filenames = ['mixed.mp3', 'transcript.json'];

/**
 * AIP-38: 本番運用の Guild ID（数値文字列）と被らない、テスト専用フォルダ名。
 * Drive 階層は `meetingBot/<TEST_GUILD_ID>/<YYYY-MM>/<sessionId>/` に書き出される。
 */
const TEST_GUILD_ID = 'test_dedup';

interface OAuthClientSecret {
  installed?: { client_id?: string; client_secret?: string };
  web?: { client_id?: string; client_secret?: string };
}

async function makeAuth(): Promise<OAuth2Client> {
  const credentialsPath = process.env.GOOGLE_DRIVE_CREDENTIALS!;
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN!;
  const abs = isAbsolute(credentialsPath)
    ? credentialsPath
    : resolvePath(process.cwd(), credentialsPath);
  const raw = await readFile(abs, 'utf-8');
  const parsed = JSON.parse(raw) as OAuthClientSecret;
  const section = parsed.installed ?? parsed.web!;
  const auth = new google.auth.OAuth2(section.client_id, section.client_secret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

function folderIdFromUrl(url: string): string {
  const m = url.match(/\/folders\/([^/?#]+)/);
  if (!m) throw new Error(`folderId が抽出できません: ${url}`);
  return m[1]!;
}

async function listFolderFiles(folderId: string): Promise<{ name: string; id: string }[]> {
  const auth = await makeAuth();
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id, name)',
    pageSize: 100,
    spaces: 'drive',
  });
  return (res.data.files ?? []).map((f) => ({ id: f.id ?? '', name: f.name ?? '' }));
}

async function trashFolder(folderId: string): Promise<void> {
  const auth = await makeAuth();
  const drive = google.drive({ version: 'v3', auth });
  await drive.files.update({ fileId: folderId, requestBody: { trashed: true } });
}

function countByName(files: { name: string }[], name: string): number {
  return files.filter((f) => f.name === name).length;
}

async function main(): Promise<void> {
  // クリーンな疑似セッションを用意
  const stamp = `aip35-${Date.now()}`;
  const tmpSession = resolvePath(`recordings/${stamp}`);
  await mkdir(tmpSession, { recursive: true });
  for (const f of filenames) {
    await copyFile(resolvePath(sourceSession, f), join(tmpSession, f));
  }

  console.log(`session: recordings/${stamp}`);
  console.log(`files  : ${filenames.join(', ')}`);
  console.log();

  let folderId: string | null = null;

  try {
    console.log('--- 1回目（create 期待） ---');
    const r1 = await uploadSession(`recordings/${stamp}`, filenames, { guildId: TEST_GUILD_ID });
    console.log(`folderUrl: ${r1.folderUrl}`);
    folderId = folderIdFromUrl(r1.folderUrl);

    const after1 = await listFolderFiles(folderId);
    console.log(`[after 1回目] files=${after1.length}`);
    for (const f of after1) console.log(`  ${f.name} (${f.id})`);

    console.log();
    console.log('--- 2回目（update 期待） ---');
    const r2 = await uploadSession(`recordings/${stamp}`, filenames, { guildId: TEST_GUILD_ID });
    console.log(`folderUrl: ${r2.folderUrl}`);

    const after2 = await listFolderFiles(folderId);
    console.log(`[after 2回目] files=${after2.length}`);
    for (const f of after2) console.log(`  ${f.name} (${f.id})`);

    console.log();
    console.log('=== 検証結果 ===');
    let ok = true;
    for (const fname of filenames) {
      const c = countByName(after2, fname);
      const status = c === 1 ? 'OK' : 'NG';
      if (c !== 1) ok = false;
      console.log(`  ${status} count(${fname}) = ${c} (期待値: 1)`);
    }
    for (const fname of filenames) {
      const idMatch = r1.fileUrls[fname] === r2.fileUrls[fname];
      const status = idMatch ? 'OK' : 'NG';
      if (!idMatch) ok = false;
      console.log(`  ${status} url 同一性(${fname}): ${idMatch}`);
    }

    // force=true で新規作成されることも確認
    console.log();
    console.log('--- 3回目（force=true で新規作成期待） ---');
    const r3 = await uploadSession(`recordings/${stamp}`, filenames, {
      force: true,
      guildId: TEST_GUILD_ID,
    });
    const after3 = await listFolderFiles(folderId);
    console.log(`[after 3回目] files=${after3.length}`);
    for (const fname of filenames) {
      const c = countByName(after3, fname);
      const status = c === 2 ? 'OK' : 'NG';
      if (c !== 2) ok = false;
      console.log(`  ${status} count(${fname}) = ${c} (期待値: 2 - force新規)`);
      const isNew = r3.fileUrls[fname] !== r1.fileUrls[fname];
      const s2 = isNew ? 'OK' : 'NG';
      if (!isNew) ok = false;
      console.log(`  ${s2} url が1回目と異なる(${fname}): ${isNew}`);
    }

    console.log();
    console.log(ok ? '=== ALL PASS ===' : '=== FAILED ===');
    if (!ok) process.exitCode = 1;
  } finally {
    // 検証で作った Drive フォルダはゴミ箱送り
    if (folderId) {
      try {
        await trashFolder(folderId);
        console.log(`[cleanup] trashed Drive folder: ${folderId}`);
      } catch (err) {
        console.warn(`[cleanup] failed to trash Drive folder: ${(err as Error).message}`);
      }
    }
    // ローカルの疑似セッションも削除
    try {
      await rm(tmpSession, { recursive: true, force: true });
      console.log(`[cleanup] removed local: ${tmpSession}`);
    } catch (err) {
      console.warn(`[cleanup] failed to remove local: ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
