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

#### 統合テスト

- [x] guildSettingsRepository.test.ts（インメモリDB使用）
- [ ] Bot起動テスト
- [ ] コマンド実行テスト

---

### 7. デプロイ

- [x] Dockerfile
  - [x] マルチステージビルド
  - [x] non-rootユーザー実行（bunユーザー）
  - [x] 本番用依存関係のみインストール（--production）
  - [x] dataディレクトリ作成（SQLiteボリュームマウント用）
- [x] .dockerignore
- [x] .env.example
- [ ] Coolifyデプロイ設定
- [ ] 動作確認（本番環境）

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

- [ ] スラッシュコマンドの整理（サブコマンドで統一）
- [ ] モデル一覧のキャッシュ（API呼び出し削減）
- [ ] モデル一覧をOpenRouter URLに誘導
- [ ] ステータス・ヘルプ等にEmbed使用

#### 設定・運用

- [ ] デフォルトモデルの環境変数化（ハードコード削除）

#### 技術的対応

- [ ] discord.js v15対応: `ready`イベントを`clientReady`に変更（`src/bot/client.ts`）
  - 現状: v14では`ready`イベントで動作、Deprecation Warningが出力される
  - 対応時期: discord.js v15リリース時

---

## v1.0 完了条件

以下がすべて完了した時点でv1.0リリースとする：

1. [x] OpenRouter APIクライアント実装完了
2. [x] 全イベントハンドラ実装完了
3. [x] 全スラッシュコマンド実装完了
4. [x] メンション呼び出しでLLM応答が返る（コード実装完了、動作確認待ち）
5. [x] エラーハンドリング実装完了
6. [ ] Coolifyへのデプロイ成功
7. [ ] 基本動作確認完了

---

## v2.0以降 将来機能（参考）

### 会話・コンテキスト

- [ ] リプライ継続対話
- [ ] スレッド内コンテキスト保持
- [ ] チャンネル内コンテキスト保持（直近n件）
- [ ] OpenProvence連携（リランカー）

### 設定拡張

- [ ] Channel単位モデル設定
- [ ] User単位モデル設定
- [ ] カスタムプロンプト（Guild/Channel/User）
- [ ] チャンネル制限（Bot有効化チャンネル指定）
- [ ] 管理権限ロール指定

### 反応モード

- [ ] チャンネル: 全発言反応モード
- [ ] スレッド: メンションのみ反応モード

### 運用

- [ ] リリースノート配信（GitHub Releases連携）
- [ ] 簡略エラー表示（一般ユーザー向け）

---

## 進捗サマリー

| カテゴリ | 完了 | 未完了 | 進捗率 |
|----------|------|--------|--------|
| 基盤層 | 15 | 0 | 100% |
| サービス層 | 6 | 0 | 100% |
| LLM層 | 8 | 0 | 100% |
| Bot層 | 20 | 0 | 100% |
| テスト | 6 | 2 | 75% |
| デプロイ | 7 | 2 | 78% |
| ドキュメント | 5 | 0 | 100% |
| **合計** | **67** | **4** | **94%** |

---

## 更新履歴

| 日付 | 内容 |
|------|------|
| 2025-12-11 | 初版作成 |
| 2025-12-12 | v1.0コード実装完了（LLM層、Bot層、エントリーポイント） |
| 2025-12-12 | ユニットテスト・統合テスト実装完了（54テスト） |
| 2025-12-16 | Dockerfile改善（マルチステージビルド、セキュリティ強化）、.dockerignore追加 |
| 2025-12-16 | .env手動読み込み追加（Bunの自動読み込み問題対応）、discord.js v15対応項目追加 |
