---
title: "対話UX改善（会話履歴ストア）"
status: in-progress
priority: high
summary: "DB 永続の会話履歴、無活動ギャップとトークン予算による文脈構築、OpenRouter session routing、削除への追従"
---

# 対話UX改善（会話履歴ストア）

## Why

現状、Bot への各メッセージは独立処理され会話の文脈が保持されない。ユーザは毎回文脈を説明し直す必要がある。
`ChatService` の `buildChatMessages()`（`src/services/chatService.ts`）は、いま届いたメッセージ 1 件だけを `[{ role: "user", content }]` として送り、Discord から過去のメッセージを取得する処理も持たない。

本 change で**多ターンの会話文脈の DB 永続基盤**を入れる。DB 逐次永続化は、(1) `/fork` 等の将来機能や圧縮要約の置き場、(2) 履歴 fetch のレート制限回避（bot は既に `messageCreate` で対象メッセージを受信）、(3) 後続の再生成/編集/undo の土台、を提供する（身内利用前提でプライバシー許容）。

固定 N 件で切る方式は会話途中でも一律に切れて筋が悪いため、**無活動ギャップ + トークン予算**でセッション境界を決め、古い画像は剥がして文脈コストを抑える。

Bot は OpenRouter の Responses API（`POST /responses`）で生成する。
Responses API は会話状態をサーバ側へ保存せず（`store` は `false` 固定）、`previous_response_id` に値を入れたリクエストは HTTP 400 で拒否される（OpenAPI 定義の `ResponsesRequest`）。
そのため会話履歴の source of truth は本 change の DB とし、毎回の `input` に履歴全体を載せる。
一方、`ResponsesRequest` の top-level `session_id` は同じ会話を同一プロバイダへ寄せる sticky routing と観測に使え、プロバイダ側 prompt caching の再利用率を高められるため、ローカル session ごとの不透明な識別子として併用する。

> **スコープ分離**: **回答再生成・編集/undo・compaction**は、本基盤（turn/session モデル）の上の独立機能として [conversation-regeneration](../conversation-regeneration/design.md) が扱う。Bot がオフラインの間の削除の取りこぼしを埋める処理と、応答途中のクラッシュで残った Discord メッセージの後始末は [会話履歴の削除同期の強化](../conversation-context-sync/design.md) が扱う。本 change は**履歴ストア + 境界 + 構造化メディア + オンライン中の削除追従と保持**に集中する。

## 依存 / 関連 change

- 前提（リリース済み）: [Responses API への移行](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/responses-api-migration/design.md) — `runToolLoop()` は `requestFields`（`ToolLoopRequestFields`、`src/llm/toolLoop.ts`）に渡したフィールドを、初回・tool 実行後の再リクエスト・最終ターンのすべてのリクエストへ載せる。`OpenRouterClient` の `toResponsesBody()` は、自分が変換しないフィールドをそのまま body へ展開する。本 change は `ChatCompletionRequest` に `session_id` を足し、`ChatService` から `requestFields: { session_id }` を渡すだけでよい
- 後続: [conversation-regeneration](../conversation-regeneration/design.md) — 本基盤を前提とする回答再生成・編集/undo・compaction
- 後続: [会話履歴の削除同期の強化](../conversation-context-sync/design.md) — オフライン中の削除の補足、孤児メッセージの後始末、未応答 turn の再開、reply チェーンの取り込み
- 連携: [settings-hierarchy](../settings-hierarchy/design.md) — **優先順位で解決した単一 system prompt**（override precedence、合成ではない）を前置
- 連携: [discord-tool](../discord-tool/design.md) — モデル駆動の文脈取得（`fetch_more_context`）は本基盤の上の発展
- 連携: [view-image-rehydration](../view-image-rehydration/design.md) — 本 change の構造化メディア参照を使い剥がした画像をベストエフォート再取得
- 連携: [使用統計](../usage-stats/design.md) — usage/トークンの**コスト計上**（message 本文は保存しない。履歴本体は本 change）
- 連携: [Web 検索](../web-search/design.md) — Web 検索 ON 時に `input` の先頭へ置く system メッセージが分単位の現在日時を含み、prompt cache の prefix を毎分変える（「8. OpenRouter session routing と prompt caching」で配置を変える）
- 連携: [code-execution](../code-execution/design.md) — コンテナは応答ごとの ID（`run_<messageId>_<hex>`）で作り、本 change の session をキーにしない。`container_auto` は `session_id` があると `sess_<session_id>` の共有コンテナになるため同 change は使わない。本 change が `session_id` を送り始めても code-execution の挙動は変わらない

## Goals / Non-Goals

**Goals:**

