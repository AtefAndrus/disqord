---
title: "ツール呼び出し基盤"
status: planned
priority: high
summary: "OpenRouter client tool calling のマルチターン実行基盤（tool registry + streaming ループ）"
---

# ツール呼び出し基盤

## Why

DisQord は現状、OpenRouter に対して単発の chat completion を投げるだけで、LLM が「ツールを呼ぶ → 結果を受け取る → 続きを応答する」という client-side tool calling のループを持たない。

今後入れたい複数の機能（[discord-tool](../discord-tool/design.md)・[view-image-rehydration](../view-image-rehydration/design.md)・[code-execution](../code-execution/design.md)、将来の任意 tool）はすべて、この **client tool ループ**を前提とする。各機能で個別にループを実装すると、tool_call delta の蓄積・`role:"tool"` 整合・暴走防止・streaming 連携といった「protocol まわりの難所」を重複実装することになる。

そこで、tool 呼び出しの protocol 部分（registry・request 組立・streaming 蓄積・マルチターン制御・ガードレール）を**1 つの再利用可能な基盤**として切り出し、各 tool 機能は「スキーマ + 検証 + ハンドラ（+ 任意の Discord 描画）」だけを差し込めばよい構造にする。

> server tool（`openrouter:web_search` など）は OpenRouter がサーバ側で実行するため、この client ループは**不要**。本基盤は **client/user-defined tool**（`type: "function"`）専用。両者は同一 `tools` 配列に共存できる（後述）。

## 依存 / 関連 change

- 連携: [chat-response-v2](../chat-response-v2/design.md) — tool 実行中の進捗表示・最終応答 stream は V2 の streaming updater を利用する。本基盤は updater をインタフェースとして受け取り、未実装期はスタブ（legacy embed）にフォールバックできるようにする
- 最初の利用者: [code-execution](../code-execution/design.md) — 既存設計にインラインで書かれていた tool ループを本基盤へ移管し、`execute_code` / `execute_code_with_network` を最初の登録ツールとする
- 利用者: [discord-tool](../discord-tool/design.md)、[view-image-rehydration](../view-image-rehydration/design.md)
- 関連: [web-search](../web-search/design.md) / [server-tools](../server-tools/design.md) — server tool は本基盤の外。ただし request 組立で client tool と server tool を同一 `tools` 配列に混在させる経路だけ共有する

## Goals / Non-Goals

**Goals:**

- OpenRouter Chat Completions の client tool calling（`tools` / `tool_choice` / `tool_calls` / `role:"tool"`）を扱う**汎用ループ**を提供する
- **Tool registry**: `{ name, description, parameters(JSON Schema), validate, handler }` を登録し、コンテキスト（guild 設定など）に応じて有効な tool だけを `tools` 配列に組み立てる
- **完全 streaming 対応**: delta から `content` と `tool_calls` を index ベースで蓄積し、`finish_reason === "tool_calls"` で正常完了したときだけ handler を実行、結果を `role:"tool"` で履歴に push して次ターンを継続する
- **protocol 整合の保証**: assistant メッセージ（`tool_calls` 入り）を tool 結果より**先に** push する規約、`tool_call_id` と `role:"tool"` の 1:1 対応（handler が throw/timeout しても各 call に必ず結果を返す）、id 欠落/`name` 欠落/重複 id/引数 JSON 不正/schema 不適合への防御
- **実行時 authorization**: dispatch 時にも `tool.isEnabled(ctx)` を再評価する（`buildTools` の非表示だけに依存しない）
- **暴走防止ガードレール**: `MAX_TURNS`（アシスタントターン上限。到達時は tool を出さず最終回答を強制）と `MAX_TOOL_CALLS_PER_TURN`（1 ターンの tool call 個数上限）、蓄積中の call 数/引数 byte 上限、tool ごとの timeout（`AbortSignal` で handler をキャンセル）
- client tool と server tool を**結合した** `tools` 配列を送る経路。結合後が空のときだけ `tools`/`tool_choice` を omit する

**Non-Goals:**

- 具体的な tool の実装（`execute_code` / Discord 操作 / `view_image` 等は各 change で定義し、本基盤に登録する）
- server tool 機能そのもの（web_search 等は [web-search](../web-search/design.md) / [server-tools](../server-tools/design.md)）。本基盤は「同一 `tools` 配列への混在」だけ面倒を見る
- tool 結果の Discord 描画ロジックの共通化（描画は tool ごとに大きく異なるため、各 change が独自 builder を持つ。本基盤は「描画フック（progress/結果）」のインタフェースだけ用意し、描画失敗は tool 結果生成と分離する）
- 並列 tool **実行**（v1 は **sequential**。モデルは parallel に複数 call を emit しうるが、実行は 1 件ずつ）
- tool calling 対応モデルの厳密な事前判定 UI（Open Questions 参照。v1 は結合 tool が空なら omit する分岐に留める）

