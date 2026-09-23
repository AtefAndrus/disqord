---
title: "OpenRouter サーバツール群"
status: investigating  # investigating | planned | in-progress | implemented
priority: medium       # high | medium | low
summary: "image_generation / fusion / advisor / subagent の OpenRouter server tool 群（web_search/web_fetch は web-search 側）"
---

# OpenRouter サーバツール群

## Why

OpenRouter には `{type:"openrouter:<id>"}` 形式の **server tool**（OpenRouter がサーバ側で実行し、結果も自動でレスポンスに織り込む）が複数ある。これらは client tool calling のループ（[tool-calling-foundation](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/tool-calling-foundation/design.md)）を必要とせず、リクエストの `tools` 配列に 1 要素足すだけで「画像生成・複数モデル合議・上位モデルへの相談・安価モデルへの委譲」をモデル判断で呼べるようになる。

`openrouter:web_search` / `openrouter:web_fetch` は [web-search](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/web-search/design.md) で扱う。本 change は **それ以外**の server tool 群 — `openrouter:image_generation` / `openrouter:fusion` / `openrouter:advisor` / `openrouter:subagent` — を 1 つの調査束として棚卸しし、各ツールが「何を返すか・どのパラメータでコスト/回数を縛るか・DisQord のどの機能に使えるか」を確定させる。個々の採否・実装は後で release 単位に**フォルダ分割**して切り出す（status は `investigating`、束ねたまま調査）。

> server tool は本基盤の client ループの**外**で実行される。`tool-calling-foundation` は「client tool と server tool を**同一 `tools` 配列に混在**させて送る経路」だけを共有し、server tool の dispatch は行わない（OpenRouter がサーバ側で実行）。本 change はその混在経路に server tool を載せる側。

## 依存 / 関連 change

- 関連: [Responses API への移行](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/responses-api-migration/design.md) — server tool の送り方は両 API で同じだが、実行が独立した output item として観測できるようになる。実 wire の fixture 化は移行後に行う
- 先行: [tool-calling-foundation](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/tool-calling-foundation/design.md) — client tool と server tool を結合した `tools` 配列を送る経路（`runToolLoop` の `serverTools` 引数）を提供する。本 change の server tool はそこへ載せる
- 関連: [web-search](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/web-search/design.md) — `openrouter:web_search` / `openrouter:web_fetch` は**そちら**で定義。本 change では再定義しない（`web_fetch` は本 change の各 server tool の nested `tools` 候補としてのみ言及）
- 関連: [Responses API への移行](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/responses-api-migration/design.md) — `ChatCompletionRequest`/`usage` 型の現行 API 整合。本 change の server tool パラメータ型・`server_tool_use_details` 取り込みはその整合方針に従う
- 関連: [出力マルチモーダル対応](../multimodal-output/design.md) — `image_generation` の producer adapter が検証済み成果物を渡した後の Discord 添付とレイアウトを所有する

## Goals / Non-Goals

**Goals:**

- 4 つの server tool（`image_generation` / `fusion` / `advisor` / `subagent`）について、用途・パラメータ・返り形・コスト特性・コスト/回数制御の責務・DisQord での適用先候補を**調査ドキュメント**として確定する
- 本 change で設計しないその他の server tool（`openrouter:files` / `openrouter:tool_search` / `openrouter:experimental__search_models`）を棚卸しし、候補かどうかを記録する
- server tool は `MAX_TURNS` / `MAX_TOOL_CALLS_PER_TURN`（client ループのガード）では**抑制できない**点を明文化し、リクエスト直下の `max_tool_calls` / `stop_server_tools_when` と、各 server tool の `parameters`（本 change 4 ツールでは `analysis_models` と `max_tool_calls`〔fusion〕/ `max_tool_calls`〔subagent〕/ image_generation の `model`・`quality`・`size` と ON/OFF。`max_results`/`max_total_results`/`max_uses` は web_search 用でスコープ外）で呼び出し側がコスト/回数を縛る責務を定義する
- `fusion` が **単一合成回答を返さず**、panel の構造化分析を返すことを明確にする
- `advisor` には nested `tools` も `max_tool_calls` も**無い**こと、`subagent` には両方があり、さらに `inherit_functions` / `inherited_function_names`（EXPERIMENTAL）で呼び出し側の client function tool を継承できることを記録する
- どの server tool を最初に release 単位として切り出すかの判断材料を残す

**Non-Goals:**

