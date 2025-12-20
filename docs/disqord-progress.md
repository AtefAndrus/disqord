# DisQord 実装進捗チェックリスト

## 概要

本ドキュメントでは、DisQordの実装進捗をチェックリスト形式で管理する。

- `[x]` 完了
- `[ ]` 未完了

---

## v1.0 実装チェックリスト

### 1. 基盤層

#### Config（環境変数）

- [x] Zodスキーマ定義 (`src/config/index.ts`)
- [x] 環境変数バリデーション
  - [x] DISCORD_TOKEN
  - [x] DISCORD_APPLICATION_ID
  - [x] OPENROUTER_API_KEY
  - [x] DATABASE_PATH（デフォルト値あり）
  - [x] NODE_ENV（デフォルト値あり）

#### Database

- [x] DB接続シングルトン (`src/db/index.ts`)
- [x] WALモード有効化
- [x] スキーマ定義・マイグレーション (`src/db/schema.ts`)
  - [x] guild_settings テーブル

#### Repository

- [x] IGuildSettingsRepository インターフェース
- [x] GuildSettingsRepository 実装 (`src/db/repositories/guildSettings.ts`)
  - [x] findByGuildId
  - [x] upsert
  - [x] delete

#### Types

- [x] 共通型定義 (`src/types/index.ts`)
  - [x] GuildId, ChannelId, UserId, MessageId
  - [x] GuildSettings
  - [x] ChatMessage
  - [x] ChatCompletionRequest / Response
  - [x] OpenRouterError

#### Utils

- [x] Logger (`src/utils/logger.ts`)
- [x] メッセージ分割（2000文字制限対応）(`src/utils/message.ts`)

---

### 2. サービス層

#### SettingsService

- [x] ISettingsService インターフェース
- [x] SettingsService 実装 (`src/services/settingsService.ts`)
  - [x] getGuildSettings
  - [x] setGuildModel

#### ChatService

- [x] IChatService インターフェース
- [x] ChatService 実装 (`src/services/chatService.ts`)
  - [x] generateResponse

---

### 3. LLM層

#### OpenRouter Client

- [x] ILLMClient インターフェース (`src/llm/openrouter.ts`)
- [x] OpenRouterClient 実装
  - [x] chat（チャット補完API呼び出し）
  - [x] listModels（利用可能モデル一覧取得）
  - [x] getCredits（残高取得）
  - [x] isRateLimited（レート制限状態確認）
- [x] レート制限ハンドリング
  - [x] 429エラー検出
  - [x] X-RateLimit-Reset ヘッダー解析
  - [x] リクエスト抑制ロジック

---

### 4. Bot層

#### Discord Client

- [x] Client初期化 (`src/bot/client.ts`)
- [x] イベントハンドラ配線
- [x] コマンド登録処理の統合

#### イベントハンドラ

- [x] ready.ts（ログ出力）
- [x] messageCreate.ts
  - [x] Bot判定（自分自身のメッセージ無視）
  - [x] メンション検出
  - [x] ChatService呼び出し
  - [x] 応答送信（分割対応）
  - [x] エラーハンドリング
- [x] interactionCreate.ts
  - [x] コマンド判定
  - [x] コマンドルーティング
  - [x] エラーハンドリング

#### スラッシュコマンド

- [x] コマンド登録処理 (`src/bot/commands/index.ts`)
- [x] SlashCommandBuilder定義
  - [x] help.ts
  - [x] model.ts
  - [x] models.ts
  - [x] status.ts
- [x] コマンドハンドラ実装 (`src/bot/commands/handlers.ts`)
  - [x] `/disqord help` - 使い方表示
  - [x] `/disqord-model current` - 現在のモデル表示
  - [x] `/disqord-model set <model>` - モデル変更
  - [x] `/disqord-models` - 利用可能モデル一覧
  - [x] `/disqord-status` - ステータス表示（残高等）

---

### 5. エントリーポイント

- [x] 基本構造 (`src/index.ts`)
- [x] 依存性注入の完成
- [x] エラーハンドリング完成
- [x] グレースフルシャットダウン

---

### 6. テスト

#### ユニットテスト

- [x] utils/
  - [x] logger.test.ts
  - [x] message.test.ts
- [x] services/
  - [x] settingsService.test.ts
  - [x] chatService.test.ts
- [x] llm/
  - [x] openrouter.test.ts
- [x] health.test.ts（v1.0.1で追加）

#### 統合テスト

- [x] guildSettingsRepository.test.ts（インメモリDB使用）
- [x] Bot起動テスト（本番環境動作確認で完了）
- [x] コマンド実行テスト（本番環境動作確認で完了）

---

### 7. デプロイ

- [x] Dockerfile
  - [x] マルチステージビルド
  - [x] non-rootユーザー実行（bunユーザー）
  - [x] 本番用依存関係のみインストール（--production）
  - [x] dataディレクトリ作成（SQLiteボリュームマウント用）