**将来別 change 候補:**

- tool 実行の並列化（`parallel_tool_calls=true` + 同時実行制御）→ 将来
- tool calling 対応モデルでの `/model` choices 動的フィルタ → 別 change `model-selection-tool-filter`（code-execution の将来候補と同一）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| request 形状 | OpenAI 互換（`tools: [{type:"function", function:{name, description, parameters}}]`） | OpenRouter は「OpenAI の tool calling 形状に従い、非 OpenAI プロバイダ向けには変換する」と明記。docs: tool-calling |
| `tool_choice` | 既定 `"auto"`、必要に応じ `"none"`/特定 tool 指定。`"required"` は使うなら実 API + provider 差を実装時検証 | `auto`/`none`/特定 function は tool-calling guide に記載。`"required"` は parameters reference に記載があるが guide / `ToolChoice` 型では未掲載のため検証を要する |
| 並列 tool call | **dispatch は逐次**（次 handler を現 call が settle/abandon するまで開始しない）。`parallel_tool_calls` は多くのモデルで既定 true（モデル/provider 依存）だが、本設計は値に依存せず複数 call を 1 件ずつ処理。1 ターン 1 call に絞りたい場合のみ `parallel_tool_calls:false` | timeout で abandon した handler が遅れて完了すると厳密な逐次は崩れるため、副作用は cancellation/kill で打ち切る（下記 handler 契約） |
| choices | `n` は明示送信せず既定（1）を仮定し `choices[0]` のみ処理。parser は choice index を検証し、**空 `choices` の usage チャンク**を許容 | endpoint reference に `n` 記載がないため送らない。最終チャンクで choices が空のことがある |
| stream の正常完了判定 | `choices[].finish_reason === "tool_calls"` のときだけ蓄積 call を dispatch。`length`/`content_filter`/`error`/切断では部分 call を実行しない | 不完全な `arguments` での誤実行を防ぐ。`finish_reason` は delta ではなく choice のフィールド |
| tool 結果の履歴順序 | assistant メッセージ（`tool_calls`）を **先に push**、その後に各 `role:"tool"`（`tool_call_id` 一致）を push | OpenRouter docs が「忘れやすい」と warning。順序違反/ id 不一致は履歴 validation で reject されうる |
| handler 失敗時 / timeout | 各 call は**必ず** `role:"tool"` を生成（throw/timeout でも error 結果）。timeout は deadline が **`AbortController.abort()`** を発火し `Promise.race([handler, deadline])`（遅延 settle は破棄）。**timeout は「実行結果不明」セマンティクス**: `signal` 確認→commit には check/commit レースが残るため、副作用安全性は tool 側が **abort-aware な atomic commit / killable isolation（例 `sandbox.kill()`）/ idempotency key + 突合** のいずれかで担保する。Discord 描画失敗は tool 結果生成と分離 | `Promise.race` は副作用未発生を証明できない（外部リクエストが既に受理されうる）。安全性は tool 側の責務 |
| 実行時 authorization | dispatch 時にも `tool.isEnabled(ctx)` を**再評価**し、無効なら error 結果。`buildTools` の非表示だけに依存しない | モデルが無効な既知 tool 名を生成しても実行させない（Discord 操作/コード実行のセキュリティ境界） |
| 引数の検証 | `JSON.parse` 後に **tool の JSON Schema / zod validator で runtime 検証**。不適合は実行せず error 結果 | parse 成功は型適合を保証しない。`Args` generic は runtime で消える |
| id 欠落への対処 | stream delta に id が来ない tool_call は assistant push 時に **synthetic id を採番**し、同じ id で結果を返す | `tool_call_id` の 1:1 対応を壊さない |
| `name` 欠落 / 全 drop | `function.name` 空の call は assistant にも乗せず drop（warn）。**全 call が drop された場合は `ToolProtocolError`**（蓄積 content は診断/暫定出力としてのみ保持し、最終応答としては返さない）。loop 内での全リクエスト自動再試行はしない | `finish_reason:"tool_calls"` の content は preamble（「確認します」等）でしかないことがあり最終応答にできない。全リクエスト再試行は server tool 二重実行・二重課金を招く |
| 重複 id | 重複 `tool_call_id` には**新しい synthetic id を採番**し、assistant の正規化済み `tool_calls` と対応する tool result の双方で同じ置換 id を使う | id を捨てず 1:1 対応を維持。衝突で結果対応が壊れるのを防ぐ |
| 引数 JSON 不正 | `JSON.parse` 失敗時は error 結果（`role:"tool"`）を返して LLM に再考させる | tool を実行せず、整合した error result で次ターンへ |
| tool 結果の serialize | `handler` は `llmResult: string` を返す契約（オブジェクトを返したい tool は自前で安全 serialize）。**最大 byte 上限を loop が UTF-8 安全に強制**（多バイト境界を割らない head+tail clip）。通常結果と生成 error 結果は同一 bounded serialize 経路 | `unknown` + `JSON.stringify` は `undefined`/循環/`BigInt` で壊れる。context 肥大も防ぐ（code-execution の clip 方針と一貫） |
| 蓄積中ガード | 上限内なら `finish_reason` まで drain。`MAX_TOOL_CALLS_PER_TURN` 超過分は id/name 保持で `_err`、distinct call hard cap 超 / `index` 異常はターン `ToolProtocolError`。**ターンあたり総保持 byte 上限**（content + 全 call の id/name/args + 診断）に加え、**transport parser（`openrouter.ts`）自身が SSE フレーム/carry の最大長を強制**。いずれか超過は**ターン失敗 + semantic parse 停止 → 生バイトを EOF まで読み捨て（or transport abort）**で、`finish_reason` 探索の buffering は続けない | loop は parsed delta しか見ず、未終端 SSE は parser 内で無制限に伸びうる。drain 継続と over-cap 破棄は両立しないので over-cap で打ち切る |
| 暴走防止（ターン） | **最大 assistant リクエスト数 = `MAX_TURNS`（5）**。turn 1..4 は tools 許可、**turn 5 は tools を再送したまま `tool_choice:"none"`** で最終回答を強制（schema を残すのは過去 tool message の validation と毎ターン再送規約のため。両 field の omit は結合配列が空のときだけ）。tools 提示下で turn 5 に `finish_reason:"tool_calls"` が返れば実行せず `ToolProtocolError` | tool だけ実行して回答しない宙吊りを防ぐ。tools を omit すると過去 tool message の validation が壊れる |
| 空 tool 配列 | client + server を**結合した**配列が空のときだけ request から `tools`/`tool_choice` を omit | 一部上流は `tools:[]` + `tool_choice` を invalid（400）と判定。server tool だけの場合は omit しない |
| server tool との混在 | `runToolLoop` に server tool を引数で渡し、`registry.buildTools(ctx)` と結合。毎ターン結合済み配列を再送。dispatch 対象は client（`function`）のみ | docs「server tools と user-defined tools は同一リクエストで併用可」。server は OpenRouter がサーバ側実行 |
| tool ハンドラの戻り | `{ llmResult: string, render? }`（LLM 用文字列と Discord 描画を分離） | LLM へ渡す `role:"tool"` content と Discord 描画は別物（code-execution の head+tail clip 方針と一貫） |
| 返り値の観測契約 | `runToolLoop()` は **`Promise<ToolLoopResult>`**（判別共用体: `{status:'final', text, history, usage, model, provider}` / `{status:'cancelled', history, usage?}` / `{status:'error', error, history, usage?}`）。**usage/cost/model/provider は全ターン集計**（cancel/error は部分集計）。content は updater 経由で stream、generator return には載せない。**reject はプログラマ/不変条件違反のみ**（API/transport/parser 失敗は `status:'error'`）。request controller は await 前に登録 | 既存 `StreamFinalResult`/chat-response-v2 が usage/model 等を要求。`for await` は generator return を捨てる |
| malformed SSE フレーム | 非コメント `data:` の JSON parse 失敗は **parser/protocol 失敗**（silent skip しない）: semantic parse 停止 → ターン abort → drain/transport abort。例外: comment 行・`[DONE]`・空 choices の usage チャンク・ドキュメント化済み top-level streaming error event | 現 parser は parse 失敗を握り潰す。壊れた tool delta の後に `stop` が来ると truncate 応答を確定しうる |

