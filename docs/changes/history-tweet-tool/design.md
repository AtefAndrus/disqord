---
title: "会話履歴のツイートを読む tool"
status: planned
priority: medium
summary: "会話履歴の発言に貼られた X のポストを、モデルが発言番号を指定して読む client tool `read_x_post` を足す"
---

# 会話履歴のツイートを読む tool

## Why

ツイート展開は、呼びかけ本文と返信先の本文に含まれる X のポストの URL だけを取得する（`src/services/chatService.ts:377`）。
そのため、少し前の別の発言に貼られたポストについて「ファクトチェックして」とだけ頼まれると、モデルには URL の文字列しか渡らず、中身を読めないまま答えることになる。
質問がどの発言のポストを指しているかは文面から決まらないことが多いので、モデルが発言を選んでポストを読めるようにする。

## 依存 / 関連 change

- 関連: [Web 検索 + ツイート展開](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/web-search/design.md) — 呼びかけ本文の URL を client tool にせず必ず展開する判断と、`<untrusted-tweet>` の整形、画像の扱い、取得の上限はここで決めた。本 change はその自動展開を変えず、届かなかった履歴の分を tool で補う。
- 関連: [返答中の発言番号をメッセージリンクにする](../message-ref-links/design.md) — どちらも会話履歴の発言番号（`m<N>`）を使う。互いに依存しない。

## Goals / Non-Goals

**Goals:**

- 会話履歴とツイート展開が有効で、モデルが tool に対応するとき、client tool `read_x_post` をモデルに渡す。
- `read_x_post` は発言番号を 1 つ受け取り、その発言の本文にある X のポストを、自動展開と同じ `<untrusted-tweet>` のテキストと画像で返す。
- 対象の発言は、その返答でモデルに示した発言すべてとする（会話の窓、返信先、`read_earlier_messages` で読んだ発言、ピン留め）。

**Non-Goals:**

- 呼びかけ本文と返信先の自動展開の変更。今のまま、tool に対応しないモデルでも展開する。
- tool に対応しないモデルで履歴のポストを読むこと。そのモデルには、今と同じく URL の文字列だけが渡る。
- 発言番号を介さず、任意の URL やポスト ID を指定して取得すること。
- 人間の発言に付いた埋め込み（embed）のテキストを会話履歴に入れること。人間の発言の履歴テキストは本文だけで作っている（`src/utils/discordMessageNormalizer.ts:281-292`）。fixupx のリンクに付く埋め込みにはポストの本文と引用元が Markdown で入るが（2026-10-15 に REST で取得した例では 679 文字）、窓の全発言の埋め込みを入れると、自動展開と同じく無関係なポストの分まで入力が増える。同じポストが埋め込みの Markdown と `<untrusted-tweet>` の 2 つの形で届くことにもなる。

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 起動の仕方 | 履歴のポストは自動展開せず、モデルが呼ぶ client tool にする | 会話の窓には最大 40 件の発言が入り（`src/services/conversationWindow.ts:41`）、質問がどのポストを指すかは文面から決まらない。窓の中のポストをすべて展開すると、無関係なポストのために fxtwitter への問い合わせと入力トークンが返答ごとに増える。直前の 1 件だけを展開する案は、指している発言が直前でないときに別のポストを読ませる。呼びかけ本文の URL を必ず展開する判断（関連 change）は、URL を貼った時点で読ませたいという意図が明らかな場合のもので、履歴の URL には当てはまらない |
| 引数 | 発言番号 `message_ref`（`^m[0-9]+$`）だけ | `view_attachment` と同じ指し方である（`src/llm/tools/viewAttachment.ts:17-25`）。URL を引数にすると、モデルに示していないポストを取得でき、発言の削除を確かめる経路からも外れる |
| 対象にできる発言 | `resolveMessageRef()` と同じ範囲（会話の窓、返信先、`read_earlier_messages` の結果、ピン留め） | 窓の外から読んだ古い発言のポストも読めるようにする。範囲を揃えると、モデルから見た番号の意味が tool ごとに変わらない |
| 削除された発言 | 返答中に削除が分かった発言（`externalDeletions`）は `{"error":"message_unavailable"}` を返す | `view_attachment` と同じ扱いである（`src/services/conversationWindow.ts:1416-1420`）。削除された発言の内容を tool 経由で読めないようにする |
| 返す内容 | `TweetService.expandTweets()` の結果を Responses API の content part（`input_text` と `input_image`）に変換して返す。画像は、モデルが画像入力に対応すると判定できたときだけ付ける | 自動展開と同じ整形と同じ画像判定を使い、ポストがどちらの経路で届いてもモデルから同じ形に見えるようにする |
| 上限 | 1 回の呼び出しで 1 発言とし、その発言から最大 3 投稿（`MAX_TWEETS_PER_MESSAGE`）を取得する。1 件の返答で tool から取得するのは合計 3 投稿、画像 4 枚まで | 自動展開の上限と同じ値にする。tool の結果は `resultBudgetTokens` の予算にも従う |
| 自動展開済みのポスト | 同じ返答で自動展開したポスト ID は取得せず、その分は `{"status":"already_loaded"}` にする | 返信先のポストを tool でもう一度読むと、同じ内容が入力に二重に入る |
| 有効になる条件 | `toolsAllowed` で、会話履歴の文脈があり、ギルド設定のツイート展開が有効なとき | ツイート展開を無効にしたギルドでは、ポスト ID を fxtwitter のホストへ送らない（README のツイート展開の説明） |
| 非信頼データの指示 | ツイート展開の system メッセージ（`buildTweetSystemMessage()`）を、tool を渡すときは先頭側の system メッセージに置き、自動展開した場合の後方の同じメッセージは省く | tool の結果にも `<untrusted-tweet>` が入るため、tool を呼ぶ前から指示が要る。先頭側は返答ごとに変わらないメッセージを置く場所で（`src/services/chatService.ts:404-412`）、tool を渡すかどうかはギルド設定とモデルで決まる |
| tool 名と説明 | `read_x_post`。説明は「Read the X (Twitter) posts linked in a message already shown in this response.」 | 既存の tool と同じく、英語の短い説明にする |