- **addressed turn**（メンションまたは autoReply チャンネルで bot に向けられた発話。範囲は Decisions の「addressing の範囲」）+ **bot 応答**を**論理ターン**として DB 永続化（1 ターン ↔ 0..N Discord メッセージ）
- gap で区切る **session** + 依存閉じた **exchange 単位**のトークン予算で文脈を構築
- ChatMessage parts（text/image-ref/file-ref・順序）を**再構築可能な versioned JSON**で保存（base64 は保存しない）
- メディア剥がし（保存不変・リクエスト配列のみ）
- 共有チャンネルの発話者識別（ラベルのスナップショット）
- 保持/プライバシー: guild 単位のオプトイン、無効化時の purge、TTL、Bot がオンラインの間に gateway で受け取った Discord メッセージ削除 / bulk 削除 / チャンネル削除 / スレッド削除 / guild 退出への追従（例外は「9. プライバシー / 保持」の「追従の限界」）
- ローカル session ごとに外部へ漏らしても Discord の guild/channel/user を推測できない `openrouter_session_id` を発行し、同じ session の全 OpenRouter リクエストへ `session_id` として付与
- 共通 prompt prefix を安定させ、provider prompt caching が効く形で履歴を送る。cache が利用できないモデルや request でも応答を継続

**Non-Goals:** 直近 N 件で切る方式（採用しない） / **回答再生成・編集/undo・compaction**（→ [conversation-regeneration](../conversation-regeneration/design.md)） / Bot がオフラインの間の削除の補足、送信後クラッシュで残った Discord メッセージの削除、未応答 user turn の再開、reply チェーンの取り込み（→ [会話履歴の削除同期の強化](../conversation-context-sync/design.md)） / OpenRouter 上の会話履歴保存・`previous_response_id` 継続 / `X-OpenRouter-Cache` による完成回答の response caching / provider ごとの明示的 `cache_control` 最適化 / チャンネル単位のオプトイン（→ [settings-hierarchy](../settings-hierarchy/design.md)） / 受動参加（全メッセージ保存）→ Phase 2 / 意図的沈黙 `[SILENT]` → Phase 2 / DM → 将来（`DirectMessages` intent 未設定・設定が guild 前提） / 意味的境界検出 → 将来 / `/search` → 見送り / `/fork` → 別 change

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 永続化の単位 | 論理ターン（`turns`）+ Discord 写像（`turn_messages`、0..N、`seq`） | 1:1 では分割送信(N)・将来の `[SILENT]`(0)・undo を表現できない |
| exchange リンク | assistant turn に `parent_user_turn_id`（その user turn に答える）。1 user → 1 assistant | exchange 単位の境界選択（user 親なしで assistant だけ残さない）に必須 |
| reply 先の記録 | user turn に `reply_to_discord_msg_id`（Discord の `message.reference.messageId`）と、その ID に写像があれば `reply_to_turn_id` を記録するだけにとどめ、文脈構築には使わない | 別 session の発言への reply を文脈に引き込む規則（深さ、循環、purge 済みの扱い）は後続 change の範囲。記録だけは今しないと後から復元できない |
| セッション同一性 | `sessions`（gap 区切り）。turn は `session_id` 保持、guild/channel は session 由来（重複保持しない） | 安定 ID（fork/sandbox）+ 重複カラム不整合の排除 |
| session の割り当て | チャンネルの最新 session の `last_activity_at` から今回の user メッセージの Discord 生成時刻までが GAP（60 分）以内ならその session、超えるか session が無ければ新規。`last_activity_at = MAX(last_activity_at, t)` | 到着順に処理する単純な規則で、session の時刻による再配置や併合をしない。この近似の影響は 2 つある。遅れて処理された発言は、本来続くはずだった古い session の履歴を参照できない。その発言が最新の session に入ると、以後その session の文脈に含まれる。GAP の境界付近では、gateway の遅延や添付の取得による数秒の処理順の逆転でも起きる（例: 最後の発言が 12:00、次の発言 A が 12:59:59、その次の B が 13:00:01 で、B が先に保存されると A も B の新しい session に入る）。身内規模の利用では許容する。`t` が `last_activity_at` より前（負の時刻差）なら同じ session に入れ、`last_activity_at` は変えない |
| OpenRouter session routing | session 作成時に `crypto.randomUUID()` で `openrouter_session_id` を発行し、同じ local session の request と tool loop 内の再 request へ一貫して付与する | OpenRouter の `session_id` は会話保存 ID ではなく sticky routing / 観測用である。Discord ID や連番 DB ID の外部送信を避ける |
| prompt caching | v1 は provider の implicit caching を利用し、共通 prompt prefix を安定させる。`ResponsesRequest` の top-level `cache_control`（最後の cacheable block に自動で breakpoint を置く）、`prompt_cache_key`、`prompt_cache_options` は送らない | 最小 prefix 長・cache write 料金・対応形式が provider ごとに異なり、Anthropic の cache write は通常入力より高い。全モデル共通の明示 cache 方針は、同じ session が続かない会話で write 料金だけを払う結果になりうる。付けるかは実測（Tasks）の後で決める |
| cache usage | 既存の `mapResponsesUsage()`（`src/llm/openrouter.ts`）が `usage.input_tokens_details.{cached_tokens,cache_write_tokens}` を内部の `prompt_tokens_details.*` へ写し、`runToolLoop()` がターンをまたいで合算し、LLM 詳細フッターが `Cached: N` を出す。本 change は新たな parser を持たず、値の永続化は [使用統計](../usage-stats/design.md) に任せる | 未対応 provider と cache miss を区別する型の方針（未返却は「不明」）は既存のまま使える |
| OpenRouter Responses API | 会話状態の保存先として採用しない | Responses API は stateless であり、`store` は `false` 固定、`previous_response_id` は 400 で拒否される |
| addressing の範囲 | 現在の `shouldRespond()`（`src/bot/events/messageCreate.ts`）が応答する発言、つまり bot へのメンションを含む発言と autoReply チャンネル（およびその配下のスレッド）の発言を addressed turn とする。`message.mentions.has()` は返信通知によるメンションも数えるので、返信通知を付けた bot のメッセージへのリプライは本文に `<@bot>` が無くても addressed turn になる。返信通知を切ったリプライは addressed turn にならない | 本 change は応答する条件を変えない。返信通知を切ったリプライにも応答させるかは Open Questions |
| 変動する system 情報の位置 | 現在日時のように毎回変わる system 情報は、履歴の後ろ、今回の user turn の直前に置く。先頭の system メッセージには変わらない内容だけを置く | prompt cache は先頭からの一致でしか効かない。Web 検索 ON 時の system メッセージは分単位の現在日時を含み、先頭に置くと毎分 prefix が変わって履歴全体が cache miss になる |
| FK 強制 | 接続時に `PRAGMA foreign_keys = ON`（WAL と `busy_timeout = 5000` と並べて `src/db/index.ts` で設定）+ 子に `ON DELETE CASCADE`。外部キーの子側の列にはすべて、その列を先頭に持つ index を置く | SQLite は FK 既定 off。子側の index が無いと、親の削除のたびに子の表を全件走査し、大量の purge がイベントループを止める |
| 送信直前の履歴の確認 | 取得した履歴のスナップショットは、履歴を組み立てる前、最初のリクエストの前、画像を外したやり直しの前に、`isContextCurrent()` で確かめる。履歴が ON で、session が残り、スナップショットの各 exchange（今回の exchange を含み、取得後に付いた assistant も DB から引く）が削除記録にも purge 待ちにも当たらないときだけ、そのまま送る。確かめられなければ、今回の発言だけを `session_id` なしで送る | 取得から送信までの間には、ツイート展開、モデル情報の取得、PDF の再取得などの待ちがある。その間の `/config history off`（続けて `on` にされても）や削除を、送る直前の 1 か所で反映するため |
| 冪等性 | user turn の作成は `turn_messages.discord_msg_id` の UNIQUE で冪等にする。同じ Discord メッセージの 2 回目の `messageCreate` は、写像があれば何もしない | gateway の再送で同じ発言に 2 回答えないため |
| bot turn の確定 | 生成の前に assistant turn を `pending` で作り、送信・追加送信のたびに写像を足し、最終描画（追加送信と余ったメッセージの削除）を終えてから `completed` / `stopped` / `failed` と `finalized_at` を書く。起動時に残っている `pending` はすべて `failed` にする | 応答の途中で bot が落ちた turn を、次の起動後に文脈へ入れないため。落ちた時点で送信済みだったメッセージは写像ごと残し、削除は後続 change に回す |
| assistant turn を文脈に入れる時刻 | `finalized_at`（確定した時刻）が今回の user 発言の Discord 生成時刻以下のものだけを入れる | 最初の bot メッセージは「生成中」の placeholder で、その時刻は回答が完成した時刻ではない。利用者が前の回答の完成前に次の発言を書いた場合、その発言の文脈に後から完成した回答を入れない |
| 内部削除と外部削除の区別 | bot が自分のメッセージを消すときは、Discord の削除を呼ぶ前に写像を DB から消す。内部削除すると決めたメッセージは、その時点から削除への追従の対象外とする。削除イベントの処理は写像のあるメッセージだけを扱う | 写像を先に消せば、自分の削除で届く削除イベントは写像が無いので何もしない。代わりに、写像を消した後に利用者が同じメッセージを消しても exchange は purge されず、Discord の削除と中立化の編集が両方失敗したメッセージも写像なしで残る。内部削除の対象は、最終描画で余ったメッセージ、停止後に届いた遅延送信、失敗した応答の後始末に限られ、どれも exchange の保存内容（`content_json`）の一部ではない。削除中のマーカーやリースを持つ方式は、この限界を閉じられる一方で DB 側の状態と起動時の回復処理が増えるため、本 change では使わない |
| 保存前に届いた削除 | 削除イベントで受け取ったメッセージ ID と、削除されたチャンネル・スレッド・guild の ID を、写像の有無にかかわらずプロセス内に 15 分間覚える。user turn の作成時には、発言のメッセージ ID・チャンネル ID・親チャンネル ID・guild ID をこれと照合し、どれかが記録にあれば turn を作らない。写像の追加時にはメッセージ ID を照合し、記録にあれば exchange を purge する。`messageCreate` の開始から user turn の作成までが 10 分を超えた発言は、照合の結果にかかわらず保存せず、履歴なしで応答する | 添付の取得など保存前の非同期処理の間や、送信が成功してから写像を足すまでの間に届いた削除は、その時点では写像や session が無いので削除イベントの処理だけでは拾えない。範囲の削除は payload に個々のメッセージ ID を持たないので、範囲の ID も覚える。10 分の打ち切りは、記録の寿命（15 分）より長く保存を待った処理が、失効した記録を見て削除済みの発言を保存することを防ぐ。プロセス内の記録なので再起動をまたがない。削除を受け取った直後に落ちた場合、後続 change が扱えるのは永続化済みの写像から確かめられる範囲に限られる |
| コンテンツ表現 | **`PersistedContentPart`（text / image-ref{url,mime} / file-ref{url,filename,mime}）の versioned JSON**。`CHECK(json_valid)`。hydration 時に `ChatMessageContent` へ変換 | 永続形（URL/メタ）と OpenRouter DTO（`file_data` は base64 必須）は**非同形**。base64 を保存しない決定とも一致 |
| メディア再取得 | ベストエフォート（画像=URL をそのまま渡す、PDF=再 fetch + base64 化）。PDF を取得できなければ `[file unavailable: <filename>]` に置き換える。画像の URL の失効は provider 側の失敗になる | Discord CDN URL は署名付きで失効する。剥がし（下記）で古いメディアは送らないので、再取得が必要になるのは同じ session の直近のターンに限られる |
| メディア剥がし | 最新のメディアを含む user turn の画像・ファイルだけを残し、それより前は `[earlier image omitted]` / `[earlier file omitted]`。リクエスト配列のみ・保存不変 | コスト/ボディサイズ。直前応答が画像内容を言語化済みという前提 |
| 境界の予算選択 | 依存閉じた exchange（user + その assistant）単位で新しい順に採用 | 行単位だと role 整合が壊れる |
| 共有チャンネル | user turn に `author_label`（表示名スナップショット）+ 安定 `author_id` | 表示名は変わりうるので再現性のためスナップショット |
| オプトイン | guild 設定 `history_enabled`（既定 0）。0 の guild では turn を保存せず、現行どおり今回の発言だけを送る。1 → 0 に変えたらその guild の履歴を物理削除する。turn を作る transaction の中で `history_enabled` を読み直し、0 なら何も作らない | 発言を DB に残すことを guild の管理者が明示的に選ぶ。無効化後に古い履歴が残ると、再度有効化したときに意図しない文脈が戻る |
| 履歴の DB 操作の失敗 | `historyRecorder` を履歴の全 write と context 構築に使い、各操作の失敗を捕捉して回答経路へ例外を渡さない。context の read に失敗した場合は履歴と `session_id` なしで回答する。history off の発言では履歴の DB 操作を行わない。送信済み bot message の写像保存に失敗したら親 user turn を削除し、purge にも失敗した対象はメッセージ ID と channel / thread / guild の scope を持つプロセス内の非期限付き集合に残して context から除外し、context 構築時と TTL sweep 時に再試行する。purge に成功した対象は集合から取り除く。 | 履歴は回答より二次的であり、削除を追従できない内容を残すより fail closed（purge）を優先するため |
| 保持/purge | 容量 TTL は exchange 単位（最後の turn から 30 日を過ぎた後の、次の sweep で消す）。Discord メッセージ削除（写像のあるもの）、チャンネル削除、スレッド削除、guild 退出は該当範囲を CASCADE で物理削除する | 消したものは DB からも消す。TTL を turn 単位にすると exchange の片側だけが残る |
| 削除イベントの受け方 | discord.js のイベントではなく、`Events.Raw` で gateway の `MESSAGE_DELETE` / `MESSAGE_DELETE_BULK` / `CHANNEL_DELETE` / `THREAD_DELETE` / `GUILD_DELETE` を受け、payload の ID で DB を引く | discord.js 14.26.5 の `threadDelete` はスレッドが channel cache にある場合だけ発火し、`messageDelete` もチャンネルの解決に依存する。再起動後の archived thread のように、DB に履歴があってキャッシュに無い対象の削除を取りこぼす。gateway の payload はキャッシュに関係なく ID を持つ |

