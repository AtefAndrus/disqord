# DisQord

Discord上でOpenRouter経由のLLMと対話するBot。メンションで呼び出す単発応答型。

## 機能

- **メンション呼び出し**: `@DisQord 質問` でLLMが応答
- **スラッシュコマンド**: `/disqord help`, `/disqord status`, `/disqord model`
- **Guild単位設定**: デフォルトモデル、無料モデル限定
- **リリース通知**: GitHub Release時に登録チャンネルへ自動通知
- **長文対応**: 2000文字超は分割送信

## セットアップ

### 必要なもの

- [Bun](https://bun.sh/) 1.3+
- Discord Bot Token
- OpenRouter API Key

### ローカル開発

```bash
# 依存関係インストール
bun install

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
| DATABASE_PATH | No | SQLiteパス（デフォルト: `data/disqord.db`） |
| DEFAULT_MODEL | No | デフォルトモデル（デフォルト: `deepseek/deepseek-r1-0528:free`） |
| HEALTH_PORT | No | ヘルスチェック用HTTPポート（デフォルト: `3000`） |
| GITHUB_WEBHOOK_SECRET | No | GitHub Webhook署名検証用（リリース通知使用時は必須） |

## コマンド一覧

| コマンド | 説明 |
| -------- | ---- |
| `/disqord help` | 使い方を表示 |
| `/disqord status` | Botのステータスを表示 |
| `/disqord model current` | 現在のモデルを表示 |
| `/disqord model set <model>` | モデルを変更 |
| `/disqord model list` | モデル一覧ページへ誘導 |
| `/disqord model refresh` | モデルキャッシュを更新 |
| `/disqord config free-only <on\|off>` | 無料モデル限定を切り替え |
| `/disqord config release-channel [channel]` | リリース通知チャンネルを設定 |
| `/disqord config llm-details <on\|off>` | LLM詳細情報表示を切り替え |

## ドキュメント

- [設計書](docs/design.md) - アーキテクチャ、DBスキーマ、エラー設計
- [進捗](docs/progress.md) - 実装状況、ロードマップ
- [インフラ設定](docs/infrastructure-setup.md) - Cloudflare Tunnel、GitHub Webhook設定

## Contributing

### 開発コマンド

```bash
bun dev            # 開発モード（ホットリロード）
bun test           # テスト実行（型チェック含む）
bun lint           # Biomeでリント
bun format         # Biomeでフォーマット
```

### コーディング規約

- TypeScript strict mode
- インターフェースには `I` プレフィックス（例: `ILLMClient`）
- Repository パターン + Service パターン
- 詳細は [CLAUDE.md](CLAUDE.md) を参照

### PR作成時

1. `bun test` が通ることを確認
2. `bun lint` でエラーがないことを確認
3. コミットメッセージは英語

## ライセンス

MIT
