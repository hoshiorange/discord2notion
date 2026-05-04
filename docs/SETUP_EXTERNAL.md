# 外部サービス連携セットアップガイド

このドキュメントは議事録Bot を動かすために必要な **外部サービス側の準備** をまとめたもの。
プロジェクト内の `npm install` や `.venv` 構築までは [README.md](../README.md) を参照し、
こちらは Discord / Notion / Google Drive / Claude Code CLI それぞれの **アカウント発行・トークン取得・権限設定** に集中する。

## 📋 全体の流れ

| サービス | 用途 | 結果として `.env` に書く値 |
| --- | --- | --- |
| [1. Discord Bot](#1-discord-bot) | VC に参加して Opus パケットを受信、スラッシュコマンド受け付け | `DISCORD_TOKEN`（任意で `DISCORD_GUILD_ID`）|
| [2. Notion](#2-notion) | 議事録 DB に新規ページを作成 | `NOTION_API_KEY` / `NOTION_DATABASE_ID` |
| [3. Google Drive](#3-google-drive) | MP3・文字起こし・要約 JSON を保管 | `GOOGLE_DRIVE_CREDENTIALS` / `GOOGLE_DRIVE_REFRESH_TOKEN` |
| [4. Claude Code CLI](#4-claude-code-cli) | 文字起こしから議事録 JSON を生成（要約） | （`.env` 不要、任意で `CLAUDE_BIN`）|

設定値はすべて `.env`（プロジェクトルート、gitignore 済み）に書き込む。
テンプレートとして [`.env.example`](../.env.example) をコピーしてから値を埋めるのが確実。

```powershell
Copy-Item .env.example .env
notepad .env
```

---

## 1. Discord Bot

### 用途

Bot が VC に参加し、`@discordjs/voice` 経由で Opus パケットを受信して `.opusraw` に保存する。
スラッシュコマンド（`/start` `/stop` `/status` `/resume`）の受信もこの Bot トークンで行う。

### セットアップ手順

1. [Discord Developer Portal](https://discord.com/developers/applications) を開いてログイン
2. 右上 **「New Application」** → 任意の名前（例: `meetingBot`）で作成
3. 左メニュー **「Bot」** → **「Reset Token」** をクリックしてトークンを生成
   - **生成直後にコピー**（再表示不可。失くしたら再 Reset するしかない）
   - **このトークンが `DISCORD_TOKEN` の値**
4. 同じ「Bot」ページ内の **Privileged Gateway Intents** をスクロールして以下を有効化
   - `SERVER MEMBERS INTENT`
   - `MESSAGE CONTENT INTENT`
   - （`PRESENCE INTENT` は不要）
5. 左メニュー **「OAuth2」 → 「URL Generator」**
   - **SCOPES** にチェック
     - `bot`
     - `applications.commands`
   - **BOT PERMISSIONS** にチェック
     - `View Channels`
     - `Send Messages`
     - `Embed Links`
     - `Connect`
     - `Speak`
     - `Use Voice Activity`
6. 画面下部に生成された **Generated URL** をブラウザで開き、Bot を招待したいサーバーを選んで認可
7. （任意）Discord アプリを開いて **設定 → 詳細設定 → 開発者モード ON** にし、サーバー名を右クリック → **「サーバー ID をコピー」**
   - これが `DISCORD_GUILD_ID` の値

### `.env` への設定

```dotenv
DISCORD_TOKEN=（手順 3 でコピーしたトークン）
DISCORD_GUILD_ID=（任意、手順 7 のサーバー ID）
```

> 💡 `DISCORD_GUILD_ID` を指定すると、その Guild に対してのみコマンド登録され **即時反映**。未指定だとグローバル登録となり、最大 1 時間ほど反映ラグが発生する。

### 疎通確認

```powershell
.\.venv\Scripts\Activate.ps1
python scripts\test_discord.py
```

成功すると Bot 自身の情報（ID / Username）と、参加サーバー一覧が表示される。

```
== Bot 情報 (GET /users/@me) ==
  ID         : 123456789012345678
  Username   : meetingBot#0
  Bot        : True
  ...
== 参加サーバー (GET /users/@me/guilds) ==
  - [OWNER] My Server (id: 987654321098765432)
=== 疎通成功 ===
```

### よくあるトラブル

| 症状 | 原因 / 対処 |
| --- | --- |
| `401 Unauthorized` | トークン不一致。Reset Token をやり直して `.env` を更新 |
| `参加サーバーなし` | Bot をサーバーに招待していない。手順 5〜6 をやり直す |
| `/start` 実行で `Unknown interaction` | 同じトークンで Bot が 2 重起動している。プロセスを kill（README の「Bot 2重起動」項参照）|
| スラッシュコマンドが見えない | `applications.commands` スコープ漏れ。再招待 |
| VC で音声が拾えない | `Connect` / `Use Voice Activity` 権限不足、または Privileged Intents 未有効 |

---

## 2. Notion

### 用途

`src/notion.ts` が Notion API を叩いて議事録 DB に新規ページを作成する。
要約結果（タイトル / タグ / 概要 / 議題 / 決定事項 / ToDo / 次回確認事項）と Drive リンクを書き込む。

### 前提

議事録用の Notion データベースが既に作成済みであること。**最低限以下のプロパティが必要**（実装と一致）：

| プロパティ名 | 型 | 用途 |
| --- | --- | --- |
| タイトル | Title | 自動生成された議事録タイトル |
| 日付 | Date | 会議開始時刻 |
| 会議時間(分) | Number | 録音時間 |
| 参加者 | Multi-select | 発話者名（任意） |
| タグ | Multi-select | `定例` / `顧客MTG` / `プロジェクト` / `1on1` / `その他` |
| ステータス | Status | `完了` 等 |
| 決定事項 | Rich text | 箇条書きテキスト |
| ToDo数 | Number | ToDo の件数 |
| 音声ファイル | URL | Drive 上の MP3 リンク |
| 文字起こし | URL | Drive 上の transcript.json リンク |

タグの選択肢は **DB 側に上記 5 つを事前登録**しておくこと（要約 LLM の出力と一致しない場合「未知のタグをスキップ」警告が出る）。

### セットアップ手順

1. [Notion My Integrations](https://www.notion.so/profile/integrations) を開く
2. **「+ New integration」** をクリック
3. 設定項目
   - **Name**: 任意（例: `meetingBot`）
   - **Associated workspace**: DB が存在するワークスペース
   - **Type**: `Internal`
4. **「Save」** で作成 → 表示される **Internal Integration Token**（`secret_xxxxxxxx...`）をコピー
   - **これが `NOTION_API_KEY` の値**
5. Notion で議事録 DB のページを開く
6. ページ右上 **「...」 → 「+ Add Connections」** から、手順 4 で作った integration を選択して接続
   - これを忘れると API は一律 `404 Not Found` を返す（最も多いハマりどころ）
7. 同じ DB ページの URL から ID を取得

   ```
   https://www.notion.so/<workspace>/<DB_ID>?v=<view_id>
                                   ^^^^^^^
                                   この 32 文字（ハイフンなし）が DATABASE_ID
   ```

   - **これが `NOTION_DATABASE_ID` の値**

### `.env` への設定

```dotenv
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 疎通確認

```powershell
.\.venv\Scripts\Activate.ps1
python scripts\test_notion.py
```

成功すると DB 名とプロパティ一覧が表示される。

```
=== 接続成功 ===
DB名         : 議事録
プロパティ数 : 11

プロパティ一覧:
  - タイトル (title)
  - 日付 (date)
  - 会議時間(分) (number)
  ...
```

### よくあるトラブル

| 症状 | 原因 / 対処 |
| --- | --- |
| `404 Not Found` | DB に integration を **Add Connections** していない。手順 6 をやり直す |
| `400 Bad Request: object_not_found` | `NOTION_DATABASE_ID` の桁数違い。32 文字（ハイフンなし）か確認 |
| `401 Unauthorized` | トークン不正。Integrations 画面で再発行 |
| 「未知のタグをスキップ」警告 | DB のタグ Multi-select に `定例` / `顧客MTG` / `プロジェクト` / `1on1` / `その他` を事前登録 |
| プロパティ書き込み失敗 | DB のプロパティ名・型が上記表と一致するか確認（日本語名・全角括弧含めて完全一致が必要）|

---

## 3. Google Drive

### 用途

`src/drive.ts` が `meetingBot/<YYYY-MM>/<sessionId>/` 配下に MP3・transcript.json・summary.json をアップロードする。
最小権限スコープ `drive.file` を使うため、**この Bot がアップロードしたファイルにのみアクセス可能**（既存の Drive ファイルは読まない）。

### セットアップ手順

#### 3-1. GCP プロジェクトと Drive API 有効化

1. [Google Cloud Console](https://console.cloud.google.com/) を開く
2. 上部のプロジェクト選択 → **「新しいプロジェクト」** → 任意の名前（例: `meetingbot`）で作成
3. 左メニュー **「APIs & Services」 → 「Library」**
4. `Google Drive API` を検索 → **「Enable」**

#### 3-2. OAuth 同意画面の設定

1. **「APIs & Services」 → 「OAuth consent screen」**
2. **User Type** は `External` を選択 → **Create**
3. 必須項目を埋める
   - **App name**: `meetingbot` 等
   - **User support email**: 自分の Gmail
   - **Developer contact**: 自分の Gmail
4. **Scopes** ステップで `https://www.googleapis.com/auth/drive.file` を追加
5. **Test users** ステップで **自分の Google アカウントを追加**
   - 公開（Production）申請しない限り、ここに登録したアカウントだけが認可可能
6. 保存して同意画面を **`Testing`** ステータスのままにする（個人利用ならこれで十分）

#### 3-3. OAuth クライアント ID 作成

1. **「APIs & Services」 → 「Credentials」**
2. 上部 **「+ CREATE CREDENTIALS」 → 「OAuth client ID」**
3. **Application type**: `Desktop app`
4. **Name**: 任意（例: `meetingbot-desktop`）
5. **「CREATE」** → 表示されたダイアログから **「DOWNLOAD JSON」** で client_secret JSON をダウンロード
6. ダウンロードしたファイルを **`C:\git\meetingBot\credentials.json`** にリネームして配置
   - このファイル名・配置場所は `.env` の `GOOGLE_DRIVE_CREDENTIALS` で指定する。既定は `credentials.json`（プロジェクトルート相対）
   - **`credentials.json` は gitignore 済み。リポジトリにコミットしないこと**

#### 3-4. refresh_token 取得（OAuth 認可フロー実行）

```powershell
.\.venv\Scripts\Activate.ps1
python scripts\test_drive.py
```

実行すると：

1. ブラウザが自動で開く
2. 手順 3-2 で **テストユーザー登録した Google アカウント** でログイン
3. 「このアプリは確認されていません」警告が出たら → **「詳細」 → 「（安全でない）...に移動」** で続行
4. `meetingbot` のアクセス許可画面で **「許可」**
5. ターミナルに「認証成功」が表示され、`.env` に `GOOGLE_DRIVE_CREDENTIALS` と `GOOGLE_DRIVE_REFRESH_TOKEN` が **自動で書き込まれる**

成功すると以下のような出力。

```
=== 認証成功 ===
refresh_token: 1//0g_XXXX...XXXX (一部マスク)

.env に以下を保存しました：
  GOOGLE_DRIVE_CREDENTIALS=credentials.json
  GOOGLE_DRIVE_REFRESH_TOKEN=(取得した値)

== 疎通確認: Drive API files.list ==
(このアプリがアクセス可能なファイルはまだありません)
=== 疎通成功 ===
```

> 💡 `drive.file` スコープのため初回は「アクセス可能ファイルなし」が正常。Phase 5 のアップロード後から見えるようになる。

### `.env` への設定（自動書き込みされる内容）

```dotenv
GOOGLE_DRIVE_CREDENTIALS=credentials.json
GOOGLE_DRIVE_REFRESH_TOKEN=1//xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### よくあるトラブル

| 症状 | 原因 / 対処 |
| --- | --- |
| `アクセスがブロックされました: このアプリはGoogleのアプリではありません` | OAuth 同意画面の Test users に Google アカウント未登録 |
| `Error 403: access_denied` | OAuth 同意画面が `Testing` ステータスでログインアカウントが Test users に未追加 |
| `refresh_token が取得できませんでした` | 過去の許可が残っている。[Google アカウントの権限管理](https://myaccount.google.com/permissions) で `meetingbot` を取り消してから再実行 |
| `credentials.json が見つかりません` | パスが違う。`.env` の `GOOGLE_DRIVE_CREDENTIALS` を絶対パスにするか、`credentials.json` をプロジェクトルートに配置 |
| `invalid_grant` | refresh_token 期限切れ／取り消し。`scripts/test_drive.py` を再実行 |

---

## 4. Claude Code CLI

### 用途

`src/summarize.ts` が `child_process.spawn('claude', ['-p', prompt])` で Claude Code を **子プロセス起動** し、文字起こしテキストから議事録 JSON を生成する。

**API キー方式ではない。** Claude Code 本体のログイン状態（既存の Pro / Max サブスク）を流用するため、**追加コスト 0** で動く。サブスクのクォータを消費する点だけ注意。

### セットアップ手順

#### 4-1. Claude Code のインストール

[Claude Code 公式インストールガイド](https://docs.claude.com/en/docs/claude-code/overview) に従ってインストールする。
Windows で npm を使う場合の例：

```powershell
npm install -g @anthropic-ai/claude-code
```

> ⚠️ パッケージ名やインストール手順は公式ドキュメントが一次情報。バージョンによって変わる可能性があるため、必ず公式を確認すること。

#### 4-2. 初回ログイン

```powershell
claude
```

を実行し、対話画面で `/login` コマンドを使ってブラウザ経由のログインを完了する（既存の Anthropic Pro / Max サブスクのアカウントでログイン）。

#### 4-3. PATH 確認

```powershell
where.exe claude
```

実行ファイルパスが返れば OK。返らない場合は PATH 設定を見直す（Windows なら通常 `C:\Users\<you>\.local\bin\claude.exe` あたり）。

実行ファイルパスを明示したい場合は `.env` に以下を追加：

```dotenv
CLAUDE_BIN=C:\Users\<you>\.local\bin\claude.exe
```

未指定なら `claude`（PATH 解決）が使われる。

### 疎通確認

```powershell
claude -p "hello"
```

何らかの応答が返れば OK。

より実用的な検証として、サンプル文字起こしから要約 JSON を生成するスクリプトもある：

```powershell
.\.venv\Scripts\Activate.ps1
python scripts\test_summary_claude.py
```

または TypeScript 側の単体検証：

```powershell
npx tsx scripts\test_summarize.ts
```

### `.env` への設定

`.env` への必須設定は **なし**（CLI のログイン状態を使うため）。
任意で `CLAUDE_BIN`（実行ファイル絶対パス）と `SUMMARIZE_TIMEOUT_MS`（既定 600000 = 10分）を上書き可能。

### よくあるトラブル

| 症状 | 原因 / 対処 |
| --- | --- |
| `claude: command not found` / `'claude' は内部コマンドまたは外部コマンドとして認識されていません` | PATH 未設定。`where.exe claude` で確認、`.env` に `CLAUDE_BIN` で絶対パス指定 |
| 認証エラー / 期限切れ | `claude` 起動 → `/login` で再ログイン |
| クォータ枯渇で要約失敗 | 翌日まで待つ → `/resume` で続きから再開（README の `/resume` 項参照）|
| `claude -p timeout after Xms` | `SUMMARIZE_TIMEOUT_MS` を増やす。または文字起こしが長すぎないか確認 |
| stdout に JSON 以外が混じる / `failed to parse claude stdout as SummaryResult` | プロンプトと出力スキーマが一致しない可能性。`src/summarize.ts:69` の `buildPrompt()` を見直し、必要なら `claude -p` を直接叩いて出力を観察 |

---

## 🔐 セキュリティに関する注意

- `.env` / `credentials.json` は **絶対にコミット・共有しない**。両方とも `.gitignore` 済み
- トークン類が漏れた疑いがある場合は、各サービスの管理画面から **即座に Reset / 取り消し**
  - Discord: Bot ページ → Reset Token
  - Notion: Integration ページ → 「Refresh secret」 or 削除
  - Google: [権限管理](https://myaccount.google.com/permissions) でアプリを取り消し → `scripts/test_drive.py` で再取得
  - Claude Code: 通常はマシンローカルなのでマシン自体のセキュリティを確保
- 公開リポジトリにする場合、`.env.example` のテンプレ値が `your_xxx_here` のままか **必ず確認**

## 📖 一次情報リンク集

- [Discord Developer Portal](https://discord.com/developers/applications)
- [Discord OAuth2 ドキュメント](https://discord.com/developers/docs/topics/oauth2)
- [Notion API: Authorization](https://developers.notion.com/docs/authorization)
- [Notion API: Working with databases](https://developers.notion.com/docs/working-with-databases)
- [Google Cloud: OAuth 2.0 for Desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Drive API: Scopes](https://developers.google.com/drive/api/guides/api-specific-auth)
- [Claude Code Documentation](https://docs.claude.com/en/docs/claude-code/overview)
- [Claude Code Headless (`-p` mode)](https://docs.claude.com/en/docs/claude-code/sdk)
