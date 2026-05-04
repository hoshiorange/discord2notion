# Contributing

discord2notion へのコントリビュートを検討いただきありがとうございます。Issue / Pull Request を送る前に以下をご一読ください。

## License & Contributions

This project is currently licensed under MIT (see [`LICENSE`](./LICENSE)).
The maintainer reserves the right to change the license for future versions.
Contributors agree that their contributions may be relicensed.

(本プロジェクトは現在 MIT ライセンスで公開されています。メンテナは将来
バージョンのライセンスを変更する権利を留保します。コントリビューターは、
自身のコントリビューションが再ライセンスされ得ることに同意したものとみな
されます。)

## Issue

### バグ報告

以下を含めてください：

- 再現手順
- 期待動作と実際の挙動
- 環境（OS、Node.js / Python のバージョン、GPU の有無）
- 関連ログ（`logs/` 配下、機密情報は伏せて）

### 機能要望

ユースケースと「なぜそれが必要か」を明記してください。

### 質問

[`README.md`](./README.md) と [`docs/SETUP_EXTERNAL.md`](./docs/SETUP_EXTERNAL.md) を先にご確認ください。

## Pull Request

1. Fork してブランチを作成（例: `feature/<name>` / `fix/<name>`）
2. 変更を実装、以下がすべて pass することを確認：
   ```bash
   npm run typecheck
   npm run lint
   npm run build
   ```
3. コミットメッセージは日本語または英語、簡潔に
4. PR description に **変更内容** と **動作確認方法** を記載

CI（GitHub Actions）が `typecheck / lint / build` を自動チェックします。

## コードスタイル

- **TypeScript**: ESLint v9 + Prettier 設定済み（[`.prettierrc.json`](./.prettierrc.json) / [`eslint.config.js`](./eslint.config.js)）
- **Python**（`scripts/` 配下）: 既存スタイルに合わせる

## 機密情報の取り扱い

- `.env` / `credentials.json` / トークン値などの実値はコミットや Issue / PR に含めないでください
- `.env.example` にはプレースホルダのみ記載
