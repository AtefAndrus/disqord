---
title: "推論内容の取得・表示"
status: in-progress
priority: medium
summary: "Responses API の reasoning item を受け取り、tool を挟む生成では送り返し、設定に応じて回答の上に推論を spoiler で表示する"
---

# 推論内容の取得・表示

## Why

bot は OpenRouter の Responses API で回答を生成しているが、ストリームに流れる推論と、`type: "reasoning"` の output item を捨てている（`src/llm/openrouter.ts` の item 処理と heartbeat の分岐）。
そのため、推論するモデルが何を考えたかをユーザは見られず、footer の `Reasoning: N` で token 数だけが分かる。
また、tool を呼んで同じ生成を続けるとき、前のターンの reasoning item を次の request に入れていないので、モデルは自分の推論を引き継げない。

## 依存 / 関連 change

- 前提（実装済み）: [conversation-context](../conversation-context/design.md) — 会話の本文を DB に保存せず、応答のたびに Discord から読む。bot の過去の返信は Components V2 の TextDisplay だけを本文として読むので、添付ファイルは履歴に入らない（`normalizeBotReply()` と `extractComponentsV2ReplyBody()`、`src/utils/discordMessageNormalizer.ts`）
- 連携: [settings-hierarchy](../settings-hierarchy/design.md) — reasoning の effort と token 上限は、同 change が scope ごとの LLM パラメータとして扱う。本 change は effort を送らない

## Goals / Non-Goals

**Goals:**

- ストリームから `type: "reasoning"` の output item を検証して受け取り、表示できる要約と本文を取り出す
- tool を呼んで同じ生成を続けるとき、そのターンの reasoning item を改変せずに次の request へ送り返す
- guild の設定が有効なとき、provider が返した推論を回答の 1 ページ目の上に spoiler で表示する
- 推論の本文が返らないモデルでは、これまでどおり token 数だけを footer に出す

**Non-Goals:**

- 暗号化された推論（`encrypted_content`）の表示
- provider が返さない推論を推測や bot 側の要約で補うこと
- reasoning の effort と token 上限の設定（settings-hierarchy が扱う）
- 生成中のストリーミング表示（推論は回答の完了時にだけ出す）
- 推論を DB や会話履歴に残すこと。次の応答では、モデルは過去の推論を受け取らない

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 受け取る単位 | `response.output_item.done` の reasoning item を完成形として受け取り、`response.reasoning_text.delta` などの delta は今までどおり heartbeat として扱う | 表示は完了時だけなので delta を組み立てる必要が無い。完成した item は送り返しにもそのまま使える |
| 表示する内容 | item の `summary` に `summary_text` があればそれを順に、無ければ `content` の `reasoning_text` を順に使う。両方が空なら何も添えない | provider が返した表現を改変しない。要約を出すモデルと本文を出すモデルの両方を扱える |
| 送り返し | tool を呼んだターンの reasoning item を、`id`、`encrypted_content`、`signature`、`format` を含めて受け取ったまま保持し、次の request の input で、そのターンの assistant メッセージと `function_call` の前に置く | OpenRouter の Reasoning Tokens ガイドは、tool を挟む継続では推論を順序も内容も変えずに送り返すよう求めている。OpenAPI 定義の `Inputs` は `OutputReasoningItem` を受け付ける |
| 暗号化された推論の取得 | request に tool があるときは `include: ["reasoning.encrypted_content"]` を付ける | `previous_response_id` は使えず（OpenAPI 定義で非 null は 400）、状態はクライアントが送り直す。暗号化された推論は `include` で求めないと返らない |
| 推論の要約を求めるか | 表示が有効で、モデルの `supported_parameters` に `reasoning` があるときだけ `reasoning: { summary: "auto" }` を送る。それ以外は `reasoning` を送らない | 要約は求めないと返らないモデルがある。非対応モデルに未対応のパラメータを送らない。effort はモデルの既定に任せる |
| 表示の設定 | `/config reasoning-display on\|off` を足し、既定は off とする。guild 設定の列 `reasoning_display_enabled` に保存する | 推論には質問の断片が繰り返し現れうるので、共有チャンネルへ意図せず出さない。token と料金の表示（`llm-details`）とは別に切り替えられるようにする |
| 表示の形 | 1 ページ目の回答の Container の前に、推論だけを入れた 2 つ目の Container を spoiler（`spoiler: true`）にして置く。見出しは `-# 推論` とする。1 メッセージの TextDisplay の字数とバイト数の上限の、回答と footer の残りに収まらなければ残りで切り、全文を `reasoning.md` として同じ Container の File component で添える | 推論は回答より先に読むものなので上に置く。Components V2 に折りたたみの部品は無く、spoiler の Container はクリックするまで中身をぼかす。ファイルの添付だけでは Discord 上で開かずに読めない。会話の履歴は bot の返信の spoiler でない最初の Container だけを本文として読むので、推論は次の応答の文脈に混ざらない |
| 複数ターンの推論 | tool loop の各ターンの推論を、ターン順に `## ターン n` の見出しを付けて 1 つのファイルにまとめる | 1 回の応答に 1 ファイルとし、どのターンの推論かを区別できるようにする |
| 停止とエラー | 停止した返信とエラーで終わった返信には推論を添えない | 完了していない推論を公開しない |

## Design

### 変更対象ファイル

