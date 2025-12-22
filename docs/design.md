# DisQord 設計書

## 概要

本ドキュメントでは、DisQordのアーキテクチャ、設計判断、DBスキーマを定義する。

実装詳細は `src/` 配下のコードを参照。

---

## 1. アーキテクチャ

### 1.1 レイヤー構成

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

### 1.2 依存関係

```text
Discord Client
      │ uses
      ▼
ChatService ───▶ ILLMClient (OpenRouter)
      │ uses
      ▼
SettingsService ───▶ IGuildSettingsRepository (SQLite)
```

### 1.3 設計パターン

| パターン | 適用箇所 | 目的 |
| -------- | -------- | ---- |
| Repository | `src/db/repositories/` | データアクセスの抽象化 |
| Service | `src/services/` | ビジネスロジックのカプセル化 |
| 依存性注入 | エントリーポイント | テスタビリティ、疎結合 |

依存性注入は手動コンストラクタ注入を採用。詳細は `src/index.ts` を参照。

---

## 2. ディレクトリ構成

```text
disqord/
├── src/
│   ├── index.ts              # エントリーポイント
│   ├── health.ts             # ヘルスチェックHTTPサーバー
│   ├── bot/
│   │   ├── client.ts         # Discord Client 初期化
│   │   ├── events/           # イベントハンドラ
│   │   └── commands/         # スラッシュコマンド
│   ├── services/             # サービス層
│   ├── llm/                  # OpenRouter APIクライアント
│   ├── db/                   # DB接続、スキーマ、Repository
│   ├── config/               # 環境変数読み込み
│   ├── utils/                # ユーティリティ
│   └── types/                # 型定義
├── tests/                    # テスト（bun:test）
├── docs/                     # ドキュメント
└── data/                     # SQLiteファイル（.gitignore）
```

詳細なファイル構成は実際のコードを参照。

---

## 3. DBスキーマ

### 3.1 現行スキーマ（v1.0）

```sql
CREATE TABLE guild_settings (
    guild_id TEXT PRIMARY KEY,
    default_model TEXT NOT NULL DEFAULT 'deepseek/deepseek-r1-0528:free',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

実装: `src/db/schema.ts`

### 3.2 v1.1.0 マイグレーション（計画）

```sql
-- 無料モデル限定フラグ
ALTER TABLE guild_settings ADD COLUMN free_models_only INTEGER NOT NULL DEFAULT 0;

-- リリースノート配信チャンネル
ALTER TABLE guild_settings ADD COLUMN release_channel_id TEXT;
```

### 3.3 設計方針

| 項目 | 方針 |
| ---- | ---- |
| Discord ID | TEXT型で保存（JavaScriptのNumber精度問題を回避） |
| タイムスタンプ | ISO 8601文字列（`datetime('now')`） |
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
| ILLMClient | `src/llm/openrouter.ts` |

---

## 5. エラーハンドリング設計（v1.1.0）

### 5.1 設計方針

- カスタムエラークラスで種別を明確化
- `userMessage` プロパティでユーザー向けメッセージを提供
- 技術的詳細はログのみに出力

### 5.2 エラーフロー

```text
OpenRouterClient
  └─ HTTPステータスに応じてカスタムエラーをthrow
      ↓
ChatService（パススルー）
      ↓
イベントハンドラ
  └─ AppErrorならuserMessage、それ以外は汎用メッセージを返信
```

エラー種別とメッセージの対応は `docs/requirements.md` を参照。

---

## 6. Webhook受信設計（v1.1.0）

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
- 処理対象: `release`イベントの`published`アクションのみ
- 配信形式: Embed

---

## 7. Bunエコシステム活用

| 機能 | モジュール | 説明 |
| ---- | ---------- | ---- |
| SQLite | `bun:sqlite` | 高性能SQLite3ドライバー |
| テスト | `bun:test` | Jest互換テストランナー |
| HTTPサーバー | `Bun.serve()` | ヘルスチェック、Webhook受信 |

---

## 参考情報

| 項目 | URL |
| ---- | --- |
| OpenRouter APIエラー | <https://openrouter.ai/docs/api/reference/errors-and-debugging> |
| GitHub Webhook Events | <https://docs.github.com/en/webhooks/webhook-events-and-payloads> |
| GitHub Webhook署名検証 | <https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries> |
| Bun HTTP Server | <https://bun.sh/docs/api/http> |

---

## 更新履歴

| 日付 | 内容 |
| ---- | ---- |
| 2025-12-23 | 実装コード例を削減、src/へのリンクに変更 |
