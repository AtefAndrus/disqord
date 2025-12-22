# DisQord

Discord上でOpenRouter経由のLLMと対話するBot。メンションで呼び出す単発応答型。

## 機能

- メンション呼び出し: `@DisQord 質問`
- スラッシュコマンド: `/disqord help`, `/disqord status`, `/disqord model`
- Guild単位でモデル設定可能
- 2000文字超は分割送信

## セットアップ

### 必要なもの

- [Bun](https://bun.sh/) 1.3+
- Discord Bot Token
- OpenRouter API Key

### ローカル開発

```bash
# 初回セットアップ
mise run setup

# .envを編集して環境変数を設定
cp .env.example .env

# 起動
bun dev
```

### Docker

```bash
docker build -t disqord .
docker run -d \
  -e DISCORD_TOKEN=your_token \
  -e DISCORD_APPLICATION_ID=your_app_id \
  -e OPENROUTER_API_KEY=your_api_key \
  -v disqord-data:/app/data \
  disqord
```

## 環境変数

| 変数名 | 必須 | 説明 |
| ------ | ---- | ---- |
| DISCORD_TOKEN | Yes | Discord Bot Token |
| DISCORD_APPLICATION_ID | Yes | Discord Application ID |
| OPENROUTER_API_KEY | Yes | OpenRouter API Key |
| DATABASE_PATH | No | SQLiteパス（デフォルト: data/disqord.db） |
| DEFAULT_MODEL | No | デフォルトモデル（デフォルト: deepseek/deepseek-r1-0528:free） |

## ドキュメント

詳細は [docs/](docs/) を参照:

- [要件定義書](docs/requirements.md) - 機能・非機能要件
- [設計書](docs/design.md) - アーキテクチャ、DBスキーマ
- [進捗](docs/progress.md) - 実装状況
- [テスト計画](docs/test-plan.md) - テスト戦略

## ライセンス

MIT
