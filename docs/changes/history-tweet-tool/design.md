---
title: "会話履歴のツイートを読む tool"
status: in-progress
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
- 関連: [返答中の発言番号をメッセージリンクにする](https://github.com/AtefAndrus/disqord/blob/c0cec01239f7e4eb45a7553ee58b5a24efcd9bca/docs/changes/message-ref-links/design.md) — どちらも会話履歴の発言番号（`m<N>`）を使う。互いに依存しない。

## Goals / Non-Goals

**Goals:**

- 会話履歴とツイート展開が有効で、モデルが tool に対応するとき、client tool `read_x_post` をモデルに渡す。
- `read_x_post` は発言番号と、その発言の何番目のポストかを受け取り、そのポスト 1 件を、自動展開と同じ `<untrusted-tweet>` のテキストと画像で返す。
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
| 引数 | 発言番号 `message_ref`（`^m[0-9]+$`）と、その発言の本文に現れる順の何番目のポストかを表す `post_index`（1 から。省略すると 1）。同じポスト ID へのリンクが複数あれば最初の 1 つだけを数え（`extractTweetUrls()` の重複除去、`src/services/tweetService.ts:133-139`）、引数の説明にもそう書く | `view_attachment` の発言番号と添付番号と同じ指し方である（`src/llm/tools/viewAttachment.ts:17-25`）。URL を引数にすると、モデルに示していないポストを取得でき、発言の削除を確かめる経路からも外れる |
| 1 回に返す量 | 1 回の呼び出しで 1 ポストだけを返す。結果には「この発言のポスト: N 件中 K 件目」を添え、同じ発言に他のポストがあることをモデルに伝える | 結果の大きさがポスト 1 件分に決まるので、予算の確認は `view_attachment` と同じく結果全体で 1 回で済み、複数のポストの一部だけを渡したときの記録が要らない |
| 対象にできる発言 | `resolveMessageRef()` と同じ範囲（会話の窓、返信先、`read_earlier_messages` の結果、ピン留め） | 窓の外から読んだ古い発言のポストも読めるようにする。範囲を揃えると、モデルから見た番号の意味が tool ごとに変わらない |
| 発言の本文と削除 | ポストの URL は、モデルに示した時点の発言の本文から取り出す。Discord から発言を取り直すことも、取得の直前に履歴の閲覧権限を確かめ直すこともしない。返答中に削除が分かった発言（`externalDeletions`）は、取得の前と後の両方で確かめ、どちらかで分かれば `{"error":"message_unavailable"}` を返す | 取得するのは X の公開ポストで、Discord のデータではなく、URL はすでにモデルの入力に入っている。`view_attachment` が取得の直前に権限を確かめ直して発言を取り直すのは（`src/services/conversationWindow.ts:1445`、`:1492`）、添付ファイルが Discord から新しく取り出すデータだからであり、この tool には当てはまらない。編集後の本文ではなく示した本文を使うのは、モデルが見た番号と内容を一致させるためである。削除が分かった発言を断るのは、削除された発言を起点に新しい内容を入力へ足さないためで、取得中に削除が分かる場合に備えて後でも確かめる（`view_attachment` も取得の後で確かめている、`:1431`） |
| 返す内容 | 1 ポストを取得して `<untrusted-tweet>` に整形する処理を `TweetService` に公開し、その結果を Responses API の content part（`input_text` と `input_image`）に変換して返す。画像は、モデルが画像入力に対応すると判定できたときだけ付ける | 自動展開と同じ取得、整形、画像判定を使い、ポストがどちらの経路で届いてもモデルから同じ形に見えるようにする |
| 件数の上限 | tool で読むポストと画像には、返答あたりの件数の上限を設けない。発言から取り出すポスト ID も、自動展開の 1 発言 3 件（`MAX_TWEETS_PER_MESSAGE`）で打ち切らずにすべて番号の対象にする。1 ポストに付ける画像は自動展開と同じ 4 枚（`MAX_TWEET_IMAGES`）までとする | 量は結果の予算で抑えられる。画像は 1 枚 1,600 トークンという多めの見積もりで数えられ（`src/llm/contextBudget.ts:27`）、収まらなければ `result_budget_exhausted` になる。呼び出しの回数も tool loop の上限（`MAX_TURNS` 5 のうち tool を呼べるのは 4 ターン、1 ターンに `MAX_TOOL_CALLS_PER_TURN` 8 件、`src/llm/toolLoop.ts:135-136`）で返答あたり 32 回までに収まる。自動展開の上限は残す。自動展開はモデルへの最初の入力に入り、tool の結果の予算を通らないからである |
| ポストの状態 | 返答ごとに、ポスト ID ごとの結果を 1 つ持つ: 渡した、取得に失敗した、予算に収まらなかった。渡したポストには `{"status":"already_loaded"}`、取得に失敗したポストには `{"error":"x_post_unavailable"}`、予算に収まらなかったポストには `{"error":"result_budget_exhausted"}` を返し、どれもその返答の中では取得し直さない | `already_loaded` を、モデルが実際に内容を受け取ったポストだけに使い、取れなかった理由をモデルに正しく伝える。結果の予算は 1 件の返答の中で消費されて減る一方なので（`src/llm/toolLoop.ts:193-202`、`:1011-1019`）、収まらなかったポストを取り直しても同じく収まらない |
| 結果の予算 | 返す content part 全体（ポストのテキスト、画像、「N 件中 K 件目」の一文）を `estimateToolResultTokens()` で見積もり、`resultBudgetTokens` に収まるときだけ返して状態を確定する。決まった形の status と error の文字列は、`view_attachment` と同じく `terminal: true` で返す（`src/llm/tools/viewAttachment.ts:69`） | `resultBudgetTokens` の契約は、結果が予算に収まると確かめてから状態を確定することを求めており（`src/llm/tools/registry.ts:93`）、超えた結果は全体が `result_too_large` に置き換わって以後の client tool も止まる（`src/llm/tools/toolHandler.ts:406`、`:421`、`src/llm/toolLoop.ts:1020`）。`terminal` の付いた短い固定の結果だけはこの確認を免除されるので（`src/llm/tools/toolHandler.ts:408`、`:435`）、予算が残り少ないときもエラーがモデルに届き、以後の tool も止まらない |
| 自動展開済みのポスト | 同じ返答で自動展開がモデルに渡したポスト ID は、渡したポストとして扱う。`expandTweets()` の結果に、渡したポストの ID の一覧を足す | 返信先のポストを tool でもう一度読むと、同じ内容が入力に二重に入る。今の結果（`TweetExpansionResult`、`src/services/tweetService.ts:42`）には、取得に成功した ID の一覧が無い |
| 再試行との関係 | `TweetToolContext` の呼び出しも、他の client tool と同じく `clientToolInvoked` を立てる | `generateChatResponse()` は、何も表示しておらず client tool も呼んでいない失敗に限って、Web 検索や自動展開の画像を外して答え直す（`src/services/chatService.ts:504-566`）。tool を呼んだ後の答え直しは、tool の取得を繰り返すことになるので、他の tool と同じ条件に揃える |
| 有効になる条件 | `toolsAllowed` で、会話履歴の文脈があり、ギルド設定のツイート展開が有効なとき | ツイート展開を無効にしたギルドでは、ポスト ID を fxtwitter のホストへ送らない（README のツイート展開の説明） |
| 非信頼データの指示 | ツイート展開の system メッセージ（`buildTweetSystemMessage()`）を、tool を渡すときは先頭側の system メッセージに置き、自動展開した場合の後方の同じメッセージは省く | tool の結果にも `<untrusted-tweet>` が入るため、tool を呼ぶ前から指示が要る。先頭側は返答ごとに変わらないメッセージを置く場所で（`src/services/chatService.ts:404-412`）、tool を渡すかどうかはギルド設定とモデルで決まる |
| tool 名と説明 | `read_x_post`。説明は「Read one X (Twitter) post linked in a message already shown in this response.」 | 既存の tool と同じく、英語の短い説明にする |

## Design

### 変更対象ファイル

- 新規: `src/llm/tools/readXPost.ts` — tool の定義、引数の検証、呼び出し。
- 修正: `src/llm/tools/registry.ts` — `IToolContext` に `tweets?: TweetToolContext` を足す。`TweetToolContext` は `readPost(messageRef, postIndex, signal, budgetTokens)` を持つ。
- 修正: `src/services/tweetService.ts` — 1 ポストの取得と整形を公開する。`expandTweets()` の結果に、渡したポストの ID の一覧を足す。
- 修正: `src/services/conversationWindow.ts` — `ConversationToolContext` に、番号から示した発言の本文を返す操作を足す。結果は「本文」「示していない番号」「削除された発言」のいずれかとする。
- 修正: `src/services/chatService.ts` — ツイート展開が有効なときに `TweetToolContext` を組み立てて `runToolLoop()` の `ctx` に渡す。自動展開したポスト ID を渡して重複を避け、system メッセージの置き場所を変える。
- 修正: `src/index.ts` — tool を登録する。
- 修正: `README.md` — ツイート展開の説明に、履歴の発言のポストはモデルが必要に応じて読むことを足す。
- 修正: `scripts/e2e/scenarios.ts`、`AGENTS.md` — e2e のシナリオを足し、その実行条件を書く。

### 実装内容

`readPost()` は次の順に処理する。

1. 番号から、示した時点の発言の本文を引く。示していない番号なら `{"error":"message_ref_not_shown"}`、削除が分かった発言なら `{"error":"message_unavailable"}` を返す。
2. 本文から `extractTweetIds()` で ID を取り出す。1 つも無ければ `{"error":"no_x_post"}`、`post_index` が件数を超えれば `{"error":"post_index_out_of_range"}` を返す。
3. 指定のポスト ID に記録した結果があれば、その結果に対応する応答（ポストの状態の行）を返す。
4. ポストを 1 件取得する。取得には、自動展開と同じ締め切り（`TWEET_FETCH_DEADLINE_MS`）と、全リクエストで共有する同時実行数の制限（`TweetRequestLimiter`）を使う。結果は、この呼び出しの中だけの変数に持ち、まだ返答の状態には記録しない。
5. 取得の後で、発言の削除が分かっていないかを確かめ直す。分かっていれば何も記録せずに `{"error":"message_unavailable"}` を返す。同じポストが削除されていない別の発言にもあれば、そちらからは後で取得できる。
6. 取得に失敗していれば、取得に失敗したと記録して `{"error":"x_post_unavailable"}` を返す。取得できていれば content part 全体を見積もり、予算を超えれば、予算に収まらなかったと記録して `{"error":"result_budget_exhausted"}` を返す。収まれば、渡したと記録して返す。

## Tasks

- [x] `read_x_post` と `TweetToolContext`、`ConversationToolContext` の追加
- [x] `chatService.ts` の配線（有効条件、自動展開済み ID、system メッセージ）
- [x] 単体テスト: 有効条件、示していない番号、削除された発言（取得の前と後）、ポストの無い発言、範囲外の `post_index`、同じポストを別のホストの URL で 2 回貼った発言での `post_index`、予算がエラー文字列より小さいときのエラー応答、自動展開済み、取得の失敗と予算超過それぞれの記録と再呼び出しへの応答、削除された発言と削除されていない発言が同じポストを含む場合、ポストが 4 件以上ある発言の 4 件目、画像非対応モデル、`clientToolInvoked` が立つこと
- [x] e2e シナリオ: tester bot がメンションなしでポストの URL を投稿し、別の発言で「さっきのポストを要約して」と頼み、`read_x_post` の呼び出しと、返答がポストの内容に触れていることを確かめる
- [ ] e2e: 既定シナリオ、`tweet`、`bot-reply-tweet`、AGENTS.md が会話履歴の変更に求める `history-set history-recall history-window read-earlier view-attachment view-image`
- [x] README と AGENTS.md の更新
- [ ] `docs/changes/history-tweet-tool/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- tool の結果に入れた画像を受け取らずに捨てるモデルがある（`view-image` シナリオのコメントに観測したモデルが並んでいる）。テキストは届くので、画像だけが欠けることになる。
- tool の結果の画像をプロバイダが拒否すると、その返答はエラーで終わる。自動展開の画像を外して答え直す処理は、tool を呼んだ後には働かない（上の「再試行との関係」）。
- どの発言のポストを指すかが質問から決まらないとき、tool はその曖昧さを解消しない。モデルが候補を選び違える場合に、利用者へ確かめるよう指示するかは、e2e と運用での観測を見て判断する。
- モデルが tool を呼ばずに「開けない」と答える可能性がある。e2e で呼び出しを確かめ、呼ばないモデルが多ければ、会話履歴の安全指示に「X のポストの URL は `read_x_post` で読める」と一文足すかを判断する。
