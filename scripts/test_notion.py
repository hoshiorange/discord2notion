"""Notion API 疎通確認スクリプト。

.env から NOTION_API_KEY と NOTION_DATABASE_ID を読み、
データベース情報を取得して表示する。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

NOTION_API_VERSION = "2022-06-28"

env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(env_path)

api_key = os.getenv("NOTION_API_KEY")
database_id = os.getenv("NOTION_DATABASE_ID")

if not api_key:
    print("ERROR: NOTION_API_KEY が .env にありません")
    sys.exit(1)
if not database_id:
    print("ERROR: NOTION_DATABASE_ID が .env にありません")
    sys.exit(1)

masked = f"{api_key[:8]}...{api_key[-4:]}" if len(api_key) > 12 else "(短すぎ)"
print(f"Database ID : {database_id}")
print(f"API Key     : {masked}")
print()

url = f"https://api.notion.com/v1/databases/{database_id}"
headers = {
    "Authorization": f"Bearer {api_key}",
    "Notion-Version": NOTION_API_VERSION,
}

response = requests.get(url, headers=headers, timeout=15)

if response.status_code != 200:
    print(f"FAIL: HTTP {response.status_code}")
    print(response.text)
    sys.exit(1)

data = response.json()
title_parts = data.get("title", [])
title = "".join(p.get("plain_text", "") for p in title_parts) or "(タイトルなし)"
properties: dict = data.get("properties", {})

print("=== 接続成功 ===")
print(f"DB名         : {title}")
print(f"プロパティ数 : {len(properties)}")
print()
print("プロパティ一覧:")
for name, prop in properties.items():
    print(f"  - {name} ({prop.get('type')})")
