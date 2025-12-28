# DisQord 設計書

本ドキュメントでは、DisQordのアーキテクチャ、仕様、設計判断を定義する。

実装の進捗・ロードマップは [progress.md](progress.md) を参照。

---

## 1. 仕様概要

### 1.1 呼び出し方法

| 方式 | 対応状況 | 備考 |
| ---- | -------- | ---- |
| メンション | 対応 | `@DisQord 質問` で呼び出し |
| スラッシュコマンド | 対応 | 設定・ヘルプ用途 |
| DM | 非対応 | Guild内のみで動作 |

### 1.2 会話コンテキスト

- **方式**: 単発応答（毎回リセット）
- 過去の会話履歴は保持しない（v1.4.0で対応予定）

### 1.3 スラッシュコマンド一覧

| コマンド | 説明 |
| -------- | ---- |
| `/disqord help` | 使い方を表示 |
| `/disqord status` | Botのステータス（OpenRouter残高等）を表示、ボタンで設定切り替え可能 |
| `/disqord model current` | 現在設定されているモデルを表示 |
| `/disqord model set <model>` | Guildのデフォルトモデルを変更（Autocomplete対応、新しい順ソート） |
| `/disqord model list` | OpenRouterのモデル一覧ページへ誘導 |
| `/disqord model refresh` | モデルキャッシュを更新 |
| `/disqord config free-only <on\|off>` | Guildの無料モデル限定設定を切り替え |
| `/disqord config release-channel [channel]` | リリースノート配信先チャンネルを設定（省略で無効化） |
| `/disqord config llm-details <on\|off>` | LLM詳細情報表示を切り替え |

### 1.4 応答形式

| 項目 | 仕様 |
| ---- | ---- |
| 送信方式 | 一括送信（Embed形式） |
| 長文対応 | 9000バイト単位で分割、改行位置優先、複数メッセージに分散（ページ番号表示） |
| Typing表示 | LLM応答待機中、8秒間隔で継続表示 |
| Embedカラー | モデルIDから決定論的に色決定（FNV-1aハッシュ、16色パレット） |
| LLM詳細情報 | トークン数、コスト、レイテンシ、TPS等をフッターに表示（ON/OFF切り替え可能、デフォルトON） |

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

### 2.2 設計パターン

| パターン | 適用箇所 | 目的 |
| -------- | -------- | ---- |
| Repository | `src/db/repositories/` | データアクセスの抽象化 |
| Service | `src/services/` | ビジネスロジックのカプセル化 |
| 依存性注入 | エントリーポイント | テスタビリティ、疎結合 |

依存性注入は手動コンストラクタ注入を採用。詳細は `src/index.ts` を参照。

---

## 3. DBスキーマ

### 3.1 現行スキーマ

```sql
CREATE TABLE guild_settings (
    guild_id TEXT PRIMARY KEY,
    default_model TEXT NOT NULL DEFAULT 'deepseek/deepseek-r1-0528:free',
    free_models_only INTEGER NOT NULL DEFAULT 0,
    release_channel_id TEXT DEFAULT NULL,
    show_llm_details INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

実装: `src/db/schema.ts`

### 3.2 設計方針

| 項目 | 方針 |
| ---- | ---- |
| Discord ID | TEXT型で保存（JavaScriptのNumber精度問題を回避） |
| タイムスタンプ | ISO 8601文字列（`datetime('now')`） |
| Boolean | INTEGER型（0/1）で保存 |
| WALモード | 有効（パフォーマンス向上） |

---

## 4. インターフェース設計

インターフェース定義は以下のファイルを参照:

| インターフェース | ファイル |
| ---------------- | -------- |
| 共通型（GuildId, ChatMessage等） | `src/types/index.ts` |
| IGuildSettingsRepository | `src/db/repositories/guildSettings.ts` |
| ISettingsService | `src/services/settingsService.ts` |
| IChatService | `src/services/chatService.ts` |
| IModelService | `src/services/modelService.ts` |
| ILLMClient | `src/llm/openrouter.ts` |

---

## 5. エラーハンドリング設計

### 5.1 設計方針

- カスタムエラークラスで種別を明確化
- `userMessage` プロパティでユーザー向けメッセージを提供
- 技術的詳細はログのみに出力

### 5.2 エラークラス階層

```text
Error
  └─ AppError (base)
       ├─ RateLimitError (429)
       ├─ InsufficientCreditsError (402)
       ├─ ModerationError (403)
       ├─ InvalidModelError (400 + message pattern)
       ├─ ConfigurationError (400 + message pattern)
       ├─ ModelUnavailableError (500, 502, 503)
       ├─ AuthenticationError (401)
       ├─ TimeoutError (408)
       ├─ BadRequestError (400)
       └─ UnknownApiError (その他)