## Design

### 1. スキーマ

```sql
PRAGMA foreign_keys = ON;  -- src/db/index.ts に追加（現状 WAL のみ）

CREATE TABLE sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  openrouter_session_id TEXT NOT NULL UNIQUE, -- UUID。OpenRouter sticky routing 用であり local FK には使わない
  guild_id     TEXT NOT NULL,
  channel_id   TEXT NOT NULL,              -- スレッドなら thread id
  parent_channel_id TEXT,                  -- スレッドの親チャンネル（親削除時の purge 用。非スレッドは NULL）
  started_at   INTEGER NOT NULL,           -- Discord 生成時刻（ms）
  last_activity_at INTEGER NOT NULL        -- user メッセージの Discord 生成時刻の最大値（ms）
);
CREATE INDEX idx_sessions_channel ON sessions(channel_id, last_activity_at);
CREATE INDEX idx_sessions_parent  ON sessions(parent_channel_id);
CREATE INDEX idx_sessions_guild   ON sessions(guild_id);

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
  discord_created_at INTEGER NOT NULL,     -- user は発言の生成時刻、assistant は最初に送った bot メッセージの生成時刻（未送信なら生成開始時刻）。並びと TTL に使う
  finalized_at  INTEGER,                   -- assistant の確定時刻（ms）。pending の間と user turn は NULL
  CHECK (
    (role='user'
      AND author_id IS NOT NULL AND author_label IS NOT NULL
      AND parent_user_turn_id IS NULL
      AND status IN ('completed','abandoned'))
    OR
    (role='assistant'
      AND author_id IS NULL AND author_label IS NULL
      AND parent_user_turn_id IS NOT NULL
      AND reply_to_turn_id IS NULL AND reply_to_discord_msg_id IS NULL
      AND status IN ('pending','completed','stopped','failed'))
  )
);
CREATE INDEX idx_turns_session ON turns(session_id, discord_created_at, id);
CREATE UNIQUE INDEX idx_turns_one_assistant ON turns(parent_user_turn_id) WHERE role='assistant' AND status != 'failed';
CREATE INDEX idx_turns_created ON turns(discord_created_at); -- TTL sweep
CREATE INDEX idx_turns_parent ON turns(parent_user_turn_id); -- user turn から assistant を引く（上の部分 UNIQUE index は条件付きなので使えない）
CREATE INDEX idx_turns_reply_to ON turns(reply_to_turn_id); -- turn の削除で ON DELETE SET NULL が参照元を引く

CREATE TABLE turn_messages (
  turn_id        INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  discord_msg_id TEXT NOT NULL,
  seq            INTEGER NOT NULL CHECK(seq >= 0),
  PRIMARY KEY (turn_id, discord_msg_id),
  UNIQUE (turn_id, seq)
);
CREATE UNIQUE INDEX idx_turn_messages_msg ON turn_messages(discord_msg_id);
```

