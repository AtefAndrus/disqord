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
- 過去の会話履歴は保持しない（対話UX改善で対応予定）

### 1.3 スラッシュコマンド一覧

| コマンド | 説明 |
| -------- | ---- |
| `/help` | 使い方を表示 |
| `/status` | Botのステータス（OpenRouter残高等）を表示、ボタンで設定切り替え可能 |
| `/model current` | 現在設定されているモデルを表示 |
| `/model set <model>` | Guildのデフォルトモデルを変更（Autocomplete対応、新しい順ソート、変更時にモデル詳細情報を表示） |
| `/model list` | OpenRouterのモデル一覧ページへ誘導 |
| `/model refresh` | モデルキャッシュを更新 |
| `/config free-only <on\|off>` | Guildの無料モデル限定設定を切り替え |
| `/config release-channel [channel]` | リリースノート配信先チャンネルを設定（省略で無効化） |
| `/config llm-details <on\|off>` | LLM詳細情報表示を切り替え |
| `/config auto-reply add <channel>` | 自動応答チャンネルを追加 |
| `/config auto-reply remove <channel>` | 自動応答チャンネルを削除 |
| `/config auto-reply list` | 自動応答チャンネル一覧を表示 |

### 1.4 応答形式

| 項目 | 仕様 |
| ---- | ---- |
| 送信方式 | ストリーミング（SSE、2秒ごとにメッセージ更新）、完了後Embed形式 |
| 長文対応 | 9000バイト単位で分割、改行位置優先、複数メッセージに分散（ページ番号表示） |
| 停止ボタン | 生成中は🛑停止ボタンを表示、クリックでAbortController.abort() |
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
    auto_reply_channels TEXT DEFAULT NULL,  -- JSON array: ["channel_id_1", "channel_id_2"]
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

## 7. 参考情報

### API・SDK関連

- [OpenRouter API Documentation](https://openrouter.ai/docs) - メインドキュメント（チャット、モデル、ストリーミング、マルチモーダルなど）
- [OpenRouter TypeScript SDK](https://www.npmjs.com/package/@openrouter/sdk) - 公式TypeScript SDK（型安全なAPI呼び出し）
- [discord.js v14 Documentation](https://discord.js.org/docs/packages/discord.js/14.16.3) - 現在使用中のバージョンのドキュメント
- [discord.js Guide](https://discordjs.guide/) - 初心者向けガイド（コマンド、イベント、デプロイなど）

### インフラ・ツール関連

- [GitHub Webhook Events](https://docs.github.com/en/webhooks/webhook-events-and-payloads) - Webhook署名検証、イベントペイロード
- [Bun Runtime](https://bun.sh/docs) - JavaScript/TypeScriptランタイム（HTTP、SQLite、テストなど）

### 実装時に役立つリソース

**エラーハンドリング**:

- OpenRouterエラーコード: 400（Bad Request）、401（Unauthorized）、402（Insufficient Credits）、403（Moderation）、408（Timeout）、429（Rate Limit）、500/502/503（Model Unavailable）

**レート制限**:

- Discord API: メッセージ取得 50回/秒、メッセージ送信 5回/5秒
- OpenRouter: ユーザーレベル制限（全モデル）とプロバイダーレベル制限（特定モデル）の2種類

**Discord制限**:

- メッセージ長: 2000文字
- Embed description: 4096文字
- Embed数: 10個/メッセージ
- ボタン数: 5個/ActionRow、最大5行（合計25個）
