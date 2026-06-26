---
title: "OpenRouter サーバツール群"
status: investigating  # investigating | planned | in-progress | implemented
priority: medium       # high | medium | low
summary: "image_generation / fusion / advisor / subagent の OpenRouter server tool 群（web_search/web_fetch は web-search 側）"
---

# OpenRouter サーバツール群

## Why

OpenRouter には `{type:"openrouter:<id>"}` 形式の **server tool**（OpenRouter がサーバ側で実行し、結果も自動でレスポンスに織り込む）が複数ある。これらは client tool calling のループ（[tool-calling-foundation](../tool-calling-foundation/design.md)）を必要とせず、リクエストの `tools` 配列に 1 要素足すだけで「画像生成・複数モデル合議・上位モデルへの相談・安価モデルへの委譲」をモデル判断で呼べるようになる。

`openrouter:web_search` / `openrouter:web_fetch` は [web-search](../web-search/design.md) で扱う。本 change は **それ以外**の server tool 群 — `openrouter:image_generation` / `openrouter:fusion` / `openrouter:advisor` / `openrouter:subagent` — を 1 つの調査束として棚卸しし、各ツールが「何を返すか・どのパラメータでコスト/回数を縛るか・DisQord のどの機能に使えるか」を確定させる。個々の採否・実装は後で release 単位に**フォルダ分割**して切り出す（status は `investigating`、束ねたまま調査）。

> server tool は本基盤の client ループの**外**で実行される。`tool-calling-foundation` は「client tool と server tool を**同一 `tools` 配列に混在**させて送る経路」だけを共有し、server tool の dispatch は行わない（OpenRouter がサーバ側で実行）。本 change はその混在経路に server tool を載せる側。

## 依存 / 関連 change

- 先行: [tool-calling-foundation](../tool-calling-foundation/design.md) — client tool と server tool を結合した `tools` 配列を送る経路（`runToolLoop` の `serverTools` 引数）を提供する。本 change の server tool はそこへ載せる
- 関連: [web-search](../web-search/design.md) — `openrouter:web_search` / `openrouter:web_fetch` は**そちら**で定義。本 change では再定義しない（`web_fetch` は本 change の各 server tool の nested `tools` 候補としてのみ言及）
- 関連: [model-compare](../model-compare/design.md) — `/model compare`（同一プロンプトを複数モデルへ並列送信し **side-by-side 表示**）は本 change の `openrouter:fusion`（panel→judge の**構造化合議**）とは**目的が異なる**。混同しない（後述）
- 関連: [openrouter-api-audit](../openrouter-api-audit/design.md) — `ChatCompletionRequest`/`usage` 型の現行 API 整合。本 change の server tool パラメータ型・`server_tool_use` 取り込みはその整合方針に従う

## Goals / Non-Goals

**Goals:**

- 4 つの server tool（`image_generation` / `fusion` / `advisor` / `subagent`）について、用途・パラメータ・返り形・コスト特性・コスト/回数制御の責務・DisQord での適用先候補を**調査ドキュメント**として確定する
- server tool は `MAX_TURNS` / `MAX_TOOL_CALLS_PER_TURN`（client ループのガード）では**抑制できない**点を明文化し、各 server tool の `parameters`（本 change 4 ツールでは `analysis_models`〔fusion〕/ `max_tool_calls`〔advisor/subagent〕/ image_generation の `model`・`quality`・`size` と ON/OFF。`max_results`/`max_total_results` は web_search 用でスコープ外）で呼び出し側がコスト/回数を縛る責務を定義する
- `fusion` が **単一合成回答を返さない**こと、`model-compare` とは別物であることを明確にする
- `advisor` / `subagent` の nested `tools` は **server tool のみ**で、function（client）tool を渡すと 400 になる制約を記録する
- どの server tool を最初に release 単位として切り出すかの判断材料を残す

**Non-Goals:**

- 本 change での実装そのもの（status は `investigating`。各 server tool は採否確定後、release 単位でフォルダ分割して実装する）
- `openrouter:web_search` / `openrouter:web_fetch` の定義（[web-search](../web-search/design.md)）
- client tool calling ループ自体（[tool-calling-foundation](../tool-calling-foundation/design.md)）
- server tool 結果の Discord 描画ロジックの確定（採用する server tool ごとに別途設計）