## Design

### 全体像

```text
chatService
  └─ runToolLoop({ model, messages, registry, serverTools, ctx, updater })
        ├─ tools = [...registry.buildTools(ctx), ...serverTools]   ← 空なら request から omit
        ├─ openrouter.chatStream({ model, messages, tools })
        ├─ delta を蓄積（content / tool_calls[index]、call 数・byte 上限を監視）
        ├─ finish_reason === "tool_calls" のときだけ:
        │     ├─ 正規化（name 欠落 drop / synthetic id / 重複 id / JSON 不正 / schema 検証 / overflow）
        │     ├─ assistant(tool_calls) を先に push
        │     └─ 各 client call を sequential dispatch
        │           ├─ isEnabled(ctx) 再評価（NG → error 結果）
        │           ├─ updater.beginToolBlock(name)
        │           ├─ handler(args, ctx, signal)（throw/timeout でも必ず結果） → { llmResult, render }
        │           ├─ role:"tool"(tool_call_id, clip(llmResult)) を push
        │           └─ updater.endToolBlock(name, render)（描画失敗は結果と分離）
        └─ 次ターンへ（最大 MAX_TURNS、turn 5 は tools 再送 + tool_choice:none で最終回答を強制）
```

### 変更対象ファイル

**新規:**

- `src/llm/tools/registry.ts` — `IClientTool` 型と `ToolRegistry`（登録・コンテキスト別 `buildTools()`）
- `src/llm/toolLoop.ts` — `runToolLoop()`（streaming マルチターンループ本体、ガードレール、finish_reason 判定、最終ターン処理）
- `src/llm/toolHandler.ts` — `tool_calls` を registry のハンドラへディスパッチ（isEnabled 再評価・timeout/AbortSignal・error 結果保証）、`role:"tool"` 組立（id 整合・clip）
- `tests/unit/llm/toolLoop.test.ts` — delta 蓄積（id/name 分割到着・引数分割）、finish_reason 分岐、synthetic id、name 欠落/全 drop、重複 id、引数不正/schema 不適合、MAX_TURNS（turn 5 は tool_choice:none・tools 再送）/MAX_TOOL_CALLS_PER_TURN・hard cap でターン失敗、蓄積 byte 上限、handler throw/timeout の error 結果、空 tool omit、server/client 混在、**凍結スナップショット外/dispatch時 isEnabled=false の拒否、既に abort 済み request、arm 構築中の abort、cancel が handler/timeout に勝つ、active+未着手 call への cancellation 結果、cancel 後にモデル再リクエストしない、各 pre-commit 脱出で commit/abort がちょうど 1 回**
- `tests/unit/llm/registry.test.ts` — コンテキスト別の tool 絞り込み + dispatch 時 isEnabled 再評価

