---
title: "Responses API への移行"
status: in-progress
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
- **後続 change が必要とするリクエストフィールドの伝搬機構を用意する**。`runToolLoop()` は毎ターンのリクエストを明示的な名前付きフィールドで組み直すため、新しいフィールドは自動伝搬しない。パススルーの器（`IToolLoopParams.requestFields`）を本 change で作り、呼び出し側が値を入れなければ振る舞いは変わらない状態にする
- **`AggregatedUsage` を実際に返る usage フィールドへ広げる**。`cache_write_tokens` / `cost_details` / `server_tool_use_details` をターンをまたいで集計する

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
| tool call の受け取り | `response.function_call_arguments.delta` を蓄積する現行経路を維持し、`response.output_item.done` の完成形 `arguments` は蓄積済み delta との長さ照合にのみ使う。delta が一度も流れなかった call に限り、完成形を唯一の `argumentsDelta` として渡す | 蓄積経路にはフレーム上限と carry buffer のガードが入っている。移行と同時に捨てると、退行したときの切り分けが難しくなる。長さ照合は、delta の欠落で切り詰められた JSON が偶然 parse できて tool handler に届く事故を防ぐ |
| tool call の識別子 | Responses の `call_id` を現行の `ToolCall.id` へ写像する | `toolLoop.ts` は `role:"tool"` の `tool_call_id` で突き合わせる。写像しておけば dispatcher 側は無変更で済む |
| tool call の index | `output_index` をそのまま `StreamToolCallDelta.index` にする | `output_index` は 1 レスポンス内で item ごとに一意で、出力順に増える。accumulator が要求するのは一意性と順序だけであり、reasoning や message の item が間に入って値が連番にならなくても支障が無い |
| provider の取得 | `X-OpenRouter-Metadata: enabled` ヘッダを送り、`openrouter_metadata.endpoints.available[]` のうち `selected: true` の `provider` を読む。形が想定外なら provider を不明として扱い、エラーにしない | Responses のレスポンスにはトップレベルの `provider` が無く、footer の「Provider:」行が消える。provider は表示専用なので、本文が届いた turn を metadata の形だけで落とさない |
| heartbeat として通すイベント | 受理したイベントのうち呼び出し側へ渡すものが無いものすべて。client が知らない `type` も拒否せず heartbeat にする | `STREAM_IDLE_TIMEOUT_MS` が測るのは受信の途絶であり、どのイベントの到着も接続が生きている証拠になる。reasoning だけを数分流すモデルを停止と誤判定しない。未知の `type` を受理するのは client 側の前方互換の方針である（OpenAPI 定義の `StreamEvents` は閉じた集合を列挙している）。イベント型が追加されたときに、client が追随するまで全 turn が失敗する状態を避ける。イベントを流し続けるストリームは `STREAM_WALL_TIMEOUT_MS` が打ち切る |
| deprecated フラグ | `usage: { include: true }` は送らない | Responses に当該フィールドは無く、usage は指定なしで返る |
| エラー処理 | `handleErrorResponse()` と `AppError` 系の分類を無変更で流用する | 実測でエラーの封筒が両 API で同一（後述） |
| SSE 読み取り | フレーム分割、UTF-8 の fatal デコード、フレームサイズ上限、carry buffer のガードを無変更で流用する | 実測で `data:` 行の連なりと `data: [DONE]` 終端が同一（後述） |
| `listModels` / `listModelsWithPricing` / `getCredits` / `isRateLimited` | 無変更 | `/models` と `/key` は API surface に依存しない |

## Design

### 実測で確認した事実

以下は 2026-09-18 と 2026-09-19 に実際にリクエストを送って確認した。

**そのまま流用できるもの:**

