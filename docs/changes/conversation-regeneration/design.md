---
title: "回答の再生成・編集/undo・compaction"
status: planned
priority: medium
summary: "会話履歴ストアの上に載る再生成（generation_number）・undo（active）・履歴 compaction（要約圧縮）"
---

# 回答の再生成・編集/undo・compaction

## Why

[conversation-context](../conversation-context/design.md) で多ターンの会話文脈が DB 永続化されるが、ユーザは「いまの回答が気に入らないのでもう一度」「直前のやり取りを無かったことに」「長い会話のトークンコストを抑えたい」を操作できない。
本 change は会話履歴ストア（`sessions`/`turns`/`turn_messages`）の上に、(1) **回答の再生成**（同じ user turn に対する複数世代）、(2) **undo/redo**（直前 exchange の有効/無効切替）、(3) **編集起因の再生成**（user メッセージ編集 → 応答やり直し）、(4) **履歴 compaction**（古い exchange を要約 turn へ畳んでトークン予算を確保）を加える。

conversation-context は v1 で「1 user → 1 assistant」を `idx_turns_one_assistant` で強制し、**再生成は本 change で `generation_number` を追加導入して当該インデックスを置換する**と明記している。本 change はその切り出しスコープそのものを実装する。

## 依存 / 関連 change

- 先行（**確定済み・必読**）: [conversation-context](../conversation-context/design.md) — `sessions`/`turns`/`turn_messages`、`status`/`active`、`parent_user_turn_id`/`abandoned`、`idx_turns_one_assistant`（v1 制約）、CAS 確定、exchange 単位の境界/予算/保持、`messageUpdate` を v1 で無視。本 change はこれら**実在の契約**の上に載る
- 連携: [tool-calling-foundation](../tool-calling-foundation/design.md) — 生成は `runToolLoop()`（`Promise<ToolLoopResult>`、判別共用体 final/cancelled/error）経由。再生成で in-flight 生成を打ち切る場合は同基盤の **`AbortSignal` cancellation 経路**（`{status:'cancelled'}`）を使う
- 連携: [chat-response-v2](../chat-response-v2/design.md) — Components V2 の描画プリミティブ（Container/Section accessory・ボタン・分割送信・stream updater）と制約を利用する。chat-response-v2 自体は再生成 interaction を扱わず描画基盤のみ提供するため、再生成/undo ボタンの追加・customId ルーティング・edit による世代差し替えは**本 change の責務**
- 連携: [settings-hierarchy](../settings-hierarchy/design.md) — compaction の要約生成に使う system prompt / モデル / 予算しきい値は precedence 解決した設定を使う
- 連携: [permissions-stats](../permissions-stats/design.md) — 再生成・compaction 要約生成の usage/cost も計上対象

## Goals / Non-Goals

**Goals（v1）:**

- 同一 user turn に対する**複数の assistant 世代**を `generation_number` で表現し、active な assistant を**親ごとに高々 1 本**（undo 中は 0 本）にする（`idx_turns_one_assistant` を置換）
- **再生成トリガ**: 直近 assistant メッセージに付く Components V2 ボタン（「再生成」）。スラッシュコマンド `/regenerate` も補助提供
- **undo/redo**: 直近 exchange を単位に `active` を 0/1 で切替（物理削除ではない）。`/undo`・`/redo`、ボタン
- **編集起因の再生成**: user が**直近の active・非 compaction exchange**の自分のメッセージを編集（`messageUpdate`）したら、その user turn の persisted content を更新し新世代を生成（オプトイン。conversation-context の「v1 無視」を**本 change で明示的に上書き**）
- **compaction**: しきい値超過時、session の古い exchange 群を 1 つの**要約**（専用 `session_summaries` 表）へ畳み、以後の文脈構築は要約 + 直近生 exchange を使う（生 turn は保持しつつ畳み込み済みフラグで除外）。被要約 turn の purge では要約を無効化/再計算する（プライバシー伝播）
- Discord 表示: 再生成は**既存 bot メッセージを edit**して世代を差し替え（履歴の `turn_messages` 写像も整合更新）

**Non-Goals（v1）:**

- 分岐ツリー UI（世代間の自由な行き来・木構造ナビ）→ 直近 user turn の世代切替に限定。任意過去 turn の再生成は将来
- **任意過去 turn の編集起因再生成**（下流 turn の cascade 無効化が必要になる）→ v1 は**直近 active・非 compaction exchange の編集のみ**処理。古い turn の編集・compaction 済み turn の編集は無視（下流 stale 化を避ける）
- assistant メッセージの編集（bot 自身の発話の手動編集）→ 対象外
- compaction の意味的要約品質チューニング / 階層的（要約の要約）compaction → 将来
- DM → conversation-context と同じく将来（`DirectMessages` intent 未設定）
- undo の無制限スタック（多段履歴の任意巻き戻し）→ v1 は直近 exchange の単段 undo/redo

**将来別 change 候補:**

- 任意過去 turn の再生成・分岐ツリー → 別 change `conversation-branching`
- 階層 compaction / 要約の再要約 → 別 change

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 世代表現 | assistant turn に `generation_number INTEGER NOT NULL DEFAULT 1`。`(parent_user_turn_id, generation_number)` を `WHERE role='assistant'` 条件付きで一意化（要約は別表 `session_summaries` なので `turns` には載らず衝突しない）。active は別 partial index で親ごと高々 1 本 | conversation-context は「regeneration で `generation_number` 追加・`idx_turns_one_assistant` 置換」と明記。世代は履歴に残し active だけ切替 |
| 旧 `idx_turns_one_assistant` の扱い | 本 change の migration で**drop し、assistant 用に 3 本の UNIQUE index（世代一意 `idx_turns_generation` + active 一意 `idx_turns_active_assistant` + pending 一意 `idx_turns_pending_assistant`）へ置換**。加えて redo 解決用の非 UNIQUE lookup `idx_turns_undone` を追加 | v1 の「failed 除く 1 本」制約は複数世代と両立しない。世代/active/pending をそれぞれ別条件で一意化し直す |
| 「active が高々 1 本」の保証 | partial unique index `WHERE role='assistant' AND active=1`（`failed`/`pending`/非アクティブ世代は active=0 なので対象外）。**SQLite の UNIQUE index は per-statement で即時評価**（commit-deferred ではない）なので、世代切替は**必ず旧 active を 0 にしてから新を 1**（同一 `BEGIN IMMEDIATE` txn・この順序固定） | partial index は条件を満たす行のみ一意制約。txn 内でも一瞬でも 2 行が active=1 になる statement 順は UNIQUE 違反で弾かれる（実測確認済み） |
| 再生成中の二重生成防止 | active=1 の pending は無い（pending は active=0）ので active index は二重 in-flight を防げない。**親ごと pending を高々 1 本に保つ partial unique index `WHERE role='assistant' AND status='pending'`** を追加。新世代 claim の前に既存 pending を AbortSignal でキャンセル+`failed` 化してから挿入 | 同一 user turn に 2 つの再生成が同時に走るのを DB レベルで防ぐ |
| assistant スロット claim（再生成中） | 新世代も conversation-context と同様**生成前に `pending` 行を挿入**して claim（pending 一意 index で並行を排除）。claim 中は `active=0`。CAS 確定（`pending → completed/stopped`）と同一 txn で**旧 active=0 → 新 active=1**（順序固定）。`failed` は active=0 のまま slot 解放 | 「送信前 claim」不変条件を世代でも維持。pending を active にしない＝失敗世代が文脈/active を汚さない |
| undo の単位 | **exchange（user turn + その active assistant 世代）**。undo = 既存マーカー全クリア後に当該 user turn と active assistant を `active=0` + `undone_at=now`。redo = session 唯一の undone マーカー（高々 1 つ）を `active=1` + `undone_at=NULL` へ戻す。新 user turn/再生成/compaction でも失効 | 行単位だと role 整合が壊れる（conversation-context の境界選択も exchange 単位）。物理削除しないので redo 可能。`active=0` は failed/旧世代/compaction でも立つので redo 対象は専用マーカー `undone_at` で特定。session 単一マーカー化で MAX/timestamp 衝突の曖昧さを排除 |
| undo と purge の区別 | undo は `active=0`（論理・redo 可・履歴に残る）。conversation-context の Discord 外部削除/guild 退出などは**物理 purge（CASCADE）**で別物 | 「ユーザが Discord で消した = DB からも消す」プライバシー契約は維持。undo はあくまで論理的取消 |
| 再生成のトリガ | 直近 assistant メッセージの Components V2 **ボタン**（「再生成」）＋ `/regenerate`。undo/redo はボタン＋ `/undo`・`/redo`。ボタン押下は **3 秒以内に `deferUpdate()` で ack** し、生成完了後は **bot トークンの message edit** で反映（component token に依存しない） | ボタンは会話の流れで自然。生成は 3 秒/15 分を超えうるので ack を即時化し edit は message API で行う。customId に turn id を埋めて再起動後も解決 |
| 操作の認可（誰が再生成/undo/redo できるか） | 既定は **対象 exchange の発話者本人（`interaction.user.id === U.author_id`）のみ**。加えて **`ManageMessages` 権限を持つメンバー**（モデレータ）は許可。ボタン押下・スラッシュコマンドの両方で handler が認可を**実行時に検証**し、満たさなければ ephemeral で拒否（履歴オプトインだけに依存しない） | 共有チャンネルでは古いボタンが他人の目に残り、`/undo`/`/redo` は「session の最新 exchange」を対象にするため**他人の発話に対する操作になりうる**。発話者本人 + モデレータに限定して誤操作・荒らしを防ぐ。settings で対象範囲（本人のみ/モデレータ含む）を調整可 |
| 編集起因の再生成 | `messageUpdate`（user 編集）を**オプトインで処理**。**直近の active・非 compaction exchange の user turn のみ**対象。**§2.2 の再生成フローを再利用**し、編集後メッセージから **`content_json` を丸ごと再構築**（text + 添付。text 差し替えではない＝multimodal の image/file part を保持）して文脈にし新世代を生成 → **成功 CAS（txn②）で初めて** `content_json` 上書き + 旧 active assistant `active=0` + 新世代 `active=1` を**まとめて確定**。生成失敗時は何も変えない（旧 `A` active・旧 `content_json` のまま）。古い/compaction 済み turn の編集は無視。conversation-context の「v1 無視」を本 change で上書き | content 上書きと active 切替を成功 CAS に束ねることで、生成失敗で「active assistant 0 本」や「回答だけ旧プロンプト対応」になる中間状態を作らない。content を全再構築し添付 part を取りこぼさない。下流 cascade 無効化を避けるため対象を直近 exchange に限定。オプトインで暴発を抑える |
| 編集時の content 更新 | user turn の `content_json` 上書きは**成功 CAS（txn②）と同一 txn**（生成前には書かない）。`turn_messages` 写像は不変（同じ discord_msg_id）。失敗時は旧 `content_json` を維持 | 編集は同一 Discord メッセージなので msg_id 不変。成功時のみ最新編集内容を反映し、失敗時は旧 active 回答と整合する旧テキストを残す（見える Discord 本文との一時乖離は best-effort・許容、再編集で再試行可） |
| compaction の保存先 | **専用 `session_summaries` 表**（`turns` に要約行を入れない）。被要約 turn は物理保持しつつ `compacted_into_summary_id` で要約を指し、文脈構築から除外。要約 → 寄与した turn を `summary_contributors` で追跡 | `turns` の CHECK（assistant は親必須）・世代 index への要約衝突・`ON DELETE SET NULL` 由来の不整合（user-only 履歴の蘇生）を全て回避。寄与追跡で purge 伝播（プライバシー）を可能にする |
| compaction の起動条件 | **既存要約 + 生 exchange の総トークン推定**が**予算の上限しきい値**（例 80%）を超えたら、最古側の生 exchange から下限（例 50%）まで畳む。要約累積で総量が予算超過なら §4.4 の境界選択が最古要約ブロックから落として boundedness を保つ。`messageCreate` 経路の文脈構築直前に同期実行（cron 不要） | 生 exchange だけで判定すると要約累積で総量が予算超過しても起動しない。会話進行に追従。独立 cron だと session 状態とのレースが増える。しきい値は settings 解決 |
| compaction の単位 | 要約は **exchange 群**を単位に畳む（user + active assistant のまとまり）。reply で外から参照される turn も**畳んでよい**が、reply seed は要約を**直接参照先 exchange に限って貫通（pierce）**して raw を hydrate する（§4.2） | 行単位だと role/parent 整合が壊れる。reply seed（conversation-context Section 4）の参照先は raw 保持済みなので pierce で拾える＝要約から除外せずとも文脈忠実性を保てる |
| compaction のプライバシー伝播 | 被要約 turn が外部削除/TTL/guild 退出などで purge されたら、その turn を寄与に持つ**要約を破棄**する。**CASCADE で寄与行を消すだけでは要約本文が残る**（残り寄与 ≥1 なので「寄与 0」では検出不能、痕跡が消えるので「寄与欠落」も検出不能）ため、(1) purge 経路の**明示フック**が `idx_summary_contributors_turn` で影響要約を解決し §4.5 uncompact、(2) **backstop トリガ** `trg_summary_purge_on_contributor_delete`（寄与行 CASCADE 削除で発火・実測）が親要約を破棄、の二段構え。要約破棄時は `compacted_into_summary_id ON DELETE SET NULL` で被要約 turn が生へ復帰 | 要約は削除済みユーザ発話のテキストを保持しうる。conversation-context の「消したものは DB から消す」契約を要約へも伝播。CASCADE のみでは部分寄与 purge を取りこぼすのでトリガで担保 |
| Discord 表示（再生成） | 既存 bot メッセージを **`edit()`** して新世代へ差し替え（分割送信ぶんは seq 整合で edit/追加/削除）。**Discord edit は CAS 確定（active 切替）が成功した後に行う**。新規メッセージは作らない | チャンネルが再生成のたびに伸びない。CAS 失敗時に「active でない世代を表示」しないよう DB 確定を先行。`turn_messages` 写像更新で履歴と一致 |
| Discord 表示（undo） | undo した exchange の bot メッセージに「取り消し済み」表示（edit）。Discord メッセージ自体は**削除しない**（削除すると外部削除イベントで purge され redo 不能） | undo は論理操作。物理削除は purge を誘発し redo を壊す |
| 並行・冪等 | 再生成・undo・compaction の各操作は conversation-context と同じ `BEGIN IMMEDIATE` 直列 txn。in-flight 生成があるユーザ操作は **`runToolLoop` の `AbortSignal` で打ち切ってから**新世代へ | Discord 送信と DB commit の非原子性は基盤と同じ前提。二重生成を防ぐ |

