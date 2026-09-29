---
title: "定期実行での Web 検索"
status: investigating  # investigating | planned | in-progress | implemented
priority: medium       # high | medium | low
summary: "定期実行のジョブごとに Web 検索を使うかを選べるようにし、使うジョブは通常の返答と同じ回数の上限で検索して答える"
---

# 定期実行での Web 検索

## Why

定期実行のジョブは tool も Web 検索も使わずに LLM を呼ぶので、「毎朝その日のニュースをまとめて」「毎週月曜に新しいリリースを確認して」のような、実行時点の情報が要るジョブを作れない。
通常の返答では Web 検索を使えるので、同じ依頼を定期実行にしたときだけ答えの質が落ちる。

## 依存 / 関連 change

- 前提: [cron](../cron/design.md) — ジョブ、提案、確認カード、`/cron` パネル、`generateScheduledResponse`
- 前提（実装済み）: Web 検索（`src/llm/tools/webSearch.ts`）— `openrouter:web_search` の server tool、1 応答あたりの上限 `MAX_SEARCHES`、費用の説明 `describeSearchBilling`、検索結果のリンク `formatSearchResultLinks`

## Goals / Non-Goals

**Goals:**

- ジョブごとに Web 検索を使うかを持ち、確認カードと詳細画面で切り替えられるようにする
- 使うジョブは、実行時にギルドの Web 検索の設定も有効なら、通常の返答と同じ上限（`MAX_SEARCHES`）で検索させる
- 検索したジョブの投稿に、通常の返答と同じく検索結果のリンクを付ける
- 確認カードに、検索を使うことと、その上限と課金先（`describeSearchBilling` の文面）を出す

**Non-Goals:**

- Web 検索以外の tool（会話履歴を読む tool、Discord 操作、コード実行）をジョブに渡すこと
- ジョブごとの検索回数の指定。上限は通常の返答と同じ `MAX_SEARCHES` に固定する
- ギルドの Web 検索の設定が無効なときに、ジョブの設定だけで検索すること

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 有効にする単位 | ジョブごとの `web_search` 列（既定 0）。実行時にギルドの Web 検索の設定（`web_search_enabled`）も有効なときだけ検索する | 検索が要るのは実行時点の情報を扱うジョブだけで、ほかのジョブに検索の費用を載せない。ギルドの設定を上位の許可にすると、管理者が Web 検索を切れば定期実行の検索もまとめて止まる |
| 検索回数の上限 | 通常の返答と同じ `buildWebSearchServerTool()` をそのまま使い、1 回の実行で最大 `MAX_SEARCHES` 回にする | 上限があるので、1 回の実行の検索費用の上限が決まり、確認カードで示せる。これが cron の design で Web 検索を外していた理由（1 回の実行費用を登録時に見積もれない）を解消する |
| 切り替える場所 | 確認カードの「Web 検索: オン / オフ」ボタンと、詳細画面の同じボタン。modal には足さない | `/cron` の modal は既に 5 項目あり、Discord の modal は 5 項目までしか持てない。確認カードで切り替えれば、modal と tool のどちらの経路でも登録前に選べる |
| tool 経路 | `propose_cron_job` に任意の `web_search`（boolean）を足す。description に「実行時点の情報が要るときだけ true にする」と書く | 会話の中で「毎朝ニュースをまとめて」と頼まれたとき、モデルが検索の要否を判断できる。確認カードで人が見直せる |
| 確認カードのボタンの権限 | 承認と同じく、提案者本人で `canManageGuildSettings` を満たすメンバーだけが押せる。押すと提案の `web_search` を反転し、カードを描き直す | 検索を有効にすると費用が増えるので、承認と同じ権限にそろえる |
| 詳細画面のボタン | 編集と同じ権限と `version` の照合を通し、`version` を 1 上げる | 実行中にオフにしたら、その実行の投稿を止める既存の仕組み（`version` の照合）がそのまま効く |
| LLM の呼び出し | `generateScheduledResponse` は非ストリームの `chat()` のまま、request に `tools: [buildWebSearchServerTool(engine)]` を足す。`chat()` は、応答の `output` から `openrouter:web_search` の項目（`action.query` と `action.sources`）と、メッセージの `url_citation` の注釈を読み、ストリームと同じ `WebSearchTrace` を返す | 定期実行に tool loop と Discord の返答ページの更新は要らない。検索は OpenRouter のサーバー側で完結する server tool なので、非ストリームでも 1 回のリクエストで済む。非ストリームの応答がストリームと同じ型名の項目と注釈を持つことは、2026-09-30 に `google/gemini-3.8-flash` と Perplexity で確かめた |
| system message | 検索するときは、通常の返答と同じく `buildWebSearchStaticSystemMessage()` と、検索ありの文面の現在日時（`buildDateTimeSystemMessage(now, true)`）を送る | 検索結果を学習時点より新しいという理由で疑わせない（`buildDateTimeSystemMessage` のコメントの計測）。通常の返答と同じ文面にすれば、同じ依頼の答えがそろう |
| 検索の失敗 | 検索の失敗で応答が失敗したら、同じ実行の中で 1 回だけ検索なしで呼び直し、投稿の末尾に「Web 検索に失敗したため検索なしで答えた」旨を添える | 通常の返答（`chatService.ts` の `dropWebSearch`）と同じ扱いにする。無人の実行なので、検索の失敗だけでジョブの連続失敗を数えない |
| ギルドの設定が無効なとき | 検索なしで実行し、失敗にはしない。詳細画面には「Web 検索: オン（ギルドの設定が無効のため使われない）」と出す | 管理者が Web 検索を切ったことで、定期実行が連続失敗で停止しないようにする |
| 検索結果のリンク | 検索したときは、投稿の本文の後に `formatSearchResultLinks()` の一覧を置き、分割は本文と同じ `splitTextIntoMessages` に任せる | 通常の返答と同じ出典の表示にする |