- エラーの封筒が同一である。存在しないモデル ID は両 API とも `{"error":{"message":"nope/nope is not a valid model ID","code":400}}`、認証失敗は `{"error":{"message":"User not found.","code":401}}` を返す
- SSE の枠組みが同一である。`data:` 行の連なりで、終端は `data: [DONE]`
- `plugins` が使える。Responses が受け付けるのは `auto-beta-router` / `auto-router` / `context-compression` / `file-parser` / `fusion` / `moderation` / `pareto-router` / `response-healing` / `web` / `web-fetch`
- `session_id` / `provider` / `models`（フォールバック）/ `metadata` / `trace` / `service_tier` / `cache_control` / `reasoning` / `parallel_tool_calls` / `max_tool_calls` / `stop_server_tools_when` / `prompt_cache_key` / `prompt_cache_options` / `modalities` / `image_config` がある
- client function tool と server tool を同一リクエストへ混在させられる。`{"type":"function",...}` と `{"type":"openrouter:datetime",...}` を同時に渡して 200 が返り、server tool は実行され `usage.server_tool_use_details` に計上された
- `tool_choice: "none"` が効く。function tool を渡した状態で送っても `function_call` item は出ない
- tool 実行後の再リクエストが通る。`{role:"assistant"}` の message、`function_call` item、`function_call_output` item を `input` に並べ、reasoning item を含めずに送って 200 が返る（`openai/gpt-5-nano` と `google/gemini-2.5-flash-lite` で確認）
- `ChatCompletionRequest` に無いフィールド（`max_output_tokens`）を透過させて送ると効き、打ち切りが `response.incomplete` として返る
- `OpenRouterClient` と `runToolLoop()` を通して、テキスト、並行 tool call 2 件の往復、画像入力、`file-parser` を使う PDF 入力が次のモデルで通る（2026-09-19）: `openai/gpt-6-astra`、`anthropic/claude-sonnet-5`、`google/gemini-3.8-flash`、`google/gemini-3.5-flash-lite`、`google/gemini-3.1-pro-preview`、`x-ai/grok-4.6`、`qwen/qwen3.8-max-0902`、`moonshotai/kimi-k3`、`mistralai/mistral-medium-3-5`。`deepseek/deepseek-v4-pro-0813` と `z-ai/glm-5.3` は画像入力に対応しないモデルで、画像だけ 404（`No endpoints found that support image input`）になり、ほかの 3 項目は通る
- 無料モデル（`google/gemma-4-26b-a4b-it:free`、`qwen/qwen3.8-27b:free`）は同日、上流の共有プールの 429 が続き、`RateLimitError` に分類されることだけを確認した

**書き換えが要るもの:**

- `messages` が `input` になる
- function tool の定義が flat になる
- usage のフィールド名が変わる
- ストリームが型付きイベントの列になる
- マルチモーダル入力の part 名が変わる
- function を名指しする `tool_choice` が flat になる（`{type:"function", name}`）
- レスポンスからトップレベルの `provider` が無くなる

### リクエストの対応

| 現行（Chat Completions） | 移行後（Responses） |
| ------------------------ | ------------------- |
| `messages: ChatMessage[]` | `input: InputItem[]` |
| `{role:"system", content}` | `{role:"system", content}`（そのまま） |
| `{role:"user", content}` | `{role:"user", content}`（そのまま） |
| `{role:"assistant", content, tool_calls}` | `{role:"assistant", content}` と、`tool_calls` 各要素を `{type:"function_call", call_id, name, arguments}` として**並べて置く** |
| `{role:"tool", content, tool_call_id}` | `{type:"function_call_output", call_id, output}` |
| `{type:"text", text}` | `{type:"input_text", text}` |
| `{type:"image_url", image_url:{url}}` | `{type:"input_image", image_url: <url>, detail:"auto"}`（`image_url` はオブジェクトではなく文字列） |
| `{type:"file", file:{filename, file_data}}` | `{type:"input_file", filename, file_data}` |
| `tools: [{type:"function", function:{name, description, parameters}}]` | `tools: [{type:"function", name, description, parameters}]` |
| `tools: [{type:"openrouter:<id>", parameters}]` | 同じ（server tool は無変更） |
| `tool_choice`（`"auto"` / `"none"` / `"required"`） | 同じ |
| `tool_choice: {type:"function", function:{name}}` | `tool_choice: {type:"function", name}` |
| `parallel_tool_calls` | 同じ |
| `plugins` | 同じ |
| `usage: {include: true}` | 送らない |

`input_image` の `image_url` は、Chat Completions ではオブジェクト（`{url}`）だが Responses では文字列である点に注意する。
OpenAPI 定義の `InputImage` は `detail` を必須としている。
実 API は `detail` なしでも受け付けたが、定義に合わせて `"auto"` を送る。
`input_file` の `file_data` は現行と同じく `data:application/pdf;base64,...` 形式の data URL を受け付ける。
`file-parser` plugin と組み合わせて PDF の本文がモデルへ渡ることを実測で確認した。