## Design

### 1. スキーマ変更（migration）

conversation-context の `turns` に列を追加し、世代モデルへインデックスを置換する。要約は `turns` に入れず**専用表**にする（CHECK 衝突・世代 index 衝突・user-only 履歴の蘇生を回避）。

```sql
-- 1. 世代番号（既存 assistant 行は generation_number=1 として埋まる）。
--    assistant 専用の意味を持つフィールド（一意制約も partial index で assistant にのみ適用）。
--    user 行にも列は付くが値は無意味（DEFAULT 1 のまま・repository は user 行の generation_number を参照しない）。
ALTER TABLE turns ADD COLUMN generation_number INTEGER NOT NULL DEFAULT 1
  CHECK(generation_number >= 1);

-- 2. 要約は専用表（turns には載せない）。compacted_into_summary_id が参照するので先に作る
--    （実測: SQLite は FK 参照先を遅延解決するので ADD COLUMN を先に書いても動くが、可読性のため先行作成）
CREATE TABLE session_summaries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- 文脈中の時系列位置を決めるアンカー（畳んだ範囲末尾の user turn の生成時刻/ snowflake）
  cutoff_msg_id TEXT NOT NULL,                 -- 範囲末尾 user turn の discord_msg_id。境界選択の cutoff 比較は conversation-context と同様 snowflake 数値（BigInt）順で行う（TEXT 文字列順ではない）
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),  -- PersistedContentPart[]（text のみ）
  content_schema_version INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_summaries_session ON session_summaries(session_id, created_at);

-- 3. compaction（畳み込み済みマーカー。畳み込み先は別表 session_summaries）
ALTER TABLE turns ADD COLUMN compacted_into_summary_id INTEGER
  REFERENCES session_summaries(id) ON DELETE SET NULL;  -- 要約破棄→生として復帰（下記参照）

-- 4. undo マーカー（redo 対象の一意特定）。NULL=未 undo。undo は U と A の両方にセット。
--    user turn を active=0 にするのは undo だけ（compaction は user を active=1 のまま compacted フラグ、
--    failed/旧世代は assistant 側のみ active=0）なので user の active=0 でも判別はできるが、
--    redo 対象を曖昧さなく引き・多段化の布石にするため明示マーカーを持つ。
ALTER TABLE turns ADD COLUMN undone_at INTEGER;

-- 5. 旧「1 user→1 assistant（failed 除外）」を drop し、世代モデルへ置換
DROP INDEX idx_turns_one_assistant;

-- 5-pre. 既存データの正規化（新 UNIQUE index 作成の前に必須）。
--   conversation-context v1 では (i) `idx_turns_one_assistant` が failed を除外するため
--   1 親に複数 failed assistant 行が残りうる（同 doc「複数 failed 行の累積を防ぐ」が示すとおり
--   resume 前なら累積しうる）、(ii) pending 行の active は未制約で DEFAULT 1 のまま残りうる。
--   このまま `idx_turns_generation`（全 assistant・gen=1）/`idx_turns_active_assistant`（active=1）を
--   作ると、(i) で (parent, 1) が重複し UNIQUE 作成が失敗、(ii) で stale pending が誤って active 扱いになる。
--   そこで index 作成前に：
--   (a) **【ハード前提・enforced phase・順序固定】**この migration の UNIQUE index 作成より前に、conversation-context の
--       startup pending-reconcile を**必ず先に完了させる**（attach 済み pending は lease→Discord 補償削除→写像 DELETE→`failed`、
--       空 pending も `failed`）。これは migration runner が呼び出す**強制フェーズ**であり、本 SQL は単体実行できる
--       standalone スクリプトではない（reconcile を経ずに走らせてはならない）。reconcile 完了後は pending 行が 0 件になる。
--       理由: attach 済み pending の `pending`→`failed` 単純フリップは **lease/補償削除を飛ばして孤児 bot メッセージと
--       「写像付き failed turn」を残す**（その mapped メッセージが後で外部削除されると親 exchange を誤 purge する）。
--       よって attach 済み pending は必ず reconcile の補償削除経路を通す（SQL の status フリップで代替してはならない）。
DELETE FROM turns
  WHERE role='assistant' AND status='failed';   -- (b) v1 の failed は履歴除外・slot 解放済みの死蔵行。世代モデルへ持ち越さず削除し (parent,1) 衝突を断つ
--   (c) 防御ネット（reconcile 後の理論上残らない pending 対策）。**attach 済み pending は status フリップしない**
--       （補償削除を飛ばすため）。フリップしてよいのは **`turn_messages` を持たない空 pending のみ**。
UPDATE turns SET status='failed', active=0
  WHERE role='assistant' AND status='pending'
    AND id NOT IN (SELECT turn_id FROM turn_messages);
--   (c') もし attach 済み pending がここで残っていれば、それは (a) の reconcile 未実行＝順序違反のサインなので
--        migration を **loud に abort**（補償削除なしに進めると孤児を生むため）。SQLite の RAISE() は trigger 本体専用で
--        bare statement では使えないため、**migration runner（アプリ側）がガードクエリで検査して throw する**:
--        `SELECT EXISTS(SELECT 1 FROM turns t JOIN turn_messages m ON m.turn_id=t.id
--           WHERE t.role='assistant' AND t.status='pending')` が真なら migration を中断し
--        「run pending-reconcile before migration」を報告する。
--   ここまでで 1 親の非 failed assistant は高々 1 本・gen=1 に正規化され、新 UNIQUE（generation/active/pending）は衝突しない。

--   (a) 同一 user turn 内で assistant 世代番号は一意（要約は別表 session_summaries なので turns には載らず衝突しない）
CREATE UNIQUE INDEX idx_turns_generation
  ON turns(parent_user_turn_id, generation_number)
  WHERE role='assistant';

--   (b) 同一 user turn に active な assistant は親ごと高々 1 本（undo 中は 0）
CREATE UNIQUE INDEX idx_turns_active_assistant
  ON turns(parent_user_turn_id)
  WHERE role='assistant' AND active=1;

--   (c) 同一 user turn に in-flight（pending）assistant は親ごと高々 1 本（二重再生成防止）
CREATE UNIQUE INDEX idx_turns_pending_assistant
  ON turns(parent_user_turn_id)
  WHERE role='assistant' AND status='pending';

--   (d) session ごとの最新 undone exchange を引く（redo 対象解決）
CREATE INDEX idx_turns_undone
  ON turns(session_id, undone_at)
  WHERE undone_at IS NOT NULL;

-- 6. 要約 → 寄与 turn（プライバシー伝播）。
--    寄与 turn が purge されると turn_id の ON DELETE CASCADE で寄与行が消える。
--    寄与行が 1 つでも消えたら要約は削除済みテキストを保持しうるので、要約自体を破棄する（下記トリガ）。
CREATE TABLE summary_contributors (
  summary_id INTEGER NOT NULL REFERENCES session_summaries(id) ON DELETE CASCADE,
  turn_id    INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  PRIMARY KEY (summary_id, turn_id)
);
-- 寄与 turn からの逆引き（purge 経路が影響要約を解決して uncompact するため）。
-- PK は (summary_id, turn_id) なので turn_id 単独の lookup には別 index が要る。
CREATE INDEX idx_summary_contributors_turn ON summary_contributors(turn_id);

-- 7. プライバシー backstop トリガ: 寄与行が（CASCADE 由来含め）消えたら親要約を破棄。
--    実測: AFTER DELETE トリガは FK CASCADE 由来の削除でも発火する（recursive_triggers 既定 OFF でも 1 回／寄与行）。
--    要約削除は連鎖して (i) summary_contributors の残り寄与行を CASCADE で掃除し、
--    (ii) turns.compacted_into_summary_id を ON DELETE SET NULL で生へ復帰させる（無限再帰・エラーなしを実測）。
--    これにより purge 経路が明示 uncompact フック（§4.5）を呼び忘れても、
--    「寄与を 1 つでも失った要約」が DB に残らない（= 削除済みユーザ発話を要約が保持しない）。
CREATE TRIGGER trg_summary_purge_on_contributor_delete
AFTER DELETE ON summary_contributors
BEGIN
  DELETE FROM session_summaries WHERE id = OLD.summary_id;
END;
```

- **migration の原子性（guard が schema を壊れた中間状態に残さない）**: 上記 DDL + 正規化 + guard クエリ（c'）は**単一の `BEGIN ... COMMIT` トランザクションで実行する**（SQLite は `CREATE/DROP INDEX`・`ALTER TABLE ADD COLUMN` を含む DDL がトランザクショナル）。`DROP INDEX idx_turns_one_assistant`（SQL 上は 5 番）と新 UNIQUE index 作成の間で guard（c'）が attach 済み pending を検出したら、migration runner が throw → **`ROLLBACK` で `DROP INDEX` も巻き戻り**、旧 `idx_turns_one_assistant` が無傷で残る（「旧 index を drop したが新 index 未作成」という claim 制約喪失状態を作らない）。なお guard（c'）と reconcile 完了チェックは破壊的 DDL に**依存しない純粋な読み取り**なので、可能なら `DROP INDEX` より**前**に実行して早期 abort する（rollback はあくまで安全網）。
- **要約を `turns` に入れない理由**: assistant の CHECK は `parent_user_turn_id IS NOT NULL` を要求し、要約は実親を持たない。`turns` に載せると (i) 偽の親アンカーが必要、(ii) その親の世代 1 と `idx_turns_generation` で衝突、(iii) `compacted_into_turn_id ON DELETE SET NULL` だと要約削除時に被要約 user turn が「生に戻るが assistant は active=0 のまま」＝ user-only 履歴が蘇生する。専用表でこれらを全て回避する。
- `compacted_into_summary_id ON DELETE SET NULL`: 要約が破棄されたら被要約 turn は NULL に戻り**生として文脈に復帰**（assistant 世代も元のまま active 化できる。下記 §4.5 の uncompact 手順で active を戻す）。FK 単体では active 復帰までは保証しないので **repository が uncompact を txn で行う**。
- **プライバシー伝播の仕組み（CASCADE だけに頼らない）**: 「寄与行が CASCADE で消える → 孤児（寄与 0/寄与欠落）を検出して破棄」だと、複数寄与の要約から **1 つの寄与 turn が purge されても要約行は残り `content_json` に削除済みテキストを保持し続ける**（残り寄与は ≥1 なので「寄与 0」では検出できず、消えた寄与の痕跡も無いので「寄与欠落」も検出できない）。そこで二段構えにする: (1) **purge 経路の明示フック**（conversation-context の各 delete 経路）が、purge 対象 turn から `idx_summary_contributors_turn` で影響要約を解決し §4.5 の uncompact（要約破棄 + 被要約 turn の生復帰 + assistant active 復帰）を実行、(2) **backstop トリガ** `trg_summary_purge_on_contributor_delete` が、寄与行が CASCADE 由来で消えた瞬間に親要約を破棄（明示フックを呼び忘れた経路でも要約が残らない保証）。トリガ経路は active 復帰までは行わないので（uncompact の active 復帰は明示フックが担う）、トリガだけで消えた場合は次の文脈構築/compaction まで一時的に当該 user turn が assistant 不在で残りうる（許容）。
- 既存行の後方互換: `generation_number=1`/`compacted_into_summary_id=NULL`/`undone_at=NULL` で自然に埋まる。**ただし新 UNIQUE index 作成の前に上記「5-pre. 正規化」が必須**: v1 の `idx_turns_one_assistant` は failed を除外するので 1 親に複数 failed 行が残りうり、これを残したまま `idx_turns_generation`（gen=1 で全 assistant 一意）を作ると `(parent, 1)` が重複して**migration が失敗**する。reconcile→failed 削除→pending/failed の active=0 化で正規化してから index を張る。