- `src/db/schema.ts` の `applyMigrations()` に `CREATE TABLE IF NOT EXISTS` として足す。`guild_settings` には既存パターン（`PRAGMA table_info` → `ALTER TABLE ADD COLUMN`）で `history_enabled INTEGER NOT NULL DEFAULT 0` を足す。
- `active`、user turn の `abandoned`、`reply_to_turn_id` は本 change では使い道を持たない（`active` は `failed` にするとき 0 にするだけ、`abandoned` は作らない、`reply_to_turn_id` は reply 先に写像があれば記録するだけ）。後続の [conversation-regeneration](../conversation-regeneration/design.md)（undo の `active=0`）と [会話履歴の削除同期の強化](../conversation-context-sync/design.md)（未応答 turn の `abandoned`、reply チェーン）がこれらを前提にしているので、後から列を足す移行を避けるために最初から持つ。
- 1 user → 1 assistant は `idx_turns_one_assistant` で強制する。`failed` は index の対象外にし、後続 change が失敗した応答をやり直せるようにしておく。再生成で複数世代を持たせるのは [conversation-regeneration](../conversation-regeneration/design.md) の範囲で、同 change がこの index を置き換える。
- assistant turn の挿入は同じ transaction の中で親の `role='user'` と `session_id` の一致を確かめてから行う（CHECK はサブクエリを書けない）。
- `json_valid` は構文だけを見る。repository は読み出し時に、root が配列であること、各 part が `content_schema_version` の形に合うことを確かめ、合わない turn は文脈から外して `console.warn` を出す。
- 写像の追加は `INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM turns WHERE id = ? AND status = 'pending')` とし、purge 済みや確定済みの turn へは何も足さない（FK が有効なので、存在しない turn への素の INSERT はエラーになる）。
- repository は `src/db/repositories/conversation.ts` の 1 つとし、書き込みは既存の `GuildSettingsRepository.update()` と同じく `db.transaction(...).immediate`（`BEGIN IMMEDIATE`）で直列化する。