- 本 change での実装そのもの（status は `investigating`。各 server tool は採否確定後、release 単位でフォルダ分割して実装する）
- `openrouter:web_search` / `openrouter:web_fetch` の定義（[web-search](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/web-search/design.md)）
- client tool calling ループ自体（[tool-calling-foundation](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/tool-calling-foundation/design.md)）
- server tool 結果の Discord 描画ロジックの確定（画像とファイルの共通描画は [出力マルチモーダル対応](../multimodal-output/design.md)、その他の構造化結果は採用する server tool ごとに別途設計）

**将来別 change 候補:**（採用が決まった server tool は release 単位で独立フォルダへ）

- 画像生成 → 別 change `image-generation`（採用時。API 付与、費用制御、wire 検証、producer adapter を所有し、Discord 描画は [出力マルチモーダル対応](../multimodal-output/design.md) を利用）
- 合議（fusion）→ 別 change `model-fusion`（採用時）
- advisor / subagent → 別 change（採用時。下位/上位委譲の UX を別途設計）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 4 ツールの束ね方 | 1 フォルダ・単一 `design.md`、Design を server tool 別小節（`---` 区切り）に分割 | 調査段階で release 単位が未確定。採用が決まったものから別フォルダへ切り出す（CLAUDE.md 粒度方針） |
| status | `investigating`（採否・優先度は調査後） | どれを最初に出すか未確定。実装着手で `in-progress` へ |
| server tool の送り方 | `tools` 配列に `{type:"openrouter:<id>", parameters?:{...}}` を追加（パラメータは `parameters` キー配下。top-level spread ではない）。client tool と同一配列に混在可 | docs「server tools と user-defined tools は同一リクエストで併用可」。web-search の `{type:"openrouter:web_search", parameters:{...}}` と同形。dispatch は OpenRouter 側 |
| `tools` 要素型の定義場所 | `ChatCompletionRequest.tools` を **client `function` tool ∪ server tool** の判別 union として `src/types/index.ts` に 1 か所で定義（[tool-calling-foundation](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/tool-calling-foundation/design.md) の mixed array 前提に合わせる） | [web-search](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/web-search/design.md) の型 sketch は `tools?: ServerTool[]`（server tool 単独）で、foundation の混在配列と**食い違う**。本 change 採用時にどちらかへ寄せる必要があるため、union 定義箇所を明示し二重定義を避ける（後述） |
| client ループとの関係 | `runToolLoop` の dispatch 対象に**しない**。`serverTools` 引数で渡し毎ターン再送、omit 判定は結合後配列で | server tool は OpenRouter がサーバ側実行。`finish_reason:"tool_calls"` の dispatch は client `function` tool のみ（foundation 準拠） |
| コスト/回数の制御 | 二層で縛る。(1) リクエスト直下の `max_tool_calls`（既定 30・上限 30、`ResponsesRequest` のみ）と `stop_server_tools_when`（server tool ループ全体の停止条件。指定すると `max_tool_calls` を**上書き**する）。(2) 各 server tool の `parameters`（本 change では `analysis_models` と `max_tool_calls`〔fusion〕/ `max_tool_calls`〔subagent〕/ image_generation の `quality`・`size`・`model`・ON/OFF） | `MAX_TURNS`/`MAX_TOOL_CALLS_PER_TURN` は client ターンの上限で、1 リクエスト内 0..N 回のサーバ側実行は抑制できない。ただしリクエスト直下の上限が効くのも HTTP リクエスト 1 回分なので、1 応答あたりを縛るにはターンをまたぐ集計が要る |
| fusion の位置づけ | **構造化合議**（panel→analyst、`analysis` + 各モデル raw `responses`）。単一合成回答は返さない | docs。合意/矛盾の構造化分析と各モデルの生応答を返すので、利用側が提示方法を決める |
| advisor の nested tools | **存在しない**（`tools` も `max_tool_calls` も無い） | 現行ドキュメントと公開スキーマ `AdvisorServerToolConfig` で確認。allowlist も再帰可否も設計する必要が無い |
| advisor の相談先 | `parameters.model` を必ず固定する | `AdvisorServerToolConfig.model` を省くと、実行中のモデルが tool call の `model` 引数で相談先を選べる（どちらも無ければ外側のリクエストのモデル）。固定しないと高価なモデルを相談先に選ばれうる |
| subagent の nested tools | `tools` と `max_tool_calls`（上限 25）がある。`tools` に入れられるのは server tool だけで、function tool は拒否され、subagent 自身も入れられない。client function tool の継承は `inherit_functions` / `inherited_function_names`（EXPERIMENTAL、Responses API のみ）で行う | 公開スキーマ `SubagentServerToolConfig` で確認。再帰 subagent は API 側で禁じられている |
| 返り形の確定度 | パラメータ名と output item の形は OpenAPI 定義で確認済み。wire 上の実際の形（特に `image_generation` の `imageUrl` / `imageB64` / `result` のどれに値が入るか）は**実装時に実 API で検証** | スキーマは実測ではない。load-bearing なので実装前に wire 形状を fixture 化 |
| usage への計上 | `usage.server_tool_use_details`（`tool_calls_requested` / `tool_calls_executed` / `web_search_requests`）。他 server tool の計上キーは実装時に実 API で確認 | web_search のキーは docs 既知。fusion/advisor/subagent の usage 計上形は未確証 |

