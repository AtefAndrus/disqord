# DisQord 実装進捗

本ドキュメントはコーディングエージェントが進捗を把握するためのもの。

---

## 未完了タスク（ロードマップ）

| バージョン | 機能 | 備考 |
|-----------|------|------|
| v1.2.0 | Embed化 | LLM応答・エラー・リリース通知をEmbed形式に |
| v1.3.0 | モデル選択UI | Autocompleteでモデル選択 |
| v1.4.0 | コンテキスト対話 | 直近n件の会話履歴保持（DBマイグレーションあり） |
| v1.5.0 | 設定階層化 | Guild/Channel/User単位の設定（DBマイグレーションあり） |
| v1.6.0 | 権限管理 | チャンネル制限、管理ロール（DBマイグレーションあり） |
| v1.7.0 | Web Search | OpenRouter `:online` サフィックス |
| v1.8.0 | 複数モデル並列 | 複数モデルで同時回答 |

詳細設計は実装時に [design.md](design.md) へ追記する。

---

## 完了済み

### v1.1.1 (2025-12-26)

レジリエンス強化

- グローバルエラーハンドラー追加（`unhandledRejection`、`uncaughtException`）
- イベントハンドラのcatchブロック内エラーハンドリング追加

### v1.1.0 (2025-12-25)

リリースノート配信 + ユーザ向けエラー表示 + 無料モデル限定

- HTTPサーバー拡張（`/webhook/github`エンドポイント）
- GitHub Webhook署名検証（HMAC-SHA256）
- DBスキーマ変更（`free_models_only`、`release_channel_id`追加）
- カスタムエラークラス導入（9種類）
- レート制限設計改善（ユーザー/プロバイダーレベル区別）
- ModelService新規作成（キャッシュ + 無料判定）
- `/disqord config free-only`、`/disqord config release-channel` コマンド追加

### v1.0.1 (2025-12-19)

運用改善

- Health Check対応（`/health`エンドポイント）
- Typing Indicator継続表示
- URL埋め込み抑制

### v1.0.0 (2025-12-19)

初期リリース

- メンション呼び出し + 単発応答
- スラッシュコマンド（help、status、model current/set/list）
- Guild単位モデル設定
- OpenRouterClient（chat、listModels、getCredits、レート制限）
- SQLite + Repository パターン
- テスト: カバレッジ98%+
- デプロイ: Docker、Coolify、GitHub Actions