### 2. 保存経路

`messageCreate` が応答すると決めた後（`shouldRespond()` と添付の検証を通った後）、guild の `history_enabled` が 1 のときだけ次を行う。`history_enabled` は手順 1 の transaction の中で読み直し、0 になっていれば何も作らず、履歴なしで応答する。

1. **user turn**: `BEGIN IMMEDIATE` の中で、`discord_msg_id = message.id` の写像があれば何もせず応答もしない（gateway の再送）。Decisions「保存前に届いた削除」の判定（メッセージ・チャンネル・親チャンネル・guild の ID の照合と、開始から 10 分の打ち切り）に当たれば、turn を作らない。メッセージ ID が記録にあれば応答もしない。それ以外（範囲の削除か打ち切り）は履歴なしで応答する。無ければ session を割り当て（Decisions「session の割り当て」）、user turn（`status='completed'`、`content_json` は今回の入力の `PersistedContentPart[]`、`author_label` は `message.member?.displayName ?? message.author.username`、`reply_to_discord_msg_id` は `message.reference?.messageId`）と写像（`seq=0`）を作る。スレッドなら `parent_channel_id` に親チャンネルの ID を入れる。
2. **assistant turn**: 同じ transaction で `pending` の assistant turn を作る。これより後で文脈を組むので、今回の user turn は文脈に入り、今回の assistant turn（`pending`）は入らない。
3. **送信の写像**: bot のメッセージを送る経路は次の 5 つあり、すべてを 1 つの記録関数（`onBotMessageSent(turnId, message)`）に通す。記録関数は写像を `seq` の昇順で足し、最初の写像のときに `discord_created_at` をそのメッセージの生成時刻に更新し、ID が「保存前に届いた削除」の記録にあれば exchange を purge する。
   - 初期メッセージの `channel.send()`（`src/bot/events/messageCreate.ts`）
   - `DiscordStreamingUpdater`（`src/bot/events/streamingUpdater.ts`）のストリーミング中の追加送信
   - 最終描画での追加送信
   - 致命的エラー時に部分文を出す追加送信
   - 停止表示での追加送信