**修正:**

- `src/llm/openrouter.ts` — request に `tools` / `tool_choice` を渡す経路、streaming の `choices[].finish_reason` と `tool_calls` 部分パース。結合 `tools` が空なら body から omit
- `src/types/index.ts` — `ChatCompletionRequest.tools?`/`tool_choice?`、`StreamDelta.tool_calls?`、`StreamChoice.finish_reason`、`ChatMessage`（`role:"tool"`・`tool_call_id`・assistant の `tool_calls`・**tool_call を持つ assistant message の `content` は `string | null`**）、`usage`（[openrouter-api-audit](../openrouter-api-audit/design.md) と整合）
- `src/services/chatService.ts` / `src/bot/events/messageCreate.ts` — 通常チャット経路を `runToolLoop()`（`Promise<ToolLoopResult>`）経由に統一し、結果で分岐（送信/沈黙/エラー）。content は updater 経由で stream。登録 tool が無ければ実質 1 ターンで現行挙動と等価
- `src/llm/openrouter.ts`（テスト含む） — SSE parser に frame/carry 最大長と malformed-frame の protocol 失敗化を実装

### 型定義（骨子）

```ts
// src/llm/tools/registry.ts
export interface IToolContext {
  guildId: string | null;
  channelId: string;
  userId: string;
  // 各 tool が必要とする依存（discord client など）は ctx 経由で受け取る
}

export interface IClientTool<Args = unknown> {
  name: string;
  description: string;
  parameters: object; // JSON Schema（OpenRouter function.parameters）
  timeoutMs?: number;  // 省略時は dispatcher 既定（上下限でクランプ）。tool ごとに実行時間が違うため
  // この tool をこのコンテキストで使ってよいか。buildTools と dispatch の両方で評価
  isEnabled(ctx: IToolContext): boolean;
  // JSON.parse 後の runtime 検証（JSON Schema/zod）。不適合は実行前に弾く
  validate(args: unknown): { ok: true; value: Args } | { ok: false; error: string };
  // 実行。signal は timeout/中断用。llmResult は role:"tool" content（文字列、最大 byte は loop が clip）
  // meta は idempotency/reconciliation 用の実行識別子
  handler(args: Args, ctx: IToolContext, signal: AbortSignal, meta: { requestId: string; toolCallId: string; invocationId: string }): Promise<{ llmResult: string; render?: ToolRenderPayload }>;
}

export class ToolRegistry {
  register(tool: IClientTool): void;                    // 重複名・空/不正名は reject（schema と get(name) の乖離を防ぐ）
  get(name: string): IClientTool | undefined;          // dispatch 時に lookup + isEnabled 再評価
  buildTools(ctx: IToolContext): FunctionTool[];        // isEnabled が true の tool のみ。空なら []
}
```