## Design

### 変更対象ファイル

- 新規: `src/llm/tools/readXPost.ts` — tool の定義、引数の検証、呼び出し。
- 修正: `src/llm/tools/registry.ts` — `IToolContext` に `tweets?: TweetToolContext` を足す。`TweetToolContext` は `readPosts(messageRef, signal, budgetTokens)` を持つ。
- 修正: `src/services/conversationWindow.ts` — `ConversationToolContext` に、番号から示した発言の本文を返す操作を足す。結果は「本文」「示していない番号」「削除された発言」のいずれかとする。
- 修正: `src/services/chatService.ts` — ツイート展開が有効なときに `TweetToolContext` を組み立てて `runToolLoop()` の `ctx` に渡す。自動展開したポスト ID を渡して重複を避け、system メッセージの置き場所を変える。
- 修正: `src/index.ts` — tool を登録する。
- 修正: `README.md` — ツイート展開の説明に、履歴の発言のポストはモデルが必要に応じて読むことを足す。
- 修正: `scripts/e2e/scenarios.ts`、`AGENTS.md` — e2e のシナリオを足し、その実行条件を書く。

### 実装内容

`readPosts()` は次の順に処理する。

1. 番号から発言の本文を引く。示していない番号なら `{"error":"message_ref_not_shown"}`、削除された発言なら `{"error":"message_unavailable"}` を返す。
2. 本文から `extractTweetIds()` で ID を取り出し、自動展開済みの ID と、この返答で tool がすでに取得した ID を除く。残りが無ければ、本文にポストが無いときは `{"error":"no_x_post"}`、すべて取得済みなら `{"status":"already_loaded"}` を返す。
3. 返答あたりの残り投稿数と残り画像枚数の範囲で `expandTweets()` を呼ぶ。取得に失敗したポストは自動展開と同じく結果から落とし、1 件も取れなければ `{"error":"x_post_unavailable"}` を返す。
4. 結果を content part に変換し、`resultBudgetTokens` に収まらなければ `{"error":"result_budget_exhausted"}` を返す。

`expandTweets()` は今、上限の 3 投稿と 4 画像を自分で数えている。返答全体で数えるために、残り数を引数で渡せるようにする。

## Tasks

- [ ] `read_x_post` と `TweetToolContext`、`ConversationToolContext` の追加
- [ ] `chatService.ts` の配線（有効条件、自動展開済み ID、system メッセージ）
- [ ] 単体テスト: 有効条件、示していない番号、削除された発言、ポストの無い発言、自動展開済み、返答あたりの上限、画像非対応モデル、結果の予算超過
- [ ] e2e シナリオ: tester bot がメンションなしでポストの URL を投稿し、別の発言で「さっきのポストを要約して」と頼み、`read_x_post` の呼び出しと、返答がポストの内容に触れていることを確かめる
- [ ] README と AGENTS.md の更新
- [ ] `docs/changes/history-tweet-tool/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- tool の結果に入れた画像を受け取らずに捨てるモデルがある（`view-image` シナリオのコメントに観測したモデルが並んでいる）。テキストは届くので、画像だけが欠けることになる。
- モデルが tool を呼ばずに「開けない」と答える可能性がある。e2e で呼び出しを確かめ、呼ばないモデルが多ければ、会話履歴の安全指示に「X のポストの URL は `read_x_post` で読める」と一文足すかを判断する。
