---
title: "セッション分岐 (/fork)"
status: investigating  # investigating | planned | in-progress | implemented
priority: low          # high | medium | low
summary: "会話履歴の途中から新しいセッションへ分岐する /fork（参照コピー・session_id 安定性前提）"
---

# セッション分岐 (/fork)

## Why

長い会話で話題が枝分かれするとき、現状は同一セッションに新しい話題を継ぎ足すか、別チャンネルで一から文脈を作り直すしかない。
過去のある時点（特定の turn）までの文脈を保ったまま、そこから先を別系統として進めたい（「あの回答の続きを別案で試す」「途中まで共有した前提から分岐する」）需要がある。

本 change は、[conversation-context](../conversation-context/design.md) が確立した turn/session モデルと**安定 `session_id`** を前提に、**指定 turn を起点に新セッションへ分岐する `/fork`** を検討する。
本 doc は `investigating`（方針探索段階）であり、設計の確定ではなく検討点と未決事項の洗い出しを目的とする。

## 依存 / 関連 change

- 先行（**確定済み前提**）: [conversation-context](../conversation-context/design.md) — turn/session/turn_messages モデル、gap 区切りの session、**`session_id` を「fork/sandbox 用の安定 ID」として不変に保つ方針**（同 change Decisions「セッション同一性」+ Design §2「セッション解決・保存経路」で物理マージしないと明記）。本 change はこの安定 ID を分岐の親参照に使う。
- 関連: [code-execution](../code-execution/design.md) — persistent sandbox は `session_id` をキーにできる（所有・ライフサイクルは code-execution 側）。fork で新 `session_id` が生まれたとき、新セッションの sandbox を**親から継承するか新規にするか**は両 change 間で決める必要がある（本 doc Open Questions）。
- 連携: [settings-hierarchy](../settings-hierarchy/design.md) — 分岐先セッションに適用する system prompt 等の設定 scope（チャンネル/スレッド/ユーザ）の解決。

## Goals / Non-Goals

**Goals（探索対象）:**

- `/fork`（slash command）で、**現在のチャンネル/スレッドの会話を、指定した過去 turn を境界に新セッションへ分岐**する道筋を定める。
- 分岐元（親）セッションと、起点 turn を**安定 ID で参照**して記録する（履歴の物理複製はしない方針を第一候補とする）。
- 分岐先で文脈構築（[conversation-context](../conversation-context/design.md) の境界ロジック）が、**起点 turn 以前の親履歴 + 分岐後の新 turn** を一貫して拾えるデータモデルの候補を 1-2 案出す。
- `session_id` 安定性（fork/sandbox 前提）を壊さない範囲で実現できることを確認する。

**Non-Goals（本 change / v1 では扱わない）:**

- 分岐ツリーの可視化・グラフ表示 UI（どの turn からどう分かれたかの俯瞰）。
- 分岐先セッションの親への**マージ / 取り込み**（分岐は一方向。merge back は別 change 候補）。
- 任意 turn の**編集による分岐**（編集再生成は [conversation-regeneration](../conversation-regeneration/design.md) の範疇。fork は「分岐点を選ぶ」だけで turn 内容は変えない）。
- DM での fork（conversation-context が guild 前提・`DirectMessages` intent 未設定）。

**将来別 change 候補:**

- 分岐先の親への取り込み（merge back）→ 別 change。
- 分岐ツリーの可視化 → 別 change。

## Decisions

> `investigating` 段階のため、以下は**現時点の第一候補（暫定）**であり確定ではない。各行の代替案・未決は Open Questions 参照。

