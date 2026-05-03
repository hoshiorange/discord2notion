# 議事録Bot

Discord ボイスチャンネルでの会議を **録音 → 文字起こし → 要約 → クラウド保存** まで自動化するBot。

## 何ができるか

```
/start  →  Discord VC に参加して録音開始
   ↓
/stop（または VC 全員退出 / 8時間タイムアウト）
   ↓
   1. ユーザー別音声を MP3 にミックス
   2. Whisper で日本語文字起こし
   3. Claude Code で議事録要約
   4. 音声・文字起こし・要約を Google Drive にアップロード
   5. Notion 議事録 DB に新規ページ作成
   ↓
Discord に完了通知（Drive / Notion へのリンク付き）
```

すべて自動。会議終わったら数分後には Notion に議事録ページができている。

## 必要な環境

| 種別 | 要件 |
| --- | --- |
| OS | Windows 11（macOS / Linux でも動く想定だが未検証）|
| Node.js | 24.x（LTS 20.x でも動くはず）|
| Python | 3.12+（`.venv` 推奨）|
| GPU | NVIDIA GPU（CUDA 対応）— Whisper のため。CPU でも動くが遅い |
| その他 | FFmpeg 8.x、git |
| 外部サービス | Discord Bot、Notion Integration、Google Drive OAuth、Claude Code（ヘッドレス）|

ローカルマシンで常駐する前提。クラウドにデプロイするなら GPU 付きインスタンスが必要。

## セットアップ

### 1. リポジトリ取得

```powershell
git clone <repo-url> meetingBot
cd meetingBot
```

### 2. Python 環境

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install faster-whisper python-dotenv requests google-auth-oauthlib google-api-python-client
```

`scripts/test_whisper.py` で GPU 動作確認できる。CUDA DLL が見つからないエラーが出る場合は [トラブルシュート](#トラブルシュート) 参照。

### 3. Node.js 依存

```powershell
npm install
```

### 4. FFmpeg

```powershell
winget install Gyan.FFmpeg
```

`ffmpeg -version` でバージョン表示されれば OK。

### 5. Claude Code

ヘッドレスモードで要約に使用。インストール後 `claude --version` で確認。詳細は [Anthropic Docs](https://docs.claude.com/en/docs/claude-code/overview) 参照。

### 6. 各種 API キー取得

`.env` を作成（`.env.example` をコピー）して各値を埋める：

| キー | 取得方法 |
| --- | --- |
| `DISCORD_TOKEN` | [Discord Developer Portal](https://discord.com/developers/applications) で Bot 作成 → Token 発行。Privileged Intents（Server Members、Message Content）を有効化、サーバーに招待 |
| `DISCORD_GUILD_ID` | （任意）Discord で開発者モード ON → サーバー右クリック → ID コピー。指定すると Guild 限定でコマンド即時反映 |
| `NOTION_API_KEY` | [Notion My Integrations](https://www.notion.so/profile/integrations) で Internal Integration 作成 → Token を取得。議事録 DB に Integration を招待 |
| `NOTION_DATABASE_ID` | 議事録 DB の URL `https://www.notion.so/<ID>?v=...` の `<ID>` 部分 |
| `GOOGLE_DRIVE_CREDENTIALS` | GCP Console で OAuth Desktop クライアント作成 → JSON ダウンロード → `credentials.json` として配置（パスを指定）|
| `GOOGLE_DRIVE_REFRESH_TOKEN` | `scripts/test_drive.py` を実行すると OAuth 認可フロー → `.env` に自動書き込み |

### 7. 動作確認

```powershell
npm run typecheck   # TypeScript エラーなし
npm run lint        # ESLint pass
npm run build       # dist/ 生成
npm start           # Bot 起動
```

Bot がログインしたら、招待先の Discord サーバーで `/start` を試す。

## 起動方法

| コマンド | 用途 |
| --- | --- |
| `npm start` | 本番（dist/ から起動）|
| `npm run dev` | 開発（tsx でホットリロード）|
| `npm run typecheck` | TypeScript の型チェックのみ |
| `npm run lint` | ESLint |
| `npm run format` | Prettier 自動整形 |

## スラッシュコマンド

Bot が招待されたサーバーのテキストチャンネルで以下が使える：

| コマンド | 動作 |
| --- | --- |
| `/start` | 自分が居る VC に Bot 参加、録音開始。録音中は再度の `/start` は拒否 |
| `/stop` | 録音停止 → MP3 → 文字起こし → 要約 → Drive → Notion を一気通貫で実行。各段階の進捗が Discord 上に表示される |
| `/status` | 現在の録音状態（VC名、経過時間、受信フレーム数）を表示 |

VC から全員退出した場合 / 録音時間上限（既定 8 時間）に達した場合も、`/stop` 相当のパイプラインが自動実行される。

## アーキテクチャ概略

