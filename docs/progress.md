# DisQord 実装進捗

本ドキュメントはcoding agent（Claude Code等）が進捗を把握するためのもの。

---

## 未完了タスク

### v1.1.0

#### 無料モデル限定機能

- [ ] OpenRouterモデル一覧取得の拡張（`pricing`フィールドで無料判定）
- [ ] 無料モデル一覧のキャッシュ機構（TTL: 5-10分）
- [ ] Guild設定に`freeModelsOnly`フラグ追加（DBスキーマ変更）
- [ ] `/disqord model set`時のバリデーション
- [ ] `/disqord config free-only <on|off>`コマンド追加

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
- [ ] Web Search機能（`:online`サフィックス）
- [ ] 複数モデル並列回答
- [ ] Embed化
- [ ] Select Menu/Modalでモデル選択

---

## 完了済み

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
| 2025-12-23 | ドキュメント整理: 未完了を先頭に、完了済みを縮小 |
