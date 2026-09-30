---
title: "定期実行での Web 検索"
status: in-progress    # investigating | planned | in-progress | implemented
priority: medium       # high | medium | low
summary: "定期実行のジョブごとに Web 検索を使うかを選べるようにし、使うジョブは通常の返答と同じ回数の上限で検索して答える"
---

# 定期実行での Web 検索

## Why

定期実行のジョブは tool も Web 検索も使わずに LLM を呼ぶので、「毎朝その日のニュースをまとめて」「毎週月曜に新しいリリースを確認して」のような、実行時点の情報が要るジョブを作れない。
通常の返答では Web 検索を使えるので、同じ依頼を定期実行にしたときだけ答えの質が落ちる。

## 依存 / 関連 change

- 前提（実装済み）: [cron](https://github.com/AtefAndrus/disqord/blob/860bd5bdbc5aa78f2259aa35dec0f49f1d06af37/docs/changes/cron/design.md) — ジョブ、提案、確認カード、`/cron` パネル、`generateScheduledResponse`
- 前提（実装済み）: Web 検索（`src/llm/tools/webSearch.ts`）— `openrouter:web_search` の server tool、1 応答あたりの上限 `MAX_SEARCHES`、費用の説明 `describeSearchBilling`、検索結果のリンク `formatSearchResultLinks`

## Goals / Non-Goals

**Goals:**

- ジョブごとに Web 検索を使うかを持ち、確認カードと詳細画面で切り替えられるようにする
- 使うジョブは、実行時にギルドの Web 検索の設定も有効なら、通常の返答と同じ上限（`MAX_SEARCHES`）で検索させる
- 検索したジョブの投稿に、通常の返答と同じく検索結果のリンクを付ける
- 確認カードに、検索を使うことと、回数の上限と課金先、上限が効かない場合（`describeSearchBilling` の文面）を出す

**Non-Goals:**

- Web 検索以外の tool（会話履歴を読む tool、Discord 操作、コード実行）をジョブに渡すこと
- ジョブごとの検索回数の指定。上限は通常の返答と同じ `MAX_SEARCHES` に固定する
- ギルドの Web 検索の設定が無効なときに、ジョブの設定だけで検索すること

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 有効にする単位 | ジョブごとの `web_search` 列（既定 0）。実行時にギルドの Web 検索の設定（`web_search_enabled`）も有効なときだけ検索する | 検索が要るのは実行時点の情報を扱うジョブだけで、ほかのジョブに検索の費用を載せない。ギルドの設定を上位の許可にすると、管理者が Web 検索を切れば定期実行の検索もまとめて止まる |
| 検索回数の上限と費用の説明 | 通常の返答と同じ `buildWebSearchServerTool()` をそのまま使い、1 回の実行で最大 `MAX_SEARCHES` 回にする。確認カードには金額ではなく `describeSearchBilling()` の文面（回数の上限、課金先、上限が効かない場合）を出し、その説明を読んだうえでの承認を、検索の費用を受け入れる手続きとする | cron の design は、1 回の実行費用を登録時に見積もれないことを理由に Web 検索を外していた。エンジンが Perplexity などなら `max_uses` で回数の上限が効くが、`native` と `auto` では Anthropic 以外のモデルの native 検索に上限が効かない（OpenRouter の `WebSearchServerToolConfig`）。エンジンを絞ると運用者が選んだエンジンと通常の返答の挙動が食い違うので絞らず、代わりに上限が効かないことを承認の前に示す。検索を使うかはジョブごとの明示の選択で、既定は使わない |
| 切り替える場所 | 確認カードの「Web 検索: オン / オフ」ボタンと、詳細画面の同じボタン。modal には足さない | `/cron` の modal は既に 5 項目あり、Discord の modal は 5 項目までしか持てない。確認カードで切り替えれば、modal と tool のどちらの経路でも登録前に選べる |
| 提案の初期値 | 新規の提案（modal の追加、tool）は tool の引数、無ければ false。既存のジョブの編集の提案（modal の編集）は、`targetVersion` を照合した対象のジョブの `web_search` を引き継ぐ | modal に検索の項目が無いので、編集の提案を新規と同じ false で作ると、検索を使うジョブの名前を直しただけで検索が外れる |
| tool 経路 | `propose_cron_job` に任意の `web_search`（boolean、省略時 false）を足し、`CronProposalArgs`（`registry.ts`）、`cronToolContext.ts` の引数の受け渡し、`CronService.createProposal()` の保存まで通す。description の「no tools」を「Web 検索だけは、実行時点の情報が要るときに `web_search: true` で使える」に書き換える | 会話の中で「毎朝ニュースをまとめて」と頼まれたとき、モデルが検索の要否を判断できる。確認カードで人が見直せる |
| 確認カードのボタンの権限と照合 | 承認と同じく、提案者本人で `canManageGuildSettings` を満たすメンバーだけが押せる。「Web 検索」ボタンと「登録する」ボタンの custom_id に、カードを描いた時点の `web_search` の値を入れる。反転は、DB の値が custom_id の値と同じときだけ条件付きの UPDATE で行う。値を含まない旧形式の承認の custom_id（`cron:proposal:approve:<id>`）が押されたら登録せず、今の値と費用の説明を載せた新形式のカードに描き直して押し直しを求める。承認は、repository が提案を読み直して書き込む同じトランザクションの中で、提案の `web_search` が custom_id の値と同じことを確かめ、違えば登録せずにカードを今の値で描き直して押し直しを求める。承認後のカードは、登録したジョブの値から描く | 検索を有効にすると費用が増えるので、承認と同じ権限にそろえる。承認は配信先の REST の解決を待ってから書き込むので、その間に反転されると、押したカードと違う設定で登録されうる。表示した値で照合すれば、人が見て承認した内容だけが登録される |
| 詳細画面のボタン | 編集と同じ権限と `version` の照合を通し、`version` を 1 上げる。切り替えのボタンは、編集と同じく `active` と `paused` のジョブにだけ出す（`done` のジョブは内容を変えない）。オフにするのは 1 回の操作で行う。オンにするのは削除と同じ 2 段階にし、「Web 検索をオンにする」を押すと、詳細画面に `describeSearchBilling()` の文面と「Web 検索をオンにする（確定）」ボタンを出し、確定を押したときだけオンにする | 実行中にオフにしたら、その実行の投稿を止める既存の仕組み（`version` の照合）がそのまま効く。登録済みのジョブで検索を有効にする経路にも、確認カードと同じく費用の説明を読んでから承認する手続きを通す。オフは費用を減らすだけなので確認を挟まない |
| LLM の呼び出し | `generateScheduledResponse` は非ストリームの `chat()` のまま、request に `tools: [buildWebSearchServerTool(engine)]` を足す。`chat()` は、応答の `output` から `openrouter:web_search` の項目（`action.query` と `action.sources`）と、メッセージの `url_citation` の注釈を読み、ストリームと同じ `WebSearchTrace` を返す | 定期実行に tool loop と Discord の返答ページの更新は要らない。検索は OpenRouter のサーバー側で完結する server tool なので、非ストリームでも 1 回のリクエストで済む。非ストリームの応答がストリームと同じ型名の項目と注釈を持つことは、2026-09-30 に `google/gemini-3.8-flash` と Perplexity で確かめた |
| system message | 検索するときは、通常の返答と同じく `buildWebSearchStaticSystemMessage()` と、検索ありの文面の現在日時（`buildDateTimeSystemMessage(now, true)`）を送る | 検索結果を学習時点より新しいという理由で疑わせない（`buildDateTimeSystemMessage` のコメントの計測）。通常の返答と同じ文面にすれば、同じ依頼の答えがそろう |
| 検索の失敗 | 検索の失敗で応答が失敗したら、同じ実行の中で 1 回だけ検索なしで呼び直し、投稿に「Web 検索に失敗したため検索なしで答えた」旨を添える。呼び直しでは、server tool と `buildWebSearchStaticSystemMessage()` を外し、現在日時の system message を検索なしの文面（`buildDateTimeSystemMessage(now, false)`）で組み直す | 通常の返答（`chatService.ts` の `dropWebSearch`）と同じ扱いにする。無人の実行なので、検索の失敗だけでジョブの連続失敗を数えない |
| ギルドの設定が無効なとき | 検索なしで実行し、失敗にはしない。詳細画面には「Web 検索: オン（ギルドの設定が無効のため使われない）」と出す | 管理者が Web 検索を切ったことで、定期実行が連続失敗で停止しないようにする |
| 検索結果のリンクと注記の位置 | 検索なしで答え直したときの注記は、先頭ページのジョブ名の見出しの直後に置く。検索したときの `formatSearchResultLinks()` の一覧は、本文と別に最終ページの末尾に置き、`buildScheduledPages()` は本文を分割するときにその分の文字数とバイト数を最終ページから差し引く。5 ページを超える本文は既存どおり省略の注記で切り、リンクは切らない | 配信は先頭ページから順に送り、後のページの送信の失敗や `version` の変更で途中で打ち切る（`cronService.ts` の配信）。注記は、検索を使っていない答えだと読み手に伝えるためのもので、先頭ページにあれば打ち切られても必ず届く。リンクは本文の出典なので、本文が最後まで届いたときだけ意味を持つ。`buildScheduledPages()` は分割後の先頭 5 ページだけを残すので、本文の後ろに付けるだけだと、長い本文でリンクが捨てられる |

## Design

### 変更対象ファイル

- 修正: `src/db/schema.ts` — `cron_jobs` と `cron_proposals` に `web_search INTEGER NOT NULL DEFAULT 0` を足す（列の有無を見て `ALTER TABLE`）
- 修正: `src/db/repositories/cronRepository.ts` — `webSearch` の読み書き、承認時の提案からジョブへの受け渡し、提案とジョブの `webSearch` の反転
- 修正: `src/llm/openrouter.ts` — 非ストリームの `chat()` で `openrouter:web_search` の項目と `url_citation` を読み、`WebSearchTrace` を返す。検索の失敗を `WebSearchFailedError` にする
- 修正: `src/services/chatService.ts` — `generateScheduledResponse` で、ジョブとギルドの両方が有効なら server tool と検索用の system message を足し、検索の失敗で 1 回だけ検索なしで呼び直す。結果に `webSearch` と `webSearchSkipped` を返す
- 修正: `src/services/cronService.ts` — 提案の保存と編集の提案の初期値、`buildScheduledPages()` のリンクと注記の領域、承認の照合
- 修正: `src/utils/cronPanel.ts` — 確認カードと詳細画面に「Web 検索」の表示とボタン、確認カードに `describeSearchBilling` の文面
- 修正: `src/bot/events/cronPanelHandler.ts` — 新しいボタンの custom_id の処理
- 修正: `src/llm/tools/proposeCronJob.ts` — `web_search` 引数と description
- 修正: `src/llm/tools/registry.ts` — `CronProposalArgs` に `webSearch`
- 修正: `src/services/cronToolContext.ts` — `web_search` を提案まで渡す
- 修正: `scripts/e2e/scenarios.ts` と `scripts/e2e/cron.ts` — `cron-search` シナリオ。確認カードの判定（`APPROVE_ID` と `isProposalCard()`）を、検索の値を含む新しい承認の custom_id に合わせる
- テスト: 各修正の単体テスト

### DBスキーマ変更

`cron_jobs` と `cron_proposals` に `web_search INTEGER NOT NULL DEFAULT 0` を足す。
既存のジョブと提案は 0（検索しない）になるので、動作は変わらない。

### 実装内容

- 確認カードは、`web_search` が 1 のとき「**Web 検索:** 使う」の行と、その下に `describeSearchBilling(engine)` の文面の行を出す。文面自体が括弧を含むので、状態の行とは分ける。ギルドの設定が無効なら、状態の行に「（ギルドの設定が無効のため使われない）」を添える。
- 詳細画面のボタンの並びは「編集」「Web 検索をオンにする / オフにする」「今すぐ実行」「停止 / 再開」「削除」「一覧へ戻る」とする。Discord の 1 行 5 ボタンに収まらないので複数行にする。
- 「今すぐ実行」もジョブの `web_search` に従う。

### e2e

`bun run e2e cron-search` を名前を指定したときだけ走らせ、定期実行と Web 検索の両方が有効なギルドを要件にする。
スクリプトが DB に `web_search = 1` の 1 回限りのジョブを直接挿入し、投稿に検索結果のリンク（`-# 検索結果`）が付くことを確かめてから、ジョブを消す。
プロンプトは `search` シナリオと同じく、過去の決まった出来事の日付を尋ねる。

## Tasks

- [x] 非ストリームの `chat()` で検索の記録と失敗を読む
- [x] `web_search` 列、repository、提案とジョブの受け渡し
- [x] `generateScheduledResponse` の検索と、検索なしでの呼び直し
- [x] 投稿のリンクと、確認カードと詳細画面の表示とボタン
- [x] `propose_cron_job` の `web_search`
- [x] 単体テスト: ジョブの `web_search` とギルドの `web_search_enabled` の 4 通りの組のうち、両方が有効なときだけ server tool と検索の system message を送ること、非ストリームの検索の失敗が HTTP のエラーでも HTTP 200 の `status: "failed"` でも `WebSearchFailedError` になること、検索なしの呼び直しが成功したら連続失敗の数を 0 に戻すこと、呼び直しも失敗したら 1 回だけ数えること、ギルドの設定が無効でも検索以外の失敗は数えること、`[SILENT]` の応答は検索の記録や注記があっても投稿せずに成功とすること、呼び直しの間にジョブが編集されたら古い `version` の投稿と結果を保存しないこと、「今すぐ実行」が実行の記録を変えないこと、無料モデル限定のギルドで検索を使うジョブも同じ確認を通ること、`web_search` 列の追加が既存の DB で動き再実行しても壊れないこと、tool の `web_search: true` が提案に保存されること、編集の提案がジョブの値を引き継ぎ反転しなければ承認後も保つこと、反転と承認が競合したときに表示と違う値で登録しないこと、長い本文でもリンクが最終ページに残ること、検索なしで答えた注記が先頭ページにあり 2 ページ目の送信の失敗やページの間の `version` の変更でも残ること、呼び直しのリクエストが server tool と検索の system message を持たず日時の文面が検索なしのものであること、`done` のジョブに切り替えのボタンが出ず更新も断ること、詳細画面でオンにするときに確定の前は値が変わらず費用の説明が出ること、旧形式の承認の custom_id では登録せずにカードを描き直すこと、e2e の確認カードの判定が新しい custom_id を認識すること
- [ ] e2e シナリオ `cron-search` を足し、確認カードの判定を新しい custom_id に合わせ、AGENTS.md の End-to-end 節に実行条件を書く。`bun run e2e`、`bun run e2e search`、`bun run e2e cron`、`bun run e2e cron-search` を実行し、結果を PR に書く
- [ ] 手動確認: 確認カードと詳細画面で「Web 検索」ボタンを押し、表示と保存された値が切り替わること、詳細画面のボタンが 1 行 5 個以内で複数行に並ぶことを確かめる
- [ ] `docs/changes/cron-web-search/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **非ストリームでの検索の失敗（未検証）**: ストリームでは、検索の失敗を `Server tool "openrouter:web_search" failed` で始まるエラーのイベントから `WebSearchFailedError` にしている（`openrouter.ts` の `throwForStreamErrorPayload`）。非ストリームで同じ失敗が HTTP 200 の `status: "failed"` と HTTP のエラーのどちらで返るかは確かめていない。実装では両方の経路で同じ文面を見て `WebSearchFailedError` にし、どちらかが違う形なら、検索なしの呼び直しが働かずにその実行が失敗として数えられる。
- **native 検索の費用**: エンジンが `native` か `auto` のとき、Anthropic 以外のモデルでは `max_uses` が効かず、1 回の実行の検索の費用に上限が無い。確認カードでそのことを示すが、無人で繰り返す実行の費用を bot 側では止められない。