- 修正: `src/types/index.ts` — reasoning item の型（受け取ったまま保持する opaque な値と、表示用に取り出した文字列）、`ResponsesInputItem` への reasoning item の追加、request の `include` と `reasoning`、assistant メッセージに reasoning item を持たせる field
- 修正: `src/llm/openrouter.ts` — `response.output_item.done` の reasoning item を検証して terminal の結果へ載せる。`toResponsesInput()` で assistant メッセージの reasoning item を先に出す。`include` と `reasoning` を body に入れる。`listModelsWithPricing()` で `supported_parameters` を読む
- 修正: `src/llm/toolLoop.ts` — ターンごとの reasoning item を assistant メッセージに付けて履歴へ積み、ターンをまたいで表示用の推論を集める
- 修正: `src/services/chatService.ts` — 表示設定とモデルの対応から `reasoning` と `include` を決める
- 修正: `src/bot/events/messageCreate.ts` / `src/utils/chatContainerBuilder.ts` — 1 ページ目に推論の spoiler Container を置き、収まらない分を `reasoning.md` で添える
- 修正: `src/utils/discordMessageNormalizer.ts` / `scripts/e2e/scenarios.ts` — 回答の Container を、spoiler でない最初の Container として読む
- 修正: `src/db/schema.ts` / `src/db/repositories/guildSettings.ts` / `src/services/settingsService.ts` / `src/bot/commands/config.ts` — `reasoning_display_enabled` の列、setter、`/config reasoning-display`、`/status` の表示
- 修正: `scripts/e2e/scenarios.ts` — 推論の Container を確かめる、名前を指定して走るシナリオ
- テスト: `tests/unit/llm/openrouter.test.ts` / `tests/unit/llm/toolLoop.test.ts` / 設定と表示のテスト

### DBスキーマ変更

`guild_settings` に `reasoning_display_enabled INTEGER NOT NULL DEFAULT 0` を足す。
追加の仕方は `web_search_enabled` と同じく、`src/db/schema.ts` で列の有無を見て `ALTER TABLE` する。

### 受信

- `response.output_item.done` の item が `type: "reasoning"` のとき、必須の `summary` が配列であることと、任意の `content` があれば配列であること、それぞれの要素の `text` が文字列であることを検証する。形が違えば既存の `StreamProtocolError` として扱う。OpenAPI 定義の `OutputItemReasoning` で必須なのは `type`、`id`、`summary` だけで、要約だけの item や暗号化されたものだけの item は `content` を持たない。
- 未知の field は捨てずに item ごと保持する。送り返すときに OpenRouter が要る field を bot が知っている必要は無い。
- 表示用の文字列は検証済みの `summary_text` または `reasoning_text` から作る。

### 送り返し

- tool loop は、function_call を含むターンの reasoning item を、そのターンの assistant メッセージに付けて履歴へ積む。
- `toResponsesInput()` は、assistant メッセージの reasoning item を、同じメッセージの本文と `function_call` より前に、受け取った順で出す。
- 最終ターン（tool を呼ばないターン）の reasoning item は送り返す先が無いので、表示にだけ使う。

### 表示

- 推論の本文は Markdown として書き出し、ファイルの先頭にモデル名を書く。
- 推論を切ったときに添える `reasoning.md` は、添付の上限（既定 20 MiB）に比べて十分に小さいので分割しない。
- 最終ページの後にメッセージを書き直すとき（停止、エラー、余分なページの中立化）は添付を消す。
- `showLlmDetails` の値は推論の表示に影響しない。

## Tasks

- [x] 型と、reasoning item の検証・保持を実装する
- [x] tool loop で reasoning item を送り返し、`include` を付ける
- [x] `supported_parameters` を読み、表示が有効なときだけ `reasoning.summary` を送る
- [x] `reasoning_display_enabled` の列と `/config reasoning-display`、`/status` の表示を足す
- [x] 1 ページ目に推論の spoiler Container を置く
- [x] 要約だけ、本文だけ、暗号化だけ、推論なし、形の壊れた item の各場合をテストする
- [x] 推論を返すモデルで、tool を挟む応答が送り返しで失敗しないことと、推論が表示されることを e2e で確かめる
- [ ] 手動確認: 実クライアントで、推論が回答の上にぼかした状態で出て、クリックすると読めること、長い推論では `reasoning.md` が添えられることを確かめる
- [ ] `docs/changes/reasoning-output/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **送り返しの効果（未検証）**: reasoning item を送り返さなくても request は通る見込みで、送り返したときにモデルの推論が引き継がれることは wire で確かめていない。e2e で、送り返しを入れても 400 にならないことだけは確かめる。
- **provider による差**: 推論を求めても、token 数だけ、要約だけ、暗号化されたものだけが返ることがある。既定モデル `google/gemma-4-26b-a4b-it:free` は Models API で reasoning が既定 off なので、既定の構成ではファイルはほぼ付かない（2026-09-23 に Models API で確認）。
- **provider による要約の有無**: `reasoning.summary` を送っても、要約を返すかは provider が応答ごとに決める。`google/gemini-3.8-flash` と `openai/gpt-6-luna` は暗号化された推論だけを返すことが多く、`z-ai/glm-5.3-flash` は毎回本文を返した（2026-09-24 に e2e で確認）。effort を high にしても gpt-6-luna は要約を返さなかった。

## 参照

- [OpenRouter Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) — 推論の送り返し（Preserving Reasoning）
- [OpenRouter OpenAPI 定義](https://openrouter.ai/openapi.json) — `OutputReasoningItem`、`ReasoningConfig`、`ResponsesRequest.include`、`Inputs`、`ModelReasoning`
