---
title: "Responses API への移行"
status: planned
priority: high
summary: "LLM 呼び出しを Chat Completions から Responses API へ振る舞いを変えずに載せ替える"
---

# Responses API への移行

## Why

DisQord は OpenRouter の Chat Completions（`POST /api/v1/chat/completions`）で LLM を呼んでいる。
一方、コード実行に使う `openrouter:shell` server tool は Responses API と Anthropic Messages API でしか使えず、Chat Completions に載せると 400 が返る。
[コード実行](../code-execution/design.md) は自前の microVM サンドボックスをやめて shell server tool に寄せる方針なので、API の載せ替えがその前提になる。

本 change は**振る舞いを変えない載せ替え**である。
ユーザから見える挙動、コマンド、表示は変わらない。
新機能は入れず、shell server tool の導入も行わない。

チャットは Chat Completions のまま、コード実行のときだけ Responses を叩く折衷は採らない。
API を二重に保守すると、会話履歴の表現、tool 呼び出しの表現、usage の形がそれぞれ二通りになり、以降のすべての change が両対応の判断を強いられるためである。

## 依存 / 関連 change

- 後続: [コード実行](../code-execution/design.md) — `openrouter:shell` の導入は本 change の完了が前提。同 change の microsandbox 統合の設計は本 change 完了後に書き直す
- 吸収済み: 旧 `openrouter-api-audit`（OpenRouter API 整合監査）— Chat Completions の deprecated フラグ撤去と usage 型整合を目的にしていた change で、移行すれば大半が自動的に満たされる。残タスクは本 change が引き取り、フォルダは削除済み
- 連携: [推論内容の取得・表示](../reasoning-output/design.md) — Responses では reasoning が専用イベントで流れるため、同 change の受信側の設計が単純になる。ただし本 change では表示を実装しない
- 連携: [設定階層化 + LLMパラメータ](../settings-hierarchy/design.md) — Responses で送れる生成パラメータが狭くなり、`supported_parameters` をそのまま許可リストにする方針が成立しなくなる（後述）
- 連携: [Web 検索 + ツイート展開](../web-search/design.md) / [OpenRouter サーバツール群](../server-tools/design.md) — server tool の送り方は両 API で同じだが、usage の読み取り先が変わる
- 連携: [マルチモーダル対応](../multimodal/design.md) / [出力マルチモーダル対応](../multimodal-output/design.md) — 入力 part の型名が変わる

## Goals / Non-Goals

**Goals:**

- `OpenRouterClient` の `chat()` / `chatStream()` を `POST /api/v1/responses` へ載せ替える
- `ILLMClient` のシグネチャと、`StreamChunk` / `StreamToolCallChunk` / `StreamHeartbeatChunk` / `StreamFinalResult` という正規化済みの yield 契約を維持する。`toolLoop.ts` と `chatService.ts` から見た振る舞いを変えない
- Responses のイベント列を上記の正規化済みチャンクへ写像する
- usage のフィールド名の差を client 境界で吸収し、下流が現行と同じ形を読めるようにする
- 現行の機能（system prompt、client tool calling、server tool、画像入力、PDF 入力、停止ボタンによるキャンセル、レート制限とエラー分類）が移行後も同じ結果になることをテストで担保する
- **後続 change が必要とするリクエストフィールドの伝搬機構を用意する**。`runToolLoop()` は毎ターンのリクエストを明示的な名前付きフィールドで組み直しており（`src/llm/toolLoop.ts:957` 付近）、新しいフィールドは自動伝搬しない。パススルーの器を本 change で作り、呼び出し側が値を入れなければ振る舞いは変わらない状態にする
- **`AggregatedUsage` を実際に返る usage フィールドへ広げる**。現行は手書きで狭められており（`src/llm/toolLoop.ts:54` 付近）、`cache_write_tokens` / `cost_details` / `server_tool_use_details` を集計しない

**Non-Goals:**