## Design

各 server tool を機能別小節に分ける。共通事項（混在経路・コスト責務・返り形の検証方針）は本節冒頭にまとめ、`---` 以降で個別に記す。

### 共通事項

**送出形（全 server tool 共通）:**

```ts
// ChatCompletionRequest.tools に混在させる（client tool と同一配列）
tools: [
  // client tool（foundation が buildTools で組む）
  { type: "function", function: { name, description, parameters } },
  // server tool（本 change）— OpenRouter がサーバ側で実行。params は parameters キー配下
  { type: "openrouter:image_generation", parameters: { /* model/quality/size/... */ } },
]
```

- 型は `ChatCompletionRequest.tools` を拡張（[tool-calling-foundation](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/tool-calling-foundation/design.md) が `tools?` を追加する前提）。server tool 要素は `{ type: "openrouter:<id>", parameters?: <ToolParameters> }` 形（パラメータは top-level spread ではなく **`parameters` キー配下**。web-search の `{type:"openrouter:web_search", parameters:{...}}` と同形）。server tool 要素の判別は `type` の `openrouter:` 接頭辞で行う。
  - **`parameters` 配下の `model` と top-level request `model` は別物**: `image_generation`/`advisor`/`subagent` は `parameters.model`（生成/相談/委譲先モデル）を持つが、これはリクエスト本体の `model`（会話を駆動するモデル）とは独立。型でもキーでも混同しない。
- **型定義の cross-doc tension（要解消）**: foundation は `tools` を **client `function` tool と server tool の混在配列**として扱うが、[web-search](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/web-search/design.md) の型 sketch は `ChatCompletionRequest.tools?: ServerTool[]`（server tool 単独）になっており**食い違う**。本 change（および web-search・foundation）採用順次第でどちらかへ寄せる必要がある。方針は **`ChatCompletionRequest.tools` を `(FunctionTool | ServerTool)[]` の判別 union として `src/types/index.ts` に 1 か所定義**し、`ServerTool` を本 4 ツール + `web_search`/`web_fetch` の `type` リテラル union で表す（web-search 側の `ServerTool[]` も同じ `ServerTool` を指すよう統一）。本 change はこの union に 4 ツールの `type` と各 `parameters` 型を**追加**する側で、独自に別型を切らない。
- DisQord 側は server tool を「リクエストに足すだけ」で、結果は OpenRouter が最終 message・annotations・`usage` に織り込んで返す。client ループの dispatch（`role:"tool"` 生成）は走らない。
- **omit 判定は結合後**（client + server）の配列で行う（foundation 準拠）。server tool が 1 つでもあれば `tools` を omit しない。

**コスト/回数制御の責務（重要）:**

