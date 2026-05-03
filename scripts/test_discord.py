"""Discord Bot Token 疎通確認スクリプト。

.env から DISCORD_TOKEN を読み、Discord REST API で
Bot 自身の情報と参加中ギルド（サーバー）一覧を取得する。

Gateway / Voice の接続は Phase 2 で discord.js を入れてから検証する。
ここではトークンが有効でBotが Discord 側に存在し、想定サーバーに招待済みかだけを確認する。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

DISCORD_API = "https://discord.com/api/v10"

env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(env_path)

token = os.getenv("DISCORD_TOKEN")
if not token:
    print("ERROR: DISCORD_TOKEN が .env にありません")
    sys.exit(1)

masked = f"{token[:10]}...{token[-4:]}" if len(token) > 14 else "(短すぎ)"
print(f"DISCORD_TOKEN: {masked}")
print()

headers = {"Authorization": f"Bot {token}"}

print("== Bot 情報 (GET /users/@me) ==")
r = requests.get(f"{DISCORD_API}/users/@me", headers=headers, timeout=15)
if r.status_code != 200:
    print(f"FAIL: HTTP {r.status_code}")
    print(r.text)
    sys.exit(1)
me = r.json()
print(f"  ID         : {me.get('id')}")
print(f"  Username   : {me.get('username')}#{me.get('discriminator', '0')}")
print(f"  Bot        : {me.get('bot')}")
print(f"  Verified   : {me.get('verified')}")
print(f"  Flags      : {me.get('flags')}")
print()

print("== 参加サーバー (GET /users/@me/guilds) ==")
r = requests.get(f"{DISCORD_API}/users/@me/guilds", headers=headers, timeout=15)
if r.status_code != 200:
    print(f"FAIL: HTTP {r.status_code}")
    print(r.text)
    sys.exit(1)
guilds = r.json()
if not guilds:
    print("  (参加サーバーなし — 招待がまだの可能性)")
else:
    for g in guilds:
        owner = "[OWNER] " if g.get("owner") else ""
        print(f"  - {owner}{g.get('name')} (id: {g.get('id')})")

print()
print("=== 疎通成功 ===")