- `openrouter:shell` の導入（[コード実行](../code-execution/design.md)）
- reasoning 本文の表示（[推論内容の取得・表示](../reasoning-output/design.md)）。本 change では現行どおり heartbeat として扱い、表示しない
- Anthropic Messages API への対応
- Responses でしか使えない機能（`openrouter:apply_patch`、`openrouter:tool_search`、`background`、`include`）の採用
- 生成パラメータの追加・削除に伴う UI 変更（[設定階層化 + LLMパラメータ](../settings-hierarchy/design.md) が未実装のため、現行が送っているパラメータの範囲で閉じる）
- tool call の delta 蓄積ロジックの簡素化。Responses は完成形の `arguments` も返すが、本 change では現行の蓄積経路とガードを維持する

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 移行先 | Responses API | Messages API は `parallel_tool_calls` / `reasoning` / `prompt_cache_key` / `prompt_cache_options` / `modalities` / `image_config` / `max_tool_calls` を持たず、`thinking` ブロックと `input_schema` という Anthropic 形の表現を採る。任意ベンダのモデルを扱う本 bot では変換層が厚くなる |
| 移行の性質 | 振る舞いを変えない載せ替え | 既存テストと `bun run preview` を回帰の判定に使える。機能追加を混ぜると回帰の切り分けができない |
| 内部 DTO | `ChatCompletionRequest` / `ChatCompletionResponse` を内部表現として維持し、`OpenRouterClient` の中だけで Responses 形へ変換する | `ILLMClient` が既に境界になっており、`toolLoop.ts` / `chatService.ts` / `embedBuilder.ts` は正規化済みの型しか見ていない。内部 DTO を変えると変更が全レイヤへ波及する |
| usage の型 | `ChatCompletionResponse["usage"]` の形（`prompt_tokens` / `completion_tokens`）を維持し、client 内で Responses の `input_tokens` / `output_tokens` から写像する | usage は `embedBuilder` の表示と [権限管理](../permissions/design.md) の計上が読む。内部名を変えると両方が巻き込まれる |
| system prompt | `input` 配下の `{role:"system"}` item として送る（`instructions` フィールドは使わない） | 実測でどちらも効く。`input` に置けば現行の `SystemChatMessage` をそのまま写像でき、`buildChatRequest()` の構造を変えずに済む |
| reasoning | 現行どおり heartbeat として扱い、本文を捨てる | 表示は [推論内容の取得・表示](../reasoning-output/design.md) の責務。移行を純粋に保つ |
| tool call の受け取り | `response.function_call_arguments.delta` を蓄積する現行経路を維持し、`response.output_item.done` の完成形は整合確認にのみ使う | 蓄積経路にはフレーム上限と carry buffer のガードが入っている。移行と同時に捨てると、退行したときの切り分けが難しくなる |
| tool call の識別子 | Responses の `call_id` を現行の `ToolCall.id` へ写像する | `toolLoop.ts` は `role:"tool"` の `tool_call_id` で突き合わせる。写像しておけば dispatcher 側は無変更で済む |
| deprecated フラグ | `usage: { include: true }` は送らない | Responses に当該フィールドは無い。吸収した監査 change の目的をここで満たす |
| エラー処理 | `handleErrorResponse()` と `AppError` 系の分類を無変更で流用する | 実測でエラーの封筒が両 API で同一（後述） |
| SSE 読み取り | フレーム分割、UTF-8 の fatal デコード、フレームサイズ上限、carry buffer のガードを無変更で流用する | 実測で `data:` 行の連なりと `data: [DONE]` 終端が同一（後述） |
| `listModels` / `listModelsWithPricing` / `getCredits` / `isRateLimited` | 無変更 | `/models` と `/key` は API surface に依存しない |

## Design

### 実測で確認した事実

以下は 2026-09-18 に実際にリクエストを送って確認した。

**そのまま流用できるもの:**

- エラーの封筒が同一である。存在しないモデル ID は両 API とも `{"error":{"message":"nope/nope is not a valid model ID","code":400}}`、認証失敗は `{"error":{"message":"User not found.","code":401}}` を返す
- SSE の枠組みが同一である。`data:` 行の連なりで、終端は `data: [DONE]`
- `plugins` が使える。Responses が受け付けるのは `auto-beta-router` / `auto-router` / `context-compression` / `file-parser` / `fusion` / `moderation` / `pareto-router` / `response-healing` / `web` / `web-fetch`
- `session_id` / `provider` / `models`（フォールバック）/ `metadata` / `trace` / `service_tier` / `cache_control` / `reasoning` / `parallel_tool_calls` / `max_tool_calls` / `stop_server_tools_when` / `prompt_cache_key` / `prompt_cache_options` / `modalities` / `image_config` がある
- client function tool と server tool を同一リクエストへ混在させられる。`{"type":"function",...}` と `{"type":"openrouter:datetime",...}` を同時に渡して 200 が返り、server tool は実行され `usage.server_tool_use_details` に計上された
- `tool_choice: "none"` が効く。function tool を渡した状態で送っても `function_call` item は出ない