**将来別 change 候補:**（採用が決まった server tool は release 単位で独立フォルダへ）

- 画像生成 → 別 change `image-generation`（採用時）
- 合議（fusion）→ 別 change `model-fusion`（採用時。model-compare とは別物）
- advisor / subagent → 別 change（採用時。下位/上位委譲の UX を別途設計）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 4 ツールの束ね方 | 1 フォルダ・単一 `design.md`、Design を server tool 別小節（`---` 区切り）に分割 | 調査段階で release 単位が未確定。採用が決まったものから別フォルダへ切り出す（CLAUDE.md 粒度方針） |
| status | `investigating`（採否・優先度は調査後） | どれを最初に出すか未確定。実装着手で `in-progress` へ |
| server tool の送り方 | `tools` 配列に `{type:"openrouter:<id>", parameters?:{...}}` を追加（パラメータは `parameters` キー配下。top-level spread ではない）。client tool と同一配列に混在可 | docs「server tools と user-defined tools は同一リクエストで併用可」。web-search の `{type:"openrouter:web_search", parameters:{...}}` と同形。dispatch は OpenRouter 側 |
| `tools` 要素型の定義場所 | `ChatCompletionRequest.tools` を **client `function` tool ∪ server tool** の判別 union として `src/types/index.ts` に 1 か所で定義（[tool-calling-foundation](../tool-calling-foundation/design.md) の mixed array 前提に合わせる） | [web-search](../web-search/design.md) の型 sketch は `tools?: ServerTool[]`（server tool 単独）で、foundation の混在配列と**食い違う**。本 change 採用時にどちらかへ寄せる必要があるため、union 定義箇所を明示し二重定義を避ける（後述） |
| client ループとの関係 | `runToolLoop` の dispatch 対象に**しない**。`serverTools` 引数で渡し毎ターン再送、omit 判定は結合後配列で | server tool は OpenRouter がサーバ側実行。`finish_reason:"tool_calls"` の dispatch は client `function` tool のみ（foundation 準拠） |
| コスト/回数の制御 | 各 server tool の `parameters` で呼び出し側が縛る（本 change では `analysis_models`〔fusion〕/ `max_tool_calls`〔advisor/subagent〕/ image_generation の `quality`・`size`・`model`・ON/OFF。`max_results`/`max_total_results` は `web_search` 用でスコープ外） | `MAX_TURNS`/`MAX_TOOL_CALLS_PER_TURN` は client ターンの上限で、1 リクエスト内 0..N 回のサーバ側実行は抑制できない |
| fusion の位置づけ | **構造化合議**（panel→judge、`analysis` + 各モデル raw `responses`）。単一合成回答は返さない。model-compare とは別物 | docs。model-compare は side-by-side 表示が目的で、合意/矛盾の構造化分析はしない |
| advisor/subagent の nested tools | **server tool のみ**許可（function tool は 400） | docs に明記。client tool をネストできない |
| 返り形の確定度 | パラメータ名・最上位フィールドは docs 由来。最終 message の正確な形（特に `image_generation` の `imageUrl`）は**実装時に実 API で検証** | research facts でも「最終 message 形は未確証」。load-bearing なので実装前に wire 形状を fixture 化 |
| usage への計上 | `usage.server_tool_use`（web_search は `web_search_requests`）。他 server tool の計上キーは実装時に実 API で確認 | web_search のキーは docs 既知。fusion/advisor/subagent の usage 計上形は未確証 |

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

- 型は `ChatCompletionRequest.tools` を拡張（[tool-calling-foundation](../tool-calling-foundation/design.md) が `tools?` を追加する前提）。server tool 要素は `{ type: "openrouter:<id>", parameters?: <ToolParameters> }` 形（パラメータは top-level spread ではなく **`parameters` キー配下**。web-search の `{type:"openrouter:web_search", parameters:{...}}` と同形）。server tool 要素の判別は `type` の `openrouter:` 接頭辞で行う。
  - **`parameters` 配下の `model` と top-level request `model` は別物**: `image_generation`/`advisor`/`subagent` は `parameters.model`（生成/相談/委譲先モデル）を持つが、これはリクエスト本体の `model`（会話を駆動するモデル）とは独立。型でもキーでも混同しない。