- server tool は 1 リクエスト内でモデル判断により **0..N 回サーバ側実行**される。`tool-calling-foundation` の `MAX_TURNS` / `MAX_TOOL_CALLS_PER_TURN` は **client ターン**の上限であり、server tool の実行回数は**縛らない**。
- 制御は **2 軸**で分けて考える（混同しない）。**(a) 1 起動あたりのコスト**を縛る `parameters`（下記）と、**(b) 何回起動されるか（invocation count）**を縛る「いつ/どう `tools` に載せるか」の付与戦略。本基盤には server tool の invocation 上限を課す汎用ガードが無いため、(b) は呼び出し側の責務になる：明示コマンド時だけ付与する / 1 ターンだけ付与して再送時は外す / `stop_server_tools_when` で 1 リクエスト内のループを止める、の組み合わせ。特に **`image_generation` は `parameters` に実行回数上限が無い**ため、chat 経路で常時付与するとモデル判断で 1 リクエスト内に複数回生成され得る点に注意。
- (a) 各 server tool を有効化する呼び出し側が、その server tool の `parameters` で **1 起動あたりの**コストを縛る（本 change の 4 ツールに効く制御は下記。`max_results`/`max_total_results` は `web_search` 用で本 change のスコープ外）:
  - `image_generation`: 生成は 1 枚でも高コスト。`quality`/`size` などの parameters で **1 枚あたり**のコストが変わる（`output_compression` 等の正確なコスト依存は実 API で確認）。**実行回数を縛る parameters は無い**ため、回数は ON/OFF と付与戦略（上記 (b)）で縛る。モデル選択もコスト軸。
  - `fusion`: `analysis_models`（panel、1–8）の数 = panel 並列呼び出し数。さらに **analyst 段（`analysis` 生成）の呼び出しが加わる**ため、1 起動あたりのコストは **panel + analyst**。`analysis_models` は panel 数（per-call コスト）であって起動回数の上限ではない。OpenRouter 制約は「1 リクエストターンにつき 1 回」だが、**loop 全体（最大 `MAX_TURNS`=5 client ターン）では理論上ターンごとに 1 回起動され得る**ため、1 会話処理あたりの上限ではない。コストは「（panel 数 + analyst）× 起動ターン数」で見積もる。
  - `advisor`: 回数の knob は無い。`parameters.model` と `max_completion_tokens` でコストが決まる（top-level の会話モデルとは別）。`parameters.model` を省くと相談先を実行中のモデルが選ぶので、必ず固定する。
  - `subagent`: `max_tool_calls`（上限 25）で nested ツールの実行回数上限を縛る。`parameters.model` と `max_completion_tokens` でもコストが変わる。
- **`stop_server_tools_when`（全 server tool 共通）**: リクエスト直下のフィールドで、`web_search` に限らず server tool ループ全体に効く（2026-09-23 に OpenAPI 定義の `StopServerToolsWhen` で確認。`ChatRequest` / `MessagesRequest` / `ResponsesRequest` が持つ）。
  - 条件は `step_count_is` / `has_tool_call` / `max_tokens_used` / `max_cost` / `finish_reason_is` の配列で、どれか 1 つが成立すればループを止める（OR）。
  - 指定すると `max_tool_calls` は無視される。
  - 成立時にモデルがまだ tool call を出していれば、その tool call を実行したうえで tool を無効にした最終ターンを 1 回行い、自然文の回答で終える。
  - したがって本 change の 4 ツールにも ON/OFF・付与戦略と並ぶ共通のコスト制御として使える。ただし止められるのは 1 HTTP リクエスト内のループだけで、client ターンをまたぐ集計は呼び出し側が持つ。wire 上の挙動は実測していない。

**返り形の検証方針:**

- パラメータ名・最上位フィールド（`status` / `model` / `advice` / `analysis` / `responses` 等）は docs と OpenAPI 定義で確認できるが、wire 上の実際の構造（特に `image_generation` が画像をどのフィールドで返すか）は実測していない。**実装着手前に実 API のレスポンスを 1 度取得して fixture 化**し、型を確定する。返りに伴う追加フィールドも同時に確認する：最終 message / delta 側の `annotations`（`url_citation` 等）と、`usage.server_tool_use_details` の各ツール計上キー。`server_tool_use_details` は `usage` 配下にあり、終端イベント（`response.completed` または `response.incomplete`）でだけ届く。server tool の実行結果は `response.output_item.done` の item（`type` が `openrouter:` 接頭辞）として流れ、現行の `chatStream` はこれを heartbeat として捨てている。`annotations` をどのイベントから読むかは実 wire 形状で確定する。

---

### image_generation（`openrouter:image_generation`）

- **用途**: モデル応答の中で画像を生成する。会話の流れで「この内容の画像を作って」に応えられる。
- **パラメータ**: `ImageGenerationServerToolConfig` が定義するのは `model`（既定 `openai/gpt-5-image`）だけで、それ以外は `additionalProperties` として画像生成へそのまま渡される。docs が挙げる渡し先の項目は `quality` / `aspect_ratio` / `size` / `background` / `output_format` / `output_compression` / `moderation`。
- **返り形**: output item `OutputImageGenerationServerToolItem` は `status` / `type` を必須とし、任意で `imageUrl` / `imageB64` / `result`（base64 文字列または URL）/ `prompt` / `revisedPrompt` を持つ（2026-09-23 に OpenAPI 定義で確認）。どのフィールドに値が入るか、URL か base64 かは実測していないので、**実装時に実 API で wire fixture を取る**。
- **コスト**: 画像生成は 1 回でも比較的高コスト。`quality` / `size` などでコストが変動（`output_compression` 等の正確なコスト依存は実 API で確認）。回数制御は「ON/OFF + `model` 選択」が主。`MAX_*` では縛れない。
- **DisQord 適用先候補**:
  - 会話内画像生成（chat 経路で server tool を有効化 → モデルが必要時に呼ぶ）。
  - `/image <prompt>` のような明示コマンド（採用時）。
  - 既存のマルチモーダル**入力**（`attachmentParser` の `image_url` / `file` part）は入力側で、本ツールは**出力側**。producer adapter が画像 URL を検証済み bytes へ変換し、[出力マルチモーダル対応](../multimodal-output/design.md) の描画基盤へ渡す。