**書き換えが要るもの:**

- `messages` が `input` になる
- function tool の定義が flat になる
- usage のフィールド名が変わる
- ストリームが型付きイベントの列になる
- マルチモーダル入力の part 名が変わる

### リクエストの対応

| 現行（Chat Completions） | 移行後（Responses） |
| ------------------------ | ------------------- |
| `messages: ChatMessage[]` | `input: InputItem[]` |
| `{role:"system", content}` | `{role:"system", content}`（そのまま） |
| `{role:"user", content}` | `{role:"user", content}`（そのまま） |
| `{role:"assistant", content, tool_calls}` | `{role:"assistant", content}` と、`tool_calls` 各要素を `{type:"function_call", call_id, name, arguments}` として**並べて置く** |
| `{role:"tool", content, tool_call_id}` | `{type:"function_call_output", call_id, output}` |
| `{type:"text", text}` | `{type:"input_text", text}` |
| `{type:"image_url", image_url:{url}}` | `{type:"input_image", image_url: <url>}`（オブジェクトではなく文字列） |
| `{type:"file", file:{filename, file_data}}` | `{type:"input_file", filename, file_data}` |
| `tools: [{type:"function", function:{name, description, parameters}}]` | `tools: [{type:"function", name, description, parameters}]` |
| `tools: [{type:"openrouter:<id>", parameters}]` | 同じ（server tool は無変更） |
| `tool_choice` | 同じ |
| `parallel_tool_calls` | 同じ |
| `plugins` | 同じ |
| `usage: {include: true}` | 送らない |

`input_image` の `image_url` は、Chat Completions ではオブジェクト（`{url}`）だが Responses では文字列である点に注意する。
`input_file` の `file_data` は現行と同じく `data:application/pdf;base64,...` 形式の data URL を受け付ける。
`file-parser` plugin と組み合わせて PDF の本文がモデルへ渡ることを実測で確認した。

### ストリームイベントの対応

Responses のイベント型と、`chatStream()` が yield する正規化済みチャンクの対応は次のとおり。

| Responses のイベント | yield するもの |
| -------------------- | -------------- |
| `response.created` / `response.in_progress` | `StreamHeartbeatChunk` |
| `response.output_item.added` / `response.content_part.added` | `StreamHeartbeatChunk` |
| `response.output_text.delta` | `StreamChunk`（`content` に delta を入れる） |
| `response.reasoning_text.delta` / `response.reasoning_text.done` | `StreamHeartbeatChunk`（本文は捨てる） |
| `response.function_call_arguments.delta` | `StreamToolCallChunk`（`argumentsDelta`） |
| `response.output_item.done`（`item.type === "function_call"`） | `StreamToolCallChunk`（`call_id` を `id` へ、`name` を設定） |
| `response.output_item.done`（`item.type` が `openrouter:` 接頭辞） | `StreamHeartbeatChunk`（server tool の実行。本 change では表示しない） |
| `response.content_part.done` / `response.output_text.done` | `StreamHeartbeatChunk` |
| `response.completed` | `StreamFinalResult`（`fullText` / `usage` / `model` / `finishReason`） |
| `data: [DONE]` | ストリーム終端 |

`response.output_item.added` は server tool の実行を独立した item として通知する（例: `{"type":"openrouter:datetime","id":"st_tmp_..."}`）。
Chat Completions では観測できなかった情報だが、本 change では heartbeat として扱い、進捗表示には使わない。

`finishReason` は `response.completed` の `response.status` から導く。
現行の `finish_reason`（`"stop"` / `"tool_calls"` / `"length"`）に相当する値が Responses のどのフィールドに出るかは実装時に確定する（Open Questions 参照）。

**tool call の完成判定**は、現行が `finish_reason: "tool_calls"` で行っているのに対し、Responses では `function_call` item の `response.output_item.done` が到達した時点で当該 tool call が完成する。
`toolLoop.ts` は「そのターンに完成した tool call が 1 件以上あるか」で分岐しているので、client 側で完成した tool call を集計し、`StreamFinalResult.finishReason` に `"tool_calls"` を立てて渡せば dispatcher は無変更で動く。

