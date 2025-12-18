# DisQord

## 概要

- Discord上でOpenRouter経由のLLMと対話するBot。メンションで呼び出す単発応答型。
- デフォルトモデルは `deepseek/deepseek-r1-0528:free`（環境変数・Guild単位で変更可）。
- Bun + discord.js + SQLite による軽量構成。

## 主な機能 (v1)

- 呼び出し: ギルド内メンションに対応。DMは非対応。会話履歴は保持せず毎回リセット。
- コマンド: `/disqord help` `/disqord status` `/disqord model current` `/disqord model set <model>` `/disqord model list`
- 応答: 2000文字超は分割送信。エラー時は種別を明示（レート制限、モデル、接続など）。
- レート制限: OpenRouterの429レスポンスに含まれる `X-RateLimit-*` を確認し、Reset時刻まで送信を抑制。

## 技術スタック・運用

- 言語/ランタイム: TypeScript + Bun
- Discordライブラリ: discord.js
- DB: SQLite（`data/disqord.db`。コンテナではボリューム永続化を想定）
- ホスティング: DockerfileをCoolifyでデプロイ（mainブランチのみ）。developブランチはローカル開発用。

## デプロイ

### Docker

```bash
# ビルド
docker build -t disqord .

# 実行（ボリュームマウントでSQLite永続化）
docker run -d \
  -e DISCORD_TOKEN=your_token \
  -e DISCORD_APPLICATION_ID=your_app_id \
  -e OPENROUTER_API_KEY=your_api_key \
  -e NODE_ENV=production \
  -v disqord-data:/app/data \
  --name disqord \
  disqord
```

### Coolify

1. GitHubリポジトリを接続
2. ビルド設定: Dockerfile（自動検出）
3. 環境変数を設定:
   - `DISCORD_TOKEN`
   - `DISCORD_APPLICATION_ID`
   - `OPENROUTER_API_KEY`
   - `NODE_ENV=production`
4. ストレージ: `/app/data` にボリュームをマウント（SQLite永続化）
5. デプロイ実行

### 自動デプロイ（GitHub Release）

GitHub Releaseを作成すると、GitHub Actions経由でCoolifyへ自動デプロイされる。

**必要なGitHubシークレット:**
- `COOLIFY_TOKEN`: CoolifyのAPIトークン
- `COOLIFY_WEBHOOK`: CoolifyのWebhook URL

```bash
# リリース作成例
gh release create v1.0.0 --title "v1.0.0" --notes "Release notes here"
```

### 注意事項

- SQLiteファイルは `/app/data/disqord.db` に保存される
- コンテナ再起動でデータが消えないよう、必ずボリュームをマウントすること
- コンテナはnon-rootユーザー（bun）で実行される

## 開発環境構築手順

1. 初回セットアップ: `mise run setup`
2. 起動: `bun dev`（本番: `bun start`）
3. 型チェック: `bun typecheck`
4. テスト: `bun test`（ウォッチ: `bun test:watch`、カバレッジ: `bun test:coverage`）
5. Lint/整形: `bun lint` / `bun format`

### 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| DISCORD_TOKEN | Yes | Discord Bot Token |
| DISCORD_APPLICATION_ID | Yes | アプリケーションID |
| OPENROUTER_API_KEY | Yes | OpenRouter API Key |
| NODE_ENV | No | production / development（デフォルト: development） |
| DATABASE_PATH | No | SQLiteパス（デフォルト: data/disqord.db） |
| DEFAULT_MODEL | No | デフォルトLLMモデル（デフォルト: deepseek/deepseek-r1-0528:free） |

## ディレクトリ

- `src/` Bot本体（client, events, commands, services, llm, db, config, utils, types）
- `tests/` bun:test 用のユニット・統合テスト
- `docs/` 機能・非機能要件および設計書
- `data/` SQLiteファイル（gitignore済み）
- `tmp/` 補助スクリプト

## 現状

**v1.0.0 リリース済み** (2025-12-19)

- 全機能実装完了
- Coolifyデプロイ完了
- GitHub Release自動デプロイ設定済み

詳細は [進捗チェックリスト](docs/disqord-progress.md) を参照。
