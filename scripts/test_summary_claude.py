"""Claude Code ヘッドレス要約検証スクリプト（AIP-15）。

模擬議事録テキストを `claude -p` に渡して要約させ、所要時間と出力を確認する。
Phase 5 で Node.js から `child_process.spawn` で叩く想定の Python 版相当。

使い方:
  python test_summary_claude.py            # 短尺（10分相当・約1300字）
  python test_summary_claude.py --length long  # 長尺（30〜45分相当・約4500字）
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

PROMPT_TEMPLATE = """以下は Discord ボイスチャンネルでの会議の文字起こし（自動生成）です。
これを Notion に貼り付ける議事録としてまとめてください。
人物名は文字起こしに登場する形のまま使い、推測で補完しないでください。

# 出力フォーマット（Markdown）

## 概要
会議の目的と全体像を3行以内で。

## 議題と議論内容
箇条書きで議題ごとにまとめる。
- 議題: ...
  - 議論の要点: ...

## 決定事項
箇条書き。決まったことのみを書き、議論段階のものは含めない。

## ToDo
担当者ごとにアクションアイテムを抽出。
- [ ] 担当者: タスク（期限がある場合は記載）

## 次回までに確認すること
箇条書き。決定保留・要調査の項目。

---
以下が会議の文字起こしです：