- **型定義の cross-doc tension（要解消）**: foundation は `tools` を **client `function` tool と server tool の混在配列**として扱うが、[web-search](../web-search/design.md) の型 sketch は `ChatCompletionRequest.tools?: ServerTool[]`（server tool 単独）になっており**食い違う**。本 change（および web-search・foundation）採用順次第でどちらかへ寄せる必要がある。方針は **`ChatCompletionRequest.tools` を `(FunctionTool | ServerTool)[]` の判別 union として `src/types/index.ts` に 1 か所定義**し、`ServerTool` を本 4 ツール + `web_search`/`web_fetch` の `type` リテラル union で表す（web-search 側の `ServerTool[]` も同じ `ServerTool` を指すよう統一）。本 change はこの union に 4 ツールの `type` と各 `parameters` 型を**追加**する側で、独自に別型を切らない。
- DisQord 側は server tool を「リクエストに足すだけ」で、結果は OpenRouter が最終 message・annotations・`usage` に織り込んで返す。client ループの dispatch（`role:"tool"` 生成）は走らない。
- **omit 判定は結合後**（client + server）の配列で行う（foundation 準拠）。server tool が 1 つでもあれば `tools` を omit しない。

**コスト/回数制御の責務（重要）:**

- server tool は 1 リクエスト内でモデル判断により **0..N 回サーバ側実行**される。`tool-calling-foundation` の `MAX_TURNS` / `MAX_TOOL_CALLS_PER_TURN` は **client ターン**の上限であり、server tool の実行回数は**縛らない**。
- 制御は **2 軸**で分けて考える（混同しない）。**(a) 1 起動あたりのコスト**を縛る `parameters`（下記）と、**(b) 何回起動されるか（invocation count）**を縛る「いつ/どう `tools` に載せるか」の付与戦略。本基盤には server tool の invocation 上限を課す汎用ガードが無いため、(b) は呼び出し側の責務になる：明示コマンド時だけ付与する / 1 ターンだけ付与して再送時は外す / `stop_server_tools_when` が効くなら併用、のいずれか。特に **`image_generation` は `parameters` に実行回数上限が無い**ため、chat 経路で常時付与するとモデル判断で 1 リクエスト内に複数回生成され得る点に注意。
- (a) 各 server tool を有効化する呼び出し側が、その server tool の `parameters` で **1 起動あたりの**コストを縛る（本 change の 4 ツールに効く制御は下記。`max_results`/`max_total_results` は `web_search` 用で本 change のスコープ外）:
  - `image_generation`: 生成は 1 枚でも高コスト。`quality`/`size` などの parameters で **1 枚あたり**のコストが変わる（`output_compression` 等の正確なコスト依存は実 API で確認）。**実行回数を縛る parameters は無い**ため、回数は ON/OFF と付与戦略（上記 (b)）で縛る。モデル選択もコスト軸。
  - `fusion`: `analysis_models`（panel、1–8）の数 = panel 並列呼び出し数。さらに **judge 段（`analysis` 生成）の呼び出しが加わる**ため、1 起動あたりのコストは **panel + judge**。`analysis_models` は panel 数（per-call コスト）であって起動回数の上限ではない。OpenRouter 制約は「1 リクエストターンにつき 1 回」だが、**loop 全体（最大 `MAX_TURNS`=5 client ターン）では理論上ターンごとに 1 回起動され得る**ため、1 会話処理あたりの上限ではない。コストは「（panel 数 + judge）× 起動ターン数」で見積もる。
  - `advisor` / `subagent`: `max_tool_calls`（1–25）で **nested server tool** の実行回数上限を縛る。`parameters.model` 選択でコストが大きく変わる（top-level の会話モデルとは別）。