- [x] .dockerignore
- [x] .env.example
- [x] Coolifyデプロイ設定
- [x] 動作確認（本番環境）
- [x] GitHub Actions自動デプロイ（`.github/workflows/deploy.yml`）
  - [x] Release作成時にCoolify Webhookをトリガー
  - [x] GitHubシークレット設定（COOLIFY_TOKEN, COOLIFY_WEBHOOK）
- [x] v1.0.0リリース（GitHub Releases）

---

### 8. ドキュメント

- [x] README.md
- [x] 機能要件定義書 (`docs/disqord-functional-requirements.md`)
- [x] 非機能要件定義書 (`docs/disqord-non-functional-requirements.md`)
- [x] 設計書 (`docs/disqord-design.md`)
- [x] 進捗チェックリスト（本ドキュメント）

---

### 9. 指摘対応

#### UX改善

- [x] スラッシュコマンドの整理（サブコマンドで統一）
- [x] モデル一覧をOpenRouter URLに誘導

#### 設定・運用

- [x] デフォルトモデルの環境変数化（ハードコード削除）

#### 技術的対応

- [x] discord.js v15対応: 評価完了、今すぐの対応は不要
  - v15は2025年12月時点でプレリリース状態（マイルストーン94%、リリース日未定）
  - 現在v14.16.3で問題なく動作
  - v15正式リリース後に`ready`→`clientReady`変更を検討

---

## v1.0 完了条件

以下がすべて完了した時点でv1.0リリースとする：

1. [x] OpenRouter APIクライアント実装完了
2. [x] 全イベントハンドラ実装完了
3. [x] 全スラッシュコマンド実装完了
4. [x] メンション呼び出しでLLM応答が返る
5. [x] エラーハンドリング実装完了
6. [x] ローカル起動、挙動確認
7. [x] 指摘事項対応完了（Embed化はv2以降に延期）
8. [x] Coolifyへのデプロイ成功
9. [x] 基本動作確認完了

---

## v1.0.1 実装チェックリスト

### v1.0.1 運用改善

- [x] Health Check対応（Coolify）
  - [x] HTTPヘルスエンドポイント追加（`Bun.serve()`で`/health`を公開）
  - [x] Discordクライアント接続状態の確認ロジック
  - [x] ヘルスレスポンス: 200 OK（正常）/ 503 Service Unavailable（異常）
  - [x] Dockerfileに`HEALTHCHECK`命令追加
  - [x] 環境変数`HEALTH_PORT`追加（デフォルト: 3000）

### v1.0.1 UX改善

- [x] Typing Indicator継続表示
  - [x] LLM応答待機中に`sendTyping()`を定期的に呼び出し（8秒間隔）
  - [x] 応答完了時に`clearInterval`で停止
- [x] `/disqord model list`のURL埋め込み抑制
  - [x] `<URL>`形式でプレビュー非表示

---

## v1.1.0 実装チェックリスト

### 無料モデル限定機能

- [ ] OpenRouterモデル一覧取得の拡張
  - [ ] `pricing`フィールドで無料モデル判定（`prompt === "0" && completion === "0"`）
  - [ ] 無料モデル一覧のキャッシュ機構（TTL: 5-10分）
- [ ] Guild設定に`freeModelsOnly`フラグ追加
  - [ ] DBスキーマ変更（マイグレーション）
  - [ ] Repository更新
  - [ ] SettingsService更新
- [ ] `/disqord model set`時のバリデーション
  - [ ] `freeModelsOnly`有効時は無料モデルのみ許可
- [ ] `/disqord config free-only <on|off>`コマンド追加

### ユーザ向けエラー表示

- [ ] カスタムエラークラス導入（`src/errors/index.ts`）
  - [ ] `AppError`基底クラス（`userMessage`プロパティ）
  - [ ] `RateLimitError`（リトライ秒数表示）
  - [ ] `ModelUnavailableError`
  - [ ] `AuthenticationError`（401/403）
  - [ ] `ServiceUnavailableError`（5xx）
  - [ ] `InputTooLongError`
  - [ ] `UnknownError`（フォールバック）
- [ ] OpenRouterClient更新
  - [ ] `handleErrorResponse`でエラー種別判定
  - [ ] 適切なカスタムエラーをthrow
  - [ ] レート制限時に`retryAfterSeconds`を計算
- [ ] イベントハンドラ更新
  - [ ] `messageCreate.ts`: `AppError`判定、`userMessage`表示
  - [ ] `interactionCreate.ts`: 同上
- [ ] テスト追加
  - [ ] `errors/index.test.ts`: エラークラスのuserMessage検証
  - [ ] `openrouter.test.ts`: エラー種別ごとのthrow検証

### リリースノート配信

- [ ] GitHub Webhook受信
  - [ ] HTTPサーバー拡張（`/webhook/github`エンドポイント）
  - [ ] 署名検証（`X-Hub-Signature-256`、HMAC-SHA256）
  - [ ] `release`イベント（`action: published`）のみ処理
  - [ ] 環境変数`GITHUB_WEBHOOK_SECRET`追加