4. **内部削除**: bot が自分のメッセージを消す経路もすべて 1 つの関数（`deleteOwnMessage(message)`）に通し、Discord の削除を呼ぶ前に写像を消す。経路は、最終描画で余ったメッセージの `deleteOrNeutralize`、致命的エラー時の `cleanupBotMessagesOnFatalError`、`DiscordStreamingUpdater` が finalize 後に完了した send を消す処理の 3 つである。finalize 後に完了した send は、記録関数を通さずにこの関数で消し、写像を足さない。
5. **確定**: 最終描画の追加送信と余ったメッセージの削除を終えてから、`completed`（全文）/ `stopped`（停止ボタン、部分文）/ `failed`（エラー、`active=0`）、最終の `content_json`、`finalized_at` を書く。更新は `WHERE status='pending'` を付け、既に purge された turn や確定済みの turn には何もしない。

- **起動時**: `ClientReady` の前に `UPDATE turns SET status='failed', active=0 WHERE status='pending'` を実行する。
- **生成中の purge**: 生成中に元の user メッセージが削除されると exchange ごと消え（下記 9）、以後の写像の追加と確定は対象 turn が無いので何もしない。生成と Discord への送信そのものは止めない（その回答は Discord に残るが DB には残らない）。
- `history_enabled` が 0 の guild では DB に何も書かず、文脈は今回の発言だけになる。

### 3. 構造化コンテンツ & メディア

- 永続型 `PersistedContentPart`: `{type:'text', text}` / `{type:'image-ref', url, mime}` / `{type:'file-ref', url, filename, mime}`（**base64 を保存しない**）。`content_json` は versioned 配列。
- user turn は添付の元の情報から作る。`parseAttachments()`（`src/services/attachmentParser.ts`）の戻り値は PDF の元 URL と画像の MIME を持たないので、送信用の part と並べて保存用の参照（URL、MIME、ファイル名）も返すように変える。
- assistant turn はテキスト 1 part とする。
- hydration: request 構築時に `PersistedContentPart[]` → `ChatMessageContent[]` へ変換する。画像は URL をそのまま `image_url` に渡すので、URL が失効していても Bot 側では気づけず、provider 側の取得失敗になる（剥がしで残るのは予算内でメディアを含む最新の user turn だけだが、それが最新の発言とは限らず、経過時間も制限しない。GAP 未満でテキストの会話が続けば、失効した画像の URL を送り続けて応答が失敗しうる）。PDF は再 fetch して base64 の `file` part にし、取得できなければ text part `[file unavailable: <filename>]` にする。
- 今回の user turn のメディアは、hydration を通さず現行どおり `parseAttachments()` の結果をそのまま使う。
- `file-parser` plugin（`PDF_PARSER_PLUGIN`）は現在、今回の入力に file part があるときだけ付く（`buildChatRequest()`）。履歴の hydration 後は、送る `input` のどこかに file part が残っていれば付ける。

### 4. 文脈の構築

1. 今回の user turn の session から、`discord_created_at` が今回の user turn より前の user turn を取り出す（同時刻は `discord_msg_id` を数値として比べる。snowflake は時刻順なので、到着順に依存せず「回答対象より後の発話」を除ける）。
2. `active=1` の turn だけを使う。取り出した user turn はすべて含める。assistant turn は `completed` / `stopped` で、かつ `finalized_at` が今回の user 発言の生成時刻以下のものだけを、その親 user turn の直後に置く。`pending` / `failed` と、今回の発言より後に完成した回答は入れない。この場合、その親 user turn は回答なしで文脈に入る。
3. 今回の user turn を除いた exchange を新しい順に見て、予算（下記 6）に収まる間だけ採用し、古い順に並べ直す。
4. 並びは「不変の system メッセージ → 採用した履歴（古い順）→ 変動する system 情報 → 今回の user turn」とする（下記 8）。

### 5. メディア剥がし

永続参照（`PersistedContentPart[]`）の段階で適用する純関数 `stripHistoricalMedia()`。
今回の user turn を含めて、画像かファイルを含む最新の user turn を基準とし、それより前の turn の image-ref / file-ref を `[earlier image omitted]` / `[earlier file omitted]` の text part に置き換える。
残った参照だけを hydrate するので、剥がした PDF を再 fetch しない。
保存している `content_json` は変えない。

### 6. トークン予算

- 予算は `min(contextLength × 0.5, 32000)` トークンとする。`contextLength` は `IModelService.getModelDetails()` から取り、取れなければ予算そのものを 16000 とする。
- 推定は文字数ベースの概算で、上限の保証ではない（ASCII は 4 文字 1 トークン、それ以外は 1 文字 1 トークン）。画像 1 枚は 1000 トークン、PDF は取得前のため 1 件 2000 トークンと見積もる。
- 予算から、system メッセージ、tool の定義（送る場合）、今回の user turn、応答の予約（4000 トークン）を差し引いた残りに履歴を詰める。残りが 0 以下なら履歴を入れない。
- 見積もりが外れて provider が文脈長超過で 400 を返した場合は、既存の `BadRequestError` の処理に任せる。縮約して再試行する仕組みは持たない。