#### インデックス整合の注意（SQLite の UNIQUE 評価タイミング）

- **SQLite の UNIQUE index は per-statement で即時評価**（commit-deferred ではない。`PRAGMA defer_foreign_keys` は FK のみで UNIQUE には無関係）。実測: 旧 active=1 を残したまま新 active=1 を INSERT する statement は**その INSERT 時点で UNIQUE 違反**になる。したがって active 切替は txn 内でも**必ず「旧を active=0 にする UPDATE を先に、新を active=1 にする UPDATE/INSERT を後に」**書く（§2.2 / §3 の手順で順序固定）。
- `idx_turns_active_assistant` は `active=1` のみ対象なので `pending`（active=0）/`failed`（active=0）/非アクティブ世代（active=0）は制約外。
- `idx_turns_pending_assistant` は `status='pending'` のみ対象。新世代の `pending` 行 INSERT 前に既存 pending を `failed` 化（slot 解放）しておかないと衝突する＝二重再生成が DB で弾かれる。

### 2. 再生成

#### 2.0 初回 assistant 生成も世代モデルへ（conversation-context claim 経路の更新）

新 index（`idx_turns_generation` は status 無関係に全 assistant・`idx_turns_active_assistant` は `active=1`・`idx_turns_pending_assistant` は `status='pending'`）は再生成だけでなく**初回 assistant 生成にも効く**ため、conversation-context の messageCreate claim 経路を本 change が世代対応へ更新する（再生成のためだけの分岐にしない）。具体的に:

- **pending は必ず `active=0` で INSERT**する（conversation-context の `active` DEFAULT 1 のまま claim すると stale な pending が active 扱いになり `idx_turns_active_assistant` を誤って占有する）。`active=1` になるのは CAS 確定の瞬間のみ。
- **`generation_number = MAX(generation_number)+1`（同一 `parent_user_turn_id`、無ければ 1）で採番**する。初回は 1。
- **failed 後のリトライ**は conversation-context の「既存 failed 行を削除してから claim」に代えて、**failed を残したまま `MAX+1` で次世代を claim**してよい（`idx_turns_generation` は世代が distinct なら failed 行と共存できる）。死蔵 failed を掃除したい場合は削除も可だが、削除しなくても新 index と衝突しない（v1 の「failed 削除必須」前提は本 change で緩和）。
- CAS 確定（`pending → completed/stopped`、`active=0→1`）は再生成と同じ「旧 active を先に 0 → 新を 1」の statement 順を守る。初回は旧 active が無いので新を 1 にするだけ。

これにより初回応答も再生成も**同一の世代採番・claim・CAS 規約**に乗り、v1 の default `generation_number=1`/`active=1` 由来の UNIQUE 衝突や stale pending を作らない。

#### 2.1 トリガと解決

- **ボタン**: 直近 assistant メッセージの ActionRow（または Section accessory、chat-response-v2 と共有）に「再生成」。**`customId` には世代に依らない安定キー＝親 `user_turn_id` を埋める**（`regen:<user_turn_id>`。assistant 世代 id は再生成のたびに変わるが user turn id は不変）。押下時は `interactionCreate` が **`user_turn_id` から「その user turn の現在の active assistant 世代（無ければ pending in-flight）」を都度解決**する（特定世代 id に束ねない）。これにより、**再生成で世代が差し替わっても customId を書き換える必要が無く**、Major #3 の「CAS 成功後・Discord edit 失敗/crash で customId が旧 inactive 世代を指したまま残る」stale 問題が原理的に起きない（解決は常に「最新 active 世代」へ向く）。フォールバックとして `interaction.message.id` → `turn_messages` → 現 turn からも解決できる。**押下時は 3 秒以内に `deferUpdate()` で ack**（生成は 3 秒/15 分を超えうるため）。再生成後の表示更新は**bot トークンの message edit**で行い、component interaction token には依存しない（customId 自体は不変なので付け替え不要）。同様に undo/redo ボタンも安定 user turn id（exchange キー）を customId に埋める。
- **コマンド**: `/regenerate`（直近 exchange 対象）。**解決規則**: channel/session の**最新 user turn** `U`（手順 1 の状態無関係 recency 述語と一致）を引き、その現状で分岐する: (i) `U` が active assistant `A` を持つ → 通常再生成（`A` を新世代へ差し替え）、(ii) `U` が `pending` 世代のみ（active `A` 不在＝初回 or 別再生成 in-flight）→ §2.2 手順 1 の「active `A` 不在ケース」（pending 失効 → 新世代 → 初回送信経路）、(iii) `U` が `abandoned`（未応答確定）→ 再生成しない（応答対象が無い）。「最新 active assistant turn」固定ではなく最新 user turn 起点で解決するので、in-flight 中の `/regenerate` も穴を作らない。長時間化に備え `deferReply()`。
- 権限/設定: 再生成可否は settings 解決（履歴オプトインが前提。off チャンネルは履歴が無いので再生成不可）。
- **認可（必須）**: ボタン handler・`/regenerate`・`/undo`・`/redo` のいずれも、対象 exchange を解決した後に **`interaction.user.id === U.author_id`（発話者本人）または `member.permissions.has(ManageMessages)`（モデレータ）** を実行時に検証し、満たさなければ ephemeral で拒否する（Decisions「操作の認可」）。共有チャンネルでは古いボタンが他ユーザに見え、`/undo`/`/redo` が session 最新 exchange（＝他人の発話かもしれない）を対象にするため、認可なしだと他人の履歴を改変できてしまう。`customId` の turn id から解決した `U.author_id` と押下者を突き合わせる。

#### 2.2 手順

事前準備（短い `BEGIN IMMEDIATE` txn）→ 生成（txn 外）→ 確定（短い `BEGIN IMMEDIATE` txn）の 3 段。LLM 生成を txn で待つと writer を占有するため claim と finalize を分離する（conversation-context の方針と同じ）。

1. **解決 + 最新 exchange 制約**: 対象 assistant turn `A`（`active=1`）とその親 user turn `U`、`session` を解決。`U` が `active=0`（undo 済み）・compaction 済み（`compacted_into_summary_id IS NOT NULL`）なら再生成しない。**さらに `U` が session の「最新の user turn」であること＝より新しい user turn が `active`/`abandoned`/`undone`（`active=0` + `undone_at IS NOT NULL`）/`pending` 世代を持つ いずれの状態でも存在しないこと（`U` が session 内で最大 snowflake を持つ user turn であること。`active=1` 限定ではなく状態無関係の recency 比較）を要求**する（Non-Goals「再生成は直近 user turn の世代切替に限定」「任意過去 turn の再生成は将来」の実装上の強制。古い bot メッセージにもボタンは残り続けるので、古い exchange のボタン押下は「最新の会話にのみ再生成できます」等で拒否する）。これが無いと、下流 turn が旧 `A` を前提に生成済みのまま `A` だけ差し替わり、履歴と Discord 表示が cascade で stale 化する（下流 cascade 無効化は v1 Non-Goal）。**状態無関係にするのは undo の redo スロットを跨ぐ stale redo を防ぐため**: `U2/A2` を undo（`active=0` + `undone_at`）した後に「より新しい active/abandoned が無い」だけを見ると、`active=1` の旧 `U1/A1` が「最新 active exchange」と誤判定され再生成可能になる。すると `A1` が新世代 `A1'` に差し替わった後で `U2/A2` を redo すると、`U2/A2` は旧 `A1` 文脈で生成済みなのに上流が変わって stale になる。`undone`/`pending` を含む全状態で「より新しい user turn が無いこと」を要求すれば、undone exchange が存在する間は上流再生成を弾き（ユーザは先に redo するか新規発言で redo スロットを失効させる）、redo は常に整合する。
   - **`U` に active assistant が無い（初回応答が `pending` のまま・active `A` が存在しない）ケース**: ボタン由来の再生成は完了済み bot メッセージに付くので通常 active `A` を持つが、**編集起因再生成（§2.4）や `/regenerate` は初回応答 in-flight 中に到来しうる**。この場合 `A` は無く `U` のみ（`completed`/active=1）が存在する。手順は initial 生成（§2.0）と同型で進める: 手順 2 で `U` の **`pending` 初回世代を CAS 失効**（`AbortSignal` 発火）→ 手順 3 で新世代を claim → 手順 6 finalize の **「旧 `A` を active=0」ステップは active `A` 不在なので skip**（§2.0「初回は旧 active が無いので新を 1 にするだけ」と同じ）。finalize の前提再確認は「`A` がまだ active」を「**`U` に他の active assistant が無い**（`idx_turns_active_assistant` 上に当該 `U` の active 行が無い）」に読み替える。これにより active `A` 不在でも UNIQUE 制約・statement 順を崩さず確定できる。`U` が `abandoned`（startup reconcile が未応答確定済み）なら再生成しない（§3 の undo と同じく応答対象が無い）。
     - **このケースの Discord 表示・写像は edit 経路ではなく初回送信経路**: 付け替える既存 active 写像が無いので、手順 6(iii) の「旧 `A` の写像を新世代へ付け替え」は **skip**、手順 7 の「既存メッセージを edit」も使わない。代わりに**初回生成と同じ新規送信 + attach**（conversation-context の初回応答 send → 送信成功直後に in-memory cleanup 一覧へ ID 記録 → 新世代へ `turn_messages` attach）で新世代に mapped メッセージを与える。これで新 active 世代は**必ず ≥1 件の `turn_messages` を持ち**、conversation-context の「mapped bot メッセージがある assistant だけ境界選択に含める」ルールから脱落しない。新規送信ぶんの孤児防止（send 成功〜attach 間 crash）も conversation-context の規約をそのまま適用する。
       - **打ち切った初回 `pending` 世代の既送信 bot メッセージ・写像の安全な始末（crash 窓を塞ぐ）**: 旧 `pending` 世代が既に bot メッセージを送信して `turn_messages` を attach 済みの場合、**txn①（手順 2 の打ち切り）内で当該写像を `deleting_internal_at = now` で lease マーク**してから（or マークと同 txn で）`failed`・active=0 に確定し、**REST 補償削除（Discord delete → 写像 DELETE）は txn 外**で行う。conversation-context の lease 抑制・stale-lease reconcile はこの順序を前提に、**`turn_messages` の `deleting_internal_at` を turn の status と独立に走査する**ので、txn① commit 後・REST cleanup 前に crash しても: (a) **fresh lease が外部削除 purge を抑制**（leased 写像＝内部削除中なので親 exchange を誤 purge しない）、(b) **startup の stale-lease reconcile が当該写像を確定的に解決**（意図削除を再試行 or 写像クリア）。これにより「`failed` 行に写像がぶら下がったまま reconcile が pending だけ見て取りこぼす」穴を作らない（conversation-context の `failed` 確定は元来「写像除去後」だが、本ケースは lease で同等の耐久性を担保する）。lease を付けず単に `failed` 化して in-memory cleanup だけに頼ると、crash 時にこの保証が失われる点に注意。
       - **敗者（打ち切った）初回世代の live updater 書き込みを status/generation でゲートする（stale 表示防止）**: 初回生成は messageCreate 経路で**ライブ stream updater**（送信中に Discord を逐次 `edit()`）を使っているため、再生成（in-memory updater）と違い**打ち切った旧 loop が Discord を塗りうる**。`AbortSignal` は非ブロッキング・tool-loop の cancel は副作用停止を保証しない（tool-calling-foundation の「実行結果不明」契約）ので、`AbortSignal` だけでは旧 loop の updater 書き込みを止められない。conversation-context の「Discord write 前に turn 存在確認」も**本ケースでは不十分**（打ち切った turn は `failed` として**存在し続ける**）。よって**旧世代の全 updater 書き込み（send/edit/finalize/attach）を、その世代がまだ pending/active かを判定する status・generation トークンでゲート**する（slot 解放〔`failed` 確定〕後の書き込みは no-op 化）。これは §2.2 手順 5 の「再生成は in-memory updater で Discord を塗らない」と対になる規約で、**初回生成のライブ updater にも『この世代が現役のときだけ書く』ゲートを課す**ことで、敗者世代が新世代の表示や既送信メッセージを stale に塗るのを防ぐ。conversation-context の存在確認を**status/generation 確認へ強化**する点を本 change が明示する。
