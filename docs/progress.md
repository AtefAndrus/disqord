# DisQord 実装進捗

本ドキュメントはコーディングエージェントが進捗を把握するためのもの。

---

## 未完了タスク（ロードマップ）

| バージョン | 機能 | 備考 |
|-----------|------|------|
| v1.3.3 | モデル詳細表示改善 | 価格表示バグ修正、無料モデルフィールド削除 |
| v1.4.0 | 即時UX改善 | ストリーミング対応、停止ボタン、prefix削除、自動応答チャンネル |
| v1.5.0 | 対話UX改善 | 会話履歴（Discord読み取り）、再生成ボタン、メッセージ編集再生成、`/help`動的生成 |
| v1.6.0 | マルチモーダル対応 | 画像入力対応、モダリティ表示 |
| v1.7.0 | Web Search | `:online`サフィックス、費用警告 |
| v1.8.0 | 複数モデル並列 | 複数モデルで同時回答 |
| v1.9.0 | 設定階層化 + パラメータ + プロンプト | Guild/Channel/User設定、LLMパラメータ、カスタムプロンプト（DBマイグレーション） |
| v1.10.0 | 権限管理 + AI改善 | チャンネル制限、管理ロール、markdown抑制（DBマイグレーション） |

### v1.3.3 詳細（モデル詳細表示改善）

- [ ] 価格表示バグ修正（1トークンあたり → 100万トークンあたりに変換）
- [ ] 「無料モデル」フィールド削除（価格表示のみで判断）

### v1.4.0 詳細（即時UX改善）

- [ ] ストリーミング対応（SSE、リアルタイム表示、2秒ごとにメッセージ更新）
- [ ] 停止ボタン（🛑ボタンで進行中のリクエストを中断、プログレスバー不要）
- [ ] prefix削除（`/disqord` → `/`、全コマンド短縮）
- [ ] 自動応答チャンネル設定（DBマイグレーション: `auto_reply_channels`カラム）
  - メンション不要で自動応答
  - 親チャンネル設定で全スレッド対応、個別スレッド設定も可能
  - `/config auto-reply add/remove/list`コマンド

### v1.5.0 詳細（対話UX改善）

- [ ] 会話履歴（Discord APIから取得、DB不要）
  - `channel.messages.fetch()`で直近n件取得
  - コンテキスト設定（デフォルト5件、0-20件）
- [ ] 回答再生成ボタン（前の回答も表示可能、DBマイグレーション: `response_generations`）
- [ ] メッセージ編集再生成（最新回答のみ対象、`messageUpdate`イベント）
- [ ] `/help`コマンド一覧の動的生成（SlashCommandBuilderから自動生成）

### v1.6.0 詳細（マルチモーダル対応）

- [ ] Discord画像添付対応（メンション時に画像を含めてLLMに送信）
- [ ] マルチモーダル対応モデルの表示（`input_modalities`/`output_modalities`表示）
- [ ] 画像URL対応（Discord CDN経由、最大10枚）

### v1.7.0 詳細（Web Search）

- [ ] Web Search ON/OFF設定（DBマイグレーション: `web_search_enabled`カラム）
- [ ] モデルIDに`:online`サフィックス自動付与
- [ ] 追加費用警告表示
- [ ] ステータス表示への追加

### v1.8.0 詳細（複数モデル並列）

- [ ] 複数モデル指定UI（`/model compare <model1> <model2> ...`、最大4モデル）
- [ ] 並列リクエスト処理（`Promise.allSettled()`）
- [ ] 各モデルの応答を別Embedで表示
- [ ] エラーハンドリング（一部失敗しても継続）

### v1.9.0 詳細（設定階層化 + パラメータ + プロンプト）

- [ ] Guild/Channel/User単位の設定（DBマイグレーション: `channel_settings`, `user_settings`）
- [ ] モデルごとのデフォルトパラメータ取得（`default_parameters`）
- [ ] ユーザーによるパラメータ上書き（`/config params set/reset/show`）
- [ ] カスタムシステムプロンプト設定（`/prompt set/show/reset`）

### v1.10.0 詳細（権限管理 + AI改善）

- [ ] チャンネル制限、管理ロール（DBマイグレーション: `allowed_channels`, `admin_role_id`）
- [ ] 権限チェックロジック（メンション時の権限検証）
- [ ] Discord非対応markdown抑制（system prompt: H4以上、水平線、表等禁止）

詳細設計は実装時に [design.md](design.md) へ追記する。

---

## 完了済み

### v1.3.2 (2025-12-29)

UX改善（言語統一 + ボタン + モデル詳細）

- `/disqord status`表示の言語統一（"ON/OFF" → "有効/無効"）
- statusボタンのUX改善（トグル形式: `設定名: 現在値 → 切替後値`）
- `/disqord model set`でモデル詳細情報を表示（名前、コンテキスト長、価格）
- `ModelService.getModelDetails()`メソッド追加
- フォーマット関数追加（`formatContextLength`, `formatPrice`）

### v1.3.1 (2025-12-29)

UX改善

- メッセージ分割改善（9000バイト単位、改行位置優先）
- statusコマンドインタラクティブ化（ボタンによる設定切り替え）
- `/disqord config llm-details`のephemeral解除
- `/disqord status`にLLM詳細設定状態を表示

### v1.3.0 (2025-12-29)

モデル選択UI + UX改善

- Embedカラーランダム化（モデルIDから決定論的に色決定）
- Autocomplete実装（モデル選択時、最大25件、新しい順ソート）
- LLM詳細情報表示（トークン数、コスト、レイテンシ、TPS等）
- OpenRouter設定エラー改善（ConfigurationError追加）

### v1.2.1 (2025-12-28)

クイックウィン（UX改善）

- バージョン表示（プレゼンス、`/status`）
- Discord.js v15対応
- 時間表示改善（Discord timestamp形式）

### v1.2.0 (2025-12-28)

Embed化 + モデル名表示改善

- LLM応答/エラー/コマンドのEmbed化
- 長文対応（4096文字単位で分割、ページ番号表示）
- Model ID → Model Name変換
- コマンドタイトル日本語統一

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