`ToolRenderPayload` は [chat-response-v2](../chat-response-v2/design.md) の updater が解釈できる形（Container 断片など）。本基盤はこれを透過的に updater へ渡すだけで、中身の組み立ては各 tool change の責務。描画（updater 呼び出し）が失敗しても、その call の `role:"tool"` 結果生成は完了させる。

### tool ループ（streaming マルチターン）

protocol 整合の中核。[code-execution](../code-execution/design.md) にインラインで書かれていた擬似コードを汎用化して本基盤へ移管する。要点:

1. ループ開始時に `tools = [...registry.buildTools(ctx), ...serverTools]` を**一度だけ構築して凍結**し、毎ターン同一配列を再送（turn 5 は `tool_choice:"none"`）。空なら request から `tools`/`tool_choice` を omit（server tool が 1 つでもあれば omit しない）。途中で `buildTools` を再実行しない（履歴が参照する schema を消さないため。authz は dispatch 時の `isEnabled` 再評価で別途担保）。
2. `openrouter.chatStream(...)` を読み、`delta.content` は updater に **stage**（暫定表示、下記「updater への content 反映」）、`delta.tool_calls` は `index` ごとに `{ id, name, args }` を蓄積（`args` は連結）。`index` は小さい非負整数のみ受理。上限内なら `finish_reason` まで drain（soft 超過分は後段で `_err`、distinct call が hard cap 超 or index 異常はターン失敗）。ただし**総保持 byte / parser フレーム上限を超えたら semantic parse を止めてターン失敗**（生バイトは EOF まで読み捨て or transport abort。`finish_reason` 探索の buffering は続けない）。`chatStream` には caller の `AbortSignal` に加え wall-clock / idle timeout を課し、drain が無限待ちにならないようにする。
3. ストリーム終了時、`choices[].finish_reason` と接続状態で分岐（下記「ストリーム終了の判定」）。`"tool_calls"` のときだけ tool 処理へ進み、部分 call は実行しない。
4. 蓄積 call を正規化:
   - `name` 欠落 → drop（warn）。**全件 drop なら `ToolProtocolError`**（蓄積 content は診断用のみで最終応答にしない。`tool_calls` 完了時の content は preamble の可能性があるため）。loop 内の全リクエスト自動再試行はしない。
   - id 欠落 → `synthetic-<uuid>`。重複 id → 新しい synthetic id を採番（assistant tool_calls と result の双方で同じ置換 id を使う）。
   - 引数 `JSON.parse` 失敗 / 未知 tool 名 / `validate()` 不適合 → `_err`（実行せず error 結果へ）。
   - `MAX_TOOL_CALLS_PER_TURN` 超過分 → `_err`（"too many tool calls"）。
   - 正規化後は **numeric `index` 昇順**で並べる（`Map` 挿入順は断片到着順でモデル宣言順と一致しないため）。
5. assistant メッセージ（`content`〔tool_call を持つ場合 `null` 可〕 + 正規化済み `tool_calls`）を**先に** push。**`finish_reason:"tool_calls"` で正規化後の call が 0 件なら `ToolProtocolError`**（content を最終応答にしない）。通常の no-tool 最終応答は `finish_reason:"stop"` 経路（マトリクス）でのみ確定する。
6. `_err` 持ちには error の `role:"tool"`（同じ id）を push。正常分は **sequential** に dispatch。**assistant push 後は各 call が必ず結果を得る no-throw envelope** で囲む:
   - dispatch 可否は **(a) リクエストに送った凍結 client-tool スナップショットに含まれる かつ (b) 現在 `isEnabled(ctx)===true`** の両方を要求（どちらか NG → error 結果）。buildTools で除外された tool が dispatch 前に有効化されても、モデルに提示していない以上実行しない。
   - **cancellation/timeout**: handler 呼び出し前に request signal の abort を確認。実行は **3 つの結末を race**: handler 完了 / request cancel / timeout（`AbortSignal.any([requestSignal, timeoutSignal])` を handler に渡すが signal abort は promise を reject しないので、race に cancel と timeout を**明示的に含める**）。**アームは race-safe に構築**（listener を付けてから `aborted` を再確認、または等価な atomic helper。check→arm の隙間の abort を取りこぼさない）。request/timeout 両 signal に適用。timeout は `tool.timeoutMs ?? 既定` で `AbortController.abort()`。**race 結果を採用する前に signal 状態を再確認**し、優先順位 `request cancel > timeout > handler 結果` で分類する（abort が handler の reject を同時誘発しても cancel/timeout を優先）。各 call 開始前・次モデルリクエスト前にも cancel を再チェック。timer/listener は必ず cleanup。
   - **timeout/cancel はともに「実行結果不明」セマンティクス**（handler が signal を無視/遅延すると、`runToolLoop()` が `timeout`/`cancelled` を返した後に副作用が完了しうる）。副作用安全性は tool 側が **abort-aware commit / killable isolation（例 `sandbox.kill()`）/ idempotency** で担保。cancellation 結果は「実行が確実に停止した」とは主張しない。throw/timeout/cancel いずれでも **必ず** error 結果を生成（後続 call の結果欠落を防ぐ）。
   - `llmResult`（文字列）を **UTF-8 安全**に最大 byte clip して `role:"tool"` に格納。
   - **dispatch envelope**: `isEnabled`/handler/clip/フォーマット/registry/authz いずれの throw も bounded な error tool 結果に変換し、updater 呼び出しの失敗は握って log（結果生成は止めない）。**request cancel 時は実行中 + 未着手の call に bounded な cancellation 結果を埋め、以降のモデルリクエストは行わない**。`runToolLoop()` は **reject せず `{status:'cancelled', history}` を返す**（呼び出し側に確定的シグナルを与える。履歴の破棄は呼び出し側判断）。clip/format 経路自体が throw した場合に備え、**最終フォールバックの固定 ASCII 定数**で必ず結果を返す。