- **検証ポイント**: 返り画像が `imageUrl` / `result` の URL 参照か、`imageB64` / `result` の base64 か。Discord 添付には再取得が要るか。`moderation` 既定挙動。

---

### fusion（`openrouter:fusion`）

- **用途**: 複数モデル（panel）に同じ問いを投げ、analyst モデルが**合意・矛盾・観点**を構造化分析する「合議」server tool。
- **パラメータ**（現行ドキュメントと公開スキーマ `FusionServerToolConfig` で確認）: `analysis_models`（panel、1–8。既定は `~anthropic/claude-opus-latest` / `~openai/gpt-sol-latest` / `~google/gemini-pro-latest` という品質プリセット）/ `model`（analyst。既定は外側のリクエストと同じモデル）/ `max_tool_calls`（既定 4、範囲 1–16）/ `tools` / `max_completion_tokens`（既定 16,000、推論トークンを含む）/ `reasoning` / `temperature` / `cache_control`。
  - 構造化分析を作る役は analyst と呼び、設定のパラメータ名は `model` である。
  - Responses API のストリーミングイベント `FusionCallAnalysisInProgressEvent` では、analyst のモデルを示すフィールドが 2026-07-28 に `judge_model` から `analyst_model` へ改名された（OpenRouter の API changelog による）。`judge_model` は同じ値を持つ非推奨の別名として残るので、読む側は `analyst_model` を使う。
  - **`max_tool_calls` を持つのは fusion**であり、advisor は持たない。これは各 panel モデルと analyst が `openrouter:web_search` / `openrouter:web_fetch` のループで踏める tool-calling ステップ数の上限である。
  - `tools` を省くと panel と analyst の内部呼び出しは `openrouter:web_search` と `openrouter:web_fetch` を有効にした状態で実行される。`tools` に空配列を渡すと内部ツールは無効になり、panel はモデル自身の知識だけで答える（2026-09-23 に OpenAPI 定義の `FusionServerToolConfig.tools` の説明で確認。wire では実測していない）。
- **返り形**（docs 由来）: `{ status, analysis{ consensus / contradictions / ... }, responses[{ model, content }] }`。一部モデルが失敗した場合は `failed_models` が付く。analyst が失敗してもツール自体はエラーにならず、`analysis` 無しで panel の応答が返る。
  - `analysis` = analyst による**構造化分析**（合意点・矛盾点など）。
  - `responses` = 各 panel モデルの**生レスポンス**。
  - **単一の合成回答（1 本にまとめた最終文）は返さない**。利用側が `analysis` と `responses` をどう提示するかを決める。
- **コスト**: 単一の要因では決まらない。費用制御の候補は `analysis_models`（panel の数とモデル）、`model`（analyst）、`max_tool_calls`（内部ツールのステップ数）、`tools`（内部ツールそのもの）、`max_completion_tokens`（各内部呼び出しの出力予算）である。panel 8・`max_tool_calls` を上限の 16 にすれば 1 起動あたり最大 9 × 16 = 144 ステップ、既定の 4 なら 36 ステップになる。これはステップ数の予算であって課金対象の検索数や金額そのものではない。`tools` を空配列にしても内部モデルの生成費用は残る。
- **DisQord 適用先候補**: 「重要な質問を複数モデルで合議させて、合意/矛盾を見せる」UX。

---

### advisor（`openrouter:advisor`）