### usage の対応

| 現行（Chat Completions） | Responses |
| ------------------------ | --------- |
| `prompt_tokens` | `input_tokens` |
| `completion_tokens` | `output_tokens` |
| `total_tokens` | `total_tokens` |
| `prompt_tokens_details.cached_tokens` | `input_tokens_details.cached_tokens` |
| `prompt_tokens_details.cache_write_tokens` | `input_tokens_details.cache_write_tokens` |
| `completion_tokens_details.reasoning_tokens` | `output_tokens_details.reasoning_tokens` |
| `cost` | `cost` |
| `cost_details.upstream_inference_cost` | 同じ |
| `cost_details.upstream_inference_prompt_cost` | `cost_details.upstream_inference_input_cost` |
| `cost_details.upstream_inference_completions_cost` | `cost_details.upstream_inference_output_cost` |
| `server_tool_use_details` | 同じ |
| `is_byok` | 同じ |

client 内で Responses 形から現行形へ写像し、下流には現行の形のまま渡す。

あわせて `ChatCompletionResponse["usage"]` の型を、実際に返るフィールドへ揃える。
現行の型に無いのは `prompt_tokens_details.video_tokens`、`completion_tokens_details.image_tokens` と `audio_tokens`、`cost_details` の 3 フィールド、`is_byok`、`server_tool_use_details` である。
`src/utils/embedBuilder.ts` の `splitTextToMultipleMessages()` が持つ `metadata.usage` のインライン定義は、`ChatCompletionResponse["usage"]` のエイリアスへ置き換えて定義を一本化する。

`server_tool_use_details` は、server tool が一度も起動しなかったリクエストでは usage から省かれる。
未起動と 0 回を区別する必要があるので、値ではなくキーの有無で判定する。

### リクエストフィールドの伝搬機構

`runToolLoop()` は毎ターンのリクエストを次の形で組み立てる（`src/llm/toolLoop.ts:957` 付近）。

```ts
const request: ChatCompletionRequest = {
  model,
  messages: [...history],
  ...(plugins && { plugins }),
  ...(hasTools && { tools, tool_choice: toolChoice }),
};
```

base request を spread せず名前付きフィールドを列挙しているため、`ChatCompletionRequest` に項目を足しても loop 内の再リクエストへは伝わらない。
この構造のままだと、次の三つの change がそれぞれ同じ配管を通すことになる。

- [対話UX改善（会話履歴ストア）](../conversation-context/design.md) — `session_id` を通常生成・tool 後の再リクエスト・retry のすべてへ渡す
- [OAuth BYOK](../oauth-byok/design.md) — API キーの上書きを全ターンへ渡す。`chatStream()` を実際に呼ぶのは loop の中であり、現状キー上書きの経路が無い
- [設定階層化 + LLMパラメータ](../settings-hierarchy/design.md) — 解決済みの生成パラメータを全ターンへ渡す

本 change は、この三つが値を載せるための器を用意する。
`runToolLoop()` が受け取ったリクエスト由来のフィールドを毎ターンのリクエストへ**そのまま引き継ぐ**ようにし、誰も値を入れていない現在は送出内容が変わらないことをテストで固定する。
どのフィールドを載せるかは各 change が決める。

### usage 集計の拡張

`AggregatedUsage`（`src/llm/toolLoop.ts:54` 付近）は基本トークン、`cost`、`cached_tokens`、`reasoning_tokens` だけを集計する手書きの型である。
`addUsage()` はこの型に列挙された項目だけを足し込むため、型を広げないと下流へ届かない。

一方、後続 change は次を要求している。

- [Web 検索 + ツイート展開](../web-search/design.md) — ターンをまたいだ server tool 実行回数の累計（`usage.server_tool_use_details`）
- [対話UX改善（会話履歴ストア）](../conversation-context/design.md) — cache read / write トークンの記録（`prompt_tokens_details.cache_write_tokens`）
- [使用統計](../usage-stats/design.md) — 上記を `usage_logs` へ保存する

