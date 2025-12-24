# DisQord 実装進捗

本ドキュメントはcoding agent（Claude Code等）が進捗を把握するためのもの。

---

## 未完了タスク（ロードマップ）

### v1.2.0 - UI/UX改善

- [ ] Embed化（LLM応答をEmbed形式で表示）
- [ ] 時刻表記をDiscord Snowflakeタイムスタンプ形式に統一（`<t:UNIX:R>` など）

### v1.3.0 - インタラクティブUI

- [ ] Autocompleteでモデル選択（`/disqord model select`）

### v1.4.0 - コンテキスト対話（DBマイグレーションあり）

- [ ] 直近n件のコンテキスト保持（デフォルト5件、0-20件設定可能）
- [ ] システムプロンプト付与
- [ ] 自動期限切れ（デフォルト24時間、設定可能）
- [ ] `/disqord context clear` コマンド
- [ ] `/disqord config context-limit/context-ttl` コマンド

### v1.4.1 - リプライ元取得

- [ ] リプライ時に元メッセージもコンテキストに含める

### v1.4.2 - メッセージリンク取得

- [ ] 同一サーバ内メッセージリンクからコンテキスト取得

### v1.5.0 - 設定階層化（DBマイグレーションあり）

- [ ] 階層別モデル設定（Guild/Channel/User）
- [ ] カスタムプロンプト
- [ ] エラー出力詳細度設定

### v1.6.0 - 権限管理（DBマイグレーションあり）

- [ ] チャンネル制限
- [ ] 管理権限ロール

### v1.7.0 - Web Search

- [ ] Web Search機能（`:online`サフィックス）

### v1.8.0 - 複数モデル並列回答

- [ ] 複数モデル並列回答

---

## 完了済み

### v1.1.0 (2025-12-25) - リリースノート配信

- HTTPサーバー拡張（`/webhook/github`エンドポイント）
- GitHub Webhook署名検証（`X-Hub-Signature-256`、HMAC-SHA256）
- DBスキーマ変更（`release_channel_id`追加）
- リリース通知サービス実装（`ReleaseNotificationService`）
- `/disqord config release-channel [channel]`コマンド追加
- 型定義追加（`src/types/github.ts`）
- テスト追加（135テスト）
- インフラ設定完了（Coolify、Cloudflare Tunnel、GitHub Webhook）

### v1.1.0 (2025-12-24) - ユーザ向けエラー表示

- カスタムエラークラス導入（`src/errors/index.ts`）
  - `AppError`基底クラス + 9種類の派生クラス
  - `InvalidModelError`追加（400 + "is not a valid model ID"パターン）
  - `ModelUnavailableError`が500/502/503に対応
- OpenRouterClient更新（`handleErrorResponse`でエラー種別判定）
- レート制限設計改善
  - ユーザーレベル制限（`X-RateLimit-Reset`ヘッダーあり）→ グローバルフラグ
  - プロバイダーレベル制限（ヘッダーなし）→ フラグセットなし、他モデル即時使用可
- イベントハンドラ更新（`AppError`判定、`userMessage`表示）
- テスト追加（117テスト）

### v1.1.0 (2025-12-23) - 無料モデル限定機能

- OpenRouterモデル一覧取得の拡張（`listModelsWithPricing()`）
- 無料モデル一覧のキャッシュ機構（TTL: 1時間、`noCache`オプション対応）
- Guild設定に`freeModelsOnly`フラグ追加（DBマイグレーション対応）
- `/disqord model set`時のバリデーション（無料制限時は無料モデルのみ許可）
- `/disqord config free-only <on|off>`コマンド追加
- ModelService新規作成（キャッシュ + 無料判定ロジック）
- テスト追加（79テスト、カバレッジ97.50%）

### v1.0.0 (2025-12-19)

全機能実装完了。Coolifyデプロイ、GitHub Actions自動デプロイ設定済み。

- 基盤層: Config、Database、Repository、Types、Utils
- サービス層: SettingsService、ChatService
- LLM層: OpenRouterClient（chat、listModels、getCredits、レート制限）
- Bot層: Client、イベントハンドラ、スラッシュコマンド
- テスト: ユニットテスト、統合テスト（カバレッジ98.71%）
- デプロイ: Dockerfile、Coolify、GitHub Actions

### v1.0.1 (2025-12-19)

- Health Check対応（`/health`エンドポイント）
- Typing Indicator継続表示
- URL埋め込み抑制
- health.test.ts追加

---

## 更新履歴

| 日付 | 内容 |
| ---- | ---- |
| 2025-12-25 | v1.4.0コンテキスト対話設計、v1.4.1/v1.4.2追加 |
| 2025-12-25 | v1.2.0〜v1.8.0ロードマップ策定 |
| 2025-12-25 | インフラ設定完了（Coolify、Cloudflare Tunnel、GitHub Webhook） |
| 2025-12-25 | インフラ設定ドキュメント更新（Coolify向け）、ローカルテスト手順追加 |
| 2025-12-25 | リリースノート配信機能実装完了（インフラ設定除く） |
| 2025-12-24 | InvalidModelError追加、レート制限設計改善 |
| 2025-12-24 | ユーザ向けエラー表示機能実装完了 |
| 2025-12-23 | 無料モデル限定機能実装完了 |
| 2025-12-23 | ドキュメント整理: 未完了を先頭に、完了済みを縮小 |