- [ ] DBスキーマ変更
  - [ ] `guild_settings`に`release_channel_id TEXT`追加
  - [ ] マイグレーション実装
  - [ ] Repository更新（findByGuildId, upsert）
- [ ] リリース通知サービス
  - [ ] 登録済み全チャンネル取得
  - [ ] Embed形式でリリースノート配信
  - [ ] 配信失敗時のエラーハンドリング
- [ ] コマンド追加
  - [ ] `/disqord config release-channel <channel>` - 通知先設定
  - [ ] `/disqord config release-channel off` - 通知解除
- [ ] インフラ設定
  - [ ] Cloudflare TunnelでBot公開
  - [ ] GitHubリポジトリにWebhook設定（`release`イベント）

---

## v2.0以降 将来機能（参考）

### 会話・コンテキスト

- [ ] リプライ継続対話
- [ ] スレッド内コンテキスト保持
- [ ] チャンネル内コンテキスト保持（直近n件）
- [ ] OpenProvence連携（リランカー）

### LLM機能拡張

- [ ] Web Search機能（OpenRouter `:online` サフィックス）
  - 注意: 無料モデルでも追加費用発生（Exa検索: 最大$0.02/リクエスト）
- [ ] 複数モデル並列回答（Body Builder連携）
  - `openrouter/bodybuilder`でリクエスト生成（無料）
  - `Promise.all()`で並列実行

### UX・表示改善

- [ ] Embed化
  - [ ] ステータス・ヘルプ等にEmbed使用
  - [ ] エラー表示にEmbed使用（赤色で視認性向上）
- [ ] メッセージ文字列の分離（i18n対応の土台、Embed化と同時に検討）

### モデル選択UI改善

- [ ] Select Menu/Modalでモデル選択UI
- [ ] モデル一覧のキャッシュ（API呼び出し削減）
- [ ] モデル検索/フィルタリング機能

### 設定拡張

- [ ] Channel単位モデル設定
- [ ] User単位モデル設定
- [ ] カスタムプロンプト（Guild/Channel/User）
- [ ] チャンネル制限（Bot有効化チャンネル指定）
- [ ] 管理権限ロール指定

### 反応モード

- [ ] チャンネル: 全発言反応モード
- [ ] スレッド: メンションのみ反応モード

---

## 進捗サマリー

| カテゴリ | 完了 | 未完了 | 進捗率 |
| ---------- | ------ | -------- | -------- |
| 基盤層 | 15 | 0 | 100% |
| サービス層 | 6 | 0 | 100% |
| LLM層 | 8 | 0 | 100% |
| Bot層 | 20 | 0 | 100% |
| テスト | 9 | 0 | 100% |
| デプロイ | 13 | 0 | 100% |
| ドキュメント | 5 | 0 | 100% |
| **合計** | **76** | **0** | **100%** |

---

## 更新履歴

| 日付 | 内容 |
| ------ | ------ |
| 2025-12-11 | 初版作成 |
| 2025-12-12 | v1.0コード実装完了（LLM層、Bot層、エントリーポイント） |
| 2025-12-12 | ユニットテスト・統合テスト実装完了（54テスト） |
| 2025-12-16 | Dockerfile改善（マルチステージビルド、セキュリティ強化）、.dockerignore追加 |
| 2025-12-16 | .env手動読み込み追加（Bunの自動読み込み問題対応）、discord.js v15対応項目追加 |
| 2025-12-18 | モデル一覧をOpenRouter URL誘導に変更、キャッシュ機構をv2以降に延期 |
| 2025-12-18 | v2将来機能にメッセージ文字列分離を追加 |
| 2025-12-18 | ドキュメント整合性修正: functional-requirements.mdにモデル選択UI改善・コード品質追加、design.mdスキーマにチャンネル制限・管理権限ロール追加 |
| 2025-12-18 | デフォルトモデルの環境変数化（DEFAULT_MODEL）、デフォルト値を openai/gpt-oss-120b:free に変更 |
| 2025-12-18 | Embed化をv2以降に延期、discord.js v15対応を評価（今すぐの対応不要と判断） |
| 2025-12-19 | Coolifyデプロイ完了、本番環境動作確認完了 |
| 2025-12-19 | GitHub Actions自動デプロイ設定（Release→Coolify Webhook） |
| 2025-12-19 | v1.0.0リリース完了 |
| 2025-12-19 | v1.0.1/v1.1.0/v2.0ロードマップ追加（Typing Indicator、無料モデル限定、Web Search等） |
| 2025-12-19 | v1.0.1実装完了（Health Check、Typing Indicator、URL埋め込み抑制） |
| 2025-12-19 | health.test.ts追加、Bot起動・コマンド実行テストを完了扱いに更新、v1.0進捗100%達成 |
| 2025-12-21 | v1.1.0にユーザ向けエラー表示・リリースノート配信機能を追加（GitHub Webhook + Cloudflare Tunnel方式） |