- **foundation との用語ずれ（要解消）**: [tool-calling-foundation](../tool-calling-foundation/design.md) は caller 側のコスト制御 knob として「fusion/advisor/subagent の `max_tool_calls`」と一括りに記しているが、**fusion の parameters は `analysis_models`（panel 数）で `max_tool_calls` は research facts では未確認**。`max_tool_calls` が効くのは nested tools を持つ `advisor`/`subagent` のみ。本 change（4 ツールの正本）が `analysis_models` を採り、foundation 側の fusion 記述は実 API 確認後に是正する（Tasks/Open Questions 参照）。
- **`stop_server_tools_when` の扱い（未確定）**: foundation は caller 側のコスト制御 knob として `parameters` のほかに `stop_server_tools_when` を挙げている。これが本 change の 4 ツールに適用できる共通制御なのか `web_search` 系固有なのかは research facts では未確証。**採用時に実 API で確認**し、適用可能なら ON/OFF と並ぶ共通制御として各ツールに加える（Tasks/Open Questions 参照）。

**返り形の検証方針:**

- パラメータ名・最上位フィールド（`status` / `model` / `advice` / `analysis` / `responses` 等）は docs 由来だが、最終 message の正確な構造（特に `image_generation` が画像をどう返すか）は research でも未確証。**実装着手前に実 API のレスポンスを 1 度取得して fixture 化**し、型を確定する。返りに伴う追加フィールドも同時に確認する：最終 message / delta 側の `annotations`（`url_citation` 等）と、`usage.server_tool_use` の各ツール計上キー。**`server_tool_use` は `usage` 配下**であり `StreamDelta` 直下ではない（現行 `StreamDelta` は `content`/`role`/`finish_reason`/`usage` のみ。`annotations` を delta/message のどこに足すかは実 wire 形状で確定）。

---

### image_generation（`openrouter:image_generation`）

- **用途**: モデル応答の中で画像を生成する。会話の流れで「この内容の画像を作って」に応えられる。
- **パラメータ**（docs 由来）: `model`（既定 `openai/gpt-5-image`）/ `quality` / `aspect_ratio` / `size` / `background` / `output_format` / `output_compression` / `moderation`。
- **返り形**: 生成画像を `imageUrl`（または相当）として最終 message に織り込む。**正確な形は未確証 → 実装時に実 API で検証**（research facts）。
- **コスト**: 画像生成は 1 回でも比較的高コスト。`quality` / `size` などでコストが変動（`output_compression` 等の正確なコスト依存は実 API で確認）。回数制御は「ON/OFF + `model` 選択」が主。`MAX_*` では縛れない。
- **DisQord 適用先候補**:
  - 会話内画像生成（chat 経路で server tool を有効化 → モデルが必要時に呼ぶ）。
  - `/image <prompt>` のような明示コマンド（採用時）。
  - 既存のマルチモーダル**入力**（`attachmentParser` の `image_url` / `file` part）は入力側で、本ツールは**出力側**。返ってきた画像 URL を Discord に添付/埋め込みする描画は別途設計。
- **検証ポイント**: 返り画像が URL 参照かインライン data URL か。Discord 添付には再取得が要るか。`moderation` 既定挙動。

---

### fusion（`openrouter:fusion`）

- **用途**: 複数モデル（panel）に同じ問いを投げ、judge モデルが**合意・矛盾・観点**を構造化分析する「合議」server tool。
- **パラメータ**（docs 由来）: `analysis_models`（panel、1–8）→ `judge`。**1 リクエストターンにつき 1 回**しか呼べない（loop が複数ターン回れば各ターンで 1 回起動され得るので、1 会話処理あたりの上限ではない。コスト見積りでは「（panel 数 + judge）× 起動ターン数」で考える。1 起動あたり panel に加えて judge の `analysis` 生成が課金される）。
- **返り形**（docs 由来）: `{ status, analysis{ consensus / contradictions / ... }, responses[{ model, content }] }`。
  - `analysis` = judge による**構造化分析**（合意点・矛盾点など）。
  - `responses` = 各 panel モデルの**生レスポンス**。
  - **単一の合成回答（1 本にまとめた最終文）は返さない**。利用側が `analysis` と `responses` をどう提示するかを決める。
- **model-compare との違い（重要）**:

| 観点 | `openrouter:fusion`（本 change） | `/model compare`（[model-compare](../model-compare/design.md)） |
| --- | --- | --- |
| 実行 | OpenRouter サーバ側（server tool、モデルが会話内で呼ぶ） | DisQord 側で `Promise.allSettled` 並列リクエスト |
| 返り | `analysis`（合意/矛盾の構造化）+ 各モデル raw `responses` | 各モデルの応答テキスト（分析なし） |
| 提示 | 構造化分析の提示（合議結果） | モデルごとに 1 Container を **side-by-side** 表示 |
| 目的 | 複数モデルの**合議・差分分析** | 応答品質の**横並び比較**（モデル選択支援） |
| 呼び出し | LLM がツールとして判断起動 | ユーザが明示コマンドで起動 |

- したがって fusion は model-compare の置換ではない。両者は併存しうる（fusion=合議分析、model-compare=横並び比較）。[model-compare](../model-compare/design.md) 側にも「`openrouter:fusion` との違い」の reciprocal note が**既にある**（本 change を参照する記述）。整合を確認し、必要なら更新する（Tasks 参照）。
- **コスト**: `analysis_models` の数 = panel 並列モデル呼び出し数。さらに judge 段の `analysis` 生成が加わるので 1 起動 = panel + judge。panel が増えるほど高コスト。1 ターン 1 回でも panel 数で増減し、multi-turn loop では起動ターン数だけ重なる。
- **DisQord 適用先候補**: 「重要な質問を複数モデルで合議させて、合意/矛盾を見せる」UX。model-compare とは別コマンド/別動線。

---

### advisor（`openrouter:advisor`）

- **用途**: 進行中の会話のまま、**より強いモデルに相談**する server tool。難しい部分だけ上位モデルへ委譲できる。
- **パラメータ**（docs 由来）: `model`（相談先）/ `instructions` / `tools`（**server tool のみ**）/ `forward_transcript` / `max_tool_calls`（1–25）/ …。
- **返り形**（docs 由来）: `{ status, model, advice }`。`advice` を会話に取り込む。
- **nested tools 制約（重要）**: `advisor` に渡す `tools` は **server tool のみ**。function（client）tool を渡すと **400**。advisor 内から DisQord の client tool は呼べない。
- **nested tools の allowlist（要設計）**: `parameters.tools` は **outer request の `tools` とは別の allowlist**。何を載せるかは別決定で、outer の `serverTools` をそのまま転送しない。転送すると `image_generation`/`fusion` や **再帰的な `advisor`/`subagent`** まで許可してコストが暴発しうる。既定は空 or 低コスト server tool（例 `web_search`/`web_fetch`）の curated subset に絞り、再帰 advisor/subagent の可否は明示的に決める（採用時に確定。`max_tool_calls` は nested の起動回数を縛るが許可 tool 種別は縛らない）。
- **コスト**: 相談先 `model` 次第（上位モデルは高コスト）。nested server tool の暴走は `max_tool_calls` で縛る。
- **DisQord 適用先候補**: 安価な既定モデルで会話しつつ、難所だけ上位モデルへ自動エスカレーション。`forward_transcript` で文脈を渡すか選べる。

---

### subagent（`openrouter:subagent`）

- **用途**: サブタスクを**安価なモデルへ委譲**する server tool（advisor の逆方向：下位委譲）。
- **パラメータ**（docs 由来）: `model`（委譲先、安価想定）/ `instructions` / `tools`（**server tool のみ、function tool は 400**）/ `max_tool_calls` / …。
- **返り形**（docs 由来）: `{ status, model, task_name, outcome }`。`outcome` を会話に取り込む。
- **nested tools 制約（重要）**: advisor と同じく、`tools` は **server tool のみ**。client tool をネストできない（function tool は 400）。
- **nested tools の allowlist（要設計）**: advisor と同様、`parameters.tools` は outer request とは別の allowlist。outer の `serverTools` を素通し転送せず、既定は空 or 低コスト server tool の curated subset に絞る。再帰 subagent/advisor の可否を明示的に決める（採用時に確定）。
- **コスト**: 委譲先が安価モデル前提だが、`max_tool_calls`（nested server tool 回数上限）でなお縛る。
- **DisQord 適用先候補**: 定型サブタスク（要約・抽出・整形）を安価モデルへ逃がしてコスト最適化。

### 変更対象ファイル（採用時の見込み・調査段階では未確定）

