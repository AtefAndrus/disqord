# DisQord 設計書

## 概要

本ドキュメントでは、DisQordのアーキテクチャ、ディレクトリ構成、DBスキーマ、インターフェース設計を定義する。

---

## 1. ディレクトリ構成

```text
disqord/
├── src/
│   ├── index.ts                  # エントリーポイント
│   ├── health.ts                 # ヘルスチェックHTTPサーバー
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
│   ├── errors/
│   │   └── index.ts              # カスタムエラークラス
│   ├── services/                 # サービス層
│   │   ├── chatService.ts        # LLM呼び出し・応答生成
│   │   ├── settingsService.ts    # 設定管理
│   │   └── releaseNotificationService.ts  # リリース通知
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
const settingsRepo = new GuildSettingsRepository(db, config.defaultModel);
const settingsService = new SettingsService(settingsRepo, config.defaultModel);
const chatService = new ChatService(llmClient, settingsService);
```

---

## 3. DBスキーマ

### 3.1 v1.0 スキーマ

```sql
-- Guild設定テーブル
CREATE TABLE guild_settings (
    guild_id TEXT PRIMARY KEY,
    default_model TEXT NOT NULL DEFAULT 'deepseek/deepseek-r1-0528:free',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 3.2 v1.1.0 スキーマ（マイグレーション）

```sql
-- 無料モデル限定フラグを追加
ALTER TABLE guild_settings ADD COLUMN free_models_only INTEGER NOT NULL DEFAULT 0;
-- 0: 全モデル利用可, 1: 無料モデルのみ
```

### 3.3 将来拡張スキーマ（v2以降）

```sql
-- Guild設定テーブル（拡張版）
CREATE TABLE guild_settings (
    guild_id TEXT PRIMARY KEY,
    default_model TEXT NOT NULL DEFAULT 'deepseek/deepseek-r1-0528:free',
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
| ------ | ------ |
| Discord ID | TEXT型で保存（JavaScriptのNumber精度問題を回避） |
| タイムスタンプ | ISO 8601文字列（`datetime('now')`） |
| 初期モデル | `deepseek/deepseek-r1-0528:free`（環境変数 `DEFAULT_MODEL` で変更可） |

### 3.4 v1.1.0 スキーマ（マイグレーション追加）

```sql
-- リリースノート配信チャンネルを追加
ALTER TABLE guild_settings ADD COLUMN release_channel_id TEXT;
```

---

## 4. エラーハンドリング設計

### 4.1 エラークラス階層

```text
src/errors/
└── index.ts    # カスタムエラークラス定義
```

```typescript
// 基底クラス
abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly userMessage: string;
}

// OpenRouter APIエラー
class RateLimitError extends AppError {
  code = "RATE_LIMIT";
  constructor(public readonly retryAfterSeconds: number) {
    super(`Rate limited. Retry after ${retryAfterSeconds} seconds.`);
  }
  get userMessage() {
    return `リクエスト制限に達しました。${this.retryAfterSeconds}秒後に再度お試しください。`;
  }
}

class InsufficientCreditsError extends AppError {
  code = "INSUFFICIENT_CREDITS";
  userMessage = "API残高が不足しています。管理者にお問い合わせください。";
}

class ModerationError extends AppError {
  code = "MODERATION";
  userMessage = "入力内容が制限されました。表現を変えてお試しください。";
}

class ModelUnavailableError extends AppError {
  code = "MODEL_UNAVAILABLE";
  userMessage = "モデルが一時的に利用できません。しばらくしてから再度お試しください。";
}

class AuthenticationError extends AppError {
  code = "AUTHENTICATION";
  userMessage = "Botの設定に問題があります。管理者にお問い合わせください。";
}

class RequestTimeoutError extends AppError {
  code = "TIMEOUT";
  userMessage = "応答に時間がかかりすぎています。短いメッセージでお試しください。";
}

class InvalidRequestError extends AppError {
  code = "INVALID_REQUEST";
  userMessage = "リクエストに問題があります。入力内容を確認してください。";
}

class UnknownError extends AppError {
  code = "UNKNOWN";
  userMessage = "予期しないエラーが発生しました。問題が続く場合は管理者にお問い合わせください。";
}
```

### 4.2 エラーフロー

```text
OpenRouterClient.handleErrorResponse()
  ├─ 429 → throw RateLimitError(retryAfterSeconds)
  ├─ 402 → throw InsufficientCreditsError()
  ├─ 403 → throw ModerationError()
  ├─ 401 → throw AuthenticationError()
  ├─ 408 → throw RequestTimeoutError()
  ├─ 502/503 → throw ModelUnavailableError()
  └─ 400/other → throw InvalidRequestError(message)
  ↓
ChatService (パススルー)
  ↓
messageCreate / interactionCreate
  catch (error) {
    logger.error(..., serializeError(error));
    const userMessage = error instanceof AppError
      ? error.userMessage
      : "予期しないエラーが発生しました。";
    reply(userMessage);
  }
```

### 4.3 ログ出力改善

```typescript
// Errorオブジェクトの適切なシリアライズ
function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof AppError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      stack: error.stack,
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { error };
}
```

---

## 5. Webhook受信設計

### 5.1 アーキテクチャ

```text
GitHub Release (published)
    ↓ POST + X-Hub-Signature-256
https://<tunnel>.cloudflare.com/webhook/github
    ↓ Cloudflare Tunnel
Bot HTTPサーバー (localhost:3000)
    ↓ 署名検証 → リリース通知サービス
    ↓
全登録Guild (release_channel_idが設定されているGuild)
```

### 5.2 HTTPサーバー拡張

```typescript
// src/health.ts を拡張（または src/server.ts に改名）

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    // 既存のヘルスチェック
    if (url.pathname === "/health") {
      // ...
    }

    // GitHub Webhookエンドポイント
    if (url.pathname === "/webhook/github" && req.method === "POST") {
      const rawBody = await req.text();
      const signature = req.headers.get("X-Hub-Signature-256");

      // 署名検証
      if (!verifyGitHubSignature(rawBody, signature, webhookSecret)) {
        return new Response("Invalid signature", { status: 401 });
      }

      const event = req.headers.get("X-GitHub-Event");
      if (event !== "release") {
        return new Response("OK", { status: 200 });
      }

      const payload = JSON.parse(rawBody);
      if (payload.action === "published") {
        await releaseNotificationService.notifyAll(payload.release);
      }

      return new Response("OK", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },
});
```

### 5.3 署名検証

```typescript
import { createHmac, timingSafeEqual } from "crypto";

function verifyGitHubSignature(
  payload: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature) return false;

  const expected =
    "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}
```

### 5.4 リリース通知サービス

```typescript
// src/services/releaseNotificationService.ts

export interface IReleaseNotificationService {
  notifyAll(release: GitHubRelease): Promise<void>;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
}
```

---

## 6. インターフェース設計

### 6.1 型定義

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

### 6.2 Repository インターフェース

```typescript
// src/db/repositories/guildSettings.ts

export interface IGuildSettingsRepository {
  findByGuildId(guildId: GuildId): GuildSettings | null;
  upsert(guildId: GuildId, settings: Partial<GuildSettings>): GuildSettings;
  delete(guildId: GuildId): boolean;
}
```

### 6.3 Service インターフェース

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

### 6.4 LLM Client インターフェース

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

## 7. Bunエコシステム活用

### 7.1 使用する組み込み機能

| 機能 | モジュール | 説明 |
| ------ | ------------ | ------ |
| SQLite | [`bun:sqlite`](https://bun.com/docs/runtime/sqlite.md) | 高性能SQLite3ドライバー（better-sqlite3の3-6倍高速） |
| テスト | [`bun:test`](https://bun.com/docs/test.md) | Jest互換テストランナー |

### 7.1.1 mise によるバージョン固定

- `mise.toml` で Bun を 1.3.x に固定。
- 初回セットアップは `mise run setup`（依存関係インストール + .env初期化）。
- 開発コマンドは `bun` を直接使用（`bun dev`, `bun test` 等）。
- Lint/Format は Biome（`bun lint`, `bun format`）。

### 7.2 bun:sqlite使用例

```typescript
import { Database } from 'bun:sqlite';

const db = new Database('data/disqord.db');

// WALモード有効化（パフォーマンス向上）
db.run('PRAGMA journal_mode = WAL');

// クエリ実行
const stmt = db.query('SELECT * FROM guild_settings WHERE guild_id = ?');
const result = stmt.get(guildId);
```

### 7.3 bun:test使用例

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';

const DEFAULT_MODEL = 'deepseek/deepseek-r1-0528:free';

describe('SettingsService', () => {
  let service: SettingsService;
  let mockRepo: IGuildSettingsRepository;

  beforeEach(() => {
    mockRepo = createMockRepository();
    service = new SettingsService(mockRepo, DEFAULT_MODEL);
  });

  test('getGuildSettings returns default when not found', () => {
    const result = service.getGuildSettings('123');
    expect(result.defaultModel).toBe(DEFAULT_MODEL);
  });
});
```

---

## 8. 参考情報

### 8.1 公式ドキュメント

| 項目 | URL |
| ------ | ------ |
| OpenRouter APIエラー | <https://openrouter.ai/docs/api/reference/errors-and-debugging> |
| GitHub Webhook Events | <https://docs.github.com/en/webhooks/webhook-events-and-payloads> |
| GitHub Webhook署名検証 | <https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries> |
| discord.js RESTJSONErrorCodes | <https://discord.js.org/docs/packages/discord.js/main/RESTJSONErrorCodes:Enum> |
| Bun HTTP Server | <https://bun.sh/docs/api/http> |

---

## 更新履歴

| 日付 | バージョン | 内容 |
| ------ | ------------ | ------ |
| 2025-11-26 | 1.0 | 初版作成 |
| 2025-12-12 | 1.1 | テストディレクトリ構成を実装に合わせて更新 |
| 2025-12-16 | 1.2 | ディレクトリ構成に.dockerignore追加、Dockerfile説明更新 |
| 2025-12-18 | 1.3 | デフォルトモデルを環境変数化、DI例・スキーマ・テスト例を更新 |
| 2025-12-19 | 1.4 | v1.1.0スキーマ（free_models_only）追加 |
| 2025-12-19 | 1.5 | ディレクトリ構成にhealth.ts追加 |
| 2025-12-21 | 1.6 | エラーハンドリング設計（セクション4）、Webhook受信設計（セクション5）、参考情報（セクション8）を追加 |