| 判断事項 | 暫定の選択 | 理由 |
| -------- | ---------- | ---- |
| 分岐点の指定 UI | **メッセージコンテキストメニュー（"ここから分岐"）を第一候補**とし、対象メッセージを `interaction.targetMessage` で受ける。代替: `/fork` slash command に message URL/ID オプション、または直近 N turn の select menu | slash command interaction は通常メッセージのような **reply 参照を持たない**（`/fork` 実行に「reply 先」は無い）。Discord で特定メッセージを起点に取る正規手段は context-menu command か明示の URL/ID オプション。turn は安定 ID を持つので、対象メッセージ → `turn_messages` → turn で境界を切れる |
| 履歴のコピー方式 | **参照（lineage 記録）を第一候補**。親 `session_id` + 起点 `turn.id` を新セッションに記録し、物理複製しない | conversation-context は「session_id は安定 ID なので不変・物理マージしない」方針。複製は二重保持・purge 整合（親削除時の扱い）を複雑化する。参照なら親が source of truth のまま |
| 新セッションの置き場 | **新スレッドを作成**して分岐先にするのを第一候補（同チャンネル継続は代替案） | 親会話と分岐が同一チャンネルで時系列混在すると gap ベースの session 解決と衝突する。スレッドなら独自 `channel_id` で session が自然に分かれ、conversation-context の `is_thread`/`parent_channel_id` モデルにも乗る |
| `session_id` との関係 | fork は**新しい `session_id` を発行**し、親 `session_id` を参照列で指す。親・子いずれの `session_id` も不変 | conversation-context の「安定 ID」契約を維持。fork は session を**マージも改名もしない**（新規発行 + lineage のみ） |
| OpenRouter routing との関係 | fork 先の local session は親から `openrouter_session_id` をコピーせず、新しい値を発行する | 分岐後の request を親と同じ外部 routing session として扱わず、独立した prompt prefix と cache 系列にする |
| fork スレッド内の gap 越え | 分岐先スレッドでの後続発話が gap を越えても、**lineage を子側の後続 session へ伝播**する（第一候補）。conversation-context の通常 gap 解決は `t` が既存 bounds 外なら新 session を作るため、長い無活動後は同一スレッドでも別 `session_id` が生まれる。新 session 作成時に**同スレッドの直近 fork session から `forked_from_session_id` + `forked_at_discord_msg_id`（cutoff の真実）を引き継ぐ**ことで、分岐先が gap で痩せない（`forked_at_turn_id` は live なら補助コピー） | 「fork session を 1 つに固定」は gap セマンティクスを壊す。「後続 session が lineage を失う」を許すと長い分岐が文脈を失う。lineage 伝播が両者を両立する（要 Open Questions 検証） |
| 分岐先の文脈構築 | 起点 turn 以前は**親 session の exchange を境界ロジックで遡って**拾い、起点以降は子 session（および lineage を伝播した後続 session）の turn を拾う（lineage を辿る読み取り） | 履歴を複製しないため、文脈構築側が親へ遡る読み取りを担う。境界・予算ロジックは conversation-context の Section 4/6 を再利用 |
| fork 起点の cutoff 基準 | 起点 turn の**写像メッセージの最大 snowflake**（`turn_messages.discord_msg_id` の数値最大）を cutoff として記録する（新規 `sessions` 列 `forked_at_discord_msg_id`〔提案〕を併せて保存）。`turns` 自体は snowflake を持たない | conversation-context Section 4 の cutoff/tie-breaker は `discord_msg_id` の snowflake 数値順（`turn.id` 挿入順や TEXT 文字列順は不可）。assistant turn は 0..N メッセージに写像するため「turn の snowflake」は一意でなく、最大 snowflake を採る |

## Design

> 本節は `investigating` のスケッチ。確定設計ではない。`planned` 昇格時に conversation-context の確定スキーマへ合わせて精緻化する。

### 変更対象ファイル（想定）

- 新規: `src/bot/commands/fork.ts` — fork コマンド（**メッセージコンテキストメニュー "ここから分岐" を第一候補**、代替で message URL/ID オプションの slash command。分岐点の受け取り、新スレッド作成、lineage 記録）。**命名注記**: 本機能は通称 `/fork` だが、第一候補のメッセージコンテキストメニュー command は実際には `/fork` と打って起動するものではない（context-menu と slash は別 command 種別）。`planned` 昇格時に「primary = context-menu "ここから分岐" + 任意で `/fork` slash fallback」か「primary = `/fork` slash（URL/ID 入力）」かを確定する。
- 修正: `src/db/schema.ts` — `sessions` に分岐元参照列を追加（下記スキーマ案）。
- 修正: `src/db/repositories/`（conversation-context が新設する session/turn repository） — fork 作成と、文脈構築時の**親 session 遡り読み取り**。
- 修正: 文脈構築経路（conversation-context Section 4「セッション境界」） — lineage を辿って親 exchange を拾う分岐。

### DB スキーマ変更（案）

conversation-context の `sessions` に分岐元参照を追加する案。

