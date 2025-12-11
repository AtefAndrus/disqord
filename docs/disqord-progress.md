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
- [ ] OpenRouterClient 実装
  - [ ] chat（チャット補完API呼び出し）
  - [ ] listModels（利用可能モデル一覧取得）
  - [ ] getCredits（残高取得）
  - [ ] isRateLimited（レート制限状態確認）
- [ ] レート制限ハンドリング
  - [ ] 429エラー検出
  - [ ] X-RateLimit-Reset ヘッダー解析
  - [ ] リクエスト抑制ロジック

---

### 4. Bot層

#### Discord Client

- [x] Client初期化 (`src/bot/client.ts`)
- [ ] イベントハンドラ配線
- [ ] コマンド登録処理の統合

#### イベントハンドラ

- [x] ready.ts（ログ出力）
- [ ] messageCreate.ts
  - [x] Bot判定（自分自身のメッセージ無視）
  - [ ] メンション検出
  - [ ] ChatService呼び出し
  - [ ] 応答送信（分割対応）
  - [ ] エラーハンドリング
- [ ] interactionCreate.ts
  - [x] コマンド判定
  - [ ] コマンドルーティング
  - [ ] エラーハンドリング

#### スラッシュコマンド

- [x] コマンド登録処理 (`src/bot/commands/index.ts`)
- [x] SlashCommandBuilder定義
  - [x] help.ts
  - [x] model.ts
  - [x] models.ts
  - [x] status.ts
- [ ] コマンドハンドラ実装
  - [ ] `/disqord help` - 使い方表示
  - [ ] `/disqord model` - 現在のモデル表示
  - [ ] `/disqord model set <model>` - モデル変更
  - [ ] `/disqord models` - 利用可能モデル一覧
  - [ ] `/disqord status` - ステータス表示（残高等）

---

### 5. エントリーポイント

- [x] 基本構造 (`src/index.ts`)
- [ ] 依存性注入の完成
- [ ] エラーハンドリング完成
- [ ] グレースフルシャットダウン

---

### 6. テスト

#### ユニットテスト

- [ ] utils/
  - [ ] logger.test.ts
  - [ ] message.test.ts
- [ ] db/
  - [ ] guildSettings.test.ts
- [ ] services/
  - [ ] settingsService.test.ts
  - [ ] chatService.test.ts
- [ ] llm/
  - [ ] openrouter.test.ts

#### 統合テスト

- [ ] Bot起動テスト
- [ ] コマンド実行テスト

---

### 7. デプロイ

- [x] Dockerfile
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

## v1.0 完了条件

以下がすべて完了した時点でv1.0リリースとする：

1. [ ] OpenRouter APIクライアント実装完了
2. [ ] 全イベントハンドラ実装完了
3. [ ] 全スラッシュコマンド実装完了
4. [ ] メンション呼び出しでLLM応答が返る
5. [ ] エラーハンドリング実装完了
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
| LLM層 | 1 | 7 | 12% |
| Bot層 | 8 | 12 | 40% |
| テスト | 0 | 8 | 0% |
| デプロイ | 2 | 2 | 50% |
| ドキュメント | 5 | 0 | 100% |
| **合計** | **37** | **29** | **56%** |

---

## 更新履歴

| 日付 | 内容 |
|------|------|
| 2025-12-11 | 初版作成 |