2. **既存 in-flight の打ち切り（txn① の一部）**: `U` に `pending` assistant があれば `UPDATE turns SET status='failed', active=0 WHERE id=<旧 pending> AND status='pending'` で slot を解放（CAS）。**この打ち切りは手順 3 の claim と同一 `BEGIN IMMEDIATE` txn①** に入れ、**打ち切りと claim の間に別 regenerate が割り込む窓を無くす**（さもないと「pending 無し」を観測した別要求が先に claim して `idx_turns_pending_assistant` 衝突を起こす）。SQLite の writer 直列化で並行 regenerate は txn① 単位で順番待ちになる。`runToolLoop` の `AbortSignal` 発火は **txn commit 後に非ブロッキング**（loop を待たない＝signal 無視時の hang・別 regenerate との race を避ける）。古い loop が後から完走しても finalize CAS（`WHERE id=<旧 pending> AND status='pending'`）が**原子的に no-op**。在庫 bot メッセージは conversation-context の in-memory cleanup 規約に従う。
3. **claim（txn① の続き）**: 同一 txn 内で `U` が `active=1` かつ未 compaction を**再確認**し、**さらに手順 1 の状態無関係 recency 述語（`U` が session の最新 user turn＝より新しい user turn が `active`/`abandoned`/`undone`/`pending` いずれの状態でも存在しない）も txn① 内で再確認する**。手順 1 の解決と本 claim の間に**新しい user turn が到来していれば、ここで弾いて生成を開始しない**（さもないと stale 文脈に対して `runToolLoop` が tool 実行・トークン消費まで走り、手順 6 finalize で無駄に失敗する。**txn① で recency を固めることで、stale 文脈での生成着手そのものを防ぐ**）。再確認を通れば `g = MAX(generation_number)+1`（同一 `parent_user_turn_id=U`）を採番 → **`pending`・`active=0`・`generation_number=g`** の assistant turn を INSERT して claim。`idx_turns_pending_assistant`（pending 1 本）/`idx_turns_generation`（世代一意）で守られ、稀な unique 競合は**リトライ**（直列化下では通常起きないが防御）。手順 1 の解決と手順 2-3 は**同一 `BEGIN IMMEDIATE` txn①**に入れる（解決→claim 間の TOCTOU を SQLite writer 直列化で閉じる）。
4. **文脈構築**: `U` までの履歴（active 世代 + 要約。conversation-context §4 の境界選択を §4.4 拡張ルールで使用。cutoff は `U` の `discord_msg_id` snowflake）で構築。
5. **生成（txn 外）**: `runToolLoop`。**再生成は in-memory（バッファリング）updater を渡し、生成中に Discord へライブ書き込みしない**（stale/敗者世代が Discord を塗らないため。`runToolLoop` は updater 経由で content を stage するが、再生成では Discord に出さずバッファに溜める）。Discord 反映は手順 7 の **CAS 成功後 edit のみ**。ライブ stream したい場合は将来、世代トークンで全 updater 書き込みを gate する（Open Questions）。
6. **finalize（txn②・CAS）**: 以下を**この順序**で同一 `BEGIN IMMEDIATE` txn 内に書く（active 切替と `turn_messages` 付け替えを同一 txn にまとめ、DB だけ見れば常に整合する状態にする）。
   - まず**前提再確認**: `U` がまだ `active=1` かつ未 compaction、`A` がまだ `active=1`（**active `A` 不在の初回 in-flight ケースでは「当該 `U` に他の active assistant が無い」と読み替え**、手順 1 の同名規約）、本新世代がまだ `pending`、より新しい世代が active になっていない（`idx_turns_active_assistant` 上の現 active が `A` のまま）、**かつ `U` が依然 session の最新の user turn（手順 1 の状態無関係 recency 述語。生成中により新しい user turn が `active`/`abandoned`/`undone`/`pending` いずれの状態でも到来していない）**。いずれか崩れていれば**新世代を `failed`/active=0 にして finalize 中止**（undo/別再生成/compaction/新規 user turn が割り込んだケース。古い in-flight が undone/非最新 exchange を蘇生させたり下流を cascade stale 化させない）。
   - 成功時: (i) `UPDATE turns SET active=0 WHERE id=<A.id>`（**旧を先に 0**）→ (ii) `UPDATE turns SET status=?, content_json=?, active=1 WHERE id=<新世代> AND status='pending'`（新を後で 1。SQLite UNIQUE は即時評価なのでこの順序でないと衝突する）→ (iii) **同 txn 内で `turn_messages` 写像を旧 `A` の `discord_msg_id` 群から新世代へ付け替え**（旧写像 DELETE → 同じ `discord_msg_id` で新世代に INSERT。`idx_turn_messages_msg` も per-statement なので delete→insert の順）。これで commit 時点で「新 active 世代が**既存メッセージへの mapped 写像を ≥1 件 atomically に持つ**」状態になり、conversation-context の「mapped bot メッセージがある assistant だけ境界選択に含める」ルールから脱落しない。
   - 失敗時（生成 error/cancel）: `UPDATE turns SET status='failed', active=0 WHERE id=<新世代> AND status='pending'`（**CAS 述語 `status='pending'` を保つ**＝割り込みで既に確定/失効していたら原子的 no-op。設計全体の CAS 規律と一致）。旧 `A` の active と写像は維持（再生成失敗なら元の回答を残す）。
7. **Discord 反映（CAS 成功後、txn 外・REST）**: txn② で**写像は既に新世代へ付いている**ので、ここで行うのは Discord 側 REST の整合だけ: 既存メッセージ群を新世代の本文で `seq` 順に **edit**、分割数差分の**追加送信/余剰削除**（§5）。**追加送信ぶんは conversation-context の「送信成功が返った直後、DB attach や後続 await の前に message ID を in-memory cleanup 一覧へ記録」規約をそのまま適用**してから新規 `discord_msg_id` を新世代に attach。ただし**この in-memory cleanup 一覧はプロセスを跨げない**ので、**send 成功〜attach の間に crash すると id を失い、孤児 bot メッセージが削除同期・履歴写像から見えなくなる**＝conversation-context の「送信後・写像作成前 crash」と**同じ best-effort の孤児ウィンドウ**（同プロセス内のエラー脱出では cleanup 一覧で掃除できるが、crash 耐性は持たない。厳密化は Open Questions の durable outbox）。余剰削除ぶんは lease マーク→delete→写像除去。CAS が中止/失敗なら Discord は触らない（active でない世代を表示しない）。**customId は親 user turn id 固定なので付け替え不要**（§2.1。世代差し替えで stale 化しない）。**CAS commit〜REST edit の間に crash しても**、新世代は既存メッセージへ mapped 済みなので履歴から消えない（Discord 表示だけ旧本文のまま残る＝stale）。これは次回 hydrate/startup で `turn_messages` を真実として best-effort 再同期（厳密化は Open Questions の durable outbox）。

#### 2.3 失敗・並行

- 再生成中にさらに再生成要求 → 手順 2-3 の txn① で既存 `pending` 世代を CAS 失効してから新世代を claim（同一 txn なので割り込み窓なし）+ 旧 loop に非ブロッキング AbortSignal（conversation-context の stale pending timeout 規約も適用）。
- **打ち切った世代の副作用安全性（tool-calling-foundation の cancellation 契約に従う）**: AbortSignal による打ち切りは tool-calling-foundation で **「実行結果不明」セマンティクス**（同 doc Decisions「handler 失敗時 / timeout」「timeout/cancel はともに『実行結果不明』」）。`runToolLoop` は cancel 後に**新しいモデルリクエストや未着手 tool dispatch を行わない**が、**既に dispatch 済みの副作用ある client tool（code-execution の実行・discord-tool の送信など）は、敗者世代の DB slot を `failed` 化した後でも完了しうる**。本 change はこの土台契約以上の保証を足さない: 副作用安全性は**各 tool 側の責務**（tool-calling-foundation の abort-aware atomic commit / killable isolation〔`sandbox.kill()`〕/ idempotency key + 突合）。in-memory updater は敗者世代の**応答テキスト**が Discord に出るのを防ぐだけで、tool 副作用までは止めない点に注意。**v1 の規範ポリシー（open にしない）**: 再生成・編集起因再生成・undo/redo が打ち切りうる「キャンセル可能ターン」では、副作用ある client tool に次を**必須**とする — **(iii) tool-calling-foundation の killable/idempotent isolation（`sandbox.kill()` / idempotency key + 突合。基盤が既に要求）** を満たすこと、**かつ (ii) 各 tool dispatch/commit を世代/操作トークンでゲート**して「この世代がまだ pending かつ当該 `U` の最新 in-flight」でなければ**未着手 dispatch を開始せず・敗者世代の commit を可能な限り抑止**すること。(ii)+(iii) を満たせない副作用 tool は**再生成中は無効化**して read-only に限定する **(i)** をフォールバックにする。read-only tool は制限なし。これにより「敗者世代が discord-tool の送信やコード実行 commit を後から完了させる」リスクを、未着手分は (ii) のゲートで止め、既着手分は (iii) の killable/idempotent で安全化する（(ii) のゲートだけでは既に発火した外部副作用は止められないため (iii) が必須）。in-memory updater は敗者世代の**応答テキスト**が Discord に出るのを防ぐだけで tool 副作用は止めない、という前段の注意はこの規範ポリシーの動機である。
- undo/redo が割り込む場合は §3 の「in-flight 世代の打ち切り」で pending を failed 化し、finalize の CAS（`status='pending'` 前提）が ABA で stale 確定するのを防ぐ。
- 起動時 reconcile: 再生成由来の `pending` 世代も conversation-context の pending reconcile 対象（attach 済みメッセージは補償削除 lease → `failed`/active=0、slot 解放）。`failed` 世代は履歴除外・slot 解放なので次回再生成で新番号採番。

#### 2.4 編集起因の再生成（messageUpdate）

conversation-context は v1 で `messageUpdate` を無視する。本 change は**オプトインで上書き**し、§2.2 の再生成フローを**そのまま再利用**する（差分は「文脈に新編集テキストを使う」「成功 CAS で `content_json` も上書きする」の 2 点のみ）。content 上書きと active 切替を**成功 CAS に束ねる**ことで、生成失敗時の中間状態（active assistant 0 本／回答だけ旧プロンプト対応）を作らない。

0. **順序保証（per-message 直列化 + debounce）**: 同一 user メッセージへの編集を**メッセージ id 単位で直列化**し、連続編集は coalesce/debounce する。これにより「古い編集ハンドラが新しい編集の pending を打ち切って stale 内容で claim する」out-of-order を防ぐ（メッセージ id 単位の in-memory ロック/キュー。単一 bot プロセス前提）。直列区間の入口で**毎回メッセージの最新状態を fetch**し、`editedTimestamp` が前回処理済みと同じなら no-op（冪等）。**「より新しい編集が割り込んだ」検知の具体機構（手順 4 の finalize が依存）**: `messageUpdate` gateway ハンドラは、受信した瞬間に当該メッセージの最新 `editedTimestamp` を**直列化ロックとは独立の in-memory「最新観測」マップ（message id → 最新 `editedTimestamp`）へ即時記録**する（生成中で直列区間がロックを保持していても記録は走る）。in-flight 再生成は自分が生成対象にした `editedTimestamp` を capture しておき、**finalize 時に「最新観測」マップの値と突き合わせて、より新しい編集が観測されていれば finalize を中止**する（DB には editedTimestamp を持たないが、単一 bot プロセスなら in-memory マップが recency の真実になる）。この機構は**単一プロセス前提**で、複数プロセス化したら in-memory マップでは不足し、`discord_edited_at` 列を user turn に persist して finalize の CAS 述語へ含める必要がある（Open Questions）。crash 時は in-flight pending が startup reconcile で `failed` 化され finalize 自体が起きないので、stale 編集が確定する穴は生じない。
1. **スコープ判定 + 新 content の再構築**: 編集対象が **session の直近 active・非 compaction exchange の user turn** か。古い turn / compaction 済み / 履歴 off 期間で未保存なら**無視**（下流 turn の cascade 無効化を避ける）。bot 自身の edit・内容無変化は無視。partial は fetch して**編集後メッセージの最新の全内容（テキスト + 現状の添付）を取得**し（手順 0 の直列区間内で fetch するので常に最新編集を見る）、conversation-context の persist 経路（attachmentParser → `PersistedContentPart[]`）で **`content_json` を丸ごと再構築**する（**text だけの差し替えではない**）。これにより multimodal user turn の `image-ref`/`file-ref` を取りこぼさない（編集で添付が残れば再パース・保持、ユーザが削除すれば落ちる＝編集後の実状態を反映）。再構築した新 `content_json` と処理対象の `editedTimestamp` を in-memory に保持。
2. **claim（txn①）**: §2.2 手順 3 と同様、新世代 `g` を `pending`/`active=0` で claim。**この時点では `content_json` を書き換えない**（生成失敗時に旧 active 回答と矛盾する新内容を残さない）。
3. **生成（txn 外）**: 再構築した新 `content_json`（in-memory）を `U` の内容として文脈構築し `runToolLoop`。
4. **finalize（txn②・CAS）**: §2.2 手順 6 の**前提再確認（`U/A` が依然 session の最新 active・非 compaction exchange であることを含む）を満たした上で**、成功時 statement に **`UPDATE turns SET content_json=<再構築した新版> WHERE id=<U.id>` を加える**（旧 `A` active=0 → 新世代 active=1 → 写像付け替え → `content_json` 上書き、すべて同一 txn）。**加えて手順 0 で capture した `editedTimestamp` が finalize 時点でも最新編集のまま**（より新しい編集が割り込んでいない）であることを、手順 0 の in-memory「最新観測」マップ（gateway 受信即時更新）と突き合わせて検証し、新しい編集が観測されていれば本 finalize を中止して新編集の処理に委ねる。**失敗時・前提崩れ時は何も変えない**（旧 `A` active・旧 `content_json`・旧写像のまま）。
5. **Discord 反映**: §2.2 手順 7（既存 bot メッセージ edit）。編集された user メッセージ自体は触らない（ユーザの編集物）。