```sql
-- conversation-context の sessions に追加（案）
ALTER TABLE sessions ADD COLUMN forked_from_session_id  INTEGER REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN forked_at_turn_id       INTEGER REFERENCES turns(id)    ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN forked_at_discord_msg_id TEXT;  -- 起点 turn の写像最大 snowflake（cutoff 用スナップショット。turn purge でも cutoff が残る）。比較は INTEGER/BigInt の数値順（TEXT 文字列順は不可、conversation-context §4 と同じ）
-- lineage の整合: forked_from_session_id と forked_at_discord_msg_id を「fork 判定 + cutoff の真実」とし、
-- forked_at_turn_id は live turn への補助参照（purge で NULL 化されても fork 判定・cutoff は維持される）。
CREATE INDEX idx_sessions_forked_from ON sessions(forked_from_session_id); -- 親→子の列挙・purge 用
```

> いずれも**提案列**であり、`planned` 昇格時に conversation-context の確定スキーマへ合わせて確定する。`ON DELETE SET NULL` の発火は conversation-context が接続時に有効化する **`PRAGMA foreign_keys = ON`**（同 change の前提）に依存するため、ALTER で追加した FK が SQLite/Bun で実際に enforce されることを実装時に検証する（FK 既定 off）。

- **cutoff を turn 参照に持たせない理由**: `turns` は snowflake を持たず、assistant turn は 0..N の Discord メッセージに写像する。`forked_at_turn_id` だけだと (a) cutoff の snowflake が一意に定まらず、(b) 起点 turn が user/TTL/メッセージ purge で消えると cutoff が失われる。よって**起点 turn の写像最大 snowflake を `forked_at_discord_msg_id` にスナップショット**し、cutoff の source of truth とする案を第一候補とする（`forked_at_turn_id` は live 参照の補助に留める）。**ただしこの「メッセージ purge 後も snowflake を残す」保持は暫定**で、プライバシー方針（消したものは DB からも消す）との両立は未決（下記 Open Questions「cutoff snowflake の purge 整合」。purge 時にクリアする代替もあり）。
- **half-null lineage の扱い**: `forked_at_turn_id` が `ON DELETE SET NULL` で消えても `forked_from_session_id`/`forked_at_discord_msg_id` は親 session が生きていれば残る。**fork 判定は `forked_from_session_id IS NOT NULL` のみで行い**、cutoff は `forked_at_discord_msg_id` を使う（`forked_at_turn_id` の NULL/非 NULL に依存しない）。これにより「片方だけ NULL」で fork 判定や文脈構築が壊れない。
- **lineage 整合は FK 単体では保証されない（repository 不変条件）**: `forked_from_session_id` と `forked_at_turn_id` は独立 FK なので、DB だけでは「親 = session A だが起点 turn は session B 由来」のような不整合な組も表現できる。`forked_at_discord_msg_id` も `forked_at_turn_id`/`turn_messages` に縛られない。よって **fork 作成時の不変条件**として、`forked_at_turn_id` が非 NULL なら**その turn は `forked_from_session_id` に属し、`forked_at_discord_msg_id` はその turn の `turn_messages` のいずれか（またはそこから導出した cutoff スナップショット）である**ことを repository txn で検証する（conversation-context が parent role/session を FK でなく repository txn で検証するのと同型。CHECK はサブクエリ不可）。テストでこの不変条件を担保する。
- `ON DELETE SET NULL` の含意（要検討）: 親 session 自体が purge されると `forked_from_session_id` が NULL になり**親文脈を辿れなくなる**（子は自分の turn のみの孤立 session になる）。子は孤立残置するか、親 purge を子へ波及させるかは Open Questions。物理複製しない第一候補ではこの「親消失で文脈が痩せる」挙動が避けられない。
- 親へ遡る読み取りは**循環・多段 fork**（fork の fork）を想定し、深さ上限・visited セットで保護する（conversation-context の reply チェーン保護と同型）。

### 分岐の流れ（案）