- **用途**: 進行中の会話のまま、**より強いモデルに相談**する server tool。難しい部分だけ上位モデルへ委譲できる。
- **パラメータ**（現行ドキュメントと公開スキーマ `AdvisorServerToolConfig` で確認）: `name` / `model`（相談先。省くと実行中のモデルが tool call の `model` 引数で選び、どちらも無ければ外側のリクエストのモデルになる）/ `instructions` / `forward_transcript`（既定 false）/ `stream`（Responses API のみ）/ `max_completion_tokens` / `reasoning` / `temperature`。
- **返り形**: モデルが tool result として受け取るのは、成功時 `{ status: "ok", model, advice }`、失敗時 `{ status: "error", error }` である（advisor ガイド）。bot が受信する output item `OutputAdvisorServerToolItem` はこれと別で、`type` / `id` / `status` / `model` / `prompt` / `advice` / `error` / `instance_name` を持ち、`status` は `in_progress` / `completed` / `incomplete` / `failed`、失敗は `status: "failed"` と `error` で表す（2026-09-23 に OpenAPI 定義で確認）。bot 側の成否判定は output item の `status` で行う。
- **nested tools は存在しない**: `advisor` に `tools` と `max_tool_calls` は**無い**。advisor 内から別のツールを呼ばせる経路そのものが無いため、nested tools の allowlist も再帰の可否も設計する必要が無い。
- **コスト**: 相談先 `model` と `max_completion_tokens`（推論トークンを含む）で決まる。上位モデルを指定すると高コストになる。`model` を省くと、実行中のモデルが任意の OpenRouter モデルを相談先に選べるので、採用時は `parameters.model` を必ず固定する。
- **DisQord 適用先候補**: 安価な既定モデルで会話しつつ、難所だけ上位モデルへ自動エスカレーション。`forward_transcript` で文脈を渡すか選べる。

---

### subagent（`openrouter:subagent`）

- **用途**: サブタスクを**安価なモデルへ委譲**する server tool（advisor の逆方向：下位委譲）。
- **パラメータ**（公開スキーマ `SubagentServerToolConfig` で確認）: `name` / `model`（委譲先、安価想定）/ `instructions` / `tools` / `max_tool_calls`（上限 25）/ `max_completion_tokens` / `reasoning` / `temperature` / `inherit_functions` / `inherited_function_names`。
- **返り形**（docs 由来）: `{ status, model, task_name, outcome }`。`outcome` を会話に取り込む。
- **`tools` の制約**: `parameters.tools` に入れられるのは OpenRouter の server tool だけで、function tool は拒否され、subagent 自身も入れられない（2026-09-23 に OpenAPI 定義の `SubagentServerToolConfig.tools` の説明で確認）。再帰 subagent は API 側で禁じられているので、DisQord 側で可否を決める必要は無い。
- **client function tool を継承できる（EXPERIMENTAL）**: client function tool を subagent に使わせる経路は `tools` ではなく `inherit_functions` である。真にすると、subagent が外側のリクエストの `tools` にある client function tool をすべて継承し、`inherited_function_names` は無視される。名前で絞って継承するときは、`inherit_functions` を省くか偽にして `inherited_function_names` だけを指定する（2026-09-23 に OpenAPI 定義の `SubagentServerToolConfig.properties.inherited_function_names` の説明で確認）。Discord を変更する client tool を subagent に渡さないよう、使う場合は名前指定に限る。`inherit_functions` は Responses API（`/api/v1/responses`）でだけ受け付けられ、他の API では 400 になる。どちらも「EXPERIMENTAL — subject to change without notice」と注記されているので依存はできない。
- **nested tools の allowlist（採用時に決める）**: `parameters.tools` は outer request とは別の allowlist。outer の `serverTools` を素通し転送せず、既定は空 or 低コスト server tool の curated subset に絞る。`inherit_functions` を使うかどうかも採用時に決める。
- **コスト**: 委譲先が安価モデル前提だが、`max_tool_calls`（nested ツールの回数上限）と `max_completion_tokens` でなお縛る。
- **DisQord 適用先候補**: 定型サブタスク（要約・抽出・整形）を安価モデルへ逃がしてコスト最適化。

---

### その他の server tool（本 change では設計しない）

2026-09-23 に OpenAPI 定義と docs の索引（`https://openrouter.ai/docs/llms.txt`）で確認した、上の 4 ツールと web-search 側の 2 ツール以外の server tool である。

| server tool | 内容 | 候補か |
| --- | --- | --- |
| `openrouter:files` | API キーの workspace のファイルを読み書き・編集・一覧する。OpenAPI 定義にだけあり、docs のガイドページは無い | 候補にしない。workspace は Bot の API キー全体で共有され、guild どうしを分けられない |
| `openrouter:tool_search` | `defer_loading` を付けた tool を検索して呼び出せるようにする | 候補にしない。DisQord の client tool は少数で、定義を遅延読み込みする必要が無い |
| `openrouter:experimental__search_models` | OpenRouter のモデル一覧を検索・絞り込みする（experimental） | 低優先の候補。モデル選びの相談に答える用途がありうるが、`/model` の既存動線で足りるかを先に見る |

shell による code 実行は [コード実行](../code-execution/design.md) が扱う。

