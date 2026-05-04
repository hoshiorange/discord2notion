# マルチ Guild 設定ガイド

このドキュメントが必要なのは **次の条件をすべて満たす場合だけ** です：

- 1 つの Bot プロセスを **複数** の Discord サーバ（Guild）に招待している
- Guild ごとに **別** の Notion データベース or Google アカウントへ議事録を振り分けたい

1 つの Discord サーバでしか使わない場合は、`.env` 一本で従来通り動作します。
**何も設定しなくて OK** です（読む必要なし）。

---

## TL;DR

```
config/
└─ guilds/
   ├─ 1234567890123456789.json     ← サーバA 用
   └─ 9876543210987654321.json     ← サーバB 用
```

それぞれの JSON に **そのサーバ用** の Notion / Drive 認証情報を書く。
ファイル名は **Discord のサーバ ID `.json`**。それだけ。

---

## 起動時に `.env` で必須なもの

`npm start` 時の起動チェックで **必須なのは `DISCORD_TOKEN` だけ** です。

| 値 | 起動時必須？ | 配置可能な場所 |
| --- | --- | --- |
| `DISCORD_TOKEN` | **必須** | `.env` のみ（Bot 共通） |
| `NOTION_API_KEY` / `NOTION_DATABASE_ID` | 任意 | `.env` または `config/guilds/<guildId>.json` |
| `GOOGLE_DRIVE_CREDENTIALS` / `GOOGLE_DRIVE_REFRESH_TOKEN` | 任意 | `.env` または `config/guilds/<guildId>.json` |

Notion / Drive 関連は **どちらか一方にあれば OK**。
両方とも空のまま該当 Guild から `/start` すると、パイプラインの該当ステージ
（Drive アップロード or Notion ページ作成）で「`NOTION_API_KEY` が未設定です」等の
エラーになり、`pipeline-state.json` に失敗が記録される（Bot 自体は止まらず、`/resume` で再開可能）。

> マルチ Guild 運用で **すべての Notion / Drive 設定を Guild 別 JSON に寄せた** 結果、
> `.env` から `NOTION_*` / `GOOGLE_DRIVE_*` を削除しても起動は通ります。

---

## ファイル形式

### 配置場所

| パス | 役割 | コミット |
| --- | --- | --- |
| `.env` | 共通設定（DISCORD_TOKEN / LOG_LEVEL / フォールバックの Notion / Drive） | gitignore |
| `config/guilds/<guildId>.json` | この Guild 専用の上書き設定 | gitignore（`config/` ごと） |

`DISCORD_TOKEN` は **Bot 共通** なので `.env` のみ。
**Notion / Drive の認証情報だけ** Guild 別に上書きできる。

#### なぜ DISCORD_TOKEN は Guild 別に分けないのか

Discord は **1 Bot Application = 1 Token** の設計。1 つの Bot トークンで複数 Guild に招待でき、Guild ごとに切替える概念がそもそも存在しない。

- **同じ Bot を複数 Guild で使う**（一般的なケース）→ Token 1 つで OK
- **別 Bot として動かしたい**（例: 配布先ユーザーが自分のサーバ用に独自 Bot を立ち上げる）→ **別マシン or 別プロセスで `npm start`**（別の Bot Application、別 Token、別 `.env`）

つまり `DISCORD_TOKEN` の切替が必要になるのは「別 Bot として運用する」ケースで、そのときは Bot プロセスごと別にする運用になる。同一プロセス内で複数 Token を切替えることは Discord の仕様上想定されていない。

### JSON スキーマ

すべてのフィールドは **任意**。書いたキーだけ Guild 側で上書きされる（書かないキーは `.env` から引き継ぎ）。