- 修正: `src/types/index.ts` — `ChatCompletionRequest.tools` の判別 union（`FunctionTool | ServerTool`）に server tool 要素型を追加（`{type:"openrouter:image_generation"|"openrouter:fusion"|"openrouter:advisor"|"openrouter:subagent", parameters?:<各ツールの ToolParameters>}`。パラメータは **`parameters` キー配下**。web-search の `ServerTool` と同一定義を共有し二重定義しない）。`StreamDelta` / `usage` への追加フィールド（実 API 検証後）
- 修正: `src/services/chatService.ts` — 採用した server tool を設定 ON 時に結合 `tools` へ付与（[tool-calling-foundation](../tool-calling-foundation/design.md) の `serverTools` 経路）
- 新規（採用時）: 各 server tool の結果を Discord に描画するロジック（image_generation の画像添付、fusion の analysis/responses 提示 など）
- 修正: 設定（`guildSettings` / `settingsService` / `/config`）— 課金が絡むため ON/OFF を guild 単位で（web-search と同方針）

> 上記はあくまで採用時の見込み。`investigating` の本 change では**実装しない**。release 単位で切り出した際に各フォルダの design.md で確定させる。

## Tasks

調査段階のため、実装タスクではなく「採否確定までに埋めるべき調査項目」を列挙する。

- [ ] 各 server tool の最終 message / annotations / `usage` 計上の実 wire 形状を実 API で取得して fixture 化（特に `image_generation` の画像返り形、`fusion` の `analysis`/`responses`、`advisor`/`subagent` の `advice`/`outcome`）
- [ ] `advisor`/`subagent` の nested `tools` に function tool を渡したときの 400 を実 API で確認（docs 記載の裏取り）。あわせて nested `tools` に渡す server tool の allowlist（既定の curated subset・再帰 advisor/subagent の可否）を設計
- [ ] `fusion` の「1 リクエストターン 1 回」制約・`analysis_models` 上限（1–8）・コスト増分を確認（multi-turn loop で各ターン起動され得る前提で、1 起動 = panel + judge で見積り）
- [ ] invocation count（何回起動されるか）の制御責務を確定：`image_generation` は parameters に回数上限が無いため付与戦略（明示コマンド時のみ / 1 ターンのみ付与し再送時に外す）で縛る方針を採用フォルダで設計
- [ ] foundation の caller 制御記述（「fusion/advisor/subagent の `max_tool_calls`」）を実 API 確認後に是正：fusion は `analysis_models`（panel 数）であり `max_tool_calls` は advisor/subagent 専用
- [ ] `stop_server_tools_when` が本 4 ツールに適用できる共通制御か（`web_search` 系固有か）を実 API で確認し、適用可能なら ON/OFF・付与戦略と並ぶコスト制御に加える
- [ ] `ChatCompletionRequest.tools` の判別 union（`FunctionTool | ServerTool`）と `ServerTool` 定義を [web-search](../web-search/design.md) / [tool-calling-foundation](../tool-calling-foundation/design.md) と統一（web-search の `ServerTool[]` typing との食い違いを解消）
- [ ] 各 server tool のコスト体系（image_generation の `quality`/`size` 依存、fusion の panel 依存、advisor/subagent の `model` 依存）を確認し、`/config` で出す費用警告文言を準備
- [ ] どの server tool を最初に release 単位で切り出すか決定（採用が決まったものを独立フォルダへ）
- [ ] 採用分について：設定 ON/OFF（guild 単位）・`serverTools` への付与・結果描画・テストを各フォルダの design.md で設計
- [ ] `model-compare`/`web-search` への参照注記が最新であることを確認（fusion≠model-compare、web_fetch は web-search 側）
- [ ] `docs/changes/server-tools/` 削除（採用分を別フォルダへ切り出し、本調査束を解消したとき。または release 完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **返り形の未確証**: `image_generation` の画像返り（URL かインライン data URL か）、`fusion`/`advisor`/`subagent` の最終 message 構造は research でも未確証。実装着手前に実 API 検証が必須。
- **usage 計上キー**: `web_search` は `usage.server_tool_use.web_search_requests` が既知だが、他 server tool の計上キー（image_generation の生成回数、fusion の panel 呼び出し数、advisor/subagent の nested 実行）は未確証。コスト把握のため実 API で確認。
- **streaming との相性**: 現行 `chatStream` は `delta.content` のみ処理。server tool 実行中の中間 SSE イベントや annotations の扱いは [tool-calling-foundation](../tool-calling-foundation/design.md) / [web-search](../web-search/design.md) の parser 拡張と整合させる必要がある。
- **モデル/プロバイダ依存**: server tool の対応・挙動はモデル/プロバイダで差が出うる。`fusion`/`advisor`/`subagent` が任意モデルで使えるか（web_search のような any model 動作か）は実 API で確認。
- **invocation count の制御**: `MAX_*` も `parameters` の per-call knob（`analysis_models`/`quality` 等）も「何回起動されるか」は縛らない。`image_generation` のように回数上限 parameters が無いツールは、付与戦略（明示コマンド時のみ / 1 ターンのみ付与）か `stop_server_tools_when`（適用可なら）でしか縛れない。chat 経路で常時 ON にするツールと明示コマンド限定にするツールの線引きを採用時に決める。
- **nested tools の allowlist**: `advisor`/`subagent` の `parameters.tools` は outer request とは別 allowlist。outer の `serverTools` を素通しすると再帰 advisor/subagent や高コスト tool まで許可しうる。既定 subset と再帰可否を採用フォルダで確定する。
- **foundation との fusion 制御記述ずれ**: foundation は「fusion/advisor/subagent の `max_tool_calls`」と一括りにしているが、fusion の parameters は `analysis_models`。本 change を正本として foundation 側を是正する（実 API 確認後）。
- **release 粒度**: 4 ツールを一括で出すか個別に出すかは調査後に決定。コスト/UX の確度が高いものから切り出す。
- **`tools` 型の cross-doc 統一**: foundation の混在配列と [web-search](../web-search/design.md) の `ServerTool[]` typing が食い違う。`ChatCompletionRequest.tools` を `(FunctionTool | ServerTool)[]` の判別 union に統一する方針（上述）だが、3 change（本 change / web-search / foundation）の採用順で誰が `ServerTool` の正本を定義するかを実装時に確定する。
- **`stop_server_tools_when` の適用範囲**: 本 4 ツールに効く共通コスト制御か `web_search` 系固有かが未確証。実 API で確認し、適用可能なら共通制御に加える。