### ストリームイベントの対応

Responses のイベント型と、`chatStream()` が yield する正規化済みチャンクの対応は次のとおり。

| Responses のイベント | yield するもの |
| -------------------- | -------------- |
| `response.output_text.delta` | `StreamChunk`（`content` に delta を入れる）。空文字の delta は heartbeat |
| `response.output_item.added`（`item.type === "function_call"`） | `StreamToolCallChunk`（`output_index` を `index` へ、`call_id` を `id` へ、`name` を設定） |
| `response.function_call_arguments.delta` | `StreamToolCallChunk`（`argumentsDelta`） |
| `response.output_item.done`（`item.type === "function_call"`） | `StreamToolCallChunk`（`id` と `name` の再送）。当該 call を完成済みとして記録する |
| `response.completed` | `usage` を載せた `StreamHeartbeatChunk`。`finishReason` を確定する |
| `response.incomplete` | 同上。`finishReason` は `incomplete_details.reason` から導く |
| `response.failed` | `response.error` を API エラーとして throw |
| `error`（`{type:"error", code, message}`） | API エラーとして throw |
| 上記以外（`response.created`、`response.content_part.added`、`response.output_text.done`、reasoning の delta、server tool の item、未知の `type` など） | `StreamHeartbeatChunk` |
| `data: [DONE]` | `StreamFinalResult`（`fullText` / `usage` / `model` / `provider` / `finishReason`）を yield して終端 |

function call の `call_id` と `name` は `response.output_item.added` の時点で届き、`response.output_item.done` で同じ値が再送される。
両方を `StreamToolCallChunk` として渡し、食い違いの検出は `toolLoop.ts` の既存ガード（同一 index で異なる id / name を拒否する）に任せる。

reasoning の本文は `response.reasoning_text.delta` のほか `response.reasoning_summary_text.delta` でも流れる（`openai/gpt-5-nano` は後者だけを流す）。
どちらも heartbeat として扱い、本文は捨てる。

`response.output_item.added` は server tool の実行を独立した item として通知する（例: `{"type":"openrouter:datetime","id":"st_tmp_..."}`）。
Chat Completions では観測できなかった情報だが、本 change では heartbeat として扱い、進捗表示には使わない。

mid-stream のエラーは Responses では flat な `{type:"error", code, message}` として定義されている。
HTTP エラーと同じ `{error:{code,message}}` の封筒が Responses のストリームに流れうるかは未検証なので、こちらも引き続き API エラーとして受理する。

終端イベント（`response.completed` / `response.incomplete`）を受けたあとに許すのは `data: [DONE]` とコメント行だけで、それ以外の `data:` フレームは protocol error にする。

**`finishReason` の導出**は次のとおり。

| 終端イベント | `finishReason` |
| ------------ | -------------- |
| `response.completed`、完成した function call が 1 件以上 | `"tool_calls"` |
| `response.completed`、完成した function call が無い | `"stop"` |
| `response.incomplete`、`incomplete_details.reason` が `max_output_tokens` | `"length"` |
| `response.incomplete`、`reason` が `content_filter` | `"content_filter"` |
| `response.incomplete`、それ以外の `reason` | `"incomplete"`（`toolLoop.ts` が未知の finish_reason として拒否し、暗黙の完了にしない）。元の `reason` はログに残す |

Responses には `finish_reason: "tool_calls"` に当たる値が無く、打ち切りは `response.completed` の `status` ではなく別イベントの `response.incomplete` で通知される。
`response.incomplete` の `reason` は wire の文字列をそのまま渡さない。
`"tool_calls"` や `"stop"` という値が来ると、`toolLoop.ts` の dispatch 分岐や正常完了分岐を選べてしまうためである。

function call のライフサイクルは、`output_index` をキーにした一つの表で追い、次の規則を client の一箇所で強制する。

- call は、その `output_index` を持つ最初のイベント（`added` / arguments の delta / `done`）で開く
- `response.output_item.done` は文字列の `arguments` を必ず持ち、その長さが蓄積済み delta の長さと一致する（delta が一度も流れていない場合は、完成形を唯一の `argumentsDelta` として渡す）
- `done` に達した call は凍結し、以後その `output_index` に届く delta / `added` / `done` は protocol error にする