### 7. 共有チャンネルの発話者識別

user turn を `input` に描画するとき、本文の先頭に `[{author_label}]:` と空白 1 つを付けて発話者を区別する。
`author_label` は保存時に正規化する: 改行とタブを空白に、制御文字・ゼロ幅文字・bidi 制御文字と `[` `]` を除き、前後の空白を落として 32 字で切る。空になったら `author_id` を使う。
OpenAI 形式の `name` フィールドは provider 差があり、Responses API の `input` でも扱いが揃わないので使わない。
今回の user turn にも同じ接頭辞を付ける（履歴の有無で今回の発言の形を変えない）。

### 8. OpenRouter session routing と prompt caching

- 同じ local `sessions.id` に属する生成は、tool 実行後の再リクエストと最終ターンを含め、すべて同じ `openrouter_session_id` を Responses API の top-level `session_id`（最大 256 文字）として送る。`ChatService.generateChatResponse()` が `runToolLoop()` の `requestFields` に渡せば、全ターンに載る。`history_enabled` が 0 の guild では送らない。
- gap 越えで新しい local session を作る場合は、新しい `openrouter_session_id` を発行して provider routing を前の session と分離する。
- cache hit は request の prefix 一致に依存するため、system prompt、tool schema、履歴 message の順序と serialization を決定的に保ち、新しい user turn だけを末尾へ追加する。
- Web 検索 ON 時の system メッセージ（`buildWebSearchSystemMessage()`）は、検索の指示と非信頼データの注意を先頭の不変の system メッセージに、現在日時を今回の user turn の直前の system メッセージに分けて置く。
- Web 検索の ON/OFF を切り替えると `tools` と先頭の system メッセージが変わり、その次の 1 回は cache miss になる。これは許容する。
- cache metadata が無い、cache miss になる、または routing 先が変わる場合も通常応答は失敗させない。

### 9. プライバシー / 保持

- 削除は `Events.Raw` で gateway の payload から受ける（Decisions「削除イベントの受け方」）。現在 `src/index.ts` が購読するのは `ClientReady` / `messageCreate` / `interactionCreate` だけで、以下の handler は本 change で新設する。受け取ったメッセージ ID はすべて「保存前に届いた削除」の記録に入れる。
- `MESSAGE_DELETE` / `MESSAGE_DELETE_BULK`: 写像のあるメッセージについて、写像先が user turn ならその user turn を、assistant turn ならその親 user turn を削除する（CASCADE で exchange 全体が消える）。分割送信のどれか 1 つが消されても exchange 全体を消す。削除後に空になった session も消す。
- `CHANNEL_DELETE`: `channel_id` がそのチャンネルの session と、`parent_channel_id` がそのチャンネルの session（子スレッド）を消す。
- `THREAD_DELETE`: `channel_id` がそのスレッドの session を消す。
- `GUILD_DELETE`: payload に `unavailable: true` が無い場合（bot の退出・キック）だけ、その guild の session をすべて消す。`unavailable: true` は Discord 側の障害による一時的な利用不能なので消さない。
- TTL: 起動時と 24 時間ごとに、最後の turn の `discord_created_at` が 30 日より前の exchange を消し、空になった session も消す。
- `/config history <on|off>`: 暫定で `ManageGuild` を handler 内で確認する（[権限管理](../permissions/design.md) の機構ができたらそれに従う）。`off` にしたら同じ transaction でその guild の session をすべて消す。応答には、発言を DB に保存すること、Bot がオフラインの間に消したメッセージは DB に残りうることを書く。
- **追従の限界**: 次の場合、利用者が消したメッセージの exchange が DB に残る。Bot の停止中に消された場合、bot のメッセージが送信されてから写像を足すまでの間に消され、その直後に Bot が落ちた場合、Bot が内部削除すると決めた後のメッセージ（余ったメッセージ、停止後の遅延送信、失敗した応答の後始末）が消された場合、Discord の削除と中立化の編集が両方失敗して残ったメッセージが消された場合。また、生成中に元の発言が消されても、回答の生成と送信は続く（DB には残らない）。purge が失敗し続ける場合はプロセスが稼働している間だけ再試行し、再起動後は TTL または `/config history off` まで exchange が残る。
- `/status` に履歴の ON/OFF を出す。README に保存する内容、保持期間（最後の発言から 30 日を過ぎた後の次の sweep で消える）、削除への追従の範囲と上の限界を書く。
- `messageUpdate`（user 編集）は無視し、保存した内容を保つ。編集に追従した再生成は [conversation-regeneration](../conversation-regeneration/design.md) の範囲。

## Tasks

