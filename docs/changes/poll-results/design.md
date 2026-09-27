---
title: "投票の内容と結果をモデルに渡す"
status: investigating  # investigating | planned | in-progress | implemented
priority: medium       # high | medium | low
summary: "会話の窓に入った投票を、質問、選択肢、票数、確定したかどうかのテキストにしてモデルへ渡し、締め切りの通知も窓に入れる"
---

# 投票の内容と結果をモデルに渡す

## Why

会話の中で投票が作られても、モデルはその中身も結果も読めない。
人が作った投票は本文が空のメッセージとして窓に入り、bot が `create_poll` で作った投票と締め切りの通知（type 46）は窓に入らない。
そのため「さっきの投票どうなった?」に答えられず、自分で作った投票の結果も知らない。

## 依存 / 関連 change

- 前提（実装済み）: [discord-tool](../discord-tool/design.md) — `create_poll` が bot を呼んだメッセージへの返信として投票を送る
- 関連: [discord-info-tools](../discord-info-tools/design.md) — 読み取りの tool 群。投票は tool にせず本 change の context で扱う

## Goals / Non-Goals

**Goals:**

- 窓に入った投票メッセージを、質問、選択肢ごとの票数、総票数、締め切り、確定したかどうかのテキストにしてモデルへ渡す
- bot が `create_poll` で作った投票を窓に入れる
- 締め切りの通知（type 46）を、どの投票が締め切られたかと結果の 1 行として窓に入れる

**Non-Goals:**

- 誰がどの選択肢に投票したか（Get Answer Voters）。投票者の一覧は個人の行動の記録なので、使い道が出てから同意の扱いと合わせて設計する
- 会話履歴が off の guild での投票の読み取り。窓が無いので、bot を呼んだメッセージそのものが投票である場合を除いて対象が無い
- 投票の締め切り（End Poll）や投票の編集

**将来別 change 候補:**

- bot が作った投票を締め切る tool（End Poll は作成者だけが使え、bot の投票なら使える）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 渡し方 | tool にせず、窓のメッセージの正規化で投票をテキストにする | 窓は応答のたびに REST で取り直すので、正規化の時点の票数がその応答での最新である。tool にしても、投票があることは窓で見えていないとモデルは呼べないので、正規化は結局要る |
| 票数の取得元 | 窓の取得で得たメッセージの `poll.results` をそのまま使い、投票ごとの追加の REST は呼ばない | メッセージ一覧の取得（`GET /channels/{id}/messages`）が `poll.results` を含むことを 2026-09-27 に開発用チャンネルで確かめた |
| `results` が無いとき | 票数を「不明」と表示し、0 票とは書かない | Discord は、応答によっては `results` を省くことがあり、その場合は「結果が無い」ではなく「不明」として扱うよう定めている |
| 票の無い選択肢 | `results` があり `answer_counts` にその選択肢が無ければ 0 票とする | Discord の定義で、票の無い選択肢は `answer_counts` に現れない。2026-09-27 の実データでも票のある選択肢だけが返った |
| 確定前の票数 | 票数に「集計中」または「確定」を添える | 投票中の票数は概ね正確だが保証は無く、締め切り後の集計で `is_finalized` が true になって確定する |
| bot の投票を窓に入れる条件 | bot 自身が送った、`poll` を持つメッセージを、返答記録（`reply_records`）に無くても窓に入れる。返信先（`message_reference`）の発言が外部で削除されていれば入れない | 返答記録は返答のページを管理する表で、投票はページではない。記録に足すと、ページ数、停止時の削除、中立化の処理が投票を返答の一部として扱ってしまう。返信先の削除に合わせて隠すのは、返答のページと同じ扱いにするため |
| 締め切りの通知 | type 46 のメッセージを、埋め込み `poll_result` の質問、勝った選択肢、その票数、総票数から作る 1 行で窓に入れる。作者が人でも bot でも入れる | 通知の作者は投票の作者と同じになる。人の発言として扱う type（0 と 19）の判定に入れず、通知として別に判定する |
| 投票の作者の扱い | 人が作った投票は人の発言、bot が作った投票は bot の発言（assistant）として並べる | 既存の窓の並べ方に合わせる |

## Design

### 変更対象ファイル

- 修正: `src/utils/discordMessageNormalizer.ts` — `RawDiscordMessage` に `poll` と `embeds` を足し、投票と締め切りの通知をテキストにする
- 修正: `src/services/messageEligibility.ts` — bot の投票メッセージと type 46 の通知を窓に入れる判定
- 修正: `src/services/chatService.ts` — `formatConversationMessage()` で投票のテキストを本文の後に置く（正規化の結果を使う）
- テスト: 正規化（票のある選択肢だけの `answer_counts`、`results` の欠落、確定と集計中、複数の勝者の通知）、窓に入る判定（bot の投票、返信先が消えた bot の投票、他の bot の投票、type 46）
- 修正: `scripts/e2e/scenarios.ts` — 名前を指定して走るシナリオ

### 実装内容

投票のテキストは、本文の後に次の形で置く。

```text
[投票 "賛成ですか？" 締め切り 2026-09-28 21:47 JST・集計中]
- はい: 0 票
- いいえ: 1 票
（総票数 1）
```

- 締め切りは `poll.expiry` を JST で書き、過ぎていれば「締め切り済み」とする。
- `results` が無ければ各選択肢の票数を「不明」とし、総票数の行を省く。
- 選択肢の絵文字は、Unicode ならそのまま、カスタム絵文字なら `:name:` で書く。
- 締め切りの通知は `[投票の締め切り "賛成ですか？": 「いいえ」が 1 票で最多（総票数 1）]` の形にする。埋め込みに勝った選択肢が無い（同票や 0 票）ときは総票数だけを書く。
- 投票メッセージのトークン見積もりは、既存の `estimateNormalizedMessageTokens()` に投票のテキストを含める。窓の予算と `read_earlier_messages` の予算は投票の分も数える。

### e2e

`bun run e2e poll-results` を名前を指定したときだけ走らせ、会話履歴と Discord 操作を有効にすることを要件にする。
テスト bot が bot に投票を作らせ、テスト bot は投票できない（アプリは投票できない）ので、票数 0 の状態で「さっきの投票の選択肢と票数を教えて」と頼み、返答に選択肢と 0 票が含まれることを確かめる。

## Tasks

- [ ] 正規化で投票と締め切りの通知をテキストにする
- [ ] bot の投票と type 46 の通知を窓に入れる
- [ ] 単体テストを足す
- [ ] e2e シナリオ `poll-results` を足し、AGENTS.md の End-to-end 節に実行条件を書く
- [ ] 手動確認: 実クライアントで投票に票を入れ、bot に結果を尋ねて票数が合うことを確かめる
- [ ] `docs/changes/poll-results/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **type 46 の実データ（未検証）**: 通知の埋め込みの項目は文書から取った。開発用チャンネルで締め切りまで待った投票の通知を 1 件取り、項目の形を確かめてから実装する。
- **票数の揺れ**: 集計中の票数はモデルにそのまま渡すので、モデルが確定した結果のように答えることがある。テキストに「集計中」を添えることで抑える。

## 参照

- Discord Poll Resource（`developers/resources/poll.mdx`）— Poll Results Object、票の無い選択肢の扱い、`results` の欠落
- Discord Message Resource（`developers/resources/message.mdx`）— type 46（POLL_RESULT）と `poll_result` 埋め込みの項目