1. ユーザが分岐したい turn の Discord メッセージに対し**コンテキストメニュー "ここから分岐"** を実行（代替: `/fork` に message URL/ID を渡す）。起点メッセージは `interaction.targetMessage`（context-menu）または URL/ID パース（slash）で得る。
2. command handler が**起点 turn を解決**: 起点 `discord_msg_id` → `turn_messages` 経由で turn を引く（conversation-context の写像照合を再利用）。解決できなければエラー（「分岐元の発言を特定できませんでした」）。
3. 起点 turn の `session_id`（= 親）・`turn.id`（= 起点）と、起点 turn の**写像最大 snowflake**（`forked_at_discord_msg_id`、cutoff 用）を確定。
4. **新スレッドを作成**（`channel.threads.create` / または起点メッセージから `message.startThread()`）。スレッド名は起点要約 or 既定名。
5. conversation-context の通常 session 解決を**スキップして fork session を明示作成**: 新スレッドの `channel_id`（= 作成したスレッド ID）と新しい `openrouter_session_id` で `sessions` 行を作り、`forked_from_session_id = 親`, `forked_at_turn_id = 起点`, `forked_at_discord_msg_id = 起点 cutoff`, `is_thread=1` を記録。**`parent_channel_id` は新スレッドの実際の親チャンネル**にする: 起点が通常チャンネルなら元チャンネル、**起点が既にスレッドなら Discord はスレッドのネストを許さないため、同じ親チャンネル配下の兄弟スレッドとして作成し `parent_channel_id = 起点スレッドの親チャンネル（`thread.parentId`）`** にする（起点スレッド ID を `parent_channel_id` にしない。下記 Open Questions「新スレッド vs 同チャンネル」）。以後そのスレッドの発話は通常の gap ベース解決に乗る。**ただし同スレッドで gap を越えて新 session が作られる場合、直近 fork session から lineage（`forked_from_session_id`/`forked_at_discord_msg_id`）を引き継ぐ一方、`openrouter_session_id` は新しい local session ごとに再発行する**（上記 Decisions「fork スレッド内の gap 越え」。さもないと長い分岐が gap で親文脈を失う）。
6. 分岐先での次回応答時、文脈構築は: **子 session（+ lineage 伝播した後続 session）の turn**（gap/予算ロジック）に加え、予算が残れば **cutoff（`forked_at_discord_msg_id`）以前の親 exchange** を lineage を辿って遡る。cutoff より後の親メッセージは拾わない（cutoff = `discord_msg_id` の snowflake 数値比較、conversation-context Section 4 の cutoff 規則と同型）。

### 設計メモ

- **物理マージ禁止との整合**: conversation-context は「t が前後 2 session の gap を橋渡しする場合でも物理マージしない（`session_id` は fork/sandbox 用の安定 ID なので不変）」と定める。fork は session を結合せず**新規発行 + lineage 参照**なので、この方針と整合する。fork はむしろ「安定 `session_id` を将来用途に使う」という同 change の想定を実体化する最初の利用者になる。
- **新スレッド方式が gap 衝突を避ける理由**: 同チャンネルで分岐すると、親会話の続きと分岐後の発話が同一 `channel_id` の時系列に混在し、gap ベース session 解決が両者を同一 session に吸収する（または誤って跨ぐ）。スレッドは独自 `channel_id` を持つため session が物理的に分離し、conversation-context の解決ロジックをそのまま使える。
- **purge / プライバシー整合**: 子 fork が親を参照するだけで親 turn を複製しないので、親側のユーザ削除・TTL purge は子に複製を残さない（プライバシー上望ましい）。代償として親 purge で子の文脈が痩せる（上記スキーマ注記）。複製方式なら子が文脈を保持できるが、親で消したものが子に残り**プライバシー方針（消したものは DB からも消す）に反する**ため、参照方式を優先する。

## Tasks

> `investigating` のため未着手。`planned` 昇格時に conversation-context の確定スキーマへ合わせて具体化する。

- [ ] conversation-context の確定スキーマ確認後、`sessions` への lineage 列（`forked_from_session_id`/`forked_at_turn_id`/`forked_at_discord_msg_id`）追加方式を確定（または別テーブル化を判断）。
- [ ] 起点 turn 解決（起点メッセージ → `turn_messages` → turn）+ cutoff snowflake（写像最大 `discord_msg_id`、数値比較）の取得経路を確定。
- [ ] fork スレッド内 gap 越えでの lineage 伝播（新 session 作成時に直近 fork session から継承）を session 解決経路へ組み込む。
- [ ] 新スレッド作成方式（`threads.create` vs `startThread`）・必要権限（CreatePublic/PrivateThreads・SendMessagesInThreads）の確認。
- [ ] 文脈構築での親 session 遡り読み取り（cutoff = `forked_at_discord_msg_id` の snowflake 比較、深さ上限・循環保護）の設計。
- [ ] 親 purge 時の子 fork の扱い（孤立残置 vs 波及）を確定。
- [ ] code-execution sandbox の継承可否を code-execution 側と調整。
- [ ] `/fork` command 実装 + テスト。
- [ ] `docs/changes/fork/` 削除（リリース完了時、git 履歴がアーカイブ）。