```
src/
├─ index.ts          # エントリポイント。Discord Client、コマンド登録、VoiceStateUpdate ハンドラ、graceful shutdown
├─ commands/
│   ├─ index.ts      # コマンド束ね
│   ├─ start.ts      # /start: VC 参加と録音開始
│   ├─ stop.ts       # /stop: 録音停止 + 段階的パイプライン実行
│   └─ status.ts     # /status: 録音状態表示
├─ voice.ts          # VoiceManager: VC 接続・Opus パケット受信・ファイル書き込み
├─ audio.ts          # processSession: .opusraw → PCM → MP3 ミックス（FFmpeg）
├─ transcribe.ts     # Whisper CLI ラッパー（Python 子プロセス）
├─ summarize.ts      # Claude Code ヘッドレスで議事録要約
├─ drive.ts          # Google Drive アップロード
├─ notion.ts         # Notion 議事録ページ生成
└─ pipeline.ts       # 文字起こし→要約→Drive→Notion を順次実行（自動退出経路で使用）

scripts/
├─ transcribe.py     # Faster-Whisper CLI（音声 → JSON）
├─ test_whisper.py   # Whisper 動作確認
├─ test_notion.py    # Notion API 疎通
├─ test_discord.py   # Discord Bot Token 疎通
├─ test_drive.py     # Drive OAuth 認可フロー（refresh_token 取得）
├─ test_summary_claude.py    # Claude Code 要約検証
├─ test_audio.ts     # audio.ts 単体検証
├─ test_transcribe.ts        # transcribe.ts 単体検証
├─ test_summarize.ts         # summarize.ts 単体検証
├─ test_drive_upload.ts      # drive.ts 単体検証
└─ test_notion_page.ts       # notion.ts 単体検証

recordings/<sessionId>/      # 録音セッションごとのファイル（gitignore 対象）
├─ <userId>.opusraw  # ユーザー別 Opus パケット（独自フォーマット: 4byte length + payload）
├─ mixed.mp3         # ミックス済み MP3
├─ transcript.json   # 文字起こし
└─ summary.json      # 要約
```

## トラブルシュート

### CUDA DLL 認識失敗（Windows）

`Could not find module 'cublas64_12.dll'` 等のエラーが Whisper 実行時に出る場合：

- 原因: venv 内の NVIDIA DLL が PATH に乗っていない
- 対処: `scripts/transcribe.py` 冒頭の `setup_cuda_paths()` で `os.add_dll_directory` + `PATH` 追加を実装済み。Python から `python scripts/transcribe.py <file>` で動かせば自動対応
- TypeScript 側からの起動でも同関数経由なので問題なし

### Bot 2重起動による interaction 衝突

「DiscordAPIError[10062]: Unknown interaction」が連発する場合：

- 原因: 同じトークンの Bot が2プロセス走っており、Discord interaction が両方に配信され取り合いになる
- 対処:
  ```powershell
  Get-Process node | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match 'dist/index.js' } | Stop-Process -Force
  ```
  古いプロセスを kill して再起動

### `.opusraw` が空または極端に小さい

- 原因: Discord Voice の Opus 受信ができていない
- 確認:
  - Bot に `Connect`, `Use Voice Activity` 権限があるか
  - Discord 側で Bot を `selfDeaf: false` で接続できているか（コードで対応済み）
  - 発話者が自動ミュート / プッシュトゥトーク無効になっていないか

### Notion タグ「未知のタグをスキップ」警告

- 原因: 要約 LLM が DB に存在しないタグ名を出力した
- DB 実値: `定例` / `顧客MTG` / `プロジェクト` / `1on1` / `その他`
- 対処:
  - 一時的: 警告を無視（タグ未設定でページは作られる）
  - 恒久: `src/summarize.ts` の prompt に登場するタグ語彙を DB の実値に合わせる、または DB 側に新しいタグオプションを追加

### Discord 通知に Notion URL が含まれない

- 原因: Notion ページ生成段階で失敗（前段の Drive アップロードまでで止まった）
- ログで `[pipeline] notion page failed:` を検索 → エラー内容を確認

### Drive 同名ファイルの重複

- 原因: 同じセッションフォルダに同名アップロードを繰り返すと、Drive 側で別 fileId として並んで作られる
- 通常運用ではセッションごとに sessionId フォルダが分かれるため発生しない
- 再アップロード時は手動で古いものを削除するのが現状の運用

### `.env` のシークレットが正しいのに認証エラー

- 改行や空白が混入していないか確認
- Notion / Discord / Google それぞれ Token / Refresh Token の有効期限・権限スコープを再確認
- `npx tsx scripts/test_*.ts` で個別モジュールを検証して切り分け

## 環境変数（必須・任意）

`.env.example` 参照。主要なもの：

**必須**
- `DISCORD_TOKEN`
- `NOTION_API_KEY`
- `NOTION_DATABASE_ID`
- `GOOGLE_DRIVE_CREDENTIALS`
- `GOOGLE_DRIVE_REFRESH_TOKEN`

**任意（チューニング）**
- `DISCORD_GUILD_ID` — Guild 限定でコマンド即時反映
- `RECORDING_MAX_MINUTES` — 録音上限分（既定 480）
- `TRANSCRIBE_TIMEOUT_MS` — Whisper タイムアウト（既定 600000）
- `SUMMARIZE_TIMEOUT_MS` — Claude 要約タイムアウト（既定 600000）
- `PYTHON_BIN` — Python 実行ファイル指定（既定 `.venv/Scripts/python.exe` 自動検出）
- `CLAUDE_BIN` — claude CLI 指定（既定 `claude`）

## ライセンス

UNLICENSED（個人利用想定）。
