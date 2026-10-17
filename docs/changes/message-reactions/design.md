---
title: "発言に付いたリアクションを読む"
status: in-progress    # investigating | planned | in-progress | implemented
priority: medium       # high | medium | low
summary: "会話履歴の各発言に付いたリアクションの種類と数を、発言の本文の後ろに添えてモデルに渡す"
---

# 発言に付いたリアクションを読む

## Why

bot は `add_reaction` でリアクションを付けられるが、発言に付いたリアクションはモデルに渡していない。
そのため「この発言にどんな反応があったか」に答えられず、自分の返答に付いたリアクションも分からない。

## 依存 / 関連 change

- 連携: [discord-expressions](../discord-expressions/design.md) — カスタム絵文字を名前で読ませる。本 change のリアクションのカスタム絵文字も同じ `:name:` の形で書くが、どちらも相手の実装を前提にしない

## Goals / Non-Goals

**Goals:**

- 会話履歴と `read_earlier_messages` の結果で、各発言に付いたリアクションの種類と数をモデルに渡す
- bot の返答に付いたリアクションも渡す

**Non-Goals:**

- 誰がリアクションを付けたかを渡すこと。絵文字ごとに `GET /channels/{channel}/messages/{message}/reactions/{emoji}` の呼び出しが要り、窓を作る REST の予算（`CONVERSATION_REST_LIMIT`）を圧迫する
- リアクションの追加や削除をきっかけに返答すること

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 取得元 | 窓を作るときに読むメッセージの `reactions`（絵文字と数） | 会話の窓は返答のたびに REST でメッセージを読み直す（`ConversationWindowService` の `rebuild` と `extend`）。メッセージには `reactions` が含まれるので、追加の呼び出しなしで返答の時点の数が得られる。gateway のリアクションのイベントを購読する案は、`GuildMessageReactions` の intent と、メッセージごとの数を保持する仕組みが要る |
| 書式 | 本文と投票の後ろに 1 行で `[リアクション 👍 2、😢 1、:kusa: 1]` と書く。カスタム絵文字は `:name:` にし、削除されて名前が null のカスタム絵文字は `:削除された絵文字:` として数を残す。Unicode 絵文字は制御文字だけを空白にし、ゼロ幅接合子は残す（`❤️‍🔥` を 1 つの絵文字のまま書く）。リアクションの無い発言には何も書かない | 投票（`formatPoll`）と同じく角括弧の 1 行にすると、本文と区別できる。カスタム絵文字の ID はモデルが読んでも意味が無い |
| bot が付けたリアクション | 数に含め、区別しない | 利用者が求めたのは種類と数である。bot が付けたかどうかは、`add_reaction` を呼んだ返答の文脈からモデルが分かる |
| bot の返答のリアクション | 返答の全ページのリアクションを絵文字ごとに合計する。カスタム絵文字は ID で、Unicode 絵文字は文字で同じ絵文字かを見分ける | 返答は複数のメッセージに分かれることがあり、利用者はどのページにも付けうる。モデルには返答が 1 件の発言として渡る（`normalizeBotReply`） |
| 並び順 | Discord が返す順のまま | 並べ替えても、モデルが読み取れる情報は増えない |

## Design

### 変更対象ファイル

- 修正: `src/utils/discordMessageNormalizer.ts` — `RawDiscordMessage` に `reactions` を足し、`NormalizedMessage` にリアクションの行（`formatReactions`）を持たせる。`messageBody` がその行を本文と投票の後ろに付け、本文が無い発言では「（本文なし）」の後ろに付ける。`formatMessageForTool` は `reactions` の項目として返す。REST の値は実行時に型が保証されないので、形の崩れた項目は読み飛ばす

- 修正: `src/bot/events/messageCreate.ts` — discord.js のメッセージから作る `toRawDiscordMessage` も、discord.js が持つ `reactions.cache` から同じ形を作る。`list_pins` はピン留めを discord.js で読んでこの関数を通すので、足さないとピン留めの発言だけリアクションが落ちる
- 修正: `src/services/chatService.ts` — 会話の発言を番号で指す指示（`buildConversationSafetyMessage()`）に、`[リアクション …]` の行は Discord が数えた反応で発言の本文ではなく、返答に自分で書かないことを足す。bot の過去の返答にもこの行が付くので、モデルがその形をまねて返答の末尾に書くのを防ぐ

### 設計メモ

リアクションの数が変わると、その発言より後ろのプロンプトのキャッシュが効かなくなる。
リアクションが付くのは返答の間隔に比べてまれなので、受け入れる。

返答するかの判定（`replyGateService.ts`）には渡さない。
判定は誰に向けた発言かで決まり、リアクションの数は判断材料にならない。

## Tasks

- [x] 正規化とモデル向けの書式（単体テスト: Unicode 絵文字、カスタム絵文字、複数種類、リアクションなし、bot の返答の複数ページの合計）
- [x] `read_earlier_messages` の結果に入ること（単体テスト）
- [x] `bun run e2e` の既定シナリオを通す
- [ ] 手動確認: 会話履歴を有効にしたチャンネルで、発言にリアクションを付けてから bot にその発言の反応を尋ね、種類と数を答えること
- [ ] `docs/changes/message-reactions/` 削除（リリース完了時、git 履歴がアーカイブ）
