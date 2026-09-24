---
title: "会話の分岐 (fork)"
status: investigating  # investigating | planned | in-progress | implemented
priority: low          # high | medium | low
summary: "指定した発言からスレッドを作り、そのスレッドの会話が親チャンネルの発言以前まで遡って読めるようにする"
---

# 会話の分岐 (fork)

## Why

長い会話で話題が枝分かれするとき、同じチャンネルで続けると二つの話題が混ざり、スレッドへ移ると bot はそれまでの文脈を読めない。
bot の会話の窓は応答した発言のチャンネルだけを読む（`src/services/conversationWindow.ts`）ので、スレッドの中からは親チャンネルの会話が見えないためである。
本 change は、指定した発言からスレッドを作り、そのスレッドでの応答が親チャンネルのその発言以前まで遡って読めるようにする分岐を検討する。

## 依存 / 関連 change

- 先行（実装済み）: [conversation-context](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/conversation-context/design.md) — 会話は応答のたびに Discord から読み、直近は窓として渡し、それより前はモデルが `read_earlier_messages` で取りに行く。窓と遡りはどちらも 24 時間（`CONVERSATION_MAX_AGE_MS`）より古い発言を読まない
- 関連: [discord-tool](../discord-tool/design.md) — モデルが呼ぶ `create_thread` も `message.startThread()` でスレッドを作る。同 change のスレッドは親の会話を読まない普通のスレッドであり、本 change の分岐とはリリース単位が別なので統合しない。`create_thread` で作ったスレッドにも親の会話を読ませるかは、両方が揃った時点で本 change の系譜表に登録するかで決める
- 連携: [settings-hierarchy](../settings-hierarchy/design.md) — 分岐先スレッドに適用する設定の解決

## Goals / Non-Goals

**Goals（探索対象）:**

- 発言を指定してスレッドを作る操作を定める
- 分岐先スレッドの窓と `read_earlier_messages` が、スレッド内の発言を読み尽くした後に親チャンネルの起点以前へ続けて遡れるようにする
- 分岐の系譜（スレッド ID から、親チャンネル ID と起点の発言 ID）を保持する

**Non-Goals:**

- スレッドの中からの分岐。Discord はスレッドの中にスレッドを作れず、親チャンネルに兄弟スレッドを作ると系譜が多段になる。v1 はスレッドの中では断る
- 分岐先の親への取り込み（merge back）と、分岐ツリーの表示
- 発言の複製。親チャンネルの発言は Discord から読むだけで、分岐先へ写さない
- DM での分岐

## Decisions

> `investigating` 段階のため、以下は現時点の第一候補であり確定ではない。未決は Open Questions を参照。

| 判断事項 | 暫定の選択 | 理由 |
| -------- | ---------- | ---- |
| 分岐点の指定 | メッセージのコンテキストメニュー「ここから分岐」。対象は `interaction.targetMessage` で受ける | slash command の interaction は reply 先を持たないので、特定の発言を起点に取るにはコンテキストメニューか、message URL を受けるオプションが要る。コンテキストメニューは URL の貼り付けが要らない |
| 分岐先の置き場 | 起点の発言から `message.startThread()` で公開スレッドを作る。テキストチャンネル（`ChannelType.GuildText`）に限る | 同じチャンネルで分岐すると親の会話と分岐後の会話が一つの窓に混ざる。スレッドは別のチャンネル ID を持つので、窓の状態（チャンネルごと）も自然に分かれる。1 つの発言には 1 つのスレッドしか作れないので、同じ起点からの二度目の分岐は既存スレッドへの案内で返す |
| 系譜の保持 | DB に `thread_lineages`（スレッド ID、親チャンネル ID、起点の発言 ID、guild ID、作成時刻）を置く | メモリに置くと再起動で失われ、再起動後の分岐先は親を読めなくなる。発言の本文は持たず ID だけなので、会話ストアを持たない前提と両立する。親チャンネルの発言が消えれば読むときに Discord から消えているので、削除の同期も要らない |
| 系譜の寿命 | 起点の発言から 24 時間を過ぎた行は、`reply_records` と同じ定期掃除で消す | 窓も遡りも今回の発言から 24 時間より古い発言を読まず、起点以前の親の発言はすべて起点より古い。起点から 24 時間を過ぎると、親の発言は一つも読めなくなる |
| 遡りの範囲 | スレッドの発言を読み尽くしたら、親チャンネルの起点の発言（それ自身を含む）から前を、スレッドと同じ窓の上限と 24 時間の制限のもとで続けて読む | 窓の縮小規則と `read_earlier_messages` の上限をそのまま使えば、分岐先だけ別の予算規則を持たずに済む |
| 親を読む権限 | 親チャンネルの発言を読む前に、bot と発言者が親チャンネルの `ViewChannel` と `ReadMessageHistory` を持つことを確かめる | 窓の認可（`messageAuthorization.ts` の `canReadConversation`）は今回のチャンネルだけを見る。スレッドの権限から親の閲覧権限が導けるかは確かめておらず（未検証）、直接確かめる方が安全である |
| 実行者の権限 | 実行者自身が `CreatePublicThreads` を持たなければ断る | bot の権限でスレッドを作ると、スレッドを作れない人が bot 経由で作れてしまう |
| セッション ID とコンテナ | 引き継がない | OpenRouter へ渡す `session_id` は窓ごとにメモリで採番し、窓を組み直すと新しくなる（`conversationWindow.ts` の `rebuild`）。分岐先スレッドは別のチャンネルなので別の窓と別の ID になる。code-execution のコンテナも生成ごとに採番されるので、分岐で共有する状態が無い |