parser から集計までを本 change が所有し、保存は [使用統計](../usage-stats/design.md) が所有する。
未返却のフィールドは 0 と同一視せず、キーの有無で「不明」と区別できる形を保つ。

### 変更対象ファイル

- 修正: `src/llm/openrouter.ts` — エンドポイントを `/responses` へ変更。リクエスト変換（`messages` → `input`、tool 定義の flat 化、part 名の変換）、イベント写像、usage 写像を追加。SSE 読み取りの枠組みとエラー処理は維持
- 修正: `src/types/index.ts` — Responses の wire 形を表す内部型を追加。`ChatCompletionResponse["usage"]` を実返却フィールドへ拡張
- 修正: `src/utils/embedBuilder.ts` — `metadata.usage` のインライン定義を `ChatCompletionResponse["usage"]` のエイリアスへ置換
- 修正: `src/llm/toolLoop.ts` — リクエストフィールドの毎ターン引き継ぎ、`AggregatedUsage` の拡張と `addUsage()` の集計対象追加
- 確認のみ: `src/services/chatService.ts` — 正規化済みチャンクの契約を維持するため無変更が目標。変更が要る場合はその理由を design へ追記する
- 修正: `tests/unit/llm/openrouter.test.ts` — リクエストボディのアサーションを Responses 形へ更新。イベント写像のフィクスチャを追加
- 修正: `tests/unit/llm/toolLoop.test.ts` — mock クライアントが yield する正規化済みチャンクは変わらないため、原則無変更。落ちる場合は契約の破れなので写像側を直す

### 移行で送れなくなる生成パラメータ

Responses には `logit_bias` / `logprobs` / `min_p` / `repetition_penalty` / `response_format` / `seed` / `stop` / `top_a` / `prediction` / `reasoning_effort`（`reasoning` は残る）/ `stream_options` が無い。
`max_tokens` と `max_completion_tokens` は `max_output_tokens` に相当する。

現行コードはこれらを送っていないため、本 change では実害が無い。
ただし [設定階層化 + LLMパラメータ](../settings-hierarchy/design.md) は Models API の `supported_parameters` をそのまま許可リストにする設計であり、この前提は Responses 上では成立しない。
`supported_parameters` は Chat Completions のパラメータ名を返すためで、全 445 モデル中 432 件が `max_tokens` を返し、`max_completion_tokens` を返すのは 63 件である。
同 change には、能力判定に使う名前と送信する名前の対応表が要る。
本 change ではその対応表を作らず、制約を同 change の design へ注記するに留める。

## Tasks

### Phase 1: 非ストリーミング経路

- [ ] Responses の wire 形を表す内部型を `src/types/index.ts` へ追加
- [ ] `ChatCompletionRequest` → Responses リクエストの変換関数を実装（`input` への写像、tool 定義の flat 化、part 名の変換、`usage:{include:true}` の非送出）
- [ ] Responses レスポンス → `ChatCompletionResponse` の変換関数を実装（`output` 配下の `message` item からテキストを組み立て、usage を写像）
- [ ] `chat()` を `/responses` へ載せ替え、`chatService.ts` の呼び出し（1 箇所）が無変更で通ることを確認
- [ ] `ChatCompletionResponse["usage"]` を実返却フィールドへ拡張し、`embedBuilder` のインライン定義をエイリアス化
- [x] 吸収した監査の残件: `GET /api/v1/key` の `data.limit_remaining` にドリフトが無いことを確認（上限未設定のキーでは `null` が返り、`getCredits()` の `?? Infinity` は意味的にも正しい）。コード変更は不要

### Phase 2: ストリーミング経路

- [ ] イベント写像を実装（上表）。SSE 読み取りの枠組み、UTF-8 の fatal デコード、フレーム上限、carry buffer のガードは流用する
- [ ] tool call の写像を実装（`call_id` → `id`、`arguments` の delta 蓄積、完成判定から `finishReason: "tool_calls"` の合成）
- [ ] `response.completed` から `StreamFinalResult` を組み立て、`finishReason` の導出元を実 wire で確定する
- [ ] reasoning イベントを heartbeat として扱い、本文を捨てることを確認する
- [ ] `chatStream()` を `/responses` へ載せ替え、`chatService.ts` が無変更で通ることを確認
- [ ] `runToolLoop()` にリクエストフィールドの毎ターン引き継ぎを実装し、誰も値を入れていない状態で送出内容が変わらないことをテストで固定
- [ ] `AggregatedUsage` を拡張し、`addUsage()` に `cache_write_tokens` / `cost_details` / `server_tool_use_details` の集計を追加。未返却フィールドを 0 と同一視しないことをテストで固定

