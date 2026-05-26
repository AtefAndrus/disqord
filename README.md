# DisQord

Discord上でOpenRouter経由のLLMと対話するBot。メンションで呼び出す単発応答型。

## セットアップ

### 必要なもの

- [mise](https://mise.jdx.dev/)
- Discord Bot Token
- OpenRouter API Key

### ローカル開発

```bash
mise install       # Bun を自動インストール
mise run setup     # bun install + .env コピー
# .env を編集して環境変数を設定
bun dev            # 起動
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

<!-- AUTO:ENV_VARS:START -->
| 変数名 | 必須 | 説明 |
| ------ | ---- | ---- |
| DISCORD_TOKEN | Yes | Discord Bot Token |
| DISCORD_APPLICATION_ID | Yes | Discord Application ID |
| OPENROUTER_API_KEY | Yes | OpenRouter API Key |
| DATABASE_PATH | No | SQLiteパス（デフォルト: `data/disqord.db`） |
| DEFAULT_MODEL | No | デフォルトモデル（デフォルト: `deepseek/deepseek-v4-flash:free`） |
| HEALTH_PORT | No | ヘルスチェック用HTTPポート（デフォルト: `3000`） |
| GITHUB_WEBHOOK_SECRET | No | GitHub Webhook署名検証用（リリース通知使用時は必須） |
<!-- AUTO:ENV_VARS:END -->

## コマンド一覧

<!-- AUTO:COMMANDS:START -->
| コマンド | 説明 |
| -------- | ---- |
| `/help` | DisQordの使い方を表示 |
| `/status` | Botのステータス（OpenRouter残高等）を表示 |
| `/model current` | 現在のデフォルトモデルを表示 |
| `/model set <model>` | デフォルトモデルを変更 |
| `/model list` | OpenRouterのモデル一覧ページへ |
| `/model refresh` | モデルキャッシュを更新 |
| `/config free-only <enabled>` | 無料モデル限定の切り替え |
| `/config release-channel [channel]` | リリース通知チャンネルを設定（省略で無効化） |
| `/config llm-details <enabled>` | LLM詳細情報表示の切り替え |
| `/config auto-reply add <channel>` | 自動応答チャンネルを追加 |
| `/config auto-reply remove <channel>` | 自動応答チャンネルを削除 |
| `/config auto-reply list` | 自動応答チャンネル一覧を表示 |
<!-- AUTO:COMMANDS:END -->

## ライセンス

MIT