`toolLoop.ts` は蓄積した call をそのまま dispatch するので、この規則のどれかを飛ばした call が `"tool_calls"` の終端に到達する経路は、すべてここで塞ぐ。
`response.completed` の時点で `done` に至っていない function call が一つでも残っていれば protocol error にする。
受理すると、`arguments` の長さ照合を経ていない call が完成済みの call と並んで実行されるためである。
`response.incomplete` では未完成の call を許す。打ち切りでは起こりうる状態であり、`toolLoop.ts` は `"length"` / `"content_filter"` で tool call の断片が残っていれば dispatch せずエラーにする。
`toolLoop.ts` は `finishReason === "tool_calls"` で分岐しているので、client 側で完成した call を数えて合成すれば dispatcher は無変更で動く。

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
| `cost_details.server_tool_cost`（Responses で新たに読む） | 同じ |
| `server_tool_use_details` | 同じ |
| `is_byok` | 同じ |

client 内で Responses 形から現行形へ写像し、下流には現行の形のまま渡す。

あわせて `ChatCompletionResponse["usage"]` の型を、Responses が実際に返すフィールドへ揃える。
追加するのは `prompt_tokens_details.cache_write_tokens`、`cost_details` の 4 フィールド、`is_byok`、`server_tool_use_details` である。
`video_tokens` / `image_tokens` / `audio_tokens` は Chat Completions の `ChatUsage` にだけあり、Responses の usage には存在しないので型へ入れない。
`src/utils/chatContainerBuilder.ts` の `UsageMetadata` は同じ形を手書きで複製しているので、`ChatCompletionResponse["usage"]` のエイリアスへ置き換えて定義を一本化する。

`cost`、`cache_write_tokens`、`cost_details.upstream_inference_cost`、`server_tool_use_details` とその各カウンタは `null` で返ることがある。
`null` は未報告を意味するので 0 にはせず、キーごと省く。

`server_tool_use_details` は、server tool が一度も起動しなかったリクエストでは usage から省かれる。
未起動と 0 回を区別する必要があるので、値ではなくキーの有無で判定する。
カウンタが一つも報告されなかった場合も、キー自体は空オブジェクトとして残す。

### リクエストフィールドの伝搬機構

`runToolLoop()` は毎ターンのリクエストを次の形で組み立てる。

```ts
const request: ChatCompletionRequest = {
  ...requestFields,
  model,
  messages: [...history],
  ...(plugins && { plugins }),
  ...(hasTools && { tools, tool_choice: toolChoice }),
};
```

loop が自分で組み立てるフィールド（`model` / `messages` / `plugins` / `tools` / `tool_choice`）は名前付きで列挙しており、それ以外のフィールドには入口が要る。
入口が無いと、次の三つの change がそれぞれ同じ配管を通すことになる。

- [対話UX改善（会話履歴ストア）](../conversation-context/design.md) — `session_id` を通常生成・tool 後の再リクエスト・retry のすべてへ渡す
- [OAuth BYOK](../oauth-byok/design.md) — ユーザ別の API キーを全ターンへ渡す。`chatStream()` を実際に呼ぶのは loop の中であり、loop を通る経路が無いとキーを切り替えられない
- [設定階層化 + LLMパラメータ](../settings-hierarchy/design.md) — 解決済みの生成パラメータを全ターンへ渡す

本 change は、この三つが値を載せるための器として `IToolLoopParams.requestFields` を用意する。
型は `ChatCompletionRequest` から loop が所有する 5 フィールドを除いたもので、`ChatCompletionRequest` に項目を足せばそのまま載せられる。
`requestFields` は毎ターンのリクエストの先頭へ spread するので、通常生成・tool 後の再リクエスト・最終ターンのすべてに同じ値が届く。
`OpenRouterClient` は `ChatCompletionRequest` のうち自分が変換しないフィールドを body へそのまま透過させるので、`session_id` や生成パラメータのような body フィールドは client 側の変更なしで届く。
API キーは body ではなく `Authorization` ヘッダに載るので、この透過だけでは切り替わらない。
`requestFields` が用意するのは「値を毎ターンの `chatStream()` 呼び出しまで運ぶ経路」までであり、運ばれたキーを client がヘッダへ使い、body からは除く処理は [OAuth BYOK](../oauth-byok/design.md) が実装する。
`requestFields` に loop が所有するフィールドが紛れ込んでいた場合は、spread の前に取り除く。
誰も値を入れていない現在は送出内容が変わらないことをテストで固定する。
どのフィールドを載せるかは各 change が決める。

