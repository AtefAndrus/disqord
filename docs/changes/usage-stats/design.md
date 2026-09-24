---
title: "使用統計"
status: planned
priority: low
summary: "サーバー/ユーザー/モデル別の使用量とコストを記録し /stats で表示する"
---

# 使用統計

## Why

利用状況の可視化手段がなく、コスト管理やモデル選択の最適化ができない。
現状、OpenRouter が返す `usage` は応答のフッター表示に使うだけで（`src/bot/events/messageCreate.ts:443-449`）、どこにも保存しない。
応答ごとの記録である `reply_records` も、状態とページ数しか持たない（`src/db/schema.ts:114-123`）。
サーバー・ユーザー・モデル別の使用量とコストを記録して `/stats` で表示する。

## 依存 / 関連 change

- 先行: [権限管理](../permissions/design.md) — `/stats` のうち他のメンバーの使用量を見る操作は同 change の共通認可関数で判定する。同じ `guild_settings` を触るが、本 change は列を足さない
- 連携: [スケジュール実行（cron）](../cron/design.md) — ジョブの実行も `usage_logs` に記録し、`user_id` にはジョブの登録者を入れる
- 連携: [OAuth BYOK](../oauth-byok/design.md) — どのキーで支払ったか（ユーザー / Guild / デフォルト）を `key_source` 列に記録する。同 change より先に実装した場合、列は `default` だけを取る

## Goals / Non-Goals

**Goals:**

- 応答 1 回ごとの使用量とコストを記録する（通常の応答とスケジュール実行の両方）
- サーバー/ユーザー/モデル別の統計を `/stats` で表示する
- 停止・失敗した応答の不完全な使用量が合計値を歪めないようにする

**Non-Goals:**

- ユーザーごとの使用量制限（レートリミット）
- 課金・請求システム
- リアルタイムダッシュボード

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 統計の保存先 | SQLite の新テーブル `usage_logs` | 既存の DB を使える。`reply_records` は Discord 上のページ管理のための表で、スケジュール実行のように返答ページを持たない実行を載せられない |
| メッセージ内容の保存 | 保存しない | 個人情報保護 |
| ログの保持期間 | 永続（削除機能は将来検討） | 長期トレンド分析を可能にする |
| 記録する箇所 | チャットは `chatService.generateChatResponse` が再試行を含めた最終の結果を決めた直後に 1 回だけ記録する。Web 検索やツイート画像の失敗でループ全体をやり直すと 1 回の応答に複数の tool ループの結果ができ、現在のコードは各試行の usage を `addUsage` で合算して最終の結果に載せている（失敗した試行の費用も含む）。ターン数と `cost` を報告したターン数も同じく全試行で合算する。スケジュール実行は [cron](../cron/design.md) の `chatService.generateScheduledResponse` が OpenRouter の応答を受け取った直後 | tool ループの結果（`ToolLoopResult`）は完了・停止・エラーのどれでも `usage` を持つ。Discord への描画や配信が後で失敗してもクレジットは消費済みなので、描画結果を待つ `messageCreate` 側ではなくここで記録する。cron と本 change のどちらが後に実装されても、後の側が `generateScheduledResponse` の記録を実装する |
| トークン列の名前 | `prompt_tokens` / `completion_tokens` | 内部の usage 型は Chat Completions の名前を使う（`src/types/index.ts` の `ChatCompletionResponse.usage`）。Responses API の `input_tokens` / `output_tokens` はクライアントの境界で変換済みであり、列名を内部型に揃えると変換が要らない |
| 不明な値 | NULL で保存する | 内部の usage 型では、報告されなかった項目は欠落しており、0 とは区別される。`cost` を 0 で埋めると「無料だった」と「不明」が見分けられない |
| 停止・失敗した応答 | 行は記録し、`usage_complete = 0` を付けてトークンとコストの合計から除く | 停止時は進行中のターンの usage が届かない（`src/bot/events/messageCreate.ts:417` のコメント）。記録される値は完了済みのターンの分だけで、実際の消費より少ない。合計に混ぜると過少になり、捨てると停止率が出せない |
| `/stats` の認可 | 自分の統計は誰でも見られる。サーバー全体・モデル別・他のメンバーの統計は [権限管理](../permissions/design.md) の共通認可関数を満たすメンバーだけ | 他のメンバーの利用量とコストは、そのメンバーの行動の記録でもある |
| 表示形式 | 他のコマンド応答と同じ Components V2 のコンテナ | コマンドの応答は Components V2 に統一済みで、Embed を使う応答は無い |

## Design

### 変更対象ファイル

- 修正: `src/db/schema.ts` — `usage_logs` テーブル追加
- 新規: `src/db/repositories/usageRepository.ts` — 使用ログの追加と集計クエリ
- 修正: `src/services/chatService.ts` — 再試行を含めた最終の結果を決めた直後に 1 回記録する
- 修正: `src/llm/toolLoop.ts` — `ToolLoopResult` にターン数と `cost` を報告したターン数を足す
- 新規: `src/services/statsService.ts` — 統計の集計
- 新規: `src/bot/commands/stats.ts` — `/stats` コマンド
- 修正: `src/bot/commands/index.ts` / `src/bot/commands/handlers.ts` — `/stats` の登録とハンドラ