7. 次ターンへ。**最大 assistant リクエスト数は `MAX_TURNS`（5）**。turn 1..4 は tools を渡し、**turn 5（最終）は tools を再送したまま `tool_choice:"none"`** を送って最終回答を強制（schema を残すのは過去 tool message の validation のため。両 field omit は結合配列が空のときだけ）。turn 5 に `finish_reason:"tool_calls"` が返れば実行せず `ToolProtocolError`。
8. **毎ターン結合済み `tools` を再送**する（OpenRouter 仕様）。`tool_choice` だけターンに応じて切り替える（turn 1..4: `auto`、turn 5: `none`）。

### ストリーム終了の判定

ターン 1..5 共通。`finish_reason` と接続状態で確定的に分岐する。content を最終応答として確定するのは**正常完了（`stop`/`length`/`content_filter`）のときのみ**で、切断は完了扱いにしない。

> `finish_reason` の位置: OpenRouter の streaming guide は `choices[0].delta.finish_reason` を見るが、非 streaming 応答は choice 直下に置く。実装は **両方を正規化**（delta と choice の双方を確認）し、integration fixture で実 wire 形状を検証する。両方あって食い違う → protocol error。**未知の非 null finish_reason → error**（暗黙の完了にしない）。`stop` を受理する前に空応答チェックを行う。

**モデルリクエスト段階の cancel**: `chatStream` の前/最中の request cancel も、優先順位 `request cancel > wall/idle timeout > transport/parser 結果` で分類する（dispatch 段階と同じ no-reject 契約）。(a) 最初のリクエスト前に cancel → `beginTurn` 前なら何もせず `{status:'cancelled'}` を返す。(b) streaming 中・protocol commit 前に cancel → `abortTurn`（暫定 content 破棄）し `{status:'cancelled', history}` を返す。(c) stream の timeout/reject と同時 → **cancel を優先**分類。

**履歴 commit（最終応答）**: `stop`/`length`/`content_filter`（断片なし）で確定した content は updater だけでなく **`history` にも assistant message として append**（`ToolLoopResult.history` が返すため）。`length` の打ち切り注記は **UI のみ**で、raw な model content を履歴に入れる。cancel/error の部分 content は履歴に含めない。

**正常終了の判定**: 最初の terminal `finish_reason` で **semantic accumulation を凍結**。以降 EOF まで許可するのは `[DONE]`・comment・空 choices の usage チャンクのみで、**後続の content / tool_call delta / 矛盾する terminal reason は reject**。`finish_reason` 受領後の**クリーン EOF で正常終了**（`[DONE]` は必須でない）。raw-stream テストで `[DONE]` あり/なし両ケースを検証。

