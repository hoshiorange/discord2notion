# マルチ Guild 設定ガイド（AIP-38）

1 つの Bot プロセスを複数の Discord サーバ（Guild）に招待し、**Guild ごとに別の Notion DB / 別の Google アカウント**へ議事録を振り分けたい場合の設定方法。

シングル Guild 運用の場合は **このドキュメントを読む必要はない**。`.env` 一本で従来通り動作する（後方互換）。

## 📋 全体像

| ファイル | 内容 | コミット |
| --- | --- | --- |
| `.env` | 共通設定（`DISCORD_TOKEN` / `LOG_LEVEL` / Whisper 等）+ デフォルトの Notion / Drive | gitignore |
| `config/guilds.json` | Guild ID → env file マッピング | gitignore（`config/` ごと） |
| `.env.guild-<guildId>` | Guild 別の Notion / Drive 認証情報（共通 `.env` を上書き） | gitignore |
| `credentials.guild-<guildId>.json` | Guild 別の Google OAuth client_secret（必要に応じて） | gitignore |

`DISCORD_TOKEN` は **Bot 共通** なので `.env` 側のみ。Notion / Drive 系の値だけ Guild 別に上書きできる。

## 🔧 設定手順

### 1. config/guilds.json を作成

```powershell
mkdir config
notepad config\guilds.json
```

内容例：

```json
{
  "default": ".env",
  "guilds": {
    "1234567890123456789": { "name": "仕事",   "envFile": ".env.guild-1234567890123456789" },
    "9876543210987654321": { "name": "個人",   "envFile": ".env.guild-9876543210987654321" }
  }
}
```

- `default` は飾り（明示用）。実際にはここの値は使わず、未登録 Guild は常に `process.env`（`.env` 由来）を使用
- `name` は **任意**。ログに表示されるラベル（運用時の見やすさ用）
- `envFile` は **プロジェクトルート相対パス** または絶対パス
- Guild ID は Discord の開発者モード ON → サーバー右クリック → 「サーバー ID をコピー」で取得

### 2. Guild 別 env を作成

```powershell
notepad .env.guild-1234567890123456789
```

中身は **その Guild 用に上書きしたい値だけ** 書けばよい：

```dotenv
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Guild 別に Google アカウントを分けたい場合は credentials を別ファイルに
GOOGLE_DRIVE_CREDENTIALS=credentials.guild-1234567890123456789.json
GOOGLE_DRIVE_REFRESH_TOKEN=1//xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

書かなかったキーは **共通 `.env` の値** が引き継がれる（merge は Guild 側優先）。

### 3. 別 Google アカウント運用の場合（任意）

Guild ごとに **別の Google アカウント** に Drive 出力したい場合：

1. その Google アカウントで [Google Cloud Console](https://console.cloud.google.com/) にログインし、Drive API を有効化した OAuth Desktop client を作成（手順は [SETUP_EXTERNAL.md](./SETUP_EXTERNAL.md#3-google-drive) 参照）
2. ダウンロードした client_secret JSON を `credentials.guild-<guildId>.json` としてプロジェクトルートに配置
3. `scripts/test_drive.py` を該当 credentials を指定して実行し、refresh_token を取得（`scripts/test_drive.py` は `.env` を更新するので、そのまま流用すると上書きされる点に注意。手動で `.env.guild-<guildId>` にコピペする）

別 Notion アカウント / 別 Notion ワークスペースに振り分ける場合も、その Notion の Internal Integration を作成し直して `NOTION_API_KEY` と `NOTION_DATABASE_ID` を `.env.guild-<guildId>` に書く。

## 🔍 動作の流れ

```
ユーザーが /start
  → interaction.guildId（Discord SDK が提供）を pipeline へ渡す
  → pipeline 内で loadGuildConfig(guildId) を呼び出し
      ├─ config/guilds.json を読込
      ├─ guildId が登録あり → .env.guild-<guildId> を merge（Guild 側優先）
      └─ 未登録 / config/guilds.json 無し → process.env（.env）の値だけ使用
  → drive.uploadSession({ guildConfig }) / notion.createMeetingPage({ guildConfig }) に渡される
```

`/resume` は `pipeline-state.json` に記録された `guildId` を使うので、再開時も同じ Guild の env が引き続き使われる。

## ✅ 後方互換性

- `config/guilds.json` を **配置しなければ** 全 Guild が `.env` 一本で動く（従来動作）
- `config/guilds.json` を配置しても **未登録 Guild** は `.env` 一本で動く
- 既存の `pipeline-state.json` には `guildId` フィールドが無いが、`null` 扱いで `.env` を使うので壊れない

## 🐛 トラブルシュート

| 症状 | 原因 / 対処 |
| --- | --- |
| `NOTION_API_KEY が未設定です（guildId=...）` | `.env.guild-<guildId>` に書いてないし、共通 `.env` にも無い。どちらかに設定 |
| `env file not found: .env.guild-...` 警告 | `config/guilds.json` で指定した envFile が実在しない。`.env` の値で動作継続 |
| Guild A の議事録が Guild B の Notion DB に書き込まれた | `config/guilds.json` のキー（Guild ID）が文字列として正しいか確認。Discord のサーバー ID は 18-19 桁の数値文字列 |
| `/resume` で別 Guild の env が使われた | `pipeline-state.json` の `guildId` を確認。古い state（AIP-38 以前）は `null` の可能性、その場合は手動で書き換えるか、新しいセッションで再録音 |

## 📖 関連ドキュメント

- [SETUP_EXTERNAL.md](./SETUP_EXTERNAL.md) — Discord / Notion / Drive 各サービスの初期セットアップ
- [../README.md](../README.md) — Bot 起動と運用全般