## Open Questions / Risks

- **分岐点の指定 UX**: メッセージコンテキストメニュー（`interaction.targetMessage` で起点メッセージを直接得る）を第一候補とするが、対象がまだ turn 化されていない/履歴 off チャンネルのメッセージを選んだ場合のエラー文言、message URL/ID オプション併設の要否、直近 N turn からの select menu（Components V2）代替を出すかが未決。
- **新スレッド vs 同チャンネル**: 第一候補は新スレッドだが、スレッド権限が無いチャンネル・既にスレッド内での `/fork`（スレッドからさらに分岐＝ネスト）をどう扱うか。スレッド内 fork は親スレッドの `channel_id` でさらに新スレッドを作れない場合がある（Discord はスレッドのネストを許さない）ため、その場合の置き場（親チャンネルに新スレッド？）が未決。
- **履歴コピー方式の最終判断**: 参照（lineage）を第一候補とするが、親 purge で子の文脈が痩せる代償がある。「分岐時点の文脈スナップショットだけ複製し、それ以降は親を参照しない」ハイブリッドも候補。プライバシー方針（消したものは消す）と文脈保持のトレードオフを `planned` 昇格時に決める。
- **多段 fork（fork の fork）**: lineage チェーンが深くなる。遡り読み取りの深さ上限・予算配分（親へ何 exchange まで遡るか）と循環保護の具体値が未決。
- **同一 fork スレッド内の複数 session の読み取り**: lineage 伝播で同一スレッド内に gap 越えの複数 fork session が並ぶと、文脈構築が後続 session の turn を拾う際、**同スレッドの先行 fork session（gap で分かれた直前の自分の続き）も読むのか、自 session の turn + 親 cutoff だけ読むのか**が未決。前者なら「同スレッド内で同一 lineage を共有する session 群」を時系列で連結して読む規則が要る（gap で分かれても同じスレッドの会話は連続体として扱うのが自然だが、予算配分・深さ上限と合わせて設計が要る）。
- **`session_id` 安定性 + gap 越え lineage 伝播の整合**: fork は新 `session_id` を発行し親を参照するだけなので安定性契約は壊さない。fork session 自体は明示作成され通常の gap 配置で再配置・改名されない。残る検討点は Decisions「fork スレッド内の gap 越え」で第一候補とした**lineage 伝播**: 同スレッドで gap 越えに新 session が作られる際、conversation-context の session 解決経路へ「直近 fork session の lineage を継承する」フックを差し込めるか（解決経路を侵襲せず実現できるか）。継承しない代替（後続 session は通常 session として lineage を持たない）を許すなら、長い分岐が gap 後に親文脈を失う旨をユーザに明示する必要がある。
- **code-execution sandbox の継承**: fork 先の新 `session_id` に対し、親 session の persistent sandbox を継承するか新規にするか。継承すると親の実行状態を共有してしまい「分岐」の独立性と矛盾しうる。code-execution 側の所有・ライフサイクル方針との整合が必要。
- **cutoff snowflake の purge 整合**: `forked_at_discord_msg_id` は起点 turn/メッセージが user/TTL/外部 purge で消えても cutoff の真実として残す設計。conversation-context のプライバシー方針（消したものは DB からも消す）に対し、**メッセージ本文を含まない lineage メタデータ（snowflake のみ）は保持を許容する**か、purge 時にクリアして「親 purge 後は cutoff 不定 → 子は自分の turn のみ」に倒すかが未決。前者は非コンテンツ ID の残置、後者は分岐文脈の喪失というトレードオフ。
- **適用設定の解決**: 分岐先スレッドの system prompt 等の設定 scope を [settings-hierarchy](../settings-hierarchy/design.md) でどう解決するか（親チャンネル設定を継承するか、スレッド独自に解決するか）。

## 参照

- [conversation-context](../conversation-context/design.md) — turn/session/turn_messages モデル、安定 `session_id`、物理マージしない方針、文脈境界（Section 4 cutoff = `discord_msg_id` snowflake）・トークン予算（Section 6）。
- [discord.js Threads](https://discord.js.org/docs/packages/discord.js/14.26.2/ThreadManager:Class) — `channel.threads.create({name,autoArchiveDuration,type})` / `message.startThread()`、必要権限。
- [discord.js Context Menus](https://discordjs.guide/interactions/context-menus.html) — メッセージコンテキストメニュー command（`interaction.targetMessage` で起点メッセージを取得）。