| finish_reason / 状態 | 扱い |
| --- | --- |
| `tool_calls` | 正規化して dispatch（turn 5 で `tool_choice:"none"` 下に出たら `ToolProtocolError`） |
| `stop` + tool_call 断片あり | `ToolProtocolError`（preamble を最終応答にしない） |
| `stop`（断片なし） | 通常の最終応答。蓄積 content を確定 |
| `length`/`content_filter` + tool_call 断片あり | abort/error。preamble を最終応答として確定しない |
| `length`（断片なし） | 「打ち切り注記付き」最終応答として確定 |
| `content_filter`（断片なし） | 最終応答（モデレーション理由を提示） |
| `error` / API エラー | エラーとして上位へ。content は確定しない |
| ストリーム切断 / 終端チャンク欠落 | **未完了として扱い、途中まで届いた content を「完了した assistant ターン」として確定しない**（updater は `abortTurn`） |
| 空応答（content も tool_call も無し） | **エラーとして上位へ。loop 内の自動リトライはしない**（server tool が絡むと再実行・二重課金になるため。リトライするなら上位が tool なし transport を明示選択） |

### updater への content 反映

streaming 中の `delta.content` は updater に**暫定表示（stage）**として渡し、ターンの確定は別操作にする（一度 Discord に出た暫定出力をどう片付けるかを定義するため）。

assistant ターンごとの状態機械にする:

- `updater.beginTurn()`: 新しい assistant ターンの暫定領域を開始。
- `updater.stageContent(text)`: streaming 中の暫定表示（Discord 上に見える）。
- `updater.commitTurn("tool_calls" | "final")`: 当該ターンを確定。`"tool_calls"` は preamble を確定して以降に tool ブロック/次ターンを続ける、`"final"`（`stop`/`length`/`content_filter`）は最終回答として確定。
- `updater.abortTurn(reason)`: **当該ターンの暫定出力のみ**を取り消す/「中断しました」表示へ。**既に commit 済みの過去ターン（preamble・tool ブロック）は消さない**。

**不変条件**: 成功した `beginTurn()` の後、**アダプタレベルの terminal 決定（commit か abort）をちょうど 1 回**行う。決定は**フォールバック可能な Discord 描画を呼ぶ前に状態として確定**する（アダプタは下流 Discord 遷移の成功までは保証しない。描画失敗は別途 log）。テストはこの「決定がちょうど 1 回」を検証する。**commit 前のあらゆるエラー脱出（hard-cap 違反・総 byte 超過・finish_reason 衝突/未知・空応答・正規化後 0 件・turn 5 の tool_calls・API エラー・ストリーム切断・正規化失敗）は abort 決定**。

履歴 commit は 2 系統に分ける:

- **protocol 履歴 commit**: `finish_reason:"tool_calls"` の assistant content（preamble 含む）は assistant message とともに**必ず**履歴へ保存（次ターン整合のため）。
- **最終ユーザ応答 commit**: ユーザ向け最終回答として確定するのは `stop`/`length`/`content_filter` のときのみ。

> 既存の code-execution には、この loop の擬似コード（`accumToolCalls`/`normalizedCalls`/`overflow`/`toolResultForLlm` 等）が既に書かれている。実装時はそれを本基盤の `toolLoop.ts` に移し、上記の finish_reason 判定・isEnabled 再評価・schema 検証・turn 5 の `tool_choice:"none"`・error 結果保証を加える。code-execution 側はツール定義とサンドボックス実行・描画だけを残す。

### server tool との混在

`tools` 配列には client tool（`{type:"function", function:{...}}`）と server tool（`{type:"openrouter:web_search", ...}`）を混在できる。`runToolLoop` は `serverTools`（web-search 等が付与）を引数で受け取り、`registry.buildTools(ctx)` と結合して送る。server tool は OpenRouter がサーバ側で実行し結果も自動で戻すため、`runToolLoop` の dispatch 対象には**ならない**（client の `function` tool だけ dispatch）。omit 判定は**結合後**の配列に対して行い、毎ターン結合済み schema を再送する。

なお server tool は 1 リクエスト内で 0..N 回サーバ側実行されるため、`MAX_TURNS`/`MAX_TOOL_CALLS_PER_TURN` では**抑制できない**。server tool を有効化する呼び出し側（web-search 等）は、各 server tool の `parameters`（web_search の `max_results`/`max_total_results`、fusion/advisor/subagent の `max_tool_calls`、必要なら `stop_server_tools_when` 等）でコスト/回数を別途制限する責務を負う。

### モデル対応検出

tool calling 対応は `GET /api/v1/models?supported_parameters=tools`（対応一覧）に加え、`GET /api/v1/model/{author}/{slug}` で**個別モデルの `supported_parameters` も取得できる**。v1 は厳密な事前判定 UI を作らず、結合 tool が空なら omit する分岐に留める。「client tool を登録したコンテキストで非対応モデルが選ばれた場合」の挙動（OpenRouter は tools 送信時に tool 対応プロバイダへルーティングするとされるが、選択モデル自体が非対応の場合は未定義）は Open Questions で扱い、必要なら別 change `model-selection-tool-filter` でモデル ID 照合 + キャッシュ + fallback を設計する。