### usage 集計の拡張

`AggregatedUsage` は `ChatCompletionResponse["usage"]` から `is_byok` を除いた型とし、`addUsage()` は各 details オブジェクトのうちターンが実際に報告したキーだけを足し込む。
`is_byok` はリクエスト単位のフラグで、合算に意味が無いので集計しない。

後続 change は次を要求している。

- [Web 検索 + ツイート展開](../web-search/design.md) — ターンをまたいだ server tool 実行回数の累計（`usage.server_tool_use_details`）
- [対話UX改善（会話履歴ストア）](../conversation-context/design.md) — cache read / write トークンの記録（`prompt_tokens_details.cache_write_tokens`）
- [使用統計](../usage-stats/design.md) — 上記を `usage_logs` へ保存する

parser から集計までを本 change が所有し、保存は [使用統計](../usage-stats/design.md) が所有する。
未返却のフィールドは 0 と同一視せず、キーの有無で「不明」と区別できる形を保つ。

### 変更対象ファイル

- 修正: `src/llm/openrouter.ts` — エンドポイントを `/responses` へ変更。リクエスト変換（`messages` → `input`、tool 定義の flat 化、part 名の変換）、イベント写像、usage 写像を追加。SSE 読み取りの枠組みとエラー処理は維持
- 修正: `src/types/index.ts` — Responses の wire 形を表す内部型を追加。`ChatCompletionResponse["usage"]` を実返却フィールドへ拡張
- 修正: `src/utils/chatContainerBuilder.ts` — `UsageMetadata` を `ChatCompletionResponse["usage"]` のエイリアスへ置換
- 修正: `src/llm/toolLoop.ts` — `requestFields` の毎ターン引き継ぎ、`AggregatedUsage` の拡張と `addUsage()` の集計対象追加
- 無変更: `src/services/chatService.ts` — 正規化済みチャンクの契約が維持されるため変更しない
- 修正: `tests/unit/llm/openrouter.test.ts` — リクエストボディのアサーションを Responses 形へ更新。イベント写像のフィクスチャを追加
- 修正: `tests/unit/llm/toolLoop.test.ts` — mock クライアントを使うテストは、yield される正規化済みチャンクが変わらないため無変更。実 `OpenRouterClient` を通す結合テストだけ SSE フィクスチャを Responses 形へ更新する。usage を content と同じフレームに載せるケースは Responses に対応する wire 形が無い（usage は終端イベントにしか載らない）ので削除する

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

- [x] Responses の wire 形を表す内部型を `src/types/index.ts` へ追加
- [x] `ChatCompletionRequest` → Responses リクエストの変換関数を実装（`input` への写像、tool 定義の flat 化、part 名の変換、`usage:{include:true}` の非送出）
- [x] Responses レスポンス → `ChatCompletionResponse` の変換関数を実装（`output` 配下の `message` item からテキストを組み立て、usage を写像）
- [x] `chat()` を `/responses` へ載せ替え、`chatService.ts` の呼び出し（1 箇所）が無変更で通ることを確認
- [x] `ChatCompletionResponse["usage"]` を実返却フィールドへ拡張し、`chatContainerBuilder` の `UsageMetadata` をエイリアス化
- [x] `GET /api/v1/key` の `data.limit_remaining` が現行の読み方と食い違っていないことを確認（上限未設定のキーでは `null` が返り、`getCredits()` の `?? Infinity` は意味的にも正しい）。コード変更は不要

### Phase 2: ストリーミング経路

- [x] イベント写像を実装（上表）。SSE 読み取りの枠組み、UTF-8 の fatal デコード、フレーム上限、carry buffer のガードは流用する
- [x] tool call の写像を実装（`call_id` → `id`、`arguments` の delta 蓄積、完成判定から `finishReason: "tool_calls"` の合成）
- [x] 終端イベントから `StreamFinalResult` を組み立て、`finishReason` の導出元を実 wire で確定する
- [x] reasoning イベントを heartbeat として扱い、本文を捨てることを確認する
- [x] `chatStream()` を `/responses` へ載せ替え、`chatService.ts` が無変更で通ることを確認
- [x] `runToolLoop()` にリクエストフィールドの毎ターン引き継ぎを実装し、誰も値を入れていない状態で送出内容が変わらないことをテストで固定
- [x] `AggregatedUsage` を拡張し、`addUsage()` に `cache_write_tokens` / `cost_details` / `server_tool_use_details` の集計を追加。未返却フィールドを 0 と同一視しないことをテストで固定