### 変更対象ファイル（採用時の見込み・調査段階では未確定）

- 修正: `src/types/index.ts` — `ChatCompletionRequest.tools` の判別 union（`FunctionTool | ServerTool`）に server tool 要素型を追加（`{type:"openrouter:image_generation"|"openrouter:fusion"|"openrouter:advisor"|"openrouter:subagent", parameters?:<各ツールの ToolParameters>}`。パラメータは **`parameters` キー配下**。web-search の `ServerTool` と同一定義を共有し二重定義しない）。`StreamDelta` / `usage` への追加フィールド（実 API 検証後）
- 修正: `src/services/chatService.ts` — 採用した server tool を設定 ON 時に結合 `tools` へ付与（[tool-calling-foundation](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/tool-calling-foundation/design.md) の `serverTools` 経路）
- 新規（採用時）: `image_generation` の API 固有レスポンスを検証済み成果物へ変換する producer adapter。Discord 添付は [出力マルチモーダル対応](../multimodal-output/design.md) を利用し、fusion の analysis/responses など画像以外の構造化表示は各採用 change が所有する
- 修正: 設定（`guildSettings` / `settingsService` / `/config`）— 課金が絡むため ON/OFF を guild 単位で（web-search と同方針）

> 上記はあくまで採用時の見込み。`investigating` の本 change では**実装しない**。release 単位で切り出した際に各フォルダの design.md で確定させる。

## Tasks

調査段階のため、実装タスクではなく「採否確定までに埋めるべき調査項目」を列挙する。

- [ ] 各 server tool の最終 message / annotations / `usage` 計上の実 wire 形状を実 API で取得して fixture 化（特に `image_generation` の画像返り形、`fusion` の `analysis`/`responses`、`advisor`/`subagent` の `advice`/`outcome`）
- [x] `advisor` に nested `tools` と `max_tool_calls` が無いこと、`subagent` には両方あり `inherit_functions` / `inherited_function_names` で client function tool を継承できることを公開スキーマで確認
- [x] `subagent` の `tools` が server tool だけを受け付け、function tool と subagent 自身を拒否することを公開スキーマで確認
- [ ] `subagent` の `inherit_functions` を有効にしたときの実挙動を実 API で確認（EXPERIMENTAL 表記のため仕様変更を前提に扱う）。あわせて nested `tools` の allowlist（既定の curated subset）を設計
- [ ] `fusion` の「1 リクエストターン 1 回」制約・`analysis_models` 上限（1–8）・コスト増分を確認（multi-turn loop で各ターン起動され得る前提で、1 起動 = panel + analyst で見積り）
- [ ] `fusion` の `tools: []` で内部ツールが無効になることを実 API で確認
- [ ] invocation count（何回起動されるか）の制御責務を確定：`image_generation` は parameters に回数上限が無いため付与戦略（明示コマンド時のみ / 1 ターンのみ付与し再送時に外す）で縛る方針を採用フォルダで設計
- [x] caller 制御の記述を現行仕様へ是正：`max_tool_calls` を持つのは `fusion`（既定 4、範囲 1–16）と `subagent`（上限 25）であり、`advisor` は持たない
- [x] `stop_server_tools_when` が `web_search` 固有ではなく server tool ループ全体に効くことを公開スキーマで確認
- [ ] 採用した server tool に付ける `stop_server_tools_when` の条件（`step_count_is` / `max_cost` など）を採用フォルダで決め、停止時の最終ターンの挙動を実 API で確認
- [ ] `ChatCompletionRequest.tools` の判別 union（`FunctionTool | ServerTool`）と `ServerTool` 定義を [web-search](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/web-search/design.md) / [tool-calling-foundation](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/tool-calling-foundation/design.md) と統一（web-search の `ServerTool[]` typing との食い違いを解消）
- [ ] 各 server tool のコスト体系（image_generation の `quality`/`size` 依存、fusion の panel 依存、advisor/subagent の `model` 依存）を確認し、`/config` で出す費用警告文言を準備
- [ ] どの server tool を最初に release 単位で切り出すか決定（採用が決まったものを独立フォルダへ）
- [ ] 採用分について：設定 ON/OFF（guild 単位）、`serverTools` への付与、API 固有レスポンスの正規化、結果描画との接続、テストを各フォルダの design.md で設計
- [ ] `docs/changes/server-tools/` 削除（採用分を別フォルダへ切り出し、本調査束を解消したとき。または release 完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **返り形の未実測**: `image_generation` の output item のフィールドは OpenAPI 定義で分かるが、`imageUrl` / `imageB64` / `result` のどれに値が入り、URL か base64 かは実測していない。`fusion`/`advisor`/`subagent` の wire 上の構造も同様である。実装着手前に実 API 検証が必須。
- **usage 計上キー**: `web_search` は `usage.server_tool_use_details.web_search_requests` が既知だが、他 server tool の計上キー（image_generation の生成回数、fusion の panel 呼び出し数、advisor/subagent の nested 実行）は未確証。コスト把握のため実 API で確認。
- **streaming との相性**: 現行 `chatStream` は `delta.content` のみ処理。server tool 実行中の中間 SSE イベントや annotations の扱いは [tool-calling-foundation](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/tool-calling-foundation/design.md) / [web-search](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/web-search/design.md) の parser 拡張と整合させる必要がある。
- **モデル/プロバイダ依存**: server tool の対応・挙動はモデル/プロバイダで差が出うる。`fusion`/`advisor`/`subagent` が任意モデルで使えるか（web_search のような any model 動作か）は実 API で確認。
- **invocation count の制御**: `MAX_*` も `parameters` の per-call knob（`analysis_models`/`quality` 等）も「何回起動されるか」は縛らない。`image_generation` のように回数上限 parameters が無いツールは、付与戦略（明示コマンド時のみ / 1 ターンのみ付与）と `stop_server_tools_when`（1 リクエスト内だけ）でしか縛れない。chat 経路で常時 ON にするツールと明示コマンド限定にするツールの線引きを採用時に決める。
- **nested tools の allowlist**: `subagent` の `parameters.tools` は outer request とは別 allowlist。再帰 subagent は API 側で拒否されるが、outer の `serverTools` を素通しすると高コスト tool まで許可しうる。既定 subset を採用フォルダで確定する。`advisor` にはこの論点が無い。
- **release 粒度**: 4 ツールを一括で出すか個別に出すかは調査後に決定。コスト/UX の確度が高いものから切り出す。
- **`tools` 型の cross-doc 統一**: foundation の混在配列と [web-search](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/web-search/design.md) の `ServerTool[]` typing が食い違う。`ChatCompletionRequest.tools` を `(FunctionTool | ServerTool)[]` の判別 union に統一する方針（上述）だが、3 change（本 change / web-search / foundation）の採用順で誰が `ServerTool` の正本を定義するかを実装時に確定する。