### Phase 3: 回帰

- [ ] 既存の unit test を通す。`tests/unit/llm/openrouter.test.ts` のボディアサーションを Responses 形へ更新
- [ ] イベント写像のフィクスチャを追加（テキストのみ、tool call を含む、server tool を含む、reasoning を含む、`choices` 相当が空の最終イベント）
- [ ] キャンセル（停止ボタン）が `AbortSignal` で従来どおり効くことを確認
- [ ] エラー分類の回帰（401 / 400 invalid model / 429）を確認
- [ ] 実機で確認する: 通常のチャット、画像添付、PDF 添付、長文の分割送信、停止ボタン
- [ ] `bun run preview` で表示の回帰を確認
- [x] 旧 `openrouter-api-audit` を削除し、残タスクを本 change へ移管

### Phase 4: 後続への引き継ぎ

- [ ] [コード実行](../code-execution/design.md) の design を、microsandbox 統合から `openrouter:shell` 前提へ書き直す
- [ ] [設定階層化 + LLMパラメータ](../settings-hierarchy/design.md) へ、`supported_parameters` をそのまま許可リストにできない制約を注記する
- [ ] [推論内容の取得・表示](../reasoning-output/design.md) へ、reasoning が専用イベントで流れることを注記する
- [ ] [Web 検索 + ツイート展開](../web-search/design.md) の usage 読み取り先を `usage.server_tool_use_details` へ訂正する
- [ ] `docs/changes/responses-api-migration/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **`finishReason` の導出元**: 現行は `finish_reason` の `"stop"` / `"tool_calls"` / `"length"` を読んでいる。Responses の `response.completed` は `status: "completed"` を返すが、打ち切り理由に相当する値がどのフィールドに出るかは未確認である。`incomplete_details` が候補になる。実装時に実 wire で確定する
- **tool call の並行実行**: Responses は `parallel_tool_calls` を受け付け、`output_index` で item を区別する。現行の `StreamToolCallDelta.index` へどう写像するかを実装時に確定する
- **heartbeat の粒度**: Responses は Chat Completions より多くのイベントを流す。すべてを heartbeat として yield すると `toolLoop.ts` の idle timer が実質無効になりうる。どのイベントを heartbeat として通すかは、`STREAM_IDLE_TIMEOUT_MS` の意図（受信の途絶を検知する）に照らして選ぶ
- **server tool の usage が API で異なる**: Chat Completions と Responses はどちらも `usage.server_tool_use_details` を返すが、Anthropic Messages API は `usage.server_tool_use` を返す。Messages API は採用しないので影響は無いが、ドキュメントの記述を読むときに混同しない
- **プロバイダ差**: Responses は OpenRouter が各プロバイダの API へ変換して呼ぶ。Chat Completions で動いていたモデルが Responses で同じ挙動になるとは限らない。既定モデルを含め、実際に使うモデルで回帰を確認する
- **`instructions` を使わない選択**: system prompt を `input` の `{role:"system"}` として送る。将来 `instructions` 固有の挙動（プロバイダ側で別扱いされる等）が必要になった場合は、その時点で切り替えを検討する

## 参照

- [OpenRouter Responses API](https://openrouter.ai/docs/api/reference/responses/overview) — stateless であり `store` / `previous_response_id` は 400
- [OpenRouter Server Tools](https://openrouter.ai/docs/guides/features/server-tools) — ツールごとの対応 API surface、`max_tool_calls` と `stop_server_tools_when`
- [OpenRouter Shell Server Tool](https://openrouter.ai/docs/guides/features/server-tools/shell) — Chat Completions では 400、Responses と Messages でのみ利用可能
- [OpenRouter Plugins](https://openrouter.ai/docs/guides/features/plugins) — `file-parser` を含む plugin 一覧
- OpenRouter の公開 OpenAPI 定義（`https://openrouter.ai/openapi.json`）— `ResponsesRequest` / `MessagesRequest` / `ChatRequest` のフィールド差分、`ChatUsage.server_tool_use_details`、`InputFile`