## Design

> `investigating` のスケッチであり、確定設計ではない。

### 変更対象ファイル（想定）

- 新規: `src/bot/commands/fork.ts` — コンテキストメニュー「ここから分岐」。起点の検証、権限の確認、スレッド作成、系譜の登録
- 新規: `src/db/repositories/threadLineage.ts` — 系譜の登録、スレッド ID での参照、期限切れの削除
- 修正: `src/db/schema.ts` — `thread_lineages` 表
- 修正: `src/services/conversationWindow.ts` — スレッドの読み尽くし後に親チャンネルの起点以前へ続ける読み取り（窓の組み立てと `read_earlier_messages` の両方）
- 修正: `src/services/messageEligibility.ts` — 返答の検証で発言を取得するチャンネルを、今回のチャンネルではなく記録の `channel_id` にする。親チャンネルの返答は親チャンネルの記録を持つためである

### DBスキーマ変更（案）

```sql
CREATE TABLE IF NOT EXISTS thread_lineages (
  thread_id          TEXT PRIMARY KEY,   -- 分岐先スレッドのチャンネル ID
  parent_channel_id  TEXT NOT NULL,      -- 起点の発言があるチャンネル
  cutoff_msg_id      TEXT NOT NULL,      -- 起点の発言。これ以前（それ自身を含む）を読む。比較は snowflake の数値順
  guild_id           TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);
```

### 分岐の流れ（案）

1. ユーザが発言のコンテキストメニューから「ここから分岐」を実行する。
2. 対象がテキストチャンネルの発言であること、実行者が `CreatePublicThreads` を持つこと、guild で履歴の設定が有効であることを確かめる。満たさなければ ephemeral で断る。
3. 対象の発言に既にスレッドがあれば、そのスレッドを案内して終える。
4. `message.startThread({ name })` でスレッドを作り、`thread_lineages` に登録する。
5. 分岐先スレッドで bot が応答するとき、窓はスレッド内を読み、読み尽くしたら系譜を引いて親チャンネルの起点以前を読む。`read_earlier_messages` のカーソルも同じ順で親へ移る。

## Tasks

- [ ] 遡りの境界（スレッドの末端から親へ移る条件、窓の縮小規則との関係）を `conversationWindow.ts` の実装に沿って確定し、`status` を `planned` にする
- [ ] `thread_lineages` の表と repository を追加し、期限切れの削除を定期掃除に加える
- [ ] 返答の検証が記録の `channel_id` で発言を取得するよう `messageEligibility.ts` を直し、テストする
- [ ] 窓と `read_earlier_messages` の親への遡りを実装し、テストする
- [ ] コンテキストメニューの command を実装し、テストする
- [ ] `docs/changes/fork/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **24 時間の制限**: 起点が 24 時間より古い発言だと、分岐しても親の会話は読めない。起点から 24 時間を過ぎると、分岐先は親の文脈を失う。加えて返答の記録は確定から 24 時間で消え、記録の無い bot の発言は窓から外れるので、親の bot の返答はそれより早く読めなくなることがある。分岐先だけ制限を延ばすには、記録の保持期間も延ばす必要がある。
- **人が作ったスレッドへの適用**: 発言から作られたスレッドは Discord 上で親チャンネルと起点の発言が分かるので、系譜表なしで全スレッドに親を読ませる案もある。既存のスレッドの挙動が変わり、応答ごとの REST 消費も増えるため、第一候補は分岐で作ったスレッドに限る。起点の発言 ID がスレッド ID と一致するという Discord の仕様は未検証である。
- **スレッドの中からの分岐**: 需要があれば、親チャンネルに兄弟スレッドを作り、系譜を多段にたどる。深さの上限と循環の防止が要る。
- **返答ページを起点にしたとき**: 窓はページが揃わない返答を外す（`conversationWindow.ts` の `eligibleEntries`）。複数ページの返答の途中のページを起点にすると、その返答は分岐先に入らない。起点を返答の最後のページへ寄せるかを決める。
- **設定の解決**: 自動応答チャンネルの判定はスレッドの親チャンネルも見る（`messageCreate.ts`）。分岐先スレッドに親と別の設定を持たせるかは settings-hierarchy と合わせて決める。

## 参照

- [conversation-context](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/conversation-context/design.md) — 窓の組み方、`read_earlier_messages`、24 時間の制限
- [discord.js ThreadManager](https://discord.js.org/docs/packages/discord.js/14.26.2/ThreadManager:Class) — `threads.create()` と `message.startThread()`
- [discord.js Context Menus](https://discordjs.guide/interactions/context-menus.html) — メッセージのコンテキストメニュー（`interaction.targetMessage`）
