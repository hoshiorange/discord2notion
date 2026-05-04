# 議事録Bot (discord2notion)

Discord ボイスチャンネルでの会議を **録音 → 文字起こし → 要約 → クラウド保存** まで自動化する Bot。

リポジトリ: <https://github.com/hoshiorange/discord2notion>

## 何ができるか

```
/start  →  Discord VC に参加して録音開始
   ↓
/stop（または VC 全員退出 / 8時間タイムアウト）
   ↓
   1. ユーザー別音声を MP3 にミックス
   2. Whisper で日本語文字起こし（ユーザー別に話者識別）
   3. Claude Code で議事録要約
   4. 音声・文字起こし・要約を Google Drive にアップロード
   5. Notion 議事録 DB に新規ページ作成（末尾に発言時間サマリを自動挿入）
   ↓
Discord に完了通知（Drive / Notion へのリンク付き）
```

すべて自動。会議が終わったら数分後には Notion に議事録ページができている。

### 話者識別

ユーザー別の `.opusraw` をそれぞれ Whisper にかけて発話タイムラインをマージするため、**誰がいつ何を話したか**まで識別される。Notion ページ末尾には参加者ごとの**発言時間サマリ**が自動で挿入される。

途中ステージ（要約 / Drive / Notion 等）が一時的に失敗しても `pipeline-state.json` に状態が永続化されるため、`/resume` で続きから再開できる。詳細は [スラッシュコマンド](#スラッシュコマンド) を参照。

### 同時録音は 1 セッションのみ

1 つの Bot プロセスで同時に録音できるのは **1 サーバ × 1 ボイスチャンネル** だけ。録音中に別サーバ / 別 VC で `/start` を打つと、既存セッションは保護されたまま **2 つ目はエラー（録音中の guild / channel / 経過時間を表示）で弾かれる**。

複数サーバで同時に議事録を録音したい場合は、各サーバの管理者がそれぞれ **自分の Bot Application を Discord Developer Portal で作成し、自分の PC で別プロセスとして起動**する運用が標準（Bot Token は Bot Application ごとに別。同じ Token で複数プロセスは動かない）。

## 必要な環境

ローカルマシンで常駐する前提。クラウドにデプロイするなら GPU 付きインスタンスが必要。

### ハードウェア / ランタイム

| 種別 | 要件 | 必須 / 任意 |
| --- | --- | --- |
| OS | Windows 11（macOS / Linux でも動く想定だが未検証） | 必須 |
| Node.js | 24.x（LTS 20.x でも動くはず） | 必須 |
| Python | 3.12+（`.venv` 推奨） | 必須 |
| FFmpeg | 8.x | 必須 |
| Git | 任意のバージョン | 必須 |
| GPU | NVIDIA GPU（CUDA 対応）— Whisper 文字起こし用 | 推奨（CPU でも動くが大幅に遅い）|

### 外部サービス

| サービス | 用途 |
| --- | --- |
| Discord Bot | VC 参加 / 音声受信 / スラッシュコマンド |
| Notion Integration | 議事録 DB へのページ作成 |
| Google Drive OAuth | 音声・文字起こし・要約の保管 |
| Claude Code (ヘッドレス) | 議事録要約 |

各サービスのアカウント発行・トークン取得・権限設定の詳しい手順は [`docs/SETUP_EXTERNAL.md`](./docs/SETUP_EXTERNAL.md) にまとめている。

## 初期セットアップ（git clone → 動くまで）

新しいマシンでゼロから立ち上げる手順。

### 1. リポジトリ取得

```powershell
git clone https://github.com/hoshiorange/discord2notion.git meetingBot
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

ヘッドレスモード（`claude -p`）で要約に使用。インストール後 `claude --version` で確認。詳細は [Anthropic Docs](https://docs.claude.com/en/docs/claude-code/overview) 参照。

### 6. 外部サービスのセットアップと `.env` 作成

Discord / Notion / Google Drive のアカウント発行・トークン取得・権限設定は **手順がそこそこ多い** ので [`docs/SETUP_EXTERNAL.md`](./docs/SETUP_EXTERNAL.md) に分離している。一通り済ませると `.env` が完成する。

ざっくり：

```powershell
Copy-Item .env.example .env
notepad .env
```

で雛形を作り、[`docs/SETUP_EXTERNAL.md`](./docs/SETUP_EXTERNAL.md) の手順に沿って各値を埋める。

### 7. 動作確認

```powershell
npm run typecheck   # TypeScript エラーなし
npm run lint        # ESLint pass
npm run build       # dist/ 生成
npm start           # Bot 起動
```

Bot がログインしたら、招待先の Discord サーバーで `/start` を試す。スラッシュコマンドの初回反映には `DISCORD_GUILD_ID` 設定有り → 即時、無し → 最大1時間かかる。

## 初回設定済みの場合の起動手順

`.env` 設定や依存インストールが済んでいる環境（自分の PC を再起動した時、別日に再開する時など）でこの Bot を起動するには：

```powershell
cd C:\git\meetingBot
npm start
```

これだけ。**PowerShell ウィンドウは閉じない**こと（閉じるとプロセスが終了する）。常駐させたい場合はそのまま開きっぱなしにする。

`npm start` は `dist/index.js` を実行するため、ソース変更後は事前に `npm run build` が必要。
普段から `.ts` を編集して即反映させたい場合は代わりに `npm run dev`（tsx watch）を使う。

### 起動後の確認

- コンソールに `✅ Logged in as <BotName>#<discriminator>` と表示される
- Discord の Bot ステータスがオンラインになる
- Discord で `/status` を打って `🟢 録音していません` が返れば正常

### 中断したパイプラインがある場合

前回起動時に `/stop` 後の文字起こし／要約／Drive／Notion のいずれかで失敗していたセッションがあれば、`/resume` で再開できる。詳細は [スラッシュコマンド](#スラッシュコマンド) を参照。

## 起動方法（npm scripts 一覧）

| コマンド | 用途 |
| --- | --- |
| `npm start` | 本番（dist/ から起動）|
| `npm run dev` | 開発（tsx でホットリロード）|
| `npm run build` | TypeScript → dist/ |
| `npm run typecheck` | TypeScript の型チェックのみ |
| `npm run lint` | ESLint |
| `npm run format` | Prettier 自動整形 |

### Windows PowerShell でのコンソール文字化け

Windows PowerShell（既定 Shift_JIS）で起動するとコンソールへのログ出力が文字化けする場合がある。`npm start` の前に以下を一度打って **コードページを UTF-8 に切り替える**：

```powershell
chcp 65001
npm start
```

そのウィンドウを閉じると元に戻るので、毎回必要。常時 UTF-8 環境にしたい場合は以下のいずれか：

- PowerShell プロファイル（`$PROFILE`）に `chcp 65001 | Out-Null` を追記
- Windows Terminal を使用（既定で UTF-8）
- VS Code 統合ターミナルを使用（既定で UTF-8）

なお `logs/` 配下のログファイル自体は UTF-8 で正しく書かれているので、文字化けはコンソール表示時だけの問題。ファイル内容に影響はない。

## スラッシュコマンド

Bot が招待されたサーバーのテキストチャンネルで以下が使える：

| コマンド | 引数 | 動作 |
| --- | --- | --- |
| `/start` | なし | 自分が居る VC に Bot 参加、録音開始。録音中は再度の `/start` は拒否 |
| `/stop` | なし | 録音停止 → MP3 → 文字起こし → 要約 → Drive → Notion を一気通貫で実行。各段階の進捗が Discord 上に表示される |
| `/status` | なし | 現在の録音状態（VC名、経過時間、受信フレーム数）を表示 |
| `/resume` | `session_id`（任意） | 途中で失敗したパイプラインを再開。引数なしなら最新の未完セッション、`session_id` 指定なら特定セッションを再開 |

VC から全員退出した場合 / 録音時間上限（既定 8 時間）に達した場合も、`/stop` 相当のパイプラインが自動実行される。

### `/resume` の使いどころ

- Claude のクォータ枯渇で要約が落ちた → 翌日 `/resume` で再開
- Drive の認証が切れて失敗 → トークン更新後 `/resume`
- Notion API が一時的に 5xx を返した → `/resume`

完了済みステージ（例: 文字起こし＋要約まで成功）はスキップされ、失敗したステージ以降のみ再実行される。`recordings/<sessionId>/pipeline-state.json` に状態が保存されている。

## アーキテクチャ概略

```
src/
├─ index.ts          # エントリポイント。Discord Client、コマンド登録、VoiceStateUpdate ハンドラ、graceful shutdown、cleanup スケジューラ
├─ commands/
│   ├─ index.ts      # コマンド束ね
│   ├─ start.ts      # /start: VC 参加と録音開始
│   ├─ stop.ts       # /stop: 録音停止 + 段階的パイプライン実行
│   ├─ status.ts     # /status: 録音状態表示
│   └─ resume.ts     # /resume: 失敗パイプラインの再開
├─ voice.ts          # VoiceManager: VC 接続・Opus パケット受信・ファイル書き込み・自動再接続
├─ audio.ts          # processSession: .opusraw → PCM → MP3 ミックス（FFmpeg）+ ユーザー別 WAV 生成
├─ transcribe.ts     # Whisper CLI ラッパー（Python 子プロセス）
├─ summarize.ts      # Claude Code ヘッドレスで議事録要約
├─ drive.ts          # Google Drive アップロード（同名ファイル上書き対応 / Guild 別フォルダ階層）
├─ notion.ts         # Notion 議事録ページ生成（話者別発言時間サマリ含む）
├─ pipeline.ts       # 文字起こし→要約→Drive→Notion を順次実行＋ pipeline-state.json 永続化
├─ cleanup.ts        # 古い完了済みセッションの自動クリーンアップ（起動時 + 24h 間隔）
├─ logger.ts         # pino ベースのロガー（日次ローテート + 自動削除）
└─ config.ts         # Guild 別の Notion / Drive 認証情報を解決（config/guilds/<guildId>.json）

scripts/
├─ transcribe.py     # Faster-Whisper CLI（音声 → JSON）。setup_cuda_paths() で Windows DLL 問題に対応
├─ test_whisper.py   # Whisper 動作確認
├─ test_notion.py    # Notion API 疎通
├─ test_discord.py   # Discord Bot Token 疎通
├─ test_drive.py     # Drive OAuth 認可フロー（refresh_token 取得）
├─ test_summary_claude.py    # Claude Code 要約検証
├─ test_audio.ts     # audio.ts 単体検証
├─ test_transcribe.ts        # transcribe.ts 単体検証
├─ test_summarize.ts         # summarize.ts 単体検証
├─ test_drive_upload.ts      # drive.ts 単体検証
├─ test_notion_page.ts       # notion.ts 単体検証
├─ test_cleanup.ts           # cleanup.ts 単体検証
├─ test_logger.ts            # logger.ts 単体検証
├─ test_voice_reconnect.ts   # Voice 自動再接続シナリオ検証
├─ test_speaker.ts           # 話者識別パイプライン検証
├─ test_stop_flow.ts         # /stop 経路の再現テスト
├─ test_drive_dedup.ts       # Drive 同名ファイル上書き検証
├─ test_multiguild_config.ts # Guild 別 JSON ローダー検証
└─ test_guild_folder_name.ts # resolveGuildFolderName 純関数検証

recordings/<sessionId>/      # 録音セッションごとのファイル（gitignore 対象）
├─ <userId>.opusraw   # ユーザー別 Opus パケット（独自フォーマット: 4byte length + payload）
├─ mixed.mp3          # ミックス済み MP3
├─ transcript.json    # 文字起こし
├─ summary.json       # 要約
└─ pipeline-state.json # 各ステージの完了状況（/resume の判断材料）
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

### パイプライン途中失敗時の再開

`/stop` 後の文字起こし／要約／Drive／Notion のいずれかで失敗した場合は `recordings/<sessionId>/pipeline-state.json` に失敗ステージと完了済みステージが記録される。原因（クォータ／認証／一時的なネットワーク等）を解消した後、Discord で `/resume` を実行する。詳細は [スラッシュコマンド](#スラッシュコマンド) を参照。

### Notion タグ「未知のタグをスキップ」警告

- 原因: 要約 LLM が DB に存在しないタグ名を出力した
- DB 実値: `定例` / `顧客MTG` / `プロジェクト` / `1on1` / `その他`
- 対処:
  - 一時的: 警告を無視（タグ未設定でページは作られる）
  - 恒久: `src/summarize.ts` の prompt に登場するタグ語彙を DB の実値に合わせる、または DB 側に新しいタグオプションを追加

### Discord 通知に Notion URL が含まれない

- 原因: Notion ページ生成段階で失敗（前段の Drive アップロードまでで止まった）
- ログで `[pipeline] notion page failed:` を検索 → エラー内容を確認
- `/resume` で再開可能

### Drive 同名ファイルの重複

- 同じセッションフォルダ内に同名ファイルが既にあれば `files.update` で上書きされるため、`/resume` で Drive ステージを再実行しても重複しない
- 通常運用でもセッションごとに sessionId フォルダが分かれるため、別セッション間でも衝突しない
- `force: true` を指定した場合のみ常に新規作成となる（通常パスでは未使用）

### `.env` のシークレットが正しいのに認証エラー

- 改行や空白が混入していないか確認
- Notion / Discord / Google それぞれ Token / Refresh Token の有効期限・権限スコープを再確認
- `npx tsx scripts/test_*.ts` で個別モジュールを検証して切り分け

## 環境変数（必須・任意）

`.env.example` 参照。主要なもの：

**起動時必須**
- `DISCORD_TOKEN` — Bot 起動チェックでこれだけが必須

**Notion / Drive 関連（`.env` または `config/guilds/<guildId>.json` のいずれかに必要）**
- `NOTION_API_KEY` / `NOTION_DATABASE_ID`
- `GOOGLE_DRIVE_CREDENTIALS` / `GOOGLE_DRIVE_REFRESH_TOKEN`

これらは Bot 起動自体には不要だが、`/stop` 後のパイプライン（Drive アップロード / Notion ページ作成）で参照される。`.env` か Guild 別 JSON のどちらか一方に書かれていれば OK。両方とも空のまま `/start` すると該当ステージで失敗し、`pipeline-state.json` に記録された上で `/resume` 可能。

> **取得方法は [`docs/SETUP_EXTERNAL.md`](./docs/SETUP_EXTERNAL.md) を参照**（Discord Bot Token / Notion Integration & DB ID / Google Drive OAuth credentials & refresh token / Claude Code CLI セットアップを 1 ファイルに集約）。

複数の Discord サーバで運用し **サーバごとに別 Notion DB / 別 Google アカウント** に振り分けたい場合は [`docs/MULTI_GUILD.md`](./docs/MULTI_GUILD.md) を参照（任意・1 サーバ運用なら `.env` 一本で OK）。

**任意（チューニング）**
- `DISCORD_GUILD_ID` — Guild 限定でコマンド即時反映
- `RECORDING_MAX_MINUTES` — 録音上限分（既定 480）
- `RECORDINGS_RETAIN_DAYS` — 完了済みセッションの保持日数。これより古いものは起動時 / 24h 周期で自動削除（既定 30）
- `TRANSCRIBE_TIMEOUT_MS` — Whisper タイムアウト（既定 600000）
- `SUMMARIZE_TIMEOUT_MS` — Claude 要約タイムアウト（既定 600000）
- `PYTHON_BIN` — Python 実行ファイル指定（既定 `.venv/Scripts/python.exe` 自動検出）
- `CLAUDE_BIN` — claude CLI 指定（既定 `claude`）

**ログ運用**
- `LOG_DIR` — ログ出力ディレクトリ（既定 `logs`）
- `LOG_LEVEL` — `trace` / `debug` / `info` / `warn` / `error` / `fatal` / `silent`（既定 `info`）
- `LOG_RETAIN_DAYS` — 古いログファイルの保持日数。これより古い `<LOG_DIR>/*.log` は起動時 + 24h 周期で自動削除（既定 14）
- `NODE_ENV` — `production` を指定すると pino-pretty が無効化され JSON 形式のファイル出力のみになる。それ以外は stdout に整形 + ファイル両方

ログは `logs/<YYYY-MM-DD>.log` に日次ローテートされ、`LOG_RETAIN_DAYS` 経過分は自動削除される。

## License & Contributions

This project is currently licensed under MIT (see [`LICENSE`](./LICENSE)).
The maintainer reserves the right to change the license for future versions.
Contributors agree that their contributions may be relicensed.

(本プロジェクトは現在 MIT ライセンスで公開されています。メンテナは将来
バージョンのライセンスを変更する権利を留保します。コントリビューターは、
自身のコントリビューションが再ライセンスされ得ることに同意したものとみな
されます。)

コントリビュート方法・PR / Issue の作法は [`CONTRIBUTING.md`](./CONTRIBUTING.md) を参照してください。
