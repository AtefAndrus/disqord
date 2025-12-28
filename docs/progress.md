# DisQord 実装進捗

本ドキュメントはコーディングエージェントが進捗を把握するためのもの。

---

## 未完了タスク（ロードマップ）

| バージョン | 機能 | 備考 |
|-----------|------|------|
| v1.2.1 | クイックウィン（UX改善） | バージョン表示、Discord.js v15対応、snowflake時間表示 |
| v1.3.0 | モデル選択UI + UX改善 | Autocomplete、色分け、詳細情報表示 |
| v1.4.0 | ストリーミング対応 | SSE、リアルタイム表示、`/stop`コマンド |
| v1.5.0 | コンテキスト対話 + コマンド改善 | 会話履歴保持（DBマイグレーション）、`/help`動的生成、prefix検討 |
| v1.6.0 | 設定階層化 + パラメータ設定 | Guild/Channel/User単位の設定（DBマイグレーションあり）、LLMパラメータ設定 |
| v1.7.0 | 権限管理 + AI改善 | チャンネル制限、管理ロール（DBマイグレーション）、markdown抑制 |
| v1.8.0 | Web Search | OpenRouter `:online` サフィックス |
| v1.9.0 | 複数モデル並列 | 複数モデルで同時回答 |

### v1.2.1 詳細（クイックウィン）

- [ ] `/disqord status`にバージョン表示（`package.json`から取得）
- [ ] Discord.js v15非推奨警告対応（`ready` → `clientReady`）
- [ ] `/disqord status`の時間表示でDiscord snowflake使用（`<t:unix:R>`形式）

### v1.3.0 詳細（モデル選択UI + UX改善）

- [ ] Embedの色をモデルごとにランダム化（`modelNameToColor()`）
- [ ] モデル選択UI（Autocomplete）
- [ ] LLM詳細情報表示モード（optional: tokens、latency、cost等）

### v1.4.0 詳細（ストリーミング対応）

- [ ] ストリーミング対応（SSE、リアルタイム表示）
- [ ] `/disqord stop`コマンド（進行中のリクエストを中断）

### v1.5.0 詳細（コンテキスト対話 + コマンド改善）

- [ ] 直近n件の会話履歴保持（DBマイグレーションあり）
- [ ] `/help`コマンド一覧の動的生成（SlashCommandBuilderから自動生成）
- [ ] `disqord` prefix削除検討（ユーザー確認必要）

### v1.6.0 詳細（設定階層化 + パラメータ設定）

- [ ] Guild/Channel/User単位の設定（DBマイグレーションあり）
- [ ] モデルごとのデフォルトパラメータ設定（temperature、top_p等）
- [ ] ユーザーによるパラメータ上書き（`/disqord config params`）

### v1.7.0 詳細（権限管理 + AI改善）

- [ ] チャンネル制限、管理ロール（DBマイグレーションあり）
- [ ] Discord非対応markdown抑制（system prompt: H4以上、水平線、表等禁止）

詳細設計は実装時に [design.md](design.md) へ追記する。

---

## 完了済み

### v1.2.0 (2025-12-28)

Embed化 + モデル名表示改善

- **Embed化**
  - LLM応答のEmbed化（author: モデル名、timestamp、色: Blurple）
  - エラーメッセージのEmbed化（色: Red #ED4245）
  - 全スラッシュコマンドのEmbed化
  - リリース通知のEmbed化（author: GitHub user、thumbnail、timestamp、footer）
- **長文対応**
  - Discord API制限対応（1メッセージあたりEmbed合計6000文字）
  - 4096文字単位で分割、複数メッセージに分散
  - ページ番号表示（例: "ページ 1/3"）
- **コマンドタイトル統一化**
  - 全て日本語に統一（例: "DisQord ヘルプ"、"ステータス"、"モデル変更"）
- **Model ID → Model Name変換**
  - `ModelService.getModelName()` 追加
  - LLM応答authorにModel Name表示（例: "DeepSeek R1 0528 (free)"）
- **UX改善**
  - `/disqord config free-only` の有効/無効を**太字**で強調

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
