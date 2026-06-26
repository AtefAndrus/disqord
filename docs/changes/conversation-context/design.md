---
title: "対話UX改善（会話履歴ストア）"
status: planned
priority: high
summary: "DB 永続の論理ターン/セッション履歴・境界検出・構造化メディア・保持。再生成系は別 change"
---

# 対話UX改善（会話履歴ストア）

## Why

現状、Bot への各メッセージは独立処理され会話の文脈が保持されない。ユーザは毎回文脈を説明し直す必要がある。

本 change で**多ターンの会話文脈の DB 永続基盤**を入れる。当初の「Discord API から毎回 fetch・DB 非永続」案は、(1) `/fork` 等の将来機能や圧縮要約の置き場、(2) 履歴 fetch のレート制限回避（bot は既に `messageCreate` で対象メッセージを受信）、(3) 後続の再生成/編集/undo の土台、を踏まえ **DB 逐次永続化へ方針転換**する（身内利用前提でプライバシー許容）。

固定 N 件で切る方式は会話途中でも一律に切れて筋が悪いため、**無活動ギャップ + トークン予算**でセッション境界を決め、古い画像は剥がして文脈コストを抑える。

> **スコープ分離**: 当初この change に含めていた**回答再生成・編集/undo・compaction**は、本基盤（turn/session モデル）の上の独立機能として [conversation-regeneration](../conversation-regeneration/design.md)（本バッチで起票）へ切り出した。本 change は**履歴ストア + 境界 + 構造化メディア + 保持**に集中する。

## 依存 / 関連 change

- 後続（本基盤を前提、本バッチで起票）: [conversation-regeneration](../conversation-regeneration/design.md) — 回答再生成・編集/undo・compaction
- 連携: [settings-hierarchy](../settings-hierarchy/design.md) — **優先順位で解決した単一 system prompt**（override precedence、合成ではない）を前置
- 連携（本バッチで起票、リンクはバッチ完了時解決）: [tool-calling-foundation](../tool-calling-foundation/design.md) / [discord-tool](../discord-tool/design.md) — モデル駆動の文脈取得（`fetch_more_context`）は両者成立後の発展
- 連携（本バッチで起票）: [view-image-rehydration](../view-image-rehydration/design.md) — 本 change の構造化メディア参照を使い剥がした画像をベストエフォート再取得
- 連携: [permissions-stats](../permissions-stats/design.md) — usage/トークンの**コスト計上**（message 本文は保存しない。履歴本体は本 change）
- 将来: [code-execution](../code-execution/design.md) の persistent sandbox は本 change の **session_id** をキーにできる（**sandbox の所有・ライフサイクルは code-execution 側**。同 change の旧記述「所有は conversation-context」を改訂で訂正）

## Goals / Non-Goals

**Goals（v1）:**

- **addressed turn**（メンション/リプライ/autoReply で bot に向けられた発話）+ **bot 応答**を**論理ターン**として DB 永続化（1 ターン ↔ 0..N Discord メッセージ）
- gap で区切る **session** + 依存閉じた **exchange 単位**のトークン予算で文脈を構築
- ChatMessage parts（text/image-ref/file-ref・順序）を**再構築可能な versioned JSON**で保存（base64 は保存しない）
- メディア剥がし（保存不変・リクエスト配列のみ）
- 共有チャンネルの発話者識別（ラベルのスナップショット）
- 保持/プライバシー（オプトイン・TTL・Discord 削除/bulk削除/チャンネル削除同期・guild 退出 purge）

