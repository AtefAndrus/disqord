---
title: "権限管理 + 使用統計"
status: planned
priority: low
summary: "チャンネル/ロール権限管理と使用統計（/stats）"
---

# 権限管理 + 使用統計

## Why

Botが全チャンネル・全ユーザに無制限でアクセス可能な状態は、大規模サーバーでの運用に適さない。チャンネル/ロール単位の制限が必要。また、利用状況の可視化手段がなく、コスト管理やモデル選択の最適化ができない。

## Goals / Non-Goals

**Goals:**

- Bot利用を特定チャンネル/ロールに制限可能にする
- サーバー/ユーザー/モデル別の使用統計を記録・表示する

**Non-Goals:**

- ユーザーごとの使用量制限（レートリミット）
- 課金・請求システム
- リアルタイムダッシュボード

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 権限のデフォルト | 全チャンネル許可 | 既存動作を維持、明示的に制限する方式 |
| 統計の保存先 | SQLite（usage_logs） | 既存DBインフラを活用 |
| メッセージ内容の保存 | 保存しない | 個人情報保護 |
| ログの保持期間 | 永続（削除機能は将来検討） | 長期トレンド分析を可能に |

## Design

### 権限管理

**変更対象ファイル**:

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

- [discord.js PermissionsBitField](https://discord.js.org/docs/packages/discord.js/14.26.3/PermissionsBitField:Class) - `member.permissions.has()`で権限チェック
- [discord.js GuildMember](https://discord.js.org/docs/packages/discord.js/14.26.3/GuildMember:Class) - `member.roles.cache.has(roleId)`でロール所属確認

---

### 使用統計

**変更対象ファイル**:

- `src/db/schema.ts` - `usage_logs`テーブル追加
- `src/db/repositories/usageRepository.ts` - 使用ログのCRUD
- `src/services/chatService.ts` - リクエスト完了時にログ記録
- `src/services/statsService.ts` - 統計集計ロジック
- `src/bot/commands/stats.ts` - `/stats`コマンド追加
- `src/bot/commands/handlers.ts` - statsハンドラー追加

**DBスキーマ変更**:

```sql
CREATE TABLE usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,          -- USD
    latency_ms INTEGER NOT NULL DEFAULT 0,
    stopped INTEGER NOT NULL DEFAULT 0,     -- 0: 完了, 1: 停止
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_usage_guild ON usage_logs(guild_id, created_at);
CREATE INDEX idx_usage_user ON usage_logs(user_id, created_at);
CREATE INDEX idx_usage_model ON usage_logs(model, created_at);
```

**コマンド設計**:

```text
/stats server [period]
  - period: today | week | month | all (デフォルト: month)
  - サーバー全体の統計を表示

/stats user [user] [period]
  - user省略時: 自分の統計
  - period: today | week | month | all (デフォルト: month)
  - ユーザー別統計を表示

/stats model [model] [period]
  - model省略時: 全モデル比較
  - period: today | week | month | all (デフォルト: month)
  - モデル別統計を表示
```

**表示項目**:

| 統計項目 | 説明 |
| -------- | ---- |
| リクエスト数 | 総リクエスト回数 |
| トークン数 | prompt/completion/total |
| 推定コスト | USD換算 |
| 平均レイテンシ | ms |
| 停止率 | 停止ボタンでキャンセルされた割合 |
| 上位モデル | 使用頻度が高いモデルTOP3 |
| 上位ユーザー | 使用頻度が高いユーザーTOP3（server統計のみ） |

**実装内容**:

1. **ログ記録タイミング**:
   - `chatService.generateResponseStream()`完了時
   - 停止ボタンでキャンセルされた場合も記録（`stopped=1`）

2. **統計集計**:
   - SQLの`GROUP BY`と集約関数で集計
   - 期間フィルタは`created_at`で絞り込み

3. **表示形式**:
   - Embed形式で表示
   - フィールドに各統計項目を配置
   - グラフは不要（テキストベースで十分）

**ストレージ見積もり**:

- 1レコード: 約200バイト
- 月間10,000リクエスト: 約2MB
- 年間: 約24MB（SQLite制限内で十分）

**設計メモ**:

- ログは永続保存（削除機能は将来検討）
- 個人情報保護: メッセージ内容は保存しない
- コスト計算: OpenRouterレスポンスの`usage`から取得。**`usage.cost` は無料モデルでは 0、ストリーミング前段チャンク等では欠落し得る**（公式に「null」と明記はされていない）ため、記録時は `cost ?? 0` でガードする（`usage_logs.cost REAL NOT NULL DEFAULT 0` は null 非許容なので明示フォールバックが必要）
- `usage` は全レスポンスで自動返却されるため `usage: { include: true }` / `stream_options: { include_usage: true }` は **deprecated**。リクエストに付与しない
- 追加で `prompt_tokens_details.cached_tokens` / `completion_tokens_details.reasoning_tokens` 等も usage に含まれる（記録するかは任意、初期は基本フィールドのみ）
- パフォーマンス: インデックスで集計クエリを高速化

**参照**:

- [OpenRouter Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting) - レスポンスの`usage`オブジェクトに`prompt_tokens`, `completion_tokens`, `total_tokens`, optional な `cost` が含まれる。`usage:{include:true}` は deprecated（自動返却）
- [SQLite Aggregate Functions](https://www.sqlite.org/lang_aggfunc.html) - `SUM()`, `AVG()`, `COUNT()`で統計集計

## Tasks

- [ ] guild_settingsにallowed_channels, admin_role_idカラム追加
- [ ] messageCreateに権限チェック追加
- [ ] 権限設定コマンド実装
- [ ] usage_logsテーブル追加
- [ ] usageRepository実装
- [ ] chatServiceにログ記録追加
- [ ] statsService実装
- [ ] `/stats`コマンド実装（server/user/model）
- [ ] `docs/changes/permissions-stats/` 削除（リリース完了時、git 履歴がアーカイブ）
