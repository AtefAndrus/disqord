# DisQord 設計書

## 概要

本ドキュメントでは、DisQordのアーキテクチャ、ディレクトリ構成、DBスキーマ、インターフェース設計を定義する。

---

## 1. ディレクトリ構成

```text
disqord/
├── src/
│   ├── index.ts                  # エントリーポイント
│   ├── bot/
│   │   ├── client.ts             # Discord Client 初期化
│   │   ├── events/               # イベントハンドラ
│   │   │   ├── messageCreate.ts
│   │   │   ├── interactionCreate.ts
│   │   │   └── ready.ts
│   │   └── commands/             # スラッシュコマンド
│   │       ├── index.ts          # コマンド登録
│   │       ├── disqord.ts        # 統合コマンド定義
│   │       └── handlers.ts       # コマンドハンドラ
│   ├── services/                 # サービス層
│   │   ├── chatService.ts        # LLM呼び出し・応答生成
│   │   └── settingsService.ts    # 設定管理
│   ├── llm/
│   │   └── openrouter.ts         # OpenRouter API クライアント
│   ├── db/
│   │   ├── index.ts              # DB接続・初期化（bun:sqlite）
│   │   ├── schema.ts             # スキーマ定義・マイグレーション
│   │   └── repositories/         # データアクセス層
│   │       └── guildSettings.ts
│   ├── config/
│   │   └── index.ts              # 環境変数読み込み
│   ├── utils/
│   │   ├── logger.ts             # ログユーティリティ
│   │   └── message.ts            # メッセージ分割等
│   └── types/
│       └── index.ts              # 共通型定義
├── tests/                        # テストディレクトリ（bun:test）
│   ├── helpers/                  # テストヘルパー
│   │   └── mockFactories.ts      # 共通モックファクトリ
│   ├── unit/                     # ユニットテスト
│   │   ├── utils/
│   │   │   ├── logger.test.ts
│   │   │   └── message.test.ts
│   │   ├── services/
│   │   │   ├── chatService.test.ts
│   │   │   └── settingsService.test.ts
│   │   └── llm/
│   │       └── openrouter.test.ts
│   └── integration/              # 統合テスト
│       └── db/
│           └── guildSettingsRepository.test.ts
├── docs/                         # ドキュメント
│   ├── disqord-functional-requirements.md  # 機能要件
│   ├── disqord-non-functional-requirements.md # 非機能要件
│   ├── disqord-design.md         # 設計書（本ドキュメント）
│   ├── disqord-progress.md       # 進捗チェックリスト
│   └── disqord-test-plan.md      # テスト計画
├── tmp/                          # 一時スクリプト・ユーティリティ
├── data/                         # SQLiteファイル格納（.gitignore）
├── mise.toml                     # ツールバージョン固定・タスク定義
├── Dockerfile                    # マルチステージビルド、non-root実行
├── .dockerignore                 # ビルドコンテキスト除外設定
├── .env.example
├── LICENSE
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## 2. アーキテクチャ

### 2.1 レイヤー構成

```text
┌─────────────────────────────────────────────────────┐
│                    Entrypoint                       │
│                   (src/index.ts)                    │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│                   Bot Layer                         │
│         (events, commands, client)                  │
│  - Discord.jsイベント処理                            │
│  - スラッシュコマンド処理                             │
│  - メッセージ受信・送信                              │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│                 Service Layer                       │
│              (src/services/)                        │
│  - ビジネスロジック                                  │
│  - LLM呼び出し制御                                   │
│  - 設定管理                                         │
└──────────┬─────────────────────┬────────────────────┘
           │                     │
┌──────────▼──────────┐ ┌────────▼─────────────────────┐
│    LLM Layer        │ │      Data Layer              │
│  (src/llm/)         │ │   (src/db/)                  │
│  - OpenRouter通信    │ │  - SQLite操作                │
│  - レート制限管理    │ │  - Repository                │
└─────────────────────┘ └──────────────────────────────┘
```

### 2.2 依存関係

```text
┌─────────────────────┐
│   Discord Client    │
└──────────┬──────────┘
           │ uses
           ▼
┌─────────────────────┐     ┌─────────────────────┐
│    ChatService      │────▶│     ILLMClient      │
│                     │     │   (OpenRouter)      │
└──────────┬──────────┘     └─────────────────────┘
           │ uses
           ▼