> 失敗時に persisted `content_json`（旧）と見える Discord 本文（新編集後）が一時乖離するが v1 の許容範囲（conversation-context は messageUpdate を完全無視＝恒久乖離だった）。ユーザは再編集で再試行できる。旧世代の stale 扱いは §7 設計メモのとおり。

### 3. undo / redo

- **undo（単位 = exchange）**: 対象の直近 exchange（`U` + その active assistant `A`）を同一 `BEGIN IMMEDIATE` txn で、(i) **session 内の既存 `undone_at` を全クリア**（下記の単段不変条件）→ (ii) `U`・`A` を `active=0` + `undone_at=now` にセット。`A` の bot メッセージは edit で「取り消し済み」表示（**削除しない**）。undo した user turn の `content_json`/`turn_messages` は不変。
- **対象は「最新の応答済み exchange」のみ**: undo は session の**最新 exchange が active assistant を持つ（応答済み）とき**だけ許可し、その exchange（`U` + `A`）を対象にする。**`/undo` は常に session の最新 user turn を見て、それが「active assistant 1 本を持つ完了 exchange」でなければ拒否**する（古い exchange を飛び越して undo しない）。具体的に undo 不可なのは:
  - **最新 turn が `abandoned`（user のみ・assistant 無し＝未応答）**: 取り消す bot 回答が無い。abandoned user turn はユーザ自身の Discord メッセージなので、消したければユーザが Discord で削除→ conversation-context の外部削除 purge 経路に委ねる。
  - **最新 turn が in-flight（`pending` assistant を持つ・active assistant 0 本＝生成中／初回 or 再生成 in-flight）**: まだ応答が確定していない。ここで**より古い応答済み `U1/A1` を undo してしまうと、最新 `U2` の `pending` 世代が「`U1/A1` は active」前提の文脈で生成中なのに `U1/A1` が抜け、finalize 後に下流 stale 状態を作る**（再生成パスが避けている cascade 問題と同類）。よって最新 turn が in-flight の間は undo を拒否し、ユーザに生成完了を待たせる（in-flight をキャンセルしてまで古い exchange を undo はしない＝対象を最新 exchange に固定する原則を維持）。
  これにより undo/redo は常に「session 最新の応答済み exchange」を単位にでき、redo の「最新 exchange のまま」条件（後述）と整合する。なお対象に選ばれた最新応答済み exchange 自身に（再生成 in-flight 由来の）`pending` 世代が併存する場合は下記「in-flight 世代の打ち切り」で同一 txn 内に CAS 失効する。
- **in-flight 世代の打ち切り（undo/redo の必須前提・ABA 防止）**: undo/redo する exchange に **in-flight `pending` 世代**があれば、§2.2 手順 2 と同じく **undo/redo の `BEGIN IMMEDIATE` txn 内で `UPDATE turns SET status='failed', active=0 WHERE id=<pending> AND status='pending'` を CAS 確定**して slot を解放してから active を切り替える（`AbortSignal` 発火は非ブロッキング・ベストエフォートで loop を待たない）。これが無いと、再生成 in-flight 中に **undo→redo** した後で**古い pending 世代が finalize（§2.2 手順 6）の「`U` active・`A` active」述語を ABA で通過し、redo で戻した回答を上書き**しうる（A が deactivate→reactivate されるので「A still active」だけでは割り込みを検知できない）。pending を failed 化すれば finalize の CAS（`WHERE id=<新世代> AND status='pending'`）が**原子的に no-op** になり、stale 確定を確実に防ぐ（pending status が割り込み検知の役割を兼ねる）。
- **redo 対象の特定（`undone_at` 単一マーカー）**: redo は**スキーマに状態を持たないと曖昧**（`active=0` は failed/旧世代/compaction 済みでも立つ）。そこで undo だけがセットする `undone_at` を redo 対象キーにし、**session ごとに undone マーカーを高々 1 つに保つ不変条件**を敷く（v1 単段。上記 undo の (i) 既存クリアで維持）。これにより `undone_at IS NOT NULL` の exchange は常に高々 1 つで、**redo 対象は MAX/timestamp 比較なしに一意**に決まる（タイムスタンプ衝突に依存しない。`idx_turns_undone` で引く）。redo は `U`・`A` を `active=1` へ戻し `undone_at=NULL` に消す（同一 txn・`A` を active=1 にする前に競合 active が無いことを確認、後述）。**DB 確定後に Discord 表示も復元する**: undo が `A` の bot メッセージを「取り消し済み」へ edit した（§5）のと対称に、**redo は CAS 成功後（txn 外・REST）に `A` の mapped メッセージ群を `A.content_json` の本文へ `seq` 順に edit し戻す**（§5 の再生成 edit と同じ経路・同じ authoritative 404/403 → purge・transient → best-effort 再同期の規約）。これをしないと「履歴は active 復帰したのに Discord は取り消し表示のまま」乖離が残る。`turn_messages` は undo/redo を通じて不変（同じ `discord_msg_id` を edit するだけ）。
- **単一マーカー不変条件は app レベル強制（schema は防がない）**: `idx_turns_undone` は非 UNIQUE の lookup index であり、`undone_at` は U と A の両行に書くため、**schema だけでは「session に undone exchange が複数」を防げない**。よって repository が redo/reconcile の入口で**明示検証**する: 当該 session の `undone_at IS NOT NULL` 行を引き、**ちょうど 1 組（user 行 1 つ + その `parent_user_turn_id` を親に持つ assistant 行 1 つ、両者同一 `undone_at`）であること**を要求する。0 件なら redo 対象なし、2 組以上 or 片割れ欠落（user だけ/assistant だけ）なら**不整合として redo を拒否し startup reconcile に委ねる**（undo は同一 txn で U・A を対で立てるので通常 1 組。万一壊れた状態を redo で増幅させない）。
- **redo の有効条件（v1 単段）**: redo は **undone exchange が session の最新 exchange のまま**（§2.2/§3 と同じ**状態無関係 recency**＝より新しい user turn が `active`/`abandoned`/`undone`/`pending` いずれの状態でも存在しない）かつ **同じ親 `U` に別 active assistant が無い**ときのみ許可。崩れていれば redo を拒否。状態無関係にするのは regenerate 述語と一致させ、`undone_at` ライフサイクル（より新しい user turn の到来でマーカーをクリア＝状態を問わない）とも整合させるため（narrow な「active user turn のみ」だと undone/pending な新 turn を見落として stale redo を許す恐れがある。実際にはマーカークリアが先に効くが、述語自体を broad にして二重防御にする）。後者は `idx_turns_active_assistant`（active=1 一意）が**防御線**として `A` の active=1 化を弾く。
- **`undone_at` のライフサイクル（redo スロットのクリア）**: undone exchange より**新しい user turn の到来 / その親への再生成 / compaction** が起きたら、その undone exchange はもう「直近 1 段の redo 対象」ではない。**新しい user turn が確定する `messageCreate` の txn で、session 内の既存 `undone_at` マーカーをクリア**（redo スロットを失効。論理的には残しても redo の有効条件で弾けるが、明示クリアで `idx_turns_undone` を最新 1 件に保つ）。purge は行ごと消えるので redo 対象も自然消滅。
- **境界選択は `active=1` を要求**: conversation-context §4 の具体ルールは user を status で、assistant を status + mapped snowflake で選ぶ。本 change は §4.4 で**境界選択を「user turn は `active=1`・assistant 世代は `active=1` を要求」へ明示拡張**する（これにより undo した exchange が文脈から外れる。`undone_at` は文脈選択には使わず redo 解決専用）。`idx_turns_session(session_id, active, created_at, id)` の `active` 列をそのまま利用できる。
- undo スタック: v1 は**直近 1 段**（連続 undo/redo は最新操作のみ対象。session に高々 1 つの undone マーカーだけを redo）。多段は将来（操作ログ or `undone_at` の全履歴保持が要る）。
- purge との関係: undo は論理操作なので、後で当該メッセージが Discord 外部削除されたら conversation-context の purge 契約どおり**物理 purge**される（redo 不能になるのは正しい＝消したものは消える）。

### 4. compaction（要約圧縮）

#### 4.1 要約の表現（専用表）

- 要約は **`session_summaries` 行**（`turns` に入れない。理由は §1 のとおり CHECK・世代 index・蘇生問題の回避）。`content_json` は `[{type:'text', text:<要約>}]`（PersistedContentPart、text のみ）。
- **要約の話者帰属（misattribution 防止）**: 要約は user 発話と assistant 回答の**両方**を 1 つの text に畳むため、これを素の assistant 発話として文脈へ入れると、**過去の user 指示がアシスタント自身の発言**として読まれうる（モデルがユーザの過去依頼を「自分が言ったこと」と誤認する）。よって `session_summaries` には per-turn の role 列を持たせず（1 要約 = 複数 role を畳んだ blob なので per-turn role は無意味）、代わりに **(i) 要約生成プロンプトが source-role-aware な三人称テキストを出す**（例「ユーザは X を依頼し、アシスタントは Y と回答した」）こと、**(ii) 文脈へ挿入する際に中立な要約マーカーで包む**（例 `【これまでの会話の要約】\n…`）ことを必須にする。これにより会話の dialogue ではなく「要約メタ情報」として読ませ、話者帰属の崩れを防ぐ。**carrier role は assistant**（§4.4 で cutoff 位置の alternation に差し込む 1 ブロック）とするが、本文が中立マーカー + 三人称帰属なので「アシスタントの過去発話」とは解釈されない（system role を mid-array に挟む案は settings-hierarchy の単一前置 system prompt 規約と競合し provider 差もあるため採らない）。
- 被要約 turn は物理保持しつつ `compacted_into_summary_id` で要約を指し、**生としては文脈から除外**（assistant 世代も `active=0` 化。要約に置き換わるため）。被要約 user turn は purge/同期/undo のため物理保持。
- **時系列位置**: 要約は `cutoff_msg_id`（範囲末尾 user turn の `discord_msg_id`）を持ち、境界選択ではこの snowflake を順序キーにして、畳まれた範囲の位置に 1 ブロックとして差し込む（§4.4）。要約**行自体**は `turn_messages` を持たないので、conversation-context の「assistant は mapped bot メッセージ snowflake が cutoff 以下のときのみ」ルールや「hydrate 直前の REST 再検証」の対象外（要約行は別扱い・REST 検証しない）。
- **被要約メッセージのオフライン削除（削除同期の穴と補修）**: 被要約 turn 自体は `turn_messages` を物理保持するが、文脈選択から除外される（要約に置換）ため **hydrate されず、conversation-context §8 の「hydrate 直前の REST 再検証」が走らない**。bot オンライン中の削除は通常の `messageDelete` ハンドラが捕捉し（→ exchange purge → 寄与 CASCADE → backstop トリガで要約破棄）問題ないが、**bot オフライン中の被要約メッセージ削除は gateway イベントも hydrate 再検証も逃す**ため、要約が削除済みテキストを保持し続けうる。補修（conversation-context §8(a) と**同等の pre-use 保証**）: **要約が prompt 文脈に採用されるたび、その採用直前に寄与 turn の全 mapped `discord_msg_id` を REST 再検証する**（conversation-context が選択 exchange の写像を hydrate 直前に必ず再検証するのと同じ強さ。要約は生 exchange の代替なので、再検証も生 exchange と同水準を要求する＝間引きで弱めない）。**要約は user 発話だけでなく bot 回答テキストも含む**ので、再検証は寄与の **user turn と assistant turn の双方の `turn_messages`**（assistant の分割 chunk 含む）を対象にする（conversation-context は「mapped chunk のどれかが外部削除されたら exchange を purge」なので、bot 回答メッセージの削除も拾う）。authoritative な 404/403 なら当該 exchange を purge（→ 寄与 CASCADE → backstop トリガで要約破棄→ 当該プロンプトには削除済みテキストを載せない）。**コスト最適化は「弱める」のではなく「重複排除」で行う**: 短い in-process TTL キャッシュ/同一ビルド内の重複排除は可だが、authoritative 削除を**次のプロンプト採用までに**必ず捕捉する（採用前未検証の寄与を残さない）。**非採用の要約**（このビルドで文脈に入らないもの）は pre-use 検証不要で、**起動時 sweep に被要約寄与メッセージ（user + assistant）の低頻度再検証**を回して取りこぼしを掃除する。conversation-context 同様 **best-effort** 契約（transient 失敗では purge しない）。
- **プライバシー寄与追跡（明示フック + backstop トリガ）**: `summary_contributors(summary_id, turn_id)` に**畳まれた（被要約）turn**を記録（=要約に実際に寄与した active 世代。後述の active 復帰の根拠にもなる）。被要約 turn が外部削除/TTL/guild 退出などで purge されると `turn_id ON DELETE CASCADE` で寄与行が消え、**backstop トリガ `trg_summary_purge_on_contributor_delete` が親要約を破棄**する（§1）。さらに purge 経路の**明示フック**が `idx_summary_contributors_turn` で影響要約を先に解決し §4.5 の uncompact（生復帰 + active 復帰）を行う。**「CASCADE で寄与行が消えるだけ」では要約本文が残る**（残り寄与 ≥1 なので寄与 0 検出不能・痕跡消失で寄与欠落も検出不能）ため、トリガで確実に破棄する。これにより削除済みユーザ発話のテキストを要約が保持し続けない（conversation-context のプライバシー契約を伝播）。