**Non-Goals（v1）:** 固定 N 件切り出し（廃止） / **回答再生成・編集/undo・compaction**（→ [conversation-regeneration](../conversation-regeneration/design.md)） / 受動参加（全メッセージ保存）→ Phase 2 / 意図的沈黙 `[SILENT]` → Phase 2 / DM → 将来（`DirectMessages` intent 未設定・設定が guild 前提） / 意味的境界検出 → 将来 / `/search` → 見送り / `/fork` → 別 change

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 永続化の単位 | 論理ターン（`turns`）+ Discord 写像（`turn_messages`、0..N、`seq`） | 1:1 では分割送信(N)・将来の `[SILENT]`(0)・undo を表現できない |
| exchange リンク | assistant turn に `parent_user_turn_id`（その user turn に答える）。v1 は 1 user → 1 assistant | exchange 単位の境界選択（user 親なしで assistant だけ残さない）に必須 |
| reply チェーン | user turn に `reply_to_turn_id`（`ON DELETE SET NULL`）+ `reply_to_discord_msg_id`（purge 後識別用スナップショット） | assistant→parent だけでは過去 user の reply 先を辿れない |
| セッション同一性 | `sessions`（gap 区切り）。turn は `session_id` 保持、guild/channel は session 由来（重複保持しない） | 安定 ID（fork/sandbox）+ 重複カラム不整合の排除 |
| FK 強制 | 接続時 `PRAGMA foreign_keys = ON`（現状 WAL のみ）+ 子に `ON DELETE CASCADE` | SQLite は FK 既定 off |
| 処理順序 | **(1) `discord_msg_id` 照合 → (2) 既存なら完全 no-op → (3) 無ければ session 解決 + turn + 写像を同一 `BEGIN IMMEDIATE` txn で作成** | duplicate event で先に session を作ると空 session/`last_activity_at` 延長が起きる |
| parent 整合 | CHECK はサブクエリ不可のため **repository txn で検証**（`parent.role='user'` かつ `parent.session_id=child.session_id`） | FK だけでは assistant 親や別 session 親を防げない |
| セッション生成レース | チャンネル単位の直列 txn（最新取得→gap 判定→作成/更新）、`last_activity_at = MAX(last_activity_at, now)` | 同時メッセージの二重 session 生成防止 |
| bot turn 確定 | **生成/送信の前に** assistant turn(pending) を挿入し `idx_turns_one_assistant` でスロットを原子的 claim（重複/並行ハンドラの二重生成・二重送信を防ぐ）。送信成功ごとに create-or-attach（terminal turn 拒否・別 turn/非互換 `seq` は整合エラー）→ **CAS 確定** `UPDATE turns SET status=?,content_json=?,active=? WHERE id=? AND status='pending'`（勝者のみ、`failed` は `active=0` も原子的に）。`completed`=全文/履歴可、`stopped`=部分文/履歴可、`failed`=`active=0`/履歴除外、`pending`=reconcile まで除外 | claim を送信後にすると二重生成を防げない。Discord 送信と DB commit は非原子的 |
| コンテンツ表現 | **`PersistedContentPart`（text / image-ref{url,meta} / file-ref{url,filename,mime}）の versioned JSON**。`CHECK(json_valid)`。hydration 時に `ChatMessageContent` へ変換 | 永続形（URL/メタ）と OpenRouter DTO（`file_data` は base64 必須）は**非同形**。base64 を保存しない決定とも一致 |
| メディア再取得 | ベストエフォート（画像=URL/再 fetch、PDF=再 fetch + file-parser 再パース）。失効・削除は取得不可を許容 | Discord CDN URL 失効。ロスレスは [view-image-rehydration](../view-image-rehydration/design.md) の課題 |
| メディア剥がし | 直近ユーザターンの画像のみ残し以前は `[earlier image omitted]`。リクエスト配列のみ・保存不変 | コスト/ボディサイズ。直前応答が画像内容を言語化済みという前提 |
| 境界の予算選択 | 依存閉じた exchange（user + その active assistant）単位で新しい順に採用 | 行単位だと role 整合が壊れる |
| 共有チャンネル | user turn に `author_label`（表示名スナップショット）+ 安定 `author_id`。適用設定は addressing ユーザ（無ければ channel 既定）を precedence 解決 | 表示名は変わりうるので再現性のためスナップショット |
| 保持/purge | 容量 TTL は**生 turn を exchange 単位**で。user 起因削除/guild 退出/チャンネル削除/**Discord メッセージ削除（外部）**は CASCADE 物理 purge（プライバシー: 消したものは DB からも消す）。`active=0` は failed turn と将来の undo に用いる | 内部削除（fresh `deleting_internal_at` lease、stale は purge）は対象外。外部 assistant 削除は親 exchange を purge。TTL 内 assistant の巻き添えを避け exchange 単位で扱う |

## Design

### 1. スキーマ

```sql
PRAGMA foreign_keys = ON;  -- src/db/index.ts に追加（現状 WAL のみ）

CREATE TABLE sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  channel_id   TEXT NOT NULL,              -- スレッドなら thread id
  parent_channel_id TEXT,                  -- スレッドの親チャンネル（親削除時の purge 用。非スレッドは NULL）
  is_thread    INTEGER NOT NULL DEFAULT 0 CHECK(is_thread IN (0,1)),
  started_at   INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_channel ON sessions(channel_id, last_activity_at);
CREATE INDEX idx_sessions_parent  ON sessions(parent_channel_id); -- 親チャンネル削除→子スレッド session purge

CREATE TABLE turns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK(role IN ('user','assistant')),
  author_id     TEXT,
  author_label  TEXT,
  parent_user_turn_id    INTEGER REFERENCES turns(id) ON DELETE CASCADE,
  reply_to_turn_id       INTEGER REFERENCES turns(id) ON DELETE SET NULL,
  reply_to_discord_msg_id TEXT,
  status        TEXT NOT NULL,
  content_schema_version INTEGER NOT NULL DEFAULT 1 CHECK(content_schema_version >= 1),
  content_json  TEXT NOT NULL CHECK(json_valid(content_json)),
  active        INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at    INTEGER NOT NULL,
  CHECK (
    (role='user'
      AND author_id IS NOT NULL
      AND author_label IS NOT NULL          -- 共有チャンネル発話者識別に必須（無ければ author_id を fallback スナップショット）
      AND parent_user_turn_id IS NULL
      AND status IN ('completed','abandoned')) -- abandoned = 未応答 user turn（startup reconcile が確定。再生成しないが文脈には含む）
    OR
    (role='assistant'
      AND author_id IS NULL AND author_label IS NULL
      AND parent_user_turn_id IS NOT NULL
      AND reply_to_turn_id IS NULL AND reply_to_discord_msg_id IS NULL
      AND status IN ('pending','completed','stopped','failed'))
  )
);
CREATE INDEX idx_turns_session ON turns(session_id, active, created_at, id);
CREATE UNIQUE INDEX idx_turns_one_assistant ON turns(parent_user_turn_id) WHERE role='assistant' AND status != 'failed'; -- v1: 1 user→1 assistant。**failed は slot を解放しリトライ可**（regeneration change で置換）。assistant スロットの原子的 claim にも使う
CREATE INDEX idx_sessions_guild ON sessions(guild_id); -- guild purge
CREATE INDEX idx_turns_author  ON turns(author_id);    -- user purge
CREATE INDEX idx_turns_created ON turns(created_at);    -- TTL sweep（exchange 失効）

CREATE TABLE turn_messages (
  turn_id        INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  discord_msg_id TEXT NOT NULL,
  seq            INTEGER NOT NULL DEFAULT 0 CHECK(seq >= 0),
  deleting_internal_at INTEGER, -- 内部削除リースの時刻（NULL=非マーク）。lease 失効/失敗時は startup reconcile がクリアし、stale マーカーによる purge 抑制の悪用を防ぐ
  external_delete_observed INTEGER NOT NULL DEFAULT 0 CHECK(external_delete_observed IN (0,1)), -- fresh lease 中に外部削除イベントを観測（内部削除が未確認なら exchange purge を発火）
  PRIMARY KEY (turn_id, discord_msg_id),
  UNIQUE (turn_id, seq)
);
CREATE UNIQUE INDEX idx_turn_messages_msg ON turn_messages(discord_msg_id);
```

- v1 は 1 user → 1 assistant（`idx_turns_one_assistant` で強制。複数世代は [conversation-regeneration](../conversation-regeneration/design.md) で `generation_number` を追加導入し置換）。
- `BEGIN IMMEDIATE` txn 内で parent の role/session を検証してから assistant turn を挿入。
- `json_valid` は構文のみ。repository で **root が配列・各 part が宣言 `content_schema_version` に合致・未知 version は安全に fail** を検証する。

### 2. セッション解決・保存経路

1. **`turn_messages.discord_msg_id` を照合 → 既存なら完全 no-op**（冪等）。pre-lock チェックは 2 ハンドラが通過しうるため、**`BEGIN IMMEDIATE` lock 取得後に再読**し、UNIQUE 競合は整合エラーでなく**冪等 no-op**として扱う。
2. 無ければ**チャンネル単位の直列 txn**で session 解決。**Discord メッセージ生成時刻 t で配置**: t が既存 session の `[started_at, last_activity_at + GAP]` に入ればそれ、入らなければ新規（最新 session との単純比較ではなく時刻配置。遅延/順序入れ替えに頑健）。**配置規則（inactivity-gap・重複なし）**: t を、`(S.started_at - GAP) <= t <= (S.last_activity_at + GAP)` を満たし**隣接 session の領域を侵さない** session S に割当て、`started_at = MIN(started_at, t)` / `last_activity_at = MAX(last_activity_at, t)` へ拡張（started_at より前に来た late message も後付け結合できる＝gap セマンティクスを保つ）。t が**前後 2 session の GAP 内に同時に入り両者を橋渡しする**場合でも、**物理マージはしない**（`session_id` は fork/sandbox 用の安定 ID なので不変に保つ）。t を**近い方（既定は earlier）の session に割当て**、bounds を隣接 session の started_at を超えない範囲で拡張する。結果として隣接 2 session が GAP 内に並ぶ近似は許容（稀。厳密 gap セマンティクスより `session_id` 安定性を優先。文脈構築は必要なら隣接 session を跨いで拾ってよい）。該当無しなら新規。`BEGIN IMMEDIATE`（SQLite は **DB 全体で writer を直列化**。単一プロセス低負荷では十分、チャンネル単位の細粒度が要れば app レベル mutex 追加）下で実行し concurrent builder は部分状態を見ない。スレッドは `is_thread=1` + `parent_channel_id` も記録。
3. user turn: turn(role=user, status=completed) + 写像を同一 txn で作成。`reply_to_turn_id`/`reply_to_discord_msg_id` を解決して記録。
4. bot turn: **LLM 生成/送信の前に** turn(role=assistant, status=pending, parent_user_turn_id) を挿入してスロットを原子的 claim（`idx_turns_one_assistant`。重複/並行ハンドラはここで弾かれ生成・送信しない）。生成 → **分割を送信成功ごとに逐次 create-or-attach**（`discord_msg_id` キーで再試行安全。既存が別 turn/非互換 seq なら整合エラー）。確定は **CAS**: `UPDATE turns SET status=?,content_json=?,active=? WHERE id=? AND status='pending'`。`completed`=全文/履歴可、`stopped`=部分文/履歴可、`failed`=`active=0`/履歴除外、`pending`=reconcile まで除外。

- `MessageContent` 有効済み。**`Partials.Message` を client に追加**し、partial delete/update も `discord_msg_id` で写像照合。

#### 2.1 状態機械・失敗回復・内部削除の抑制

- **処理の state machine**（冪等と回復の両立。Section 2 の「照合 → no-op」を細分化）: `discord_msg_id` 照合 + user/assistant の状態で分岐。
  - user turn 無し → 新規作成（session 配置 + user turn + 写像）。
  - user turn 有り（**not abandoned**）+ **assistant 未 claim**（or `failed` のみ）→ **resume**（既存 `failed` 行を削除してから assistant スロットを原子的 claim・生成再開。複数 failed 行の累積を防ぐ）。
  - user turn が **`abandoned`** → no-op（再生成しない。replay されても resume しない。文脈には含む）。
  - user turn 有り + **assistant pending（in-flight）** → **attach / 待ち**（既存処理に委譲。**起動時の補償削除パスは走らせない**。reconcile〔補償削除〕は startup スキャン or timeout/lease 失効でのみ）。
  - user turn 有り + **assistant terminal**: `completed`/`stopped` → no-op（既に応答済み）。`failed` は terminal だが**上記 resume 対象**（slot 解放済み・リトライ可）。
- **送信と DB の非原子性 / 起動時 reconcile の確定規則**: assistant slot を**送信前に** claim するので二重生成・二重送信は防げる。`pending` assistant turn の起動時 reconcile は確定的に: **attach 済み `turn_messages` がある**なら、**先に `deleting_internal_at = now` lease をマーク**（下記 lease 抑制プロトコルを全 bot 起因削除＝reconcile 含むに適用。さもないと自分の削除を外部削除と誤認し exchange/user turn まで purge する）→ `discord_msg_id` で Discord メッセージを補償削除（best-effort）→ 写像削除 → turn を `failed`/`active=0`（slot 解放・リトライ可）。**attach 0 件**の pending も `failed`/`active=0`。送信後・写像作成前 crash（写像化されていない孤児メッセージ）は id を失うので best-effort 照合 + log（厳密化は durable outbox を将来検討、Open Questions）。content は完了時 CAS で確定するため、crash した pending は部分 content を最終応答にしない。
- **stale pending**: 同一プロセス内で hung/lost した生成は `pending` が slot を塞ぐ。全生成経路に **timeout** を課し、超過で `pending → failed`（failed は slot を解放しリトライ可）。lease/heartbeat でも可。
- **外部 purge と生成中の競合**: source メッセージが `pending` 中に外部削除されたら exchange を purge し、**in-flight 生成を AbortSignal でキャンセル**（[tool-calling-foundation](../tool-calling-foundation/design.md) の cancellation 経路）。現行の応答は初期メッセージを `edit()` で stream するため、**send だけでなく edit/delete/finalize の各 Discord write の前に turn 存在を確認**する。purge 後は CASCADE で写像が消えるので、cleanup は **in-memory の既作成 bot メッセージ一覧**を使い、turn 不在/purge-abort なら当該 pending turn の**既知 bot 応答メッセージを全て best-effort 削除**する。**send 成功が返った直後、DB attach や後続 edit/finalize を await する前に** message ID を cleanup 一覧へ記録する（さもないと send 成功〜DB 写像の間に purge が来ると初回応答を取りこぼす）。
- **未応答 user turn の起動時 reconcile**: 重複イベントの来ない crash 後、assistant 未 claim の user turn が応答経路を失う。startup スキャンで未応答 user turn を検出し、しきい値より古いものは **abandoned**（自動再生成しない＝ユーザの再質問に委ねる、履歴には残す）、ごく直近のみ resume 可。決定的ルールで無期限放置を防ぐ。
- **内部削除 vs 外部 delete handler の競合（lease 方式）**: 生成中クリーンアップ（既存 `messageCreate` 送信ロジックが Discord 削除 + 写像削除）と汎用 `messageDelete`（exchange を物理 purge）が競合し、gateway イベントが写像削除より先に来ると正常 exchange を誤 purge する。**耐久的抑制プロトコル**: ①写像を txn で `deleting_internal_at = now`（lease）にマーク → ②Discord 削除 → ③成功後に写像削除。**purge 抑制は内部削除が confirmed のときだけ**。fresh lease 中に外部 delete イベントが来た場合は写像を即削除せず `external_delete_observed` を記録し、内部削除が**確認できたら写像のみ除去（purge なし）**、内部削除が**失敗/未確認なら観測した外部削除を採用して exchange を purge**（fresh lease でも実外部削除を取りこぼさない）。**stale lease**（失効・REST 失敗・crash）は **startup reconcile が確定的に解決**: 意図した内部削除がまだ有効なら再試行、そうでなければ**マーカーをクリア**（以後の外部削除は正常に purge）。これにより stale/fresh どちらのマーカーもプライバシー purge を恒久バイパスしない（in-memory set はクラッシュを跨げない）。

### 3. 構造化コンテンツ & メディア

- 永続型 `PersistedContentPart`: `{type:'text', text}` / `{type:'image-ref', url, mime, ...}` / `{type:'file-ref', url, filename, mime}`（**base64 を保存しない**）。`content_json` は versioned 配列。
- hydration: request 構築時に `PersistedContentPart[]` → `ChatMessageContent[]` へ変換（画像は URL 直渡し or 再 fetch、PDF は再 fetch + file-parser で base64 化）。失効/削除は取得不可を許容。
- ライブ送信時の PDF base64 化は現行どおり（保存形だけ参照化）。

### 4. セッション境界

```text
0. **選択ルール（具体）**: `user.status IN ('completed','abandoned')` の turn を含める（現在の user turn・未応答 abandoned turn＝assistant 無しも文脈に入れる）。assistant は `status IN ('completed','stopped')` かつ**その mapped bot メッセージの snowflake が cutoff 以下**のときのみ付随（out-of-order 完了で「回答対象より後」の assistant を含めない）、`pending`/`failed` は除外。
1. session 内の exchange（上記ルールの user + 付随 assistant）を、**現在の user turn を cutoff**（Discord 生成時刻 + tie-breaker は `discord_msg_id` の **snowflake 数値順**〔= 時刻順。`turn.id`〔挿入順〕や TEXT の文字列 ORDER は不可。INTEGER/BigInt 比較 or 数値 snowflake 列で〕）として、それ以前のものだけ新しい順に列挙（out-of-order 処理で「回答対象より後の発話」が混入するのを防ぐ）
2. 予算（下記 6）に収まる範囲で exchange 単位採用 → 古い順へ
3. reply トリガー時: reply_to_turn_id を辿る（深さ上限・循環検出・purge 済み(reply_to_discord_msg_id のみ)は省略 or 短い注記）。予算/境界は上書きしない
```

### 5. メディア剥がし

最新の**メディアを含む（画像/ファイル）user turn** を基準に、それ以前の image/file part を `[earlier image omitted]` へ置換する純関数（hydration 後の `ChatMessageContent[]` に適用、保存不変）。画像のみでなく file-only turn も基準対象に含める。

### 6. トークン予算

保守的推定（日本語は係数厚め）+ system prompt/tool schema/応答/メディアトークンの予約を BUDGET から差し引く。超過は最古 exchange から落とす。`usage.prompt_tokens`（native）は事後ログ用。

### 7. 共有チャンネルの発話者識別

user turn の OpenRouter 表現では `author_label` を**メッセージ本文に描画**（例: 先頭に `表示名:`）して発話者を区別する。描画時は **bounded な単一行ラベルに正規化**する（改行除去・長さ制限・role 風/制御文字のエスケープ。表示名が使えなければ `author_id` に fallback）。OpenAI 形式の `name` フィールドはプロバイダ差があり脆いので使わない。非 bot メンション/リプライ先の文脈は保持。適用設定は addressing ユーザ（無ければ channel 既定）を precedence 解決。

### 8. プライバシー / 保持

- guild/channel オプトイン（既定 off も可）。容量 TTL は**生 turn を exchange 単位**で（user expiry の CASCADE で TTL 内 assistant まで消えるのを避ける）。**sweep 契約**: 失効判定は exchange の最新 turn timestamp を基準、txn 境界内で exchange ごと削除、空 session も削除。
- user 起因削除 / guild 退出 / **チャンネル削除 / `threadDelete`** → CASCADE 物理 purge（session 削除で turns/turn_messages まで）。スレッドは独自 channel_id を session キーに持つため `threadDelete`（partial-safe）も要る。**親チャンネル削除時は `parent_channel_id` で子スレッド session を列挙して purge**（archived 子スレッドの `threadDelete` が来ないケースを DB 側で補える）。
- **Discord メッセージ削除（単発 / `messageDeleteBulk`、外部）→ 対応 exchange を物理 purge**（プライバシー: ユーザが消したものは DB からも消す〔best-effort。下記「削除同期の耐久性」〕。CASCADE）。**対応 exchange の特定**: 写像 turn が `user` ならその user turn を削除、`assistant` ならその `parent_user_turn_id`（=親 user turn）を削除（分割 chunk のどれが消えても exchange 全体を purge）。CASCADE で子も消える。partial は id で写像照合、**fresh な `deleting_internal_at` lease を持つ写像＝内部削除は purge 対象外**、stale lease は purge する。`active=0` は failed turn と将来の undo（regeneration change）に用いる。
- **削除同期の耐久性（best-effort + opportunistic reconcile）**: gateway delete イベントは bot オンライン時のみ観測されるため、オフライン中の削除は取りこぼす。**契約は best-effort** とし補強する: (a) **hydrate 直前に選択 exchange の写像 `discord_msg_id` を REST 再検証**し、404/権限喪失なら exchange を purge、(b) **起動時にアクセス不能になった guild/channel/thread の session を purge**。**purge は authoritative な 404/403（削除・アクセス剥奪）のときだけ**で、transient な REST 失敗・timeout・rate limit では purge しない（一時障害が破壊的にならないように）。bulk delete は完全復元できないため、ユーザ向け文言も「best-effort」と明記する。
- `last_activity_at` は **user メッセージの Discord 生成時刻**で更新する（gap は user の無活動を測る。**assistant 送信では延長しない**＝bot レイテンシが境界に影響しない）。処理時刻は使わない（遅延イベントで gap を跨いで誤マージするため）。
- **無効化時の挙動**: guild/channel の履歴設定を後から off にしたら、新規 persist を止めるとともに**その scope の既存履歴を物理 purge**（プライバシー優先）。**チャンネル単位の off/purge は `parent_channel_id = channel_id` の子スレッド session も purge**（スレッド履歴がチャンネル無効化を生き残らないように）。別途 `/config history purge` も提供。
- **`messageUpdate`（user 編集）**: v1 は**無視**（元 snapshot を保持。編集再生成は [conversation-regeneration](../conversation-regeneration/design.md)）。永続文脈が見かけの Discord 内容と乖離しうるが v1 は意図的に許容（将来 update/rebuild を検討）。
- 運用範囲を README/`/status` に明示。

## Tasks

- [ ] `PRAGMA foreign_keys = ON` を `src/db/index.ts` に追加
- [ ] `sessions`/`turns`/`turn_messages` + repository（CASCADE・CHECK・冪等順序〔照合→no-op→txn 作成〕・parent role/session 検証・session 直列解決・bot turn status/逐次 create-or-attach・削除同期）
- [ ] `client` に `Partials.Message`、partial-safe な `messageDelete`/`messageDeleteBulk`/`channelDelete`/`threadDelete`/`guildDelete` handler（`deleting_internal_at` lease 抑制 + startup での stale lease 解決つき）
- [ ] 失敗回復契約（user-turn 後・送信前失敗の resumable claim、送信後・写像作成前 crash の補償削除）、bot-turn の CAS 確定、purge 用 index（`sessions(guild_id)`/`turns(author_id)`）
- [ ] `messageCreate` で addressed user turn 保存、bot 応答を送信成功後に逐次保存、生成中削除の写像同期
- [ ] 境界構築（exchange 単位予算 + reply seed〔深さ/循環/purge 注記〕）
- [ ] `PersistedContentPart` 型 + hydration（→ `ChatMessageContent`）+ メディア参照保存
- [ ] `stripHistoricalMedia()`（配列のみ・保存不変）
- [ ] トークン予算推定（保守係数 + 予約 + 超過フォールバック）
- [ ] 共有チャンネル `author_label` + 適用設定解決
- [ ] 保持/プライバシー（オプトイン・exchange 単位 TTL・削除/bulk/channel 同期・user/guild purge）+ `/config`
- [ ] 旧 Discord-fetch コードの置換
- [ ] テスト（冪等順序・session 直列解決・parent 検証・exchange 境界・PersistedContentPart 往復・剥がし・予算・発話者・削除/bulk/channel 同期と purge・partial イベント・pending reconcile）
- [ ] `docs/changes/conversation-context/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **受動参加スコープ**（Phase 2、MessageContent 範囲・保存量・privacy）
- **メディア再取得失敗 UX**（取得不可表示、バイト永続化は view-image で判断）
- **トークン推定精度**（日本語/メディア。over-size 時の縮約リトライ）
- **pending turn の reconcile / 孤児メッセージ**（crash 残置 pending の起動時掃除。送信後・写像作成前 crash の孤児 Discord メッセージは best-effort 照合 + log。厳密化が要れば **durable outbox**〔送信前に outbox 行 → 送信 → 写像確定〕を将来導入）
- **1 user に複数 assistant の制約**（v1 は 1:1 だが、誤って二重生成しない保証を repository で持つか）
- **DM**（将来、`DirectMessages` intent・設定 fallback・privacy）

## 参照

- [OpenRouter Chat Completions](https://openrouter.ai/docs/api/reference/chat) — `messages` 配列。`usage.prompt_tokens`（native）は事後計測
- [SQLite CHECK / foreign keys](https://www.sqlite.org/foreignkeys.html) — CHECK は式が NULL なら成功扱い、FK は既定 off
- [discord.js Partials](https://discordjs.guide/popular-topics/partials.html) — partial delete/update に `Partials.Message`
- [discord.js Client events](https://discord.js.org/docs/packages/discord.js/14.26.2/Client:Class) — `messageDelete`/`messageDeleteBulk`/`channelDelete`/`guildDelete`、`MessageContent` 特権 intent（有効済み）
- 着想元: hermes-agent のメディア剥がし、構造化履歴