```json
{
  "name": "仕事",
  "notionApiKey": "ntn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "notionDatabaseId": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "googleDriveCredentials": "credentials.guild-1234567890123456789.json",
  "googleDriveRefreshToken": "1//xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

| フィールド | 意味 |
| --- | --- |
| `name` | ログ表示用ラベル（任意）。例 `"仕事"`、`"個人"` |
| `notionApiKey` | この Guild 用の Notion Internal Integration Token |
| `notionDatabaseId` | この Guild 用の議事録 DB の ID |
| `googleDriveCredentials` | OAuth credentials JSON のパス（プロジェクトルート相対 or 絶対） |
| `googleDriveRefreshToken` | OAuth refresh token |

> 値はすべて `.env` のキー名と1対1対応している（`NOTION_API_KEY` ⇔ `notionApiKey` 等）。
> 見覚えのある名前のはず。

### Guild ID の取得方法

Discord アプリで：

1. **設定 → 詳細設定 → 開発者モード ON**
2. サーバー名を右クリック → **「サーバー ID をコピー」**
3. その値（18-19 桁の数値）が `<guildId>`

---

## セットアップ手順

### 例: 2 つの Discord サーバで運用したい

ざっくりこういう想定：

- **サーバA**（仕事用）: 仕事用の Notion DB / 仕事用 Google アカウントの Drive へ
- **サーバB**（個人用）: 個人 Notion DB / 個人 Google アカウントの Drive へ

#### 1. ディレクトリ作成

```powershell
mkdir config\guilds
```

#### 2. サーバA 用の JSON 作成

```powershell
notepad config\guilds\1234567890123456789.json
```

```json
{
  "name": "仕事",
  "notionApiKey": "ntn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "notionDatabaseId": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "googleDriveCredentials": "credentials.guild-1234567890123456789.json",
  "googleDriveRefreshToken": "1//xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

#### 3. サーバB 用の JSON 作成（任意項目だけ書いてもよい）

書かなかったキーは `.env` の値が引き継がれる。例えば「Notion DB だけ別、Drive は共通でいい」なら：

```powershell
notepad config\guilds\9876543210987654321.json
```

```json
{
  "name": "個人",
  "notionApiKey": "ntn_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
  "notionDatabaseId": "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
}
```

#### 4. 起動

```powershell
npm start
```

これだけ。各 Guild からの `/start` で、その Guild の JSON が自動的に使われる。
ログに「`guild 1234567890123456789 (仕事) using config/guilds/1234567890123456789.json`」のような行が出れば反映成功。

---

## 別 Notion アカウント / 別 Google アカウント の運用

### 別 Notion アカウントへ振り分けたい

1. その Notion アカウントで [Internal Integration を作成](https://www.notion.so/profile/integrations)
2. その Integration を、振り分け先の議事録 DB に **「Add Connections」** で接続
3. Integration Token と DB ID を、対象 Guild の `config/guilds/<guildId>.json` の
   `notionApiKey` / `notionDatabaseId` に書く

詳しい手順は [SETUP_EXTERNAL.md - Notion](./SETUP_EXTERNAL.md#2-notion) 参照。

### 別 Google アカウントへ振り分けたい

1. その Google アカウントで [Google Cloud Console](https://console.cloud.google.com/) にログイン
2. Drive API 有効化 → OAuth Desktop client 作成（手順は [SETUP_EXTERNAL.md - Google Drive](./SETUP_EXTERNAL.md#3-google-drive) 参照）
3. credentials JSON をダウンロードし、**`credentials.guild-<guildId>.json`** という名前で
   プロジェクトルートに配置（gitignore 済み）
4. `scripts/test_drive.py` で refresh_token を取得
   - 注意: そのスクリプトは **`.env` を上書きする**（既存設定が消える可能性）。
     既存環境を壊したくない場合は、いったん `.env.bak` にバックアップしてから実行 →
     取得した値を Guild JSON に手動コピペ → `.env.bak` を `.env` に戻す
5. 取得した値を対象 Guild の `config/guilds/<guildId>.json` の
   `googleDriveCredentials` / `googleDriveRefreshToken` に書く

---

## Drive 出力先のフォルダ階層

マルチ Guild 対応に伴い、Drive 上の保存階層には **Guild ID 層** が挟まる。
これによって「同じ Google アカウント上で複数の Discord サーバを運用する」場合も、
各サーバの議事録が混ざらず、それぞれ別フォルダに整理される。

```
（Drive 上）
meetingBot/
├─ 1234567890123456789/      ← サーバA の Guild ID
│   ├─ 2026-05/
│   │   ├─ 2026-05-04_213000_abc123/
│   │   │   ├─ mixed.mp3
│   │   │   ├─ transcript.json
│   │   │   └─ summary.json
│   │   └─ 2026-05-05_103000_def456/
│   │       └─ ...
│   └─ 2026-06/
│       └─ ...
├─ 9876543210987654321/      ← サーバB の Guild ID
│   └─ 2026-05/
│       └─ ...
└─ default/                  ← Guild ID 不明 / DM 経由 / 後方互換セッション
    └─ 2026-05/
        └─ ...
```

| 階層 | 値 |
| --- | --- |
| 1 | `meetingBot`（固定） |
| 2 | `<guildId>` 文字列 / 不明な場合は `default` |
| 3 | `<YYYY-MM>`（セッション開始の月） |
| 4 | `<sessionId>`（録音セッション ID） |

### `default` フォルダに入る場合

- DM など Guild に紐づかないコンテキスト（`interaction.guildId === null`）
- `pipeline-state.json` に `guildId` が記録されていない古いセッションを `/resume` した場合
  （AIP-38 以前に開始した未完セッションが該当）

実運用ではほぼ使われないが、フォールバック先として用意されている。

### 既存データへの影響

AIP-38 リリース以前にアップロード済みの `meetingBot/<YYYY-MM>/...` フォルダは **そのまま残る**。
新階層へ自動移動はしないので、必要なら Drive 上で手動移動してください
（通常は触らず、新規セッションだけ新階層に入る運用で問題なし）。

---

## 動作の仕組み

```
ユーザーが /start
   ↓
interaction.guildId（Discord SDK 提供）を pipeline へ渡す
   ↓
loadGuildConfig(guildId) を呼び出し
   ├─ config/guilds/<guildId>.json が存在  → process.env と merge（JSON 側優先）
   └─ 存在しない                          → process.env のみ使用
   ↓
drive.uploadSession({ guildConfig, ... })
notion.createMeetingPage({ guildConfig, ... })
```

`/resume` は `recordings/<sessionId>/pipeline-state.json` に記録された `guildId` を使うので、
再開時も同じ Guild の設定が引き続き使われる。

---

## 後方互換性

このドキュメントは「マルチ Guild にしたい人向け」。
**やらない場合は何も影響しません**：

| 状況 | 挙動 |
| --- | --- |
| `config/guilds/` が存在しない | 全 Guild で `.env` 一本（従来動作） |
| `config/guilds/` はあるが対象 Guild の JSON が無い | その Guild は `.env` 一本（従来動作） |
| AIP-38 以前の `pipeline-state.json` | `guildId` が無いので `null` 扱い → `.env` 一本（従来動作） |

---

## トラブルシュート

| 症状 | 原因 / 対処 |
| --- | --- |
| `NOTION_API_KEY が未設定です（guildId=...）` | 該当 Guild の JSON にも書かれてないし、共通 `.env` にもない。どちらかに設定 |
| ログに「`guild XXX has no config/guilds/XXX.json, using default .env`」と出る | JSON ファイルが見つかっていない。**ファイル名が Guild ID と一致しているか**（前後の空白・拡張子 `.json` を確認） |
| `failed to read config/guilds/XXX.json` | JSON 構文エラー。エディタで開き直して `}` `,` `"` の閉じ忘れを確認 |
| サーバA の議事録がサーバB の Notion DB に書き込まれた | JSON のファイル名（Guild ID）が間違っている。Discord の「サーバー ID をコピー」で取り直し |
| `/resume` で意図しない Guild の設定が使われた | `recordings/<sessionId>/pipeline-state.json` の `guildId` を確認。AIP-38 以前の古い state は `null`、その場合は手動編集するか新セッションで再録音 |

---

## セキュリティ

- `config/guilds/` 配下は **gitignore 済み**（`.gitignore` で `config/` ごと無視）
- `credentials.guild-*.json` も **gitignore 済み**
- `.env.example` 等のテンプレに **実トークンは書かない**（プレースホルダのみ）

万が一トークンが漏れた疑いがある場合は、各サービス側で即座に再発行する：
- Notion: Integration ページで「Refresh secret」 or 削除して作り直し
- Google: [権限管理](https://myaccount.google.com/permissions) で対象アプリを取り消し → `scripts/test_drive.py` で再取得

---

## 関連ドキュメント

- [SETUP_EXTERNAL.md](./SETUP_EXTERNAL.md) — Discord / Notion / Drive 各サービスの初期セットアップ
- [../README.md](../README.md) — Bot 起動と運用全般