- [x] `PRAGMA foreign_keys = ON` を `src/db/index.ts` に追加し、テストが独自に開く `:memory:` の接続にも同じ PRAGMA を掛けてから、既存テストが通ることを確かめる
- [x] `sessions` / `turns` / `turn_messages` と `guild_settings.history_enabled` のマイグレーション
- [x] `ConversationRepository`: session の割り当て、user turn と pending assistant turn の作成（冪等）、写像の追加、確定、写像の削除、purge（メッセージ・チャンネル・スレッド・guild）、TTL sweep、起動時の pending の失敗化
- [x] `PersistedContentPart` 型と、入力からの変換・hydration
- [x] 文脈の構築（cutoff、exchange 単位の予算、並び）と `stripHistoricalMedia()`
- [x] トークン予算の推定
- [x] `author_label` の正規化と接頭辞の描画
- [x] 送信 5 経路を `onBotMessageSent()` に、内部削除 3 経路を `deleteOwnMessage()` に集約し、`messageCreate` と `DiscordStreamingUpdater` に保存経路を組み込む
- [x] 履歴の DB 操作を `src/services/historyRecorder.ts` に集約し、失敗時の fail closed、pending purge の再試行、履歴 context の除外を実装する
- [x] 「保存前に届いた削除」のプロセス内記録（メッセージ・チャンネル・スレッド・guild の ID、15 分）と、user turn 作成時・写像追加時の照合、開始から 10 分を超えた発言を保存しないこと
- [x] `ChatCompletionRequest.session_id` の追加と `requestFields` 経由の付与
- [x] Web 検索の system メッセージを不変部分と現在日時に分け、現在日時を今回の user turn の直前へ移す
- [x] `file-parser` plugin の付与条件を履歴全体へ広げる
- [x] `Events.Raw` による `MESSAGE_DELETE` / `MESSAGE_DELETE_BULK` / `CHANNEL_DELETE` / `THREAD_DELETE` / `GUILD_DELETE`（`unavailable` を除く）の handler
- [x] `/config history` と `/status`、README
- [x] テスト（冪等性、`history_enabled` の transaction 内での再確認、保存前・写像追加前に届いた削除、送信 5 経路の写像、finalize 後の遅延送信を写像せず消すこと、`finalized_at` による cutoff、キャッシュに無いスレッドの削除、`GUILD_DELETE` の `unavailable`、session の割り当て、親の検証、exchange 単位の予算、剥がし、hydration の失敗時、発話者の正規化、各削除イベントの purge、内部削除で purge しないこと、起動時の pending、TTL、`session_id` が全ターンに載ること）
- [x] e2e に 2 往復の会話で前の発言を覚えているかを確かめるシナリオを追加（`history-set` / `history-recall`、名前指定時のみ）
- [ ] prompt caching 対応モデルで同一 session の連続 request を実測し、返却された cache usage と provider routing を記録。top-level `cache_control` を付けるかをこの結果で決める
- [ ] 手動確認: 実クライアントで `/config history on` にして 2 往復会話し、bot の返答メッセージを削除すると次の返答がその exchange を覚えていないこと、`/config history off` の後は前の会話を覚えていないことを確かめる
- [ ] `docs/changes/conversation-context/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **返信通知を切ったリプライでの応答（要決定）**: 返信通知を切った bot のメッセージへのリプライ（メンションとして数えられない）も addressed turn にするか。会話の続きを自然に書けるようになる一方、応答する条件が広がり、autoReply でないチャンネルでも bot が話し始める。本 change の範囲に入れるなら `shouldRespond()` の変更と e2e シナリオの追加が要る
- **受動参加スコープ**（Phase 2、MessageContent 範囲・保存量・privacy）
- **トークン推定精度**（日本語/メディア。文脈長超過は 400 のエラー表示になる）
- **prompt cache の provider 差**（最小 cache 対象長、write 料金、TTL、暗黙 caching の有無は provider と model で異なるため、cache hit と費用削減は保証しない）
- **削除への追従の限界**: Bot の停止中に消されたメッセージと、「9. プライバシー / 保持」の「追従の限界」に挙げた場合は DB に残る。停止中の削除の補足は [会話履歴の削除同期の強化](../conversation-context-sync/design.md) の範囲で、それまでは `/config history off` で guild 単位に消せる
- **DM**（将来、`DirectMessages` intent・設定 fallback・privacy）

## 参照

- [OpenRouter OpenAPI 定義](https://openrouter.ai/openapi.json) — `ResponsesRequest` の `session_id`（sticky routing と観測、最大 256 文字）、`store`（`false` 固定）、`previous_response_id`（400 で拒否）、top-level `cache_control` / `prompt_cache_key` / `prompt_cache_options`
- [OpenRouter Prompt Caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching) — provider 別の implicit / explicit caching、cache usage
- [OpenRouter Responses API](https://openrouter.ai/docs/api/reference/responses/overview) — stateless API
- [SQLite foreign keys](https://www.sqlite.org/foreignkeys.html) — FK は既定 off
- [discord.js Client events](https://discord.js.org/docs/packages/discord.js/14.26.5/Client:Class) — `raw` イベント。`threadDelete` はスレッドが channel cache にある場合だけ発火する（14.26.5 の `ThreadDeleteAction`）
- [Discord Gateway Events](https://discord.com/developers/docs/events/gateway-events) — `MESSAGE_DELETE` / `MESSAGE_DELETE_BULK` / `CHANNEL_DELETE` / `THREAD_DELETE` / `GUILD_DELETE`（`unavailable`）
- 着想元: hermes-agent のメディア剥がし、構造化履歴
