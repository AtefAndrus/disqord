# DisQord 実装進捗

本ドキュメントはcoding agent（Claude Code等）が進捗を把握するためのもの。

---

## 未完了タスク

### v1.1.0

#### ユーザ向けエラー表示

- [ ] カスタムエラークラス導入（`src/errors/index.ts`）
  - `AppError`基底クラス
  - `RateLimitError`, `InsufficientCreditsError`, `ModerationError`等
- [ ] OpenRouterClient更新（`handleErrorResponse`でエラー種別判定）
- [ ] イベントハンドラ更新（`AppError`判定、`userMessage`表示）
- [ ] テスト追加

#### リリースノート配信

- [ ] HTTPサーバー拡張（`/webhook/github`エンドポイント）
- [ ] GitHub Webhook署名検証（`X-Hub-Signature-256`）
- [ ] DBスキーマ変更（`release_channel_id`追加）
- [ ] リリース通知サービス実装
- [ ] `/disqord config release-channel`コマンド追加
- [ ] Cloudflare Tunnel設定
- [ ] GitHubリポジトリにWebhook設定

---

### v2以降（将来）

- [ ] リプライ継続対話
- [ ] スレッド/チャンネル内コンテキスト保持
- [ ] 階層別モデル設定（Guild/Channel/User）
- [ ] カスタムプロンプト
- [ ] チャンネル制限、管理権限ロール
- [ ] エラー出力詳細度設定
- [ ] Web Search機能（`:online`サフィックス）
- [ ] 複数モデル並列回答
- [ ] Embed化
- [ ] Select Menu/Modalでモデル選択

---

## 完了済み

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
| 2025-12-23 | 無料モデル限定機能実装完了 |
| 2025-12-23 | ドキュメント整理: 未完了を先頭に、完了済みを縮小 |