```

実装: `src/errors/index.ts`

### 5.3 ユーザー向けエラーメッセージ

| エラー種別 | ユーザー向けメッセージ |
| ---------- | ---------------------- |
| レート制限 | リクエスト制限に達しました。{N}秒後に再度お試しください。 |
| クレジット不足 | API残高が不足しています。管理者にお問い合わせください。 |
| コンテンツモデレーション | 入力内容が制限されました。表現を変えてお試しください。 |
| 無効なモデル | 指定されたモデルは存在しません。 |
| 設定エラー | OpenRouterの設定に問題があります。設定URLで確認してください。 |
| モデル利用不可 | モデルが一時的に利用できません。 |
| 認証エラー | Botの設定に問題があります。管理者にお問い合わせください。 |
| タイムアウト | 応答に時間がかかりすぎています。短いメッセージでお試しください。 |
| 不明エラー | 予期しないエラーが発生しました。 |

### 5.4 レート制限の設計

OpenRouterの429エラーには2種類がある:

| 種別 | 説明 | 動作 |
|------|------|------|
| ユーザーレベル | APIキーに対する制限（`X-RateLimit-Reset`あり） | グローバルフラグで全モデルブロック |
| プロバイダーレベル | 特定モデルのアップストリーム制限（ヘッダーなし） | フラグセットなし、他モデル使用可 |

### 5.5 レジリエンス設計

| 項目 | 動作 |
|------|------|
| 単一リクエスト障害 | 他リクエストに影響を与えない |
| エラー応答失敗 | フォールバックでログのみ出力 |
| `unhandledRejection` | ログ出力、プロセス継続 |
| `uncaughtException` | ログ出力、graceful shutdown |

---

## 6. Webhook受信設計

### 6.1 アーキテクチャ

```text
GitHub Release (published)
    ↓ POST + X-Hub-Signature-256
Cloudflare Tunnel
    ↓
Bot HTTPサーバー (/webhook/github)
    ↓ 署名検証
ReleaseNotificationService
    ↓
登録済み全Guild (release_channel_id設定あり)
```

### 6.2 設計方針

- 署名検証: HMAC-SHA256、timing-safe比較
- 処理対象: `release`イベントの`released`アクションのみ
- インフラ設定: [infrastructure-setup.md](infrastructure-setup.md) を参照

---

## 7. 将来計画（設計骨子）

詳細設計は実装時に本セクションへ追記する。

### v1.4.0 ストリーミング対応

**目的**: リアルタイムでLLM応答を表示し、`/stop`コマンドでキャンセル可能に

---

#### ストリーミング対応

**変更対象**:

- `src/llm/openrouter.ts` - `stream: true`対応、SSE処理
- `src/services/chatService.ts` - ストリーミングレスポンス処理、進行中リクエスト追跡
- `src/bot/events/messageCreate.ts` - メッセージ更新ロジック

**設計メモ**:

**キャンセルと課金**:

- **非ストリーミングリクエスト**: クライアント側でキャンセルしてもサーバー側で処理継続、フル課金
- **ストリーミングリクエスト（対応プロバイダー）**: 接続中断で即座に処理・課金停止
- **対応プロバイダー**: OpenAI、Anthropic、Fireworks、Cohere、DeepInfra等20+
- **非対応プロバイダー**: Google、AWS Bedrock、Groq、Mistral等20+

**実装方式**:

1. `Map<messageId, AbortController>` で進行中リクエストを追跡
2. SSEストリーミングでトークンを受信
3. 2秒ごとにDiscordメッセージを更新（レート制限: 5回/5秒 = 1回/秒、余裕を持って2秒間隔）
4. 完了時にMapから削除

**参照**:

- [OpenRouter Streaming](https://openrouter.ai/docs/api/reference/streaming)

---

#### `/disqord stop`コマンド

**変更対象**:

- `src/bot/commands/disqord.ts` - `stop`サブコマンド追加
- `src/bot/commands/handlers.ts` - stopハンドラー追加
- `src/services/chatService.ts` - AbortController.abort()呼び出し

**設計メモ**:

- `AbortController.abort()`でストリーミング中断
- エラーハンドリング:
  - プロバイダーが非対応の場合、キャンセル警告を表示
  - 既に完了したリクエストへのキャンセルはエラー応答

**参照**:

- [OpenRouter Streaming Cancellation](https://openrouter.ai/docs/api/reference/streaming#cancellation)

---

### v1.5.0 コンテキスト対話

**目的**: 直近n件の会話履歴をLLMに送信し、文脈を保持した対話を実現

**変更対象**:

- `src/db/schema.ts` - `conversation_history`テーブル追加、guild_settings拡張
- `src/db/repositories/conversationHistory.ts` - 新規作成
- `src/services/chatService.ts` - 複数メッセージ対応、履歴取得・保存
- `src/bot/events/messageCreate.ts` - channelId/messageId抽出
- `src/bot/commands/disqord.ts` - contextサブコマンド追加

**DBスキーマ変更**:

```sql
CREATE TABLE conversation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,  -- 'user' | 'assistant'
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_conversation_channel ON conversation_history(channel_id, created_at);