### DB スキーマ変更

```sql
CREATE TABLE usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,                  -- 依頼者。スケジュール実行ではジョブの登録者
    channel_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('chat','cron')),
    model TEXT NOT NULL,                    -- 実際に応答したモデル。不明なら要求したモデル
    outcome TEXT NOT NULL CHECK(outcome IN ('completed','stopped','failed')),
    usage_complete INTEGER NOT NULL CHECK(usage_complete IN (0,1)),
    prompt_tokens INTEGER,                  -- NULL = 不明
    completion_tokens INTEGER,
    total_tokens INTEGER,
    cached_tokens INTEGER,                  -- prompt_tokens_details.cached_tokens
    reasoning_tokens INTEGER,               -- completion_tokens_details.reasoning_tokens
    web_search_requests INTEGER,            -- server_tool_use_details.web_search_requests
    cost REAL,                              -- USD。NULL = 不明
    key_source TEXT NOT NULL DEFAULT 'default' CHECK(key_source IN ('user','guild','default')),
    latency_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_usage_guild ON usage_logs(guild_id, created_at);
CREATE INDEX idx_usage_user ON usage_logs(user_id, created_at);
CREATE INDEX idx_usage_model ON usage_logs(model, created_at);
```

- 記録する値は tool ループが全ターンを合算した `AggregatedUsage`（`src/llm/toolLoop.ts`）から取る。
- `server_tool_use_details` は server tool が一度も起動しなかったリクエストでは usage から省かれる。この場合 `web_search_requests` は NULL（未起動）とし、0 回と区別する。
- `usage_complete` は `outcome = 'completed'` で、かつ全ターンが usage と `cost` を報告したときだけ 1 にする。
- `AggregatedUsage` は、どれか 1 ターンでも報告した項目を残す（`src/llm/toolLoop.ts` の型の説明）。0.10 ドルを報告したターンと `cost` の無いターンを合算すると `cost: 0.10` になり、合計が完全かどうかは合算値から分からない。そこで `runToolLoop()` が、ターン数と `cost` を報告したターン数を `ToolLoopResult` に返すようにし、両者が一致しないときは `usage_complete = 0` にする（`cost` は報告された分の合計として保存し、合計の集計からは除く）。

### コマンド設計

```text
/stats user [user] [period]
  - user 省略時: 自分の統計。他のメンバーを指定するには認可が要る
/stats server [period]
  - サーバー全体の統計（認可が要る）
/stats model [model] [period]
  - model 省略時: 全モデル比較（認可が要る）

period: today | week | month | all（既定: month）
```

### 表示項目

| 統計項目 | 説明 |
| -------- | ---- |
| リクエスト数 | 総数と、停止・失敗の件数 |
| トークン数 | prompt / completion / total（`usage_complete = 1` の行だけを合計） |
| 推定コスト | USD（`usage_complete = 1` かつ `cost` が非 NULL の行だけを合計し、コスト不明の件数を併記する） |
| 平均レイテンシ | ms（完了した応答のみ） |
| 停止率 | 停止ボタンで止めた割合 |
| 上位モデル | 使用頻度が高いモデル TOP3 |
| 上位ユーザー | 使用頻度が高いユーザー TOP3（server 統計のみ） |

### 設計メモ

- 集計は SQL の `GROUP BY` と集約関数で行い、期間は `created_at` で絞る。
- ストレージ見積もり: 1 レコード約 200 バイト。月 10,000 リクエストで約 2MB、年約 24MB で、SQLite の運用上問題にならない。
- 合計値の下に「停止・失敗 N 件の使用量は含まない」と表示し、合計が全消費ではないことを読み手に伝える。

**参照**:

- [OpenRouter Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting) - レスポンスの `usage` に含まれる項目
- [SQLite Aggregate Functions](https://www.sqlite.org/lang_aggfunc.html) - `SUM()` / `AVG()` / `COUNT()`

## Tasks

- [ ] `usage_logs` テーブル追加
- [ ] `usageRepository` 実装
- [ ] `chatService.generateChatResponse` に記録を追加（完了・停止・エラーの 3 経路）
- [ ] `statsService` 実装（不完全な行を合計から除く）
- [ ] `/stats` コマンド実装（server / user / model、認可の判定を含む）
- [ ] テスト追加（停止時の `usage_complete = 0`、不明なコストの NULL 保存と集計での除外、他メンバーの統計の認可）
- [ ] `docs/changes/usage-stats/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **停止・失敗時のコストの推定**: 停止した応答のうち完了済みターンの分は分かるが、進行中のターンの分は分からない。OpenRouter の generation 取得（`GET /api/v1/generation`）は停止時に 404 を返す（`src/bot/events/messageCreate.ts:417` のコメント）ため、後から補完する手段は今のところ無い。