#### 4.2 起動条件と範囲

- `messageCreate` の文脈構築直前（conversation-context §4 の境界構築の前段）に評価。
- **compaction の範囲選択より前に、backstop トリガ残骸の検出/修復（§4.5 (C)・§4.4 build-time ガードと同一述語）を先に走らせる**。compaction は §4.4 の build-time ガードより前段で動くため、これをしないと「`active=1`・未 compaction の user turn で `completed`/`stopped` 世代を ≥1 持つが active assistant 0 本」のトリガ残骸を **compaction が「user-only exchange」と誤認し、bot 回答を欠いたまま要約化**しうる（要約品質劣化 + 当時 active だった世代を寄与記録できない）。残骸を先に修復（eligible 最大世代を `active=1`）してから範囲を選べば、被要約 exchange は常に正しい active assistant 世代を伴う。修復不能な残骸（eligible 世代が無い）は範囲から除外する。
- **しきい値は「既存要約 + 生 exchange」の総トークン推定で評価する**（生 exchange だけで判定すると、要約が複数累積して総量が予算を超えても compaction が起動しない）。総量（conversation-context §6 の推定器を再利用）が**上限しきい値**（既定 80% of BUDGET、settings 解決）を超えたら compaction を起動。
- **最古側の生 exchange から**、生 exchange ぶんのトークン推定が**下限しきい値**（既定 50%）に収まるまで連続する exchange 群を畳む。直近 N exchange（既定 2）は常に生で残す（直近の文脈忠実性）。
- **boundedness の保証（要約累積対策）**: v1 は要約をマージしない（複数 `session_summaries` が session 内に累積しうる。**既存要約を入力に再要約する単一ローリング要約は Non-Goals「要約の再要約」に該当するため将来**）。代わりに §4.4 の文脈構築で**要約も exchange 予算（conversation-context §6）の droppable ブロックとして計上し、総量が予算を超える場合は最古ブロック（最古の要約から）を落とす**ことで、要約が何個累積してもプロンプト総量を**常に予算内に保つ**。最古要約のドロップは古い文脈の喪失（compaction の劣化＝単なる切り捨て）だが、v1 は boundedness を優先し、品質改善（ローリング/階層要約）は将来 change に委ねる。
- **in-flight 中の exchange は畳まない**: 範囲内に **`pending` assistant を持つ exchange**（再生成/編集起因の生成中）があれば、その exchange を畳み込み対象から除外する（範囲をそこで打ち切る or skip）。さもないと compaction が pending を残したまま親 user を compacted 化し、`idx_turns_pending_assistant` を塞いだ pending が宙吊りになる（pending 世代の finalize は §2.2 手順 6 の「`U` 未 compaction」述語で no-op するが、slot 解放は stale-timeout reconcile 待ちになる）。最古側を畳むので通常 in-flight は範囲外だが、明示的に除外する。
- **abandoned user turn（未応答・assistant 無し）が畳み込み範囲に入る場合**: text contributor として要約に含める（`content_json` を持つので要約入力に使え、`summary_contributors` にも記録。assistant 世代が無いだけで通常の被要約 user turn と同様に `compacted_into_summary_id` をセットして文脈から除外する）。§4.4 の build-time ガードは abandoned を「active assistant 必須」制限の対象外にしているが、compaction 済み（`compacted_into_summary_id IS NOT NULL`）の abandoned turn は要約に置換されるため文脈からは外れる。
- reply（conversation-context §4 の reply seed）で外から参照される turn を畳む場合の扱いを**明示定義**する。conversation-context §4 step 3 は reply トリガー時に `reply_to_turn_id` を辿って参照先 exchange を seed する（予算/境界を上書きしない）。畳まれた turn は §4.4 で生として除外されるため、何もしないと reply seed が実際の参照先を拾えなくなる。そこで: **reply seed は compaction を「直接の参照先 exchange に限って」貫通（pierce）する**。すなわち `reply_to_turn_id` が `compacted_into_summary_id IS NOT NULL` の turn を指す場合でも、**その直接参照先の exchange（user + 当時 active だった assistant 世代）は raw 物理保持されている**ので、§4.4 の compaction 除外の**例外として hydrate して seed に含める**（conversation-context の depth 上限・循環検出はそのまま。貫通するのは「直接参照先 1 件」だけで、そこから先の連鎖まで raw 展開はしない＝有界）。直接参照先 turn が既に物理 purge 済み（`reply_to_discord_msg_id` のみ残存）なら conversation-context の「purge 済み → 省略 or 短い注記」にフォールバック。これにより reply 文脈の忠実性を保ちつつ、compaction の予算削減効果は通常 turn では維持する。
  - **pierce した raw 被要約 seed にも pre-use 削除検証を必ず適用する（プライバシー）**: §4.1 で述べたとおり compacted turn は通常 hydrate されないため conversation-context §8(a) の「hydrate 直前 REST 再検証」が走らない。pierce はこの除外を破って raw を hydrate するので、**要約ブロックが予算で落ちて要約寄与の再検証（§4.4）が走らないケースでも**、pierce した exchange のオフライン外部削除を取りこぼしうる。よって pierce で hydrate する exchange は、**採用直前に §4.1 と同水準の REST 再検証（user + assistant の `turn_messages` 写像、assistant 分割 chunk 含む）を必ず通し、authoritative な 404/403 なら当該 exchange を purge して seed から omit**（→ 寄与 CASCADE → backstop トリガで要約破棄）。pierce は「compaction 除外の例外」だが「§8 削除検証の例外ではない」。

#### 4.3 手順（生成 txn 外 + 2 段コミット）

1. 畳む exchange 範囲 `[oldest .. cutoff]` を確定（上記しきい値）。
1.5. **生成前の REST 削除検証（プライバシー必須・§4.1 と同水準）**: 要約生成は範囲内の生テキストを LLM リクエストへ送り `session_summaries.content_json` に焼き込む「use」なので、**生成前に**範囲内**各寄与 exchange の `turn_messages`（user + assistant・分割 chunk 含む）を REST 再検証**する（conversation-context §8(a) の「hydrate 直前 REST 再検証」と同じ強さ。要約生成は raw turn の hydrate に相当するので同水準を要求する）。**authoritative な 404/403 を返した exchange は範囲から除外し、対応 exchange を purge**（→ §4.5 の uncompact 経路）。これにより**オフライン中に外部削除された発話のテキストが要約に焼き込まれること自体を防ぐ**（DB 存在チェックだけだと、オフライン削除が DB へ未同期の間は purge 判定をすり抜けて削除済みテキストを要約化してしまう）。transient な REST 失敗では除外せず（best-effort 契約・conversation-context と同じ）、その exchange は今回の compaction を skip して次回に委ねる。
2. 範囲内の生テキストを集めて要約を生成（**txn 外**。`runToolLoop` ではなく**単発 chat completion**で十分。tool 不要。settings 解決のモデル/プロンプト）。**この completion の `usage`/cost も [permissions-stats](../permissions-stats/design.md) の計上経路に明示的に記録する**（`runToolLoop` の `ToolLoopResult` 経由ではないので、compaction service が単発 completion の usage を別途 stats へ渡す契約を持つ。invoking user/guild に帰属。要約生成のコストが隠れないように）。
3. 生成完了後、**短い `BEGIN IMMEDIATE` txn**で: (a) **要約生成の入力になった各 turn が依然存在・適格か再確認**: 範囲が変化していないか（新規メッセージ・undo・別 compaction で範囲構成が動いていないか、**範囲内に新たな `pending` assistant が現れていないか**）に加え、**要約テキストを生成した元の寄与 turn id 群がすべて `turns` に存在し、外部削除/TTL/guild 退出などで purge されておらず、scope の履歴設定も off 化されていないこと**を検証する。生成は txn 外なので、**生成ウィンドウ中に**範囲内 turn が外部削除（オンライン中の gateway delete が DB へ同期）されると**生成済み要約テキストに削除済み発話が焼き込まれている**。手順 1.5 は**生成前**のオフライン削除を REST で弾き、本手順 3(a) は**生成中**に同期された削除を DB 存在再確認で弾く二段で、削除済みテキストの永続化を防ぐ。1 つでも欠落/不適格なら**当該要約を破棄して再計算 or skip**（焼き込まれた削除済みテキストを永続化しない＝プライバシー）→ (b) `session_summaries` 行を挿入 → (c) `summary_contributors` に**要約テキスト生成の入力になった turn を漏れなく**記録（= 各被要約 exchange の active な user turn + その `active=1` assistant 世代。**abandoned user turn は assistant 世代を持たないので user 行のみが寄与**（§4.2。要約入力にも user テキストだけが入る）。`active=0` の旧世代/failed は文脈外なので寄与に含めない。この「寄与 = 当時 active だった世代」が §4.5 の active 復帰の根拠であり、かつ**寄与を漏れなく記録することで FK + backstop トリガが purge 伝播の第二防衛線になる**〔記録漏れの turn が後で purge されても要約破棄が発火しない穴を作らない〕）→ (d) 範囲内の各寄与 turn に `compacted_into_summary_id = <要約 id>` をセット、**寄与 assistant（=当時の active 世代）の `active=0`**（要約が置き換える）。user turn は active のまま物理保持だが文脈構築では除外（下記）。
4. 文脈構築（§4.4）は要約 + 畳まれていない直近 exchange を採用。

> 要約生成を txn 内で待つと writer を長時間占有するため、生成は txn 外。`compacted_into_summary_id` の set と assistant `active=0` を同 txn で行うので、active 一意制約は壊れない（被要約 assistant は active=0 になり、要約は `turns` に載らないので index 対象外）。

#### 4.4 文脈構築への反映（conversation-context §4 の拡張）

本 change は conversation-context §4 の選択ルールを次のとおり**明示拡張**する:

- user turn は `status IN ('completed','abandoned')` **かつ `active=1` かつ `compacted_into_summary_id IS NULL`** のものを採用（undo/compaction 済みを除外）。**例外として、§4.5 (C) のトリガ残骸だけを除外する**: すなわち「`completed`/`stopped` の非 compaction assistant 世代を **≥1 持つ**のに active assistant が **0 本**の `completed` user turn」（= backstop トリガが要約だけ破棄して active を戻していない user-only exchange）のみ文脈から外す。**この残骸条件は cutoff＝現在処理中の user turn や、abandoned turn を誤って除外しない**: いずれも「`completed`/`stopped` の assistant 世代 ≥1」を満たさない（現在 turn は assistant が pending/未生成、abandoned は assistant 世代 0）。これにより**現在の user prompt は conversation-context §4 の cutoff ルールどおり常に文脈へ入り**（conversation-context は user turn を `status=completed`/active=1 で作り、その assistant 確定前に当該 user turn を cutoff として含める）、**トリガ残骸の user-only exchange だけが startup 修復前でも混入しない**（修復タイミングに依存しない build-time ガード）。
- assistant 世代は `status IN ('completed','stopped')` **かつ `active=1` かつ `compacted_into_summary_id IS NULL`** のものを採用（mapped snowflake ≤ cutoff は元ルールのまま）。
- `compacted_into_summary_id IS NOT NULL` の turn は生として除外し、代わりに対応する `session_summaries` 行を、その `cutoff_msg_id` snowflake 位置に 1 ブロック（assistant message。本文は §4.1 のとおり中立マーカー + source-role-aware な三人称要約で、過去 user 指示が assistant 発話と誤認されないようにする）として挿入。**要約ブロックは `session_summaries.id` で DISTINCT に挿入する**（1 要約に複数 turn が `compacted_into_summary_id` で紐づくので、turn を素朴に join して turn ごとに挿入すると同じ要約ブロックが重複混入する。被要約 turn 集合から distinct な summary id を取り、1 要約 = 1 ブロックにする）。**例外: reply seed の直接参照先**（§4.2）は compacted でも raw を hydrate して含める（pierce。有界・直接 1 件のみ）。**pierce した raw seed は採用直前に §4.1 と同水準の REST 再検証（user + assistant 写像、authoritative 404/403 → exchange purge）を必ず通す**（要約ブロックが予算で落ちて寄与再検証が走らない場合でも、削除済みメッセージを seed として復活させない。§4.2）。
- 採用した要約の寄与 turn は、採用直前に §4.1 の pre-use REST 再検証（user + assistant 写像、authoritative 404/403 → exchange purge → 要約破棄）を必ず通す。
- 要約は exchange 予算（conversation-context §6）で 1 ブロックとして計上し、**生 exchange と同じく droppable**（総量が予算超過なら最古ブロック＝最古要約から落とす。§4.2 の boundedness 保証）。メディア剥がし（§5）は要約に影響しない（text のみ）。

#### 4.5 要約の uncompact（破棄時の復帰）

**要約が破棄される契機と経路の棲み分け:**

