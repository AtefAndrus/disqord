---
title: "使用統計"
status: planned
priority: low
summary: "サーバー/ユーザー/モデル別の使用統計（/stats）"
---

# 使用統計

## Why

利用状況の可視化手段がなく、コスト管理やモデル選択の最適化ができない。
サーバー・ユーザー・モデル別の使用量とコストを記録して `/stats` で表示する。

## 依存 / 関連 change

- 関連: [権限管理](../permissions/design.md) — 同じ `guild_settings` を触るが、リリース単位としては独立。`/stats` の実行権限は同 change の共通認可契約に従う
- 先行: [Responses API への移行](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/responses-api-migration/design.md) — usage のフィールド名と、ターンをまたぐ集計対象は同 change が確定する。本 change は確定した集計結果を保存する側
- 関連: [対話UX改善（会話履歴）](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/conversation-context/design.md) — cache read / write トークンの計上先は本 change の `usage_logs`
- 関連: [Web 検索 + ツイート展開](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/web-search/design.md) — server tool の実行回数（`usage.server_tool_use_details`）の計上先は本 change の `usage_logs`

## Goals / Non-Goals

**Goals:**

- サーバー/ユーザー/モデル別の使用統計を記録・表示する

**Non-Goals:**

- 権限管理（[権限管理](../permissions/design.md)）
- ユーザーごとの使用量制限（レートリミット）
- 課金・請求システム
- リアルタイムダッシュボード

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 統計の保存先 | SQLite（usage_logs） | 既存DBインフラを活用 |
| メッセージ内容の保存 | 保存しない | 個人情報保護 |
| ログの保持期間 | 永続（削除機能は将来検討） | 長期トレンド分析を可能に |

## Design

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
- `usage` は全レスポンスで自動返却される。[Responses API への移行](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/responses-api-migration/design.md) 後は `usage: { include: true }` に相当するフィールド自体が存在しない
- 記録対象は、同 change が `AggregatedUsage` に載せるフィールドから選ぶ。基本トークンと `cost` のほか、`prompt_tokens_details.cached_tokens` / `cache_write_tokens`、`completion_tokens_details.reasoning_tokens`、`cost_details`、`server_tool_use_details`（server tool の実行回数）が候補になる
- `server_tool_use_details` は server tool が一度も起動しなかったリクエストでは usage から省かれる。未起動と 0 回を区別するなら、値ではなくキーの有無で判定する
- パフォーマンス: インデックスで集計クエリを高速化

**参照**:

- [OpenRouter Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting) - レスポンスの`usage`オブジェクトに`prompt_tokens`, `completion_tokens`, `total_tokens`, optional な `cost` が含まれる。`usage:{include:true}` は deprecated（自動返却）
- [SQLite Aggregate Functions](https://www.sqlite.org/lang_aggfunc.html) - `SUM()`, `AVG()`, `COUNT()`で統計集計

## Tasks

- [ ] `usage_logs` テーブル追加
- [ ] `usageRepository` 実装
- [ ] `chatService` にログ記録追加
- [ ] `statsService` 実装
- [ ] `/stats` コマンド実装（server/user/model）
- [ ] `docs/changes/usage-stats/` 削除（リリース完了時、git 履歴がアーカイブ）