## Design

### 変更対象ファイル

- 修正: `src/db/schema.ts` — `cron_jobs` と `cron_proposals` に `web_search INTEGER NOT NULL DEFAULT 0` を足す（列の有無を見て `ALTER TABLE`）
- 修正: `src/db/repositories/cronRepository.ts` — `webSearch` の読み書き、承認時の提案からジョブへの受け渡し、提案とジョブの `webSearch` の反転
- 修正: `src/llm/openrouter.ts` — 非ストリームの `chat()` で `openrouter:web_search` の項目と `url_citation` を読み、`WebSearchTrace` を返す。検索の失敗を `WebSearchFailedError` にする
- 修正: `src/services/chatService.ts` — `generateScheduledResponse` で、ジョブとギルドの両方が有効なら server tool と検索用の system message を足し、検索の失敗で 1 回だけ検索なしで呼び直す。結果に `webSearch` と `webSearchSkipped` を返す
- 修正: `src/services/cronService.ts` — 投稿に検索結果のリンクと、検索を諦めた旨を足す
- 修正: `src/utils/cronPanel.ts` — 確認カードと詳細画面に「Web 検索」の表示とボタン、確認カードに `describeSearchBilling` の文面
- 修正: `src/bot/events/cronPanelHandler.ts` — 新しいボタンの custom_id の処理
- 修正: `src/llm/tools/proposeCronJob.ts` — `web_search` 引数
- 修正: `scripts/e2e/scenarios.ts` と `scripts/e2e/cron.ts` — `cron-search` シナリオ
- テスト: 各修正の単体テスト

### DBスキーマ変更

`cron_jobs` と `cron_proposals` に `web_search INTEGER NOT NULL DEFAULT 0` を足す。
既存のジョブと提案は 0（検索しない）になるので、動作は変わらない。

### 実装内容

- 確認カードは、`web_search` が 1 のとき「**Web 検索:** 使う（{describeSearchBilling(engine)}）」の行を出す。
- 詳細画面のボタンの並びは「編集」「Web 検索をオンにする / オフにする」「今すぐ実行」「停止 / 再開」「削除」「一覧へ戻る」とする。Discord の 1 行 5 ボタンに収まらないので 2 行にする。
- 「今すぐ実行」もジョブの `web_search` に従う。

### e2e

`bun run e2e cron-search` を名前を指定したときだけ走らせ、定期実行と Web 検索の両方が有効なギルドを要件にする。
スクリプトが DB に `web_search = 1` の 1 回限りのジョブを直接挿入し、投稿に検索結果のリンク（`-# 検索結果`）が付くことを確かめてから、ジョブを消す。
プロンプトは `search` シナリオと同じく、過去の決まった出来事の日付を尋ねる。

## Tasks

- [ ] 非ストリームの `chat()` で検索の記録と失敗を読む
- [ ] `web_search` 列、repository、提案とジョブの受け渡し
- [ ] `generateScheduledResponse` の検索と、検索なしでの呼び直し
- [ ] 投稿のリンクと、確認カードと詳細画面の表示とボタン
- [ ] `propose_cron_job` の `web_search`
- [ ] 単体テスト
- [ ] e2e シナリオ `cron-search` を足し、AGENTS.md の End-to-end 節に実行条件を書く
- [ ] `docs/changes/cron-web-search/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **非ストリームでの検索の失敗（未検証）**: ストリームでは、検索の失敗を `Server tool "openrouter:web_search" failed` で始まるエラーのイベントから `WebSearchFailedError` にしている（`openrouter.ts` の `throwForStreamErrorPayload`）。非ストリームで同じ失敗が HTTP 200 の `status: "failed"` と HTTP のエラーのどちらで返るかは確かめていない。実装では両方の経路で同じ文面を見て `WebSearchFailedError` にし、どちらかが違う形なら、検索なしの呼び直しが働かずにその実行が失敗として数えられる。
- **native 検索の上限**: エンジンが `native` か `auto` のとき、Anthropic 以外のモデルでは `max_uses` が効かない（`describeSearchBilling` の文面）。確認カードにはその文面をそのまま出し、上限が効かないことを承認前に示す。