## 参照

- [OpenRouter Server Tools Overview](https://openrouter.ai/docs/guides/features/server-tools/overview) — server tool は `{type:"openrouter:<id>"}` で `tools` 配列に追加、サーバ側実行、client/user-defined tool と同一リクエスト併用可
- [OpenRouter Image Generation Server Tool](https://openrouter.ai/docs/guides/features/server-tools/image-generation) — `openrouter:image_generation`。`model`（既定 `openai/gpt-5-image`）/`quality`/`aspect_ratio`/`size`/`background`/`output_format`/`output_compression`/`moderation`。返り `imageUrl`（最終 message 形は実装時検証）
- [OpenRouter Fusion Server Tool](https://openrouter.ai/docs/guides/features/server-tools/fusion) — `openrouter:fusion`。`analysis_models`(1–8)→judge、1 ターン 1 回。返り `{status, analysis{consensus/contradictions/...}, responses[{model,content}]}`。単一合成回答は返さない
- [OpenRouter Advisor Server Tool](https://openrouter.ai/docs/guides/features/server-tools/advisor) — `openrouter:advisor`。`model`/`instructions`/`tools`(server tool のみ)/`forward_transcript`/`max_tool_calls`(1–25)。返り `{status, model, advice}`
- [OpenRouter Subagent Server Tool](https://openrouter.ai/docs/guides/features/server-tools/subagent) — `openrouter:subagent`。`model`/`instructions`/`tools`(server tool のみ、function tool は 400)/`max_tool_calls`。返り `{status, model, task_name, outcome}`
- [tool-calling-foundation](../tool-calling-foundation/design.md) — client/server tool を同一 `tools` 配列に混在させる経路（`serverTools` 引数）。server tool は dispatch しない
- [web-search](../web-search/design.md) — `openrouter:web_search` / `openrouter:web_fetch`（本 change では再定義しない）