{transcript}
"""

# 模擬議事録（10分相当・約1300字）
TRANSCRIPT_SHORT = """（14:00）
山田: お疲れ様です、議事録Bot プロジェクトのキックオフ会議を始めます。今日のアジェンダは3つです。Phase 2 のスコープ確認、スケジュール、リスク洗い出し。よろしくお願いします。
佐藤: よろしくお願いします。Phase 2 は Discord Bot の骨格作りでしたよね。
山田: はい。Node.js + TypeScript で discord.js v14 を使う想定です。Voice チャンネルに接続できる最小構成を1週間で作りたい。
佐藤: スラッシュコマンドは何を用意しますか？
山田: 三つだけ。/start で録音開始、/stop で停止、/status で現在の録音時間を返す。これで十分かなと。
鈴木: 録音対象は誰の音声ですか？全員？
山田: VCに参加している全員です。あとで個別ミックスできるようにユーザーごとに分けて保存します。
佐藤: ユーザー数の上限は決めますか？
山田: 暫定10人で。本番運用を見て調整します。
鈴木: 録音時間の上限は？
山田: 1時間にしましょう。それ以上の会議はそうそう無いですし、長時間運用のリスクも避けたい。
佐藤: スケジュールはどう考えてますか？
山田: Phase 2 を1週間、Phase 3 の音声処理を1週間、Phase 4 から 6 をまとめて2週間。トータル1ヶ月で MVP まで持っていきたい。
鈴木: タイト目ですね。リスクは？
山田: 一番怖いのは Discord Voice API の挙動が想定と違うこと。あと長時間録音時のメモリリークです。
鈴木: 最初に短時間（5分くらい）で動作確認して、徐々に時間を延ばしましょう。
佐藤: それと、録音停止後の音声ファイルが破損していないかの検証も毎回必要です。
山田: 確かに。検証フローもセットで考えます。
鈴木: 文字起こしは Faster-Whisper の large-v3-turbo を使うんでしたよね。RTX 3060 で動作確認済み。
山田: はい、Phase 1 で確認済みです。リアルタイム比35倍出てます。1時間音声なら2分弱で文字起こしできる計算。
佐藤: 要約は？
山田: Claude Code ヘッドレスで叩く方針に変更しました。元々 Gemini を予定してたけど、私のサブスクで賄えるなら追加コスト0で品質も期待できる。
佐藤: それも検証してから本実装ですよね。
山田: はい、Phase 1 の最後にAIP-15で検証します。今やってるところ。
鈴木: じゃあ次回までの宿題確認しましょう。
山田: 私が discord.js の Voice 周りの実装サンプル作ってきます。/start /stop /status の最小実装です。
佐藤: 私は録音ファイルの保存戦略を調べておきます。Opus → WAV 変換のタイミング、ユーザー別ミックスの方法。
鈴木: 私はテスト計画を作っておきます。短時間動作確認 → 中時間 → 長時間の段階テスト。
山田: 期限は来週月曜まで。次回は来週水曜日 14:00 で。
全員: お疲れさまでした。
（14:42 終了）
"""

# 模擬議事録（30〜45分相当・約4500字、参加者5人、議題7件）
TRANSCRIPT_LONG = """（14:00）
山田: お疲れ様です、議事録Botプロジェクトの第2回定例を始めます。今日はやることが多いので時間を意識していきましょう。アジェンダは7つ。Phase 2 の進捗共有、技術選定の確定、Phase 3 の設計、Phase 4 の連携方式、Phase 5 のNotionスキーマ、リスクと対策、最後に次回までの宿題確認です。
佐藤: よろしくお願いします。
鈴木: お願いします。
田中: あー、今日初参加の田中です。よろしくお願いします。
小林: 同じく途中参加で小林です。インフラ周りで関われればと。
山田: 田中さん小林さんよろしく。じゃあまず Phase 2 の進捗から。先週宿題でスラッシュコマンドの最小実装やってきました。/start /stop /status の3つです。動作確認はサンプルサーバーで完了。
佐藤: discord.js のバージョンは v14.x ですよね？
山田: はい、v14.16.3 で固定。Node は LTS の 20.x。
鈴木: えーと、Voice の方は？接続できました？
山田: できました、@discordjs/voice の最新版を使ってます。Opus エンコードのまま受け取れる構成。あとで Phase 3 で WAV にデコードします。
佐藤: いいですね。じゃあ次、技術選定の確定。文字起こしは Faster-Whisper で確定でしたよね？
山田: はい、large-v3-turbo で確定。RTX 3060 でリアルタイム比35倍出てます。
小林: GPU メモリどれくらい使います？
山田: ピーク 4GB くらいです。12GB 載ってるので余裕。
小林: 並列実行は？
山田: 同時に複数会議の文字起こしは想定してないので、シーケンシャルで十分です。
鈴木: 要約は Claude Code ヘッドレス採用で確定でしたよね。
山田: はい、AIP-15 の検証で品質OK確認済み。Gemini フォールバックは不要と判断。
田中: えーと、Claude のサブスクで賄えるんですか？
山田: 議事録は週1〜2回想定で、1回あたりサブスク枠の数%程度なので余裕です。
田中: 了解です。
山田: では Phase 3 の音声処理設計。佐藤さん、調査お願いしてた件どうでした？
佐藤: はい、調査結果まとめました。Discord から取れるのが Opus のフレームストリーム。これをユーザーごとに別ファイルで保存して、最後に FFmpeg で WAV にデコード、ミックス、MP3 にエンコード、という流れです。
鈴木: ユーザー別の音声ってメモリに溜めるんですか？
佐藤: いえ、ストリーミングでファイルに直書きします。1時間録音でもメモリ上は数MBで済みます。
山田: ファイル名規則は？
佐藤: `recordings/<sessionId>/<userId>.opus` で。あと FFmpeg のミックスは `amix` フィルタを使います。
小林: ディスク容量は？1時間でどれくらい？
佐藤: Opus は10人の会議で1時間あたり 50MB くらいです。WAV にすると 600MB くらい膨らむので一時的に大きくなりますが、MP3 に変換したあと WAV は削除します。
山田: いいですね。じゃあ Phase 4 の Node-Python 連携。鈴木さんどうですか？
鈴木: えー、`child_process.spawn` で Python の Whisper スクリプトを叩く方針で。標準入力に MP3 のパスを渡して、標準出力に JSON で文字起こし結果を返してもらう設計にします。
山田: タイムアウトは？
鈴木: 1時間音声で2分強で終わるので、タイムアウトは10分にしようかと。
佐藤: もし Python 側でクラッシュしたら？
鈴木: 標準エラーをキャプチャしてログ出力、Discord にエラー通知を投げる流れです。リトライは1回だけ自動でやります。
山田: 了解。次 Phase 5 の Notion スキーマ。AIP-11 で議事録DBの構造は確認済み。プロパティは11個ありました。
佐藤: えっと、すべて埋める必要は？
山田: いえ、必須はタイトル・日付・会議時間・参加者・タグくらいで、決定事項とToDoは要約結果から抽出して入れます。音声ファイルは Drive リンク、文字起こしは Drive の別ファイルリンクで。
小林: Drive のフォルダ構成は？
山田: ルート直下に `meetingBot/<YYYY-MM>/<sessionId>/` で、配下に音声ファイルと文字起こしを置きます。
小林: アクセス権限は？
山田: `drive.file` スコープなので Bot がアップロードしたものしか触れません。プライバシー的には安全。
鈴木: タグはどうやって決めるんですか？
山田: 要約 LLM に判定させます。「会議の内容から `定例` `キックオフ` `振り返り` `1on1` `その他` のいずれかを選んで」って指示する予定。
田中: あ、それいいですね。
山田: では、リスクと対策。今のところ把握してるのは…
佐藤: メモリリーク、Discord API の挙動、長時間録音の安定性ですよね。
山田: はい、それと API レート制限。Notion は無料無制限、Drive は十分余裕、Claude はサブスク枠内で。Gemini に切り替える可能性が出たら都度判断。
鈴木: あとはエラー時の通知方法。サイレント失敗が一番怖い。
山田: そうですね。エラーは Discord のチャンネルに必ず投稿する。あと Phase 6 で重点的にエラーハンドリング詰めます。
小林: デプロイ環境はどうします？常時起動？
山田: ローカルで常時起動の方針。Docker 化はオプションです。
小林: わかりました、デプロイ周りは私が見ます。
山田: 助かります。では次回までの宿題。私は Phase 2 の Voice 受信から MP3 出力までの最小パイプラインを実装します。
佐藤: 私は FFmpeg の amix の動作確認と、ユーザー別ミックスのサンプルコードを作ります。
鈴木: 私は Phase 4 の Node-Python 連携プロトタイプ。Whisper を spawn で叩くサンプル。
小林: 私は systemd でのデーモン化と、ログローテーションの設計をやります。
田中: 僕は何をすれば？
山田: 田中さんは Phase 5 の Notion ページ生成のプロトタイプお願いします。要約結果のJSON を Notion API でページ化する部分。
田中: 了解しました。
山田: 期限は全員来週月曜の朝までで。次回は来週水曜日 14:00、進捗共有と統合確認をします。
全員: お疲れ様でした。
（14:47 終了）
"""


def run_claude_summary(transcript: str) -> tuple[str, float, str]:
    """claude -p に要約を依頼し、stdout・所要秒・stderr を返す。"""
    prompt = PROMPT_TEMPLATE.format(transcript=transcript)

    start = time.perf_counter()
    result = subprocess.run(
        ["claude", "-p", prompt],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=300,
        stdin=subprocess.DEVNULL,
    )
    elapsed = time.perf_counter() - start

    if result.returncode != 0:
        print(f"ERROR (returncode={result.returncode})", file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        sys.exit(1)

    return result.stdout, elapsed, result.stderr


def main() -> None:
    parser = argparse.ArgumentParser(description="Claude Code ヘッドレス要約検証")
    parser.add_argument("--length", choices=["short", "long"], default="short",
                        help="使う模擬議事録の長さ (default: short)")
    args = parser.parse_args()

    transcript = TRANSCRIPT_LONG if args.length == "long" else TRANSCRIPT_SHORT

    print(f"== Claude Code ヘッドレス要約検証 (AIP-15, {args.length}) ==")
    print(f"transcript length : {len(transcript)} chars")
    print(f"prompt length     : {len(PROMPT_TEMPLATE.format(transcript=transcript))} chars")
    print()
    print("claude -p 実行中...")
    print()

    summary, elapsed, stderr = run_claude_summary(transcript)

    print("=" * 60)
    print("【要約出力】")
    print("=" * 60)
    print(summary)
    print("=" * 60)
    print()
    print(f"所要時間   : {elapsed:.2f} 秒")
    print(f"出力長     : {len(summary)} chars")
    if stderr.strip():
        print(f"stderr     : {stderr.strip()[:200]}")

    # 検証結果をファイル保存
    out_dir = Path(__file__).resolve().parent.parent / "tmp"
    out_dir.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = out_dir / f"summary_{args.length}_{timestamp}.md"
    out_path.write_text(
        f"# Claude Code ヘッドレス要約検証結果 ({args.length})\n\n"
        f"- 日時: {datetime.now().isoformat()}\n"
        f"- transcript length: {len(transcript)} chars\n"
        f"- 所要時間: {elapsed:.2f}s\n\n"
        f"## 要約出力\n\n{summary}\n",
        encoding="utf-8",
    )
    print(f"\n保存先: {out_path.relative_to(Path.cwd()) if out_path.is_relative_to(Path.cwd()) else out_path}")


if __name__ == "__main__":
    main()
