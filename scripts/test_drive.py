"""Google Drive OAuth 認証フロー & 疎通確認スクリプト。

credentials.json を使って OAuth 2.0 Authorization Code フロー（Desktop App）を実行し、
refresh_token を取得して .env に書き込む。
その後、Google Drive API で files.list を叩いて疎通確認を行う。

scope: https://www.googleapis.com/auth/drive.file
このアプリで作成/アップロード/開いたファイルにのみアクセス可。最小権限。
"""

from __future__ import annotations

import sys
from pathlib import Path

from dotenv import load_dotenv, set_key
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/drive.file"]

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CREDENTIALS_PATH = PROJECT_ROOT / "credentials.json"
ENV_PATH = PROJECT_ROOT / ".env"

if not CREDENTIALS_PATH.exists():
    print(f"ERROR: {CREDENTIALS_PATH} が見つかりません")
    sys.exit(1)

load_dotenv(ENV_PATH)

print("== OAuth フロー開始 ==")
print(f"credentials.json: {CREDENTIALS_PATH}")
print(f"scope           : {SCOPES[0]}")
print()
print("ブラウザが自動で開きます。テストユーザー登録した Google アカウントでログインし、")
print("'meetingbot' のアクセス許可をしてください。")
print("「このアプリは確認されていません」警告が出たら：")
print("  → 「詳細」を展開 → 「(安全でない)〜に移動」リンクをクリック で進めます。")
print()

flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_PATH), SCOPES)
# prompt='consent' で必ず refresh_token が返るようにする
creds = flow.run_local_server(
    port=0,
    open_browser=True,
    prompt="consent",
    access_type="offline",
)

if not creds.refresh_token:
    print("ERROR: refresh_token が取得できませんでした。")
    print("Google アカウントの設定 (https://myaccount.google.com/permissions) で")
    print("既存の meetingbot アクセス許可を取り消してから、もう一度実行してください。")
    sys.exit(1)

token_masked = f"{creds.refresh_token[:8]}...{creds.refresh_token[-4:]}"
print()
print("=== 認証成功 ===")
print(f"refresh_token: {token_masked} (一部マスク)")
print()

# .env に書き込み
set_key(str(ENV_PATH), "GOOGLE_DRIVE_CREDENTIALS", "credentials.json")
set_key(str(ENV_PATH), "GOOGLE_DRIVE_REFRESH_TOKEN", creds.refresh_token)
print(".env に以下を保存しました：")
print("  GOOGLE_DRIVE_CREDENTIALS=credentials.json")
print("  GOOGLE_DRIVE_REFRESH_TOKEN=(取得した値)")
print()

# 疎通確認
print("== 疎通確認: Drive API files.list ==")
service = build("drive", "v3", credentials=creds)
results = service.files().list(
    pageSize=10,
    fields="files(id, name, mimeType)",
).execute()
files = results.get("files", [])
if not files:
    print("(このアプリがアクセス可能なファイルはまだありません)")
    print("drive.file スコープなので想定通り — Phase 5 でアップロードしたものから見えるようになります。")
else:
    print(f"{len(files)} 件のファイル:")
    for f in files:
        print(f"  - {f.get('name')} ({f.get('mimeType')})")

print()
print("=== 疎通成功 ===")