┌─────────────────────┐     ┌─────────────────────┐
│  SettingsService    │────▶│ IGuildSettingsRepo  │
│                     │     │    (SQLite)         │
└─────────────────────┘     └─────────────────────┘
```

### 2.3 依存性注入

手動コンストラクタ注入を採用する。

```typescript
// 例: ChatServiceの初期化
const llmClient = new OpenRouterClient(config);
const settingsRepo = new GuildSettingsRepository(db);
const settingsService = new SettingsService(settingsRepo);
const chatService = new ChatService(llmClient, settingsService);
```

---

## 3. DBスキーマ

### 3.1 v1 スキーマ

```sql
-- Guild設定テーブル
CREATE TABLE guild_settings (
    guild_id TEXT PRIMARY KEY,
    default_model TEXT NOT NULL DEFAULT 'google/gemini-2.0-flash-exp:free',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 3.2 将来拡張スキーマ（v2以降）

```sql
-- Guild設定テーブル（拡張版）
CREATE TABLE guild_settings (
    guild_id TEXT PRIMARY KEY,
    default_model TEXT NOT NULL DEFAULT 'google/gemini-2.0-flash-exp:free',
    custom_prompt TEXT,
    admin_role_ids TEXT,                              -- JSON配列: 設定変更権限を持つロールID
    release_notify_enabled INTEGER NOT NULL DEFAULT 1,
    release_notify_channel_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Channel設定テーブル
CREATE TABLE channel_settings (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    bot_enabled INTEGER NOT NULL DEFAULT 1,           -- 0: Bot無効, 1: Bot有効（チャンネル制限用）
    default_model TEXT,
    custom_prompt TEXT,
    response_mode TEXT NOT NULL DEFAULT 'mention_only',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
);

-- User設定テーブル
CREATE TABLE user_settings (
    user_id TEXT PRIMARY KEY,
    default_model TEXT,
    custom_prompt TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 会話履歴テーブル
CREATE TABLE conversation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
);

-- インデックス
CREATE INDEX idx_conversation_channel ON conversation_history(channel_id, created_at);
CREATE INDEX idx_conversation_user ON conversation_history(user_id, created_at);
```

### 3.3 設計方針

| 項目 | 方針 |
|------|------|
| Discord ID | TEXT型で保存（JavaScriptのNumber精度問題を回避） |
| タイムスタンプ | ISO 8601文字列（`datetime('now')`） |
| 初期モデル | `google/gemini-2.0-flash-exp:free` |

---

## 4. インターフェース設計

### 4.1 型定義

```typescript
// src/types/index.ts

// Discord関連
export type GuildId = string;
export type ChannelId = string;
export type UserId = string;
export type MessageId = string;

// Guild設定
export interface GuildSettings {
  guildId: GuildId;
  defaultModel: string;
  createdAt: string;
  updatedAt: string;
}

// OpenRouter関連
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
}

export interface ChatCompletionResponse {
  id: string;
  choices: {
    message: {
      role: 'assistant';
      content: string;
    };
  }[];
}

// OpenRouterエラー
export interface OpenRouterError {
  code: number;
  message: string;
  metadata?: {
    headers?: {
      'X-RateLimit-Limit'?: string;
      'X-RateLimit-Remaining'?: string;
      'X-RateLimit-Reset'?: string;
    };
  };
}
```

### 4.2 Repository インターフェース

```typescript
// src/db/repositories/guildSettings.ts

export interface IGuildSettingsRepository {
  findByGuildId(guildId: GuildId): GuildSettings | null;
  upsert(guildId: GuildId, settings: Partial<GuildSettings>): GuildSettings;
  delete(guildId: GuildId): boolean;
}
```

### 4.3 Service インターフェース

```typescript
// src/services/chatService.ts

export interface IChatService {
  generateResponse(
    guildId: GuildId,
    userMessage: string
  ): Promise<string>;
}

// src/services/settingsService.ts

export interface ISettingsService {
  getGuildSettings(guildId: GuildId): GuildSettings;
  setGuildModel(guildId: GuildId, model: string): GuildSettings;
}
```

### 4.4 LLM Client インターフェース

```typescript
// src/llm/openrouter.ts

export interface ILLMClient {
  chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  listModels(): Promise<string[]>;
  getCredits(): Promise<{ remaining: number }>;
  isRateLimited(): boolean;
}
```

---

## 5. Bunエコシステム活用

### 5.1 使用する組み込み機能

| 機能 | モジュール | 説明 |
|------|------------|------|
| SQLite | [`bun:sqlite`](https://bun.com/docs/runtime/sqlite.md) | 高性能SQLite3ドライバー（better-sqlite3の3-6倍高速） |
| テスト | [`bun:test`](https://bun.com/docs/test.md) | Jest互換テストランナー |

### 5.1.1 mise によるバージョン固定

- `mise.toml` で Bun を 1.3.x に固定。
- 初回セットアップは `mise run setup`（依存関係インストール + .env初期化）。
- 開発コマンドは `bun` を直接使用（`bun dev`, `bun test` 等）。
- Lint/Format は Biome（`bun lint`, `bun format`）。

### 5.2 bun:sqlite使用例

```typescript
import { Database } from 'bun:sqlite';

const db = new Database('data/disqord.db');

// WALモード有効化（パフォーマンス向上）
db.run('PRAGMA journal_mode = WAL');

// クエリ実行
const stmt = db.query('SELECT * FROM guild_settings WHERE guild_id = ?');
const result = stmt.get(guildId);
```

### 5.3 bun:test使用例

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';

describe('SettingsService', () => {
  let service: SettingsService;
  let mockRepo: IGuildSettingsRepository;

  beforeEach(() => {
    mockRepo = createMockRepository();
    service = new SettingsService(mockRepo);
  });

  test('getGuildSettings returns default when not found', () => {
    const result = service.getGuildSettings('123');
    expect(result.defaultModel).toBe('google/gemini-2.0-flash-exp:free');
  });
});
```

---

## 更新履歴

| 日付 | バージョン | 内容 |
|------|------------|------|
| 2025-11-26 | 1.0 | 初版作成 |
| 2025-12-12 | 1.1 | テストディレクトリ構成を実装に合わせて更新 |
| 2025-12-16 | 1.2 | ディレクトリ構成に.dockerignore追加、Dockerfile説明更新 |