ALTER TABLE guild_settings ADD COLUMN context_limit INTEGER NOT NULL DEFAULT 5;
ALTER TABLE guild_settings ADD COLUMN context_ttl_hours INTEGER DEFAULT 24;
```

**設計メモ**:

- デフォルト: 5件、0-20件設定可能
- TTL: デフォルト24時間、無効化可能
- システムプロンプト: 全会話に付与

**参照**:

- [OpenRouter Chat API](https://openrouter.ai/docs/api-reference/chat-completion)

---

### v1.6.0 設定階層化 + LLMパラメータ設定

**目的**: Guild/Channel/User単位で設定を上書き可能に、LLMパラメータをモデルごとに最適化

**変更対象**:

- `src/db/schema.ts` - `channel_settings`, `user_settings`テーブル追加、`llm_params`カラム追加
- `src/db/repositories/` - 新規Repository追加
- `src/services/settingsService.ts` - 階層解決ロジック
- `src/services/modelService.ts` - デフォルトパラメータ取得
- `src/llm/openrouter.ts` - パラメータ適用

**DBスキーマ変更**:

```sql
CREATE TABLE channel_settings (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    model TEXT,
    system_prompt TEXT,
    llm_params TEXT,  -- JSON: {temperature, top_p, ...}
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id)
);

CREATE TABLE user_settings (
    user_id TEXT PRIMARY KEY,
    model TEXT,
    system_prompt TEXT,
    llm_params TEXT  -- JSON
);

ALTER TABLE guild_settings ADD COLUMN llm_params TEXT;
```

**LLMパラメータ設計**:

**Phase 1: モデルごとのデフォルトパラメータ**:

1. `/api/v1/models` APIレスポンスに含まれる`default_parameters`を使用
2. `ModelService`でキャッシュ時に保存
3. `chatService`がモデルのデフォルトパラメータを取得して適用

**Phase 2: ユーザー設定可能パラメータ**:

- `/disqord config params set <json>` - パラメータをJSON形式で設定
- `/disqord config params reset` - デフォルトに戻す
- `/disqord config params show` - 現在の設定を表示

**マージロジック**:

1. モデルのデフォルトパラメータを取得
2. Guild設定でマージ
3. Channel設定でマージ
4. User設定でマージ
5. `supported_parameters`でバリデーション

**参照**:

- [OpenRouter Parameters](https://openrouter.ai/docs/api/reference/parameters)
- [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models)

**設計メモ**:

- 優先順位: User > Channel > Guild > Model Default > OpenRouter Default
- NULL値は上位設定を継承
- 無効なパラメータはバリデーションで拒否

---

### v1.7.0 権限管理

**目的**: Bot利用を特定チャンネル/ロールに制限

**変更対象**:

- `src/db/schema.ts` - guild_settings拡張
- `src/bot/events/messageCreate.ts` - 権限チェック追加
- `src/bot/commands/disqord.ts` - configサブコマンド追加

**DBスキーマ変更**:

```sql
ALTER TABLE guild_settings ADD COLUMN allowed_channels TEXT;  -- JSON array
ALTER TABLE guild_settings ADD COLUMN admin_role_id TEXT;
```

**設計メモ**:

- `allowed_channels`: NULL=全チャンネル許可、配列=指定チャンネルのみ
- `admin_role_id`: 設定変更権限を持つロール

**参照**:

- [discord.js Permissions](https://discord.js.org/docs/packages/discord.js/main/PermissionsBitField:Class)

---

### v1.8.0 Web Search

**目的**: LLMにWeb検索機能を付与

**変更対象**:

- `src/services/chatService.ts` - モデルIDに`:online`サフィックス付与
- `src/bot/commands/disqord.ts` - 検索モード切り替えコマンド

**設計メモ**:

- OpenRouter `:online` サフィックスで有効化
- 追加費用発生（要注意）

**参照**:

- [OpenRouter Web Search](https://openrouter.ai/docs/features/web-search)

---

### v1.9.0 複数モデル並列

**目的**: 同じ質問を複数モデルに投げて比較

**変更対象**:

- `src/services/chatService.ts` - 並列リクエスト
- `src/bot/events/messageCreate.ts` - 複数Embed送信

**設計メモ**:

- `Promise.allSettled()` で並列実行
- 各モデルの応答を別々のEmbedで表示

---

## 8. 参考情報

- [OpenRouter APIエラー](https://openrouter.ai/docs/api/reference/errors-and-debugging)
- [GitHub Webhook Events](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [Bun HTTP Server](https://bun.sh/docs/api/http)