## Tasks

- [ ] `src/types/index.ts` に tool 関連型（`ChatMessage` の `tool`/`tool_calls`、`ChatCompletionRequest.tools`、`StreamDelta.tool_calls`、`StreamChoice.finish_reason`）を追加
- [ ] `openrouter.ts`: request への `tools`/`tool_choice` 付与（**結合後**が空なら omit）、streaming の `finish_reason` と `tool_calls` パース
- [ ] `src/llm/tools/registry.ts`: `IClientTool`（`isEnabled`/`validate`/`handler(signal)`）/ `IToolContext` / `ToolRegistry.buildTools()` / `get()` / `register()`（重複名・不正名 reject）
- [ ] `src/llm/toolHandler.ts`: dispatch（isEnabled 再評価・`Promise.race` timeout・throw/timeout でも error 結果）+ `role:"tool"` 組立（id 整合・最大 byte clip）
- [ ] `src/llm/toolLoop.ts`: streaming マルチターンループ（`n=1`/`choices[0]`、delta 蓄積〔drain 継続 + 保持量上限〕、ストリーム終了判定マトリクス、正規化〔name 欠落/全 drop/重複 id→synthetic/JSON 不正/schema 検証/overflow〕、turn 5 は `tool_choice:"none"`〔tools 再送〕、server/client 結合）
- [ ] `chatService`/`messageCreate` を `runToolLoop()`（`Promise<ToolLoopResult>`）経由に統一（tool 未登録時は現行と等価）、結果で分岐
- [ ] `openrouter.ts` SSE parser: frame/carry 最大長強制 + malformed-frame の protocol 失敗化。`tests/unit/llm/openrouter.test.ts` に **raw-stream テスト**（未終端 carry/frame 過大、chunk 境界跨ぎ UTF-8 byte 計算、ちょうど上限、malformed JSON、abort/drain、parser 失敗と同時の cancel 優先）
- [ ] unit test（上記の各分岐を mock stream で網羅）
- [ ] `docs/changes/tool-calling-foundation/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **streaming の tool_call delta 形状**: OpenRouter は Chat Completions streaming で `delta.tool_calls`/`delta.finish_reason` を文書化済み。index ベースの蓄積（`function.arguments` の分割連結、`id`/`name` は最初の断片）を用いるが、**provider 差は fixture で検証**する。非 streaming 経路（`tool_calls` がまとめて返る）を使う場合は**事前に選択する transport** とし、streaming 失敗後の自動リトライにはしない（server tool の二重実行・二重課金を避ける）。
- **非対応モデルでの client tool**: client tool を登録したコンテキストで tool 非対応モデルが選択された場合の挙動が未定義。実 API で確認し、必要なら `model-selection-tool-filter` でモデル ID 照合 + fallback を設計。
- **`length` の注記文言**: tool_call 断片なしの `length` は「打ち切り注記付きで確定」（マトリクスで確定済み）。ユーザ向け注記の具体文言のみ運用調整。
- **`tool_choice:"required"` の可用性**: parameters reference には記載があるが tool-calling guide / `ToolChoice` 型では未掲載。使うなら実 API + provider 差を検証。
- **プロバイダ差**: OpenRouter は OpenAI 形状を各プロバイダ向けに変換するため、tool_choice の厳密さや並列挙動・finish_reason の出方に差が出うる。load-bearing な箇所は実装時に再確認。
- **chat-response-v2 未完時の進捗表示**: updater をスタブ化（legacy embed）して先行実装できる構造にする。
- **既存単発チャットとの等価性**: tool 未登録時に `runToolLoop` が現行の単発応答と完全に等価（余計な 1 ターンや遅延が出ない）であることをテストで担保する。

## 参照

- [OpenRouter Tool Calling](https://openrouter.ai/docs/guides/features/tool-calling) — `tools`/`tool_choice`、`tool_calls`（`choices[].message.tool_calls`、`function.arguments` は JSON 文字列）、`role:"tool"` + `tool_call_id`、assistant を先に push、`parallel_tool_calls`（既定 true）
- [OpenRouter Chat API reference](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request) — `finish_reason`（choice フィールド）、`tool_choice` 値
- [OpenRouter Server Tools Overview](https://openrouter.ai/docs/guides/features/server-tools/overview) — client/server tool の同一 `tools` 配列併用、server tool はサーバ側実行
- [OpenRouter Models filter](https://openrouter.ai/docs/guides/overview/models) — `GET /api/v1/models?supported_parameters=tools`（対応一覧の取得 API）