### Phase 3: 回帰

- [x] 既存の unit test を通す。`tests/unit/llm/openrouter.test.ts` のボディアサーションを Responses 形へ更新
- [x] イベント写像のフィクスチャを追加（テキストのみ、tool call を含む、server tool を含む、reasoning を含む、`response.incomplete` / `response.failed` / `error`）
- [x] キャンセル（停止ボタン）が `AbortSignal` で従来どおり効くことを確認
- [x] エラー分類の回帰（401 / 400 invalid model / 429）を確認
- [x] 実 API で確認する（`OpenRouterClient` と `runToolLoop` を直接駆動）: 非ストリーミング、並行 tool call と server tool の混在、画像入力、PDF 入力、無効モデルの 400、stream 途中のキャンセル、`max_output_tokens` による打ち切り
- [x] Discord 上で確認する（開発用 bot、`google/gemini-3.7-flash`）: 通常のチャットと長文の分割送信。footer の項目（Tokens / Cost / Model / Latency / Provider / Reasoning / TPS）とページ分割は、同じ発言に応答した Chat Completions 版の bot と一致した
- [ ] Discord 上で確認する: 画像添付、PDF 添付、停止ボタン
- [ ] `bun run preview` で表示の回帰を確認

### Phase 4: 後続への引き継ぎ

- [ ] [コード実行](../code-execution/design.md) の design を、microsandbox 統合から `openrouter:shell` 前提へ書き直す
- [x] [設定階層化 + LLMパラメータ](../settings-hierarchy/design.md) へ、`supported_parameters` をそのまま許可リストにできない制約を注記する
- [x] [推論内容の取得・表示](../reasoning-output/design.md) へ、reasoning が専用イベントで流れることを注記する
- [x] [Web 検索 + ツイート展開](../web-search/design.md) の usage 読み取り先を `usage.server_tool_use_details` へ訂正する
- [ ] `docs/changes/responses-api-migration/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **server tool の usage が API で異なる**: Chat Completions と Responses はどちらも `usage.server_tool_use_details` を返すが、Anthropic Messages API は `usage.server_tool_use` を返す。Messages API は採用しないので影響は無いが、ドキュメントの記述を読むときに混同しない
- **refusal を本文として扱っていない**: Responses は拒否応答を `response.refusal.delta` と、message の `{type:"refusal"}` part で返す。client はどちらも本文に写像しないので、拒否だけの応答は `toolLoop.ts` の空応答エラーになる。Chat Completions 版も `refusal` フィールドを読んでおらず同じ結果だったので、本 change では挙動を変えない。拒否文をユーザへ見せるかどうかは別 change で決める
- **プロバイダ差**: Responses は OpenRouter が各プロバイダの API へ変換して呼ぶ。Chat Completions で動いていたモデルが Responses で同じ挙動になるとは限らない。既定モデルを含め、実際に使うモデルで回帰を確認する
- **`instructions` を使わない選択**: system prompt を `input` の `{role:"system"}` として送る。将来 `instructions` 固有の挙動（プロバイダ側で別扱いされる等）が必要になった場合は、その時点で切り替えを検討する

## 参照

- [OpenRouter Responses API](https://openrouter.ai/docs/api/reference/responses/overview) — stateless であり `store` / `previous_response_id` は 400
- [OpenRouter Server Tools](https://openrouter.ai/docs/guides/features/server-tools) — ツールごとの対応 API surface、`max_tool_calls` と `stop_server_tools_when`
- [OpenRouter Shell Server Tool](https://openrouter.ai/docs/guides/features/server-tools/shell) — Chat Completions では 400、Responses と Messages でのみ利用可能
- [OpenRouter Plugins](https://openrouter.ai/docs/guides/features/plugins) — `file-parser` を含む plugin 一覧
- OpenRouter の公開 OpenAPI 定義（`https://openrouter.ai/openapi.json`）— `ResponsesRequest` / `MessagesRequest` / `ChatRequest` のフィールド差分、`ChatUsage.server_tool_use_details`、`InputFile`