- **(A) exchange 単位の partial purge**（外部 `messageDelete`/`messageDeleteBulk`、TTL の exchange sweep、`/config history purge`）で寄与 turn が消えるケース → **明示フック**（下記）が uncompact を正しく行う（active 復帰込み）。これらは「特定 turn/exchange を消す」アプリコードを通るのでフック可能。
- **(B) session/channel/thread/guild 単位の whole purge** → `session_summaries.session_id ON DELETE CASCADE` で要約も一緒に消える。生き残る寄与 turn が無い（session ごと消える）ので active 復帰の問題自体が起きない。明示フック不要。
- **(C) backstop トリガ単独**（(A) のどれかをフックし忘れた経路で寄与行が CASCADE 削除された場合の保険）→ 要約は破棄されるが active は戻らない（下記）。

**明示フック (A) の破棄手順（同一 txn・順序固定。set-based）**: `messageDeleteBulk`/TTL sweep/`/config history purge` は**複数 exchange を同時に purge**しうるので、手順は**単一ターゲットではなく purge 対象集合全体で set-based に**行う（同一要約に寄与する 2 つの exchange が同時に消えるとき、片方だけを除外して復帰させると「これから消える側」を一瞬/恒久的に active=1 に戻してしまう）。**CASCADE が寄与行を消す前に寄与を読む**必要がある（`summary_contributors.summary_id ON DELETE CASCADE` なので summary を先に消すと復帰先 turn_id を失う）。順序（全て同一 txn）: (1) **purge 対象 turn 集合 `P`（bulk なら全件、exchange 単位に正規化＝各対象 turn の親 user turn とその全世代）を先に確定** → (2) `idx_summary_contributors_turn` で `P` の各 turn が属する**影響要約集合 `S` を解決**（重複排除） → (3) `S` の各要約の**寄与 assistant turn_id を読み、`P` に含まれない exchange の寄与 assistant のみ** `UPDATE turns SET active=1` で復帰（`P` 内の exchange は除外＝消える予定のものを一瞬も active に戻さない。conversation-context は assistant chunk の外部削除でも**親 exchange ごと** purge するので、除外は exchange 単位） → (4) `DELETE FROM session_summaries WHERE id IN (<S>)`（残り寄与行が CASCADE 掃除され、`P` 外の被要約 turn は `compacted_into_summary_id` が SET NULL で生復帰） → (5) 目的の purge（`P` 削除）。**どの世代を active に戻すかは曖昧でない**: §4.3 (c) で寄与に記録したのは「当時 active だった世代」そのものなので寄与 assistant turn を `active=1` に戻すだけでよい。compaction 済み `U` は再生成も編集起因再生成も禁止（§2.2 手順 1 / Non-Goals）なので、復帰時に同じ `U` に別 active assistant は無く `idx_turns_active_assistant` 衝突は起きない。

- 復帰で予算超過するなら次回 compaction で畳み直す。再計算（残存寄与から要約し直し）を選ぶ場合は、フックが破棄前に新要約を作って差し替える。

**backstop トリガ (C) の残骸とその修復（二重の安全）**: トリガは要約破棄と `ON DELETE SET NULL`（生復帰）までしか行わず assistant active を戻さないため、その exchange は一時的に **「user turn active=1 + 未 compaction だが active assistant 無し」** の user-only 状態で残る（プライバシー＝要約本文の即時消去は満たす）。これを (1) **文脈構築側で即座に無害化**: §4.4 の build-time ガードが「`completed`/`stopped` の非 compaction assistant 世代を ≥1 持つのに active assistant 0 本の `completed` user turn」（＝この残骸そのもの）だけを除外するので、**修復前でも残骸は文脈に混入しない**（現在 turn・abandoned turn はこの条件を満たさず誤除外されない。次の `messageCreate` でも安全）。(2) **状態は startup reconcile（conversation-context の reconcile を拡張）で確定的に修復**: 「`active=1` かつ未 compaction の user turn で、`completed`/`stopped` の非 compaction assistant 世代を ≥1 持つのに active assistant が 0 本」のものを検出し、**その user turn の `status IN ('completed','stopped')` かつ `compacted_into_summary_id IS NULL` な世代のうち最大 `generation_number` のものを `active=1` に戻す**。**`failed`/`pending` 世代や compacted 済み世代は復帰候補にしない**（本 change は `failed` 世代を `MAX+1` 採番のため物理保持する〔§2.0〕ので、単純な「最大 `generation_number`」だと失敗世代を誤って `active=1` 化し `idx_turns_active_assistant` を status 不適格な行で占有してしまう。eligible 世代に限定してこれを防ぐ）。この述語は undo 済み（user active=0 → 対象外）・abandoned（assistant 世代 0 → 対象外）・正常 exchange（active assistant 1 → 対象外）を自然に除外し、トリガ残骸だけを拾う。(3) **長時間プロセスでの即時修復（restart を待たない）**: §4.4 の build-time ガードが残骸（同一述語）を**検出した時点で、同じ process 内で reconcile の active 復帰アクション（eligible 最大世代を `active=1`）を opportunistic に実行**する（検出と修復の述語は同一なので、ガードはついでに修復を発火できる）。これにより「明示フックを取りこぼした残骸が次の restart まで文脈から欠落し続ける」劣化を避ける（startup reconcile は cold-start の保険として残す）。build-time ガードが混入を防ぎ、検出時の即時修復 + startup reconcile が通常運用へ復帰させる三段で「user-only が文脈へ混入」も「無期限残置（restart 待ち含む）」も防ぐ。

### 5. Discord 表示と `turn_messages` 整合

- **post-CAS Discord write のフェンス（必須・後続操作との競合防止）**: DB は `BEGIN IMMEDIATE` で直列化され常に整合する（最新 active 世代/取り消し状態が真実）が、**CAS commit 後の Discord REST（edit/追加送信/余剰削除）は txn 外**なので、ある操作の REST がまだ走っている間に**後続の regenerate/undo/redo が同じ `turn_messages` を supersede しうる**。フェンス無しだと、遅い REST が**新 active 世代のメッセージを旧世代本文で上書き**したり、**新世代が attach したばかりの chunk を旧操作が「余剰」として削除**したりして、Discord 表示が DB と乖離する（例: regenerate-A の遅い edit が regenerate-B の本文を上書き、undo 後に A の遅い edit が「取り消し済み」表示を A 本文で塗り直す）。これを次の二段で fence する:
  - **(1) exchange 単位の直列化**: ある exchange（= 親 `user_turn_id`。その `turn_messages` の `discord_msg_id` 群）への post-CAS Discord write を**in-memory の per-exchange ロックで直列化**する（§2.4 の per-message 直列化・§2.2 の live updater ゲートと同じロック領域。単一 bot プロセス前提）。これで 2 つの post-CAS REST 列が同一メッセージ上で interleave しない。
  - **(2) 世代/操作トークンでの再確認**: 各 REST write は、**発行直前（およびリトライ/backoff 後にも毎回）**、当該 `turn_messages` が DB 上でいま指す世代/状態を読み直し、**自分が描画しようとしている世代/操作がまだ authoritative（regenerate なら当該 `discord_msg_id` の現 mapped 世代が自分・undo/redo なら現 active/取り消し状態が自分の意図と一致）であるときだけ発行**する。supersede されていれば**残りの write を放棄**する（後続操作の write が authoritative・DB は既に整合）。これは §2.2 手順 1 の「敗者 live updater を status/generation でゲート」の post-CAS REST 版。
  - per-exchange ロックで (2) の read→issue は同一プロセス内で race-free。crash/transient はこれまでどおり次回 hydrate/startup で `turn_messages` を真実として best-effort 再同期（厳密化は Open Questions の durable outbox）。
- **再生成（CAS txn で写像付け替え → CAS 成功後に Discord REST）**: edit ベースで:
  - **写像の付け替えは §2.2 手順 6 の CAS txn② 内**（旧 `A` の写像を削除し、同じ `discord_msg_id` で新世代に INSERT。`idx_turn_messages_msg` の `discord_msg_id` 一意は per-statement なので delete→insert の順）。**active 切替と同一 txn**なので、commit 後は「active 世代」と「mapped 写像」が原子的に一致し、両者の間に crash しても新 active 世代が写像 0 件で履歴から脱落することがない。
  - **Discord REST（CAS 成功後・txn 外、手順 7）**: 既存メッセージを新世代本文で `seq` 順に edit。分割数が旧より**少なければ余剰メッセージを削除、多ければ追加送信**。**追加送信は send 成功直後・attach 前に message ID を in-memory cleanup 一覧へ記録**（conversation-context の孤児防止規約）してから新 `discord_msg_id` を新世代に attach（別 txn）、余剰削除ぶんは写像除去（別 txn）。これらの post-CAS 写像変更（追加/削除）は best-effort: **同プロセス内のエラー脱出**なら send 成功直後に記録した in-memory cleanup id で孤児を掃除でき、transient 失敗は次回 hydrate/startup で `turn_messages` を真実として best-effort 再同期できる。ただし**send 成功〜attach 間の crash では cleanup id が揮発する**ため、§2.2 手順 7 と同じく**孤児 bot メッセージは削除同期・履歴写像から見えなくなる**（crash 耐性は持たない＝conversation-context の「送信後・写像作成前 crash」と同等の best-effort 孤児ウィンドウ。durable な掃除は in-memory cleanup id ではなく Open Questions の durable outbox に委ねる）。§2.2 手順 7 の「記録済み cleanup id があるので掃除できる」も同プロセス内エラー脱出に限り、crash は対象外である点は同じ。
  - これにより「いま Discord に見えている bot メッセージ」と「active 世代」が（REST 成功後）一致し、失敗しても DB（`turn_messages`）が真実として残る。
  - **bot 起因の delete/edit には必ず conversation-context の `deleting_internal_at` lease 抑制を適用**（外部削除と誤認して exchange を purge しないため。特に「余剰メッセージ削除」は REST delete なので lease マーク → delete → 写像除去の順を守る）。
  - **失敗時の整合（transient と authoritative を区別）**: Discord edit/追加/削除が途中で失敗しても DB の active 世代と既存メッセージ写像は確定済み。**transient な失敗（5xx/timeout/rate limit）**は次回 hydrate で `turn_messages` を真実として best-effort 再同期（厳密化は Open Questions の durable outbox に委ねる）。**ただし `edit()`/`delete()` が authoritative な `404 Unknown Message` / `403 Missing Access` を返した場合は、当該メッセージが既に外部削除/アクセス喪失している証拠**なので、次回まで遅延させず**即座に conversation-context の外部削除/purge 経路へ流す**（404/403 → 対応 exchange を物理 purge。conversation-context §8 と同じ authoritative シグナル契約）。さもないと「消えていると分かっているメッセージ」を mapped 写像として保持し再利用してしまう。transient と 404/403 の判定は conversation-context の削除同期と同じ規約を踏襲する。
- **undo（edit）**: 取り消し表示に edit。`turn_messages` は不変（lease 不要、delete しないため）。
- **redo（edit）**: DB の active 復帰（§3）成功後に、`A` の mapped メッセージ群を `A.content_json` の本文へ `seq` 順に edit し戻す（取り消し表示 → 元の回答本文）。`turn_messages` は不変。authoritative 404/403（取り消し表示中に当該メッセージが外部削除されていた）→ 対応 exchange を purge（redo 結果は表示されないが DB は整合）、transient → 次回 hydrate で best-effort 再同期。undo→redo を通じて新規送信も削除もしない（同じ `discord_msg_id` の edit のみ）。
- **新規送信しない理由**: 再生成のたびに新規送信するとチャンネルが伸び、`turn_messages` 写像が世代ごとに増殖して purge/同期が複雑化する。
- **mention 安全性の継承**: 本 change の全 Discord write（再生成の本文 edit・分割差分の追加送信/余剰削除、undo の「取り消し済み」表示 edit、`/regenerate` 等コマンドの返信）は chat-response-v2 の mention safety 規約（[chat-response-v2](../chat-response-v2/design.md) Decisions「Mention safety」）を継承し、**`allowedMentions: { parse: [] }`（`message.reply()` 経路は `repliedUser: false` も）を必ず付ける**。TextDisplay/content はモデル出力をそのまま ping しうるため。chat-response-v2 は送信ヘルパの型シグネチャで強制しており、本 change の再生成/undo インタラクションも同 builder/ヘルパ経由で送って漏れを防ぐ（chat-response-v2 §「再生成ボタン等の新規インタラクション実装は各 change の責務」と整合）。

### 6. 変更対象ファイル

**新規:**

- `src/db/repositories/regenerationRepository.ts` — 世代採番・active 切替（undo/redo）・compaction フラグ更新を `BEGIN IMMEDIATE` txn で提供（または conversation-context の turn repository を拡張）
- `src/services/regenerationService.ts` — 再生成オーケストレーション（対象解決 → 旧 in-flight cancel → claim → 生成 → CAS 確定 → Discord edit）
- `src/services/compactionService.ts` — しきい値判定・範囲確定・要約生成（txn 外）・2 段コミット
- `src/bot/commands/regenerate.ts` / `undo.ts` / `redo.ts` — スラッシュコマンド
- `src/bot/events/interactionCreate.ts`（拡張） — 再生成/undo ボタンの `customId` ルーティング（`regen:<turnId>` 等）+ 即時 `deferUpdate()`
- `src/bot/events/messageUpdate.ts` — user 編集起因の再生成（オプトイン、直近 active・非 compaction exchange のみ、partial は fetch）。`client.ts` の event 登録に追加
- `tests/unit/services/regenerationService.test.ts` / `compactionService.test.ts` / `tests/unit/db/regenerationRepository.test.ts`