## 参照

- [OpenRouter Server Tools](https://openrouter.ai/docs/guides/features/server-tools) — server tool は `{type:"openrouter:<id>"}` で `tools` 配列に追加、サーバ側実行、client/user-defined tool と同一リクエスト併用可
- [OpenRouter Image Generation Server Tool](https://openrouter.ai/docs/guides/features/server-tools/image-generation) — `openrouter:image_generation`。`model`（既定 `openai/gpt-5-image`）/`quality`/`aspect_ratio`/`size`/`background`/`output_format`/`output_compression`/`moderation`。output item は `imageUrl`/`imageB64`/`result`/`revisedPrompt`（wire 形は実装時検証）
- [OpenRouter Fusion Server Tool](https://openrouter.ai/docs/guides/features/server-tools/fusion) — `openrouter:fusion`。`analysis_models`(1–8)/`model`(analyst)/`max_tool_calls`(既定 4、1–16)/`tools`/`max_completion_tokens`(既定 16,000)。返り `{status, analysis{consensus/contradictions/...}, responses[{model,content}], failed_models?}`。単一合成回答は返さない
- [OpenRouter Advisor Server Tool](https://openrouter.ai/docs/guides/features/server-tools/advisor) — `openrouter:advisor`。`name`/`model`/`instructions`/`forward_transcript`/`stream`/`max_completion_tokens`/`reasoning`/`temperature`。`tools` と `max_tool_calls` は無い。返り `{status, model, advice}`
- [OpenRouter Subagent Server Tool](https://openrouter.ai/docs/guides/features/server-tools/subagent) — `openrouter:subagent`。`name`/`model`/`instructions`/`tools`/`max_tool_calls`(上限 25)/`max_completion_tokens`/`reasoning`/`temperature`/`inherit_functions`/`inherited_function_names`。`tools` は server tool のみで subagent 自身は不可。返り `{status, model, task_name, outcome}`
- [tool-calling-foundation](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/tool-calling-foundation/design.md) — client/server tool を同一 `tools` 配列に混在させる経路（`serverTools` 引数）。server tool は dispatch しない
- [web-search](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/web-search/design.md) — `openrouter:web_search` / `openrouter:web_fetch`（本 change では再定義しない）