**修正:**

- `src/db/schema.ts` — 上記 migration（`generation_number`/`compacted_into_summary_id`/`undone_at` 追加、`session_summaries`/`summary_contributors` 新表 + `idx_summary_contributors_turn` + backstop トリガ、index 置換）
- `src/bot/events/messageCreate.ts`（または conversation-context の文脈構築経路） — 文脈構築直前に compaction 評価をフック、要約を文脈に織り込む拡張（§4.4）。**初回 assistant claim を世代対応へ更新**（pending を `active=0` で INSERT・`generation_number=MAX+1`・failed リトライは MAX+1、§2.0）。これは再生成専用でなく初回応答経路にも効く
- chat-response-v2 の Components V2 builder を呼ぶ箇所 — 「再生成」「取り消し」ボタンの ActionRow/Section accessory を本 change が組み立てて付与

### 7. 設計メモ

- **active 不変条件**: 「親 user turn ごとに active assistant は高々 1 本」（undo 中は 0、通常/再生成成功後は 1）。`idx_turns_active_assistant` が DB レベルで強制。**SQLite UNIQUE は即時評価**なのでアプリは「旧 active=0 → 新 active=1」の statement 順を必ず守る（同一 statement 内で 2 行が active=1 になる瞬間を作らない）。
- **pending と active の独立**: claim 中の世代は `pending`・`active=0`。active=1 になるのは CAS 確定の瞬間のみ。失敗世代（`failed`/`active=0`）は文脈にも active 一意制約にも影響しない。並行 in-flight は `idx_turns_pending_assistant`（親ごと pending 1 本）で排除。
- **finalize の前提再確認（CAS 予測子）**: 古い in-flight 再生成が後から確定して、その間に割り込んだ undo/別再生成/compaction の結果を上書きしないよう、finalize 時に「`U` が active・未 compaction」「`A` がまだ active」「より新しい世代が active 化していない」を確認してから active を切り替える（§2.2 手順 6）。
- **conversation-context の不変条件継承**: 「送信前 claim」「CAS 確定」「Discord write 前の turn 存在確認」「内部削除 lease 抑制」「pending startup reconcile」は本 change の新世代にもそのまま適用する。
- **編集（messageUpdate）の境界**: bot は `Partials.Message`（conversation-context が追加済み）で partial update も受ける。partial は内容が無いことがあるので fetch して content を取得してから再生成。編集対象が **直近 active・非 compaction exchange の user turn でない**（古い turn・compaction 済み・履歴 off 期間で未保存）なら無視（下流 cascade 無効化を避ける）。
- **編集後の旧世代は stale（世代別 snapshot は持たない）**: 編集起因再生成は user turn の `content_json` を上書きするので、その exchange の**旧 assistant 世代は編集前プロンプトへの回答**になり意味的に stale。旧世代は `active=0` の履歴行として残るが、(a) **redo 対象にしない**（`undone_at` は undo だけがセット。編集再生成は undone_at を立てない）、(b) 文脈にも復帰させない（§4.4 は active=1 のみ採用）。v1 は世代ごとのプロンプト snapshot を保持せず、見える user turn が最新編集を反映・旧世代は参照されない死蔵行になる乖離を意図的に許容する（世代別 snapshot が要るなら将来 change）。

## Tasks

- [ ] migration（`generation_number`/`compacted_into_summary_id`/`undone_at` 追加、`session_summaries`/`summary_contributors` 新表 + `idx_summary_contributors_turn` + backstop トリガ `trg_summary_purge_on_contributor_delete`、`idx_turns_one_assistant` を `idx_turns_generation`+`idx_turns_active_assistant`+`idx_turns_pending_assistant`+`idx_turns_undone` へ置換）
- [ ] repository: 世代採番、active 切替（undo/redo は `active` + `undone_at` を操作、undo は session 既存マーカー全クリア後にセット、二重 active を制約で弾く・statement 順固定、redo 対象は session 唯一の undone exchange〔user turn + その assistant ちょうど 1 組として検証〕）、pending claim（pending 一意 index）、compaction フラグ更新、要約挿入 + 寄与記録（当時 active 世代のみ）、uncompact（要約破棄時の寄与 assistant 復帰）
- [ ] 再生成 service（解決〔最新 user turn 起点・状態無関係 recency 述語で stale redo を防ぐ〕 → in-flight cancel〔`AbortSignal`〕 → pending claim → 文脈構築 → 生成〔txn 外〕 → finalize CAS〔前提再確認 + 旧 active=0 → 新 active=1 + `turn_messages` 付け替えを**同一 txn②**〕 → CAS 成功後に Discord REST edit〔分割数差分の追加/削除〕。**active `A` 不在の初回 in-flight ケース**〔旧 pending 失効時に写像 lease + 初回送信経路で新世代に mapped 付与・敗者 live updater を status/generation でゲート〕）
- [ ] undo/redo service（exchange 単位 active 切替 + `undone_at` マーカー、undo は最新の応答済み exchange のみ〔最新 turn が abandoned/in-flight pending なら不可〕、redo 対象 = session 唯一の undone exchange〔高々 1 つを検証・MAX 比較不要・複数あれば不整合として拒否〕、新 user turn/再生成/compaction での `undone_at` 失効、**undo は取り消し表示 edit・redo は本文へ edit 戻し**〔双方 404/403→purge・transient→再同期〕、直近 1 段）
- [ ] compaction service（しきい値判定・範囲確定・要約生成 txn 外・2 段コミット・range 再確認/skip・寄与記録・文脈構築への織り込み・uncompact）
- [ ] コマンド `/regenerate`・`/undo`・`/redo` + ボタン `customId` ルーティング（即時 `deferUpdate()`・**customId は安定 user turn id を埋め押下時に現 active 世代へ都度解決＝世代差し替えで stale 化せず付け替え不要**・再起動後も解決可・`interaction.message.id` フォールバック）+ **認可検証**（`interaction.user.id === U.author_id` または `ManageMessages`、満たさなければ ephemeral 拒否）
- [ ] `messageUpdate` ハンドラ（user 編集起因の再生成、オプトイン、直近 active・非 compaction exchange のみ、partial fetch、`content_json` 全再構築〔text + 添付 part 保持〕、成功 CAS で content 上書き・失敗時は無変更、conversation-context の「v1 無視」を上書き）
- [ ] conversation-context の初回 assistant claim を世代対応へ更新（pending `active=0`・`generation_number=MAX+1`・failed リトライ MAX+1。§2.0。再生成専用にしない）
- [ ] 文脈構築の拡張（active=1 + 未 compaction フィルタ、要約ブロック挿入、cutoff snowflake 位置、build-time ガードはトリガ残骸〔completed/stopped 世代 ≥1 だが active 0 本〕のみ除外し cutoff/現在 turn・abandoned は除外しない）
- [ ] Discord 表示（再生成 edit + seq 整合の追加/削除〔削除は lease 抑制〕、undo 取り消し表示、全 write に `allowedMentions:{parse:[]}`、**post-CAS Discord write の fence〔§5: exchange 単位の直列化 + 世代/操作トークン再確認で supersede されたら残り write 放棄〕**、post-CAS の authoritative 404/403 は即 purge 経路へ・transient は再同期）
- [ ] purge 伝播（partial purge は明示フックで uncompact〔寄与読取→active 復帰→summary 削除の順〕、whole-session は `session_summaries.session_id` CASCADE、backstop トリガは privacy 最終防衛線、conversation-context の各 delete 経路にフック）+ startup reconcile でトリガ残骸の user-only exchange を修復（`completed`/`stopped` 非 compaction 世代のうち最大 `generation_number` を active 復帰。`failed`/`pending`/compacted は復帰対象外）+ 被要約寄与メッセージのオフライン削除補修（要約採用時の best-effort REST 再検証 + 起動時 sweep）
- [ ] テスト（世代採番/active・pending 一意制約と statement 順、打ち切り+claim を同一 txn①〔割り込み窓なし〕、CAS 同一 txn での `turn_messages` 付け替え〔新 active 世代が写像 0 件にならない〕、再生成中の再生成キャンセル、finalize 前提再確認〔undo/別再生成/compaction 割り込みで上書きしない〕、undo→redo→再生成の ABA〔in-flight pending を failed 化〕と状態整合 + `undone_at` 失効、in-memory updater で敗者世代が Discord を塗らない、編集の per-message 直列化/out-of-order〔古い編集が新編集を上書きしない〕+ multimodal content 全再構築、compaction の txn 外生成 + range 再確認 + pending exchange を畳まない、寄与 turn purge → backstop トリガ発火〔CASCADE 経由〕で要約破棄 + uncompact 復帰〔exchange 単位除外〕、被要約メッセージ〔user + assistant chunk〕のオフライン削除 → 採用時 REST 再検証で purge、§4.4 build-time ガードで残骸 user-only を除外、編集起因再生成のスコープ制限 + 旧世代 stale、pending reconcile の世代対応）
- [ ] `docs/changes/conversation-regeneration/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **要約破棄時の active 復帰**: §4.3 (c) で `summary_contributors` に**当時 active だった世代そのもの**（active な user turn + その `active=1` assistant）を記録する設計にしたので、uncompact は寄与 assistant turn を `active=1` へ戻すだけで復帰先が一意に決まる（別途「当時の active 世代 id」を持つ必要はない）。残るのは **backstop トリガだけで要約が消えた経路は active を戻さない**点で、その exchange は次の文脈構築/compaction まで一時的に user-only で残りうる（プライバシーは満たすので許容）。明示フックを必ず通すべき purge 経路の洗い出しは実装で詰める。
- **要約と外部削除の粒度差**: 寄与 turn 1 つの purge で要約全体を破棄すると、無関係な発話が要約から消えるのは過剰。再計算（残存寄与から要約し直し）を既定にするか、破棄＋生復帰を既定にするかは UX/コストで判断。backstop トリガは「破棄」を強制するので、再計算したい場合は明示フックが破棄前に残存寄与から要約し直す（トリガはあくまで最終防衛線）。
- **undo の多段化**: v1 は直近 1 段。多段スタックにするなら undo 順序を保持する列（または操作ログ）が要る。将来 change。
- **compaction の要約品質と情報欠落**: 要約は text のみなので、畳んだ exchange の **media-ref（画像/ファイル）が要約で失われる**（reply seed が畳み込み済み turn を直接参照するケースは §4.2/§4.4 の pierce で raw を hydrate するため解決済み。残る欠落は媒体と、pierce で拾えない間接連鎖の文脈忠実性）。media を含む exchange の要約注記や、要約品質チューニングは将来 change。
- **編集起因再生成の暴発**: 連続編集や bot 自身の edit を user 編集と誤認しないよう、`messageUpdate` の author が bot か・内容変化があるかを判定。オプトイン既定 off。
- **再生成 edit の Discord 整合**: CAS 確定後に Discord edit が部分失敗した場合の再同期（startup re-hydrate での best-effort）。厳密化が要れば conversation-context の durable outbox を共有。
- **再生成のライブ stream**: v1 は in-memory updater で生成中 Discord を触らず CAS 成功後に edit（敗者/stale 世代が Discord を塗らない）。生成中もライブ表示したいなら、世代/cancellation トークンで**全 updater 書き込みを gate**し、当該世代が active 確定した時だけ反映する将来拡張。
- **編集の out-of-order / 多重編集**: v1 は per-message 直列化 + debounce + 直列区間での最新 fetch（§2.4 手順 0）で「古い編集が新しい編集を上書き」を防ぐ（単一 bot プロセス前提）。複数プロセス化したら in-memory ロックでは不足で、`editedTimestamp` 列等の DB ベース recency 述語が要る。
- **トークン推定の精度**: compaction しきい値は conversation-context §6 の推定器に依存。over/under-compaction の調整余地。

## 参照

- [conversation-context design](../conversation-context/design.md) — `turns`/`status`/`active`/`parent_user_turn_id`/`idx_turns_one_assistant`、CAS 確定、§4 境界選択・§5 メディア剥がし・§6 トークン予算、`deleting_internal_at` lease、`messageUpdate` v1 無視
- [tool-calling-foundation design](../tool-calling-foundation/design.md) — `runToolLoop()`（`Promise<ToolLoopResult>`、cancelled 経路の `AbortSignal`）
- [SQLite partial indexes](https://www.sqlite.org/partialindex.html) — `WHERE` 句付き UNIQUE INDEX の条件評価（**per-statement で即時評価**）
- [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html) — `ADD COLUMN` の制約（`NOT NULL` は DEFAULT 必須、FK 参照を持つ追加列は DEFAULT NULL 必須）。**実測: FK 参照先テーブルは ADD COLUMN 時に未作成でもよい**（遅延解決）。本 migration は可読性のため `session_summaries` を先に作る
- [discord.js component collectors](https://discordjs.guide/message-components/interactions.html) — ボタン interaction、3 秒 ack / 15 分トークン、`customId` ルーティング（コレクタは in-memory・再起動で揮発）
