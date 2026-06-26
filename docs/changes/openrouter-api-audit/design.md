---
title: "OpenRouter API 整合監査"
status: planned
priority: medium
summary: "実装済み OpenRouter 連携を現行 API へ整合（deprecated な usage:{include} 撤去ほか）"
---

# OpenRouter API 整合監査

## Why

OpenRouter の API は更新が続いており、DisQord の実装済みコードと現行仕様の間にドリフトが生じている。最大の具体例は **`usage: { include: true }` が deprecated（no-op）化**したことで、現行は usage/cost が常に自動返却される。今は害がない no-op だが、放置すると「将来 OpenRouter 側が削除した際の地雷」になる。

本 change は新機能ではなく、**実装済み（リリース済み）コードを現行 OpenRouter API に対して一度棚卸しして整合させるリファクタ**である。tool calling・server tools といった**新規 API の導入は対象外**（それぞれ [tool-calling-foundation](../tool-calling-foundation/design.md) / [web-search](../web-search/design.md) で扱う）。

## 依存 / 関連 change

- 関連: [tool-calling-foundation](../tool-calling-foundation/design.md) — `tools`/`tool_choice` と `ChatMessage` の `tool` ロール追加は**そちら**で行う。本 change では追加しない（重複回避）
- 関連: [permissions-stats](../permissions-stats/design.md) — usage 型を現行返却フィールドに拡張すると `/stats` のトークン/コスト計上が充実する
- 関連: [web-search](../web-search/design.md) — server tools 固有の usage（`usage.server_tool_use.web_search_requests` 等）の取り込みは**そちら**が所有する（server tools 機能の一部であり、release 単位として web-search に属する）。本 change は usage accounting 文書に載る基本フィールドの型整合のみで、`server_tool_use` は対象外（この種のフィールドは本 change の根拠文書にも含まれない）

## Goals / Non-Goals

**Goals:**

- `chat()` / `chatStream()` から **deprecated な `usage: { include: true }` を撤去**する（現行は自動返却）。さらに deprecated フラグが二度と body に載らないよう、destructure 段で `usage` request param（whole）と `stream_options.include_usage`（キーのみ）を**明示 strip** する（cast/untyped 経由の注入も塞ぐ。現行コードは `stream_options` を送っていないが、deprecated キーは strip 対象に含めて固定する）
- 現行 API が返す usage フィールドに型を整合させる（後述。`cost_details.upstream_inference_cost` / `prompt_tokens_details.cache_write_tokens` / `audio_tokens` の取りこぼしを解消）
- `plugins`（PDF parser）が **deprecated ではない**ことを確認し、誤って外さない（deprecated なのは `web` plugin と `:online` のみ）
- credits 取得（`GET /api/v1/key` の `limit_remaining`）が現行仕様と一致するか確認する。**機械的ドリフト（エンドポイント/フィールドの rename・envelope 変更）を検出したら、public な `{ remaining }` 契約を保ったまま写像だけ本 change で是正する**（drift 是正こそ本監査の目的なので別 change へ先送りしない）。`limit_remaining` の意味の再解釈・表示の作り込み・別エンドポイント（`/api/v1/credits` 等）への意味的乗り換えは対象外（Open Questions 参照）
- ストリーミングの usage 受信箇所（最終 SSE チャンク）を確認し、`choices` 省略の usage チャンクで usage を取りこぼす潜在不具合を最小限の安全読み取りで是正する（SSE parser 本体の再設計は対象外＝[tool-calling-foundation](../tool-calling-foundation/design.md)）

**Non-Goals:**

- client tool calling（`tools`/`tool_choice`/`tool_calls`/`role:"tool"`）の追加 → [tool-calling-foundation](../tool-calling-foundation/design.md)
- server tools（`openrouter:web_search` 等）の追加 → [web-search](../web-search/design.md)
- usage を使った統計機能そのもの → [permissions-stats](../permissions-stats/design.md)
- リトライ/エラー分類ロジックの再設計（現行の `handleErrorResponse` は維持）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| `usage: { include: true }` | **撤去**（chat / chatStream 双方） | docs「`usage:{include:true}` と `stream_options:{include_usage:true}` は deprecated で効果なし。usage は常に自動返却」 |
| deprecated フラグの runtime strip | **入れる（deprecated なものに限定）**: `usage` param 全体 + `stream_options.include_usage` キーのみ（siblings 保持） | `chat`/`chatStream` は public method（tool-calling-foundation も経由）で、構造的型付け上 `as` キャスト/untyped 経由なら理論上混入し得る。主目的が「deprecated フラグを送らない」ことなので型保証に頼らず実コードで閉じる。ただし `stream_options` bag 全体の drop は conformance を越える挙動判断なので避け、deprecated キーだけ抜く（runtime コストは無視できる） |
| usage 型 | 現行返却フィールドへ拡張（下記） | 取りこぼしを無くし、permissions-stats のコスト/キャッシュ/推論トークン計上に備える |
| 最終 SSE チャンクの usage 読み取り | usage を `choices` アクセス前に取り込み + `choices?.[0]` で optional 化（最小是正） | 現行は `choices` 省略時に throw→`catch` 握り潰しで usage を落とす。parser 本体再設計は TCF の責務なので usage 読み取り経路のみ直す |
| `plugins`（PDF parser） | **維持** | deprecated は `web` plugin / `:online` のみ。`file-parser` plugin（`PDF_PARSER_PLUGIN`）は健在 |
| `:online` / `web` plugin | 使用していないことを確認（grep 済み: 不使用） | 新規採用しない方針を明文化 |
| credits エンドポイント | `GET /api/v1/key` を継続。**機械的ドリフトのみ in-scope 是正**（`{ remaining }` 契約は維持） | 既存 `getCredits()` は JSON envelope `{ data: { limit_remaining } }` を local 変数 `data` 経由で `data.data.limit_remaining ?? Infinity` として `remaining` に写像。payload field `data.limit_remaining` が現行どおりなら無変更。field/envelope が rename されていれば写像だけ直す（drift 是正が監査の目的）。意味の再解釈・別エンドポイントへの意味的乗り換えは対象外 |
| 監査スコープ | 実装済みコードのみ。新 API は対象外 | 「整合監査」であり機能追加ではない |

## Design

### 撤去対象（deprecated no-op）

`src/llm/openrouter.ts` の 2 箇所（`chat()` L130-136 / `chatStream()` L171-178）で送っている `usage: { include: true }` を削除する。あわせて、deprecated フラグが二度と body に載らない不変条件を**型に頼らず実コードで保証**するため、destructure 段で deprecated なものを**明示的に strip** する（後述）。strip の粒度は対象ごとに異なり、本監査の mandate（deprecated 除去）に合わせて選ぶ:

- `usage` request param → **key 全体を policy として whole strip**。`usage` request param の唯一の用途が `{include:true}` という deprecated accounting toggle であり、非 deprecated な用途を持たないため、key-level 保持はせず param ごと剥がす。
- `stream_options.include_usage` → **`include_usage` キーのみ** strip（`stream_options` 自体は deprecated ではないため bag は残し、他キーが万一 cast で入っていれば保持。`include_usage` を抜いた結果が空なら `stream_options` を省く）。ここで「siblings を passthrough する」のは**意図的**で、本監査の方針「deprecated なものだけ落とし、それ以外には触れない」に沿った最小タッチである（未知 `stream_options` キーを新たにサポートする意図ではなく、conformance を越える挙動判断＝bag 全体 drop を避けるためだけ。`ChatCompletionRequest` は依然 `stream_options` を宣言せず、「実装済みコードのみ・新 API は対象外」の Decision とも矛盾しない＝新 API を**有効化**するのではなく、deprecated だけを**無効化**する）。

すなわち `usage` と `stream_options` で粒度が非対称である点に注意（`usage` は whole-key、`stream_options` は key-level）。`stream_options` プロパティ全体を無条件に落とすことはしない（deprecated は `include_usage` キーだけであり、bag 全体の drop は conformance cleanup を越える runtime 挙動判断になるため）。`fetch` の `body` を以下の形に直す（削除後の到達点）。現行コードは `stream_options` を**そもそも送っていない**が、cast/untyped 経由の `include_usage` 注入も塞ぐため strip 対象に含める。

```ts
// chat() / chatStream() 共通: usage は key 全体、stream_options は include_usage キーのみ strip。
// ChatCompletionRequest は usage / stream_options を宣言しないため widened local 型でキャストして剥がす。
const { plugins, usage: _usage, stream_options, ...rest } =
  request as ChatCompletionRequest & {
    usage?: unknown;
    stream_options?: Record<string, unknown>;
  };
// stream_options から deprecated な include_usage キーだけ除去（siblings は保持、空なら省略）。
// 非 object（cast/untyped 由来の primitive 等）は object でない時点で無視する（primitive を rest 分解すると
// {"0":"a",...} のような junk になるのを避ける。null/undefined は元々 falsy なので下の typeof で弾かれる）。
const sanitizedStreamOptions =
  stream_options && typeof stream_options === "object"
    ? (({ include_usage: _iu, ...so }) => (Object.keys(so).length ? so : undefined))(stream_options)
    : undefined;

// chat() — usage 全体と stream_options.include_usage は body に載らない
body: JSON.stringify({
  ...rest,
  ...(plugins && { plugins }),
  ...(sanitizedStreamOptions && { stream_options: sanitizedStreamOptions }),
}),

// chatStream() — 同上 + stream: true は残す
body: JSON.stringify({
  ...rest,
  ...(plugins && { plugins }),
  ...(sanitizedStreamOptions && { stream_options: sanitizedStreamOptions }),
  stream: true,
}),
```

usage/cost が**自動返却されること自体**は OpenRouter docs（usage accounting）と実 API 観測で確立される事実であり、unit test で証明する対象ではない。後述の回帰テストが担保するのは「**client が deprecated な送信フラグに依存していない**」こと、すなわち送信 body から `usage` キーを外しても client 側の parsing（`ChatCompletionResponse.usage` / `StreamFinalResult.usage` への写像）が維持されることのみである。

なお `usage` は **request 由来ではなく client（`openrouter.ts`）が body へ注入していた**フラグである。現行 `ChatCompletionRequest`（`src/types/index.ts`）は `model` / `messages` / `plugins?` のみを宣言し `usage` / `stream_options` を**型として持たない**。かつ唯一の生成元 `buildChatRequest()`（`chatService.ts`）は request を object literal（excess-property check 有効）で構築するため、現状の typed callsite からは deprecated フラグは載らない。ただし `chat()` / `chatStream()` は **public method**（tool-calling-foundation も `chatStream` を経由する）であり、構造的型付け上 `as` キャストや untyped runtime データ経由なら理論上 deprecated フラグが `rest` に紛れ込み `{ ...rest }` で転送され得る。本 change の主目的が「deprecated フラグを送らない」ことなので、型保証に頼らず**上記の明示 strip で「`usage` param と `stream_options.include_usage` は送られない」不変条件を閉じる**（destructure 1 段の追加で、runtime コストは無視できる）。strip は deprecated なものに限定しており、`stream_options` の非 deprecated キーや他の正規パラメータには触れない。

### usage 型の整合

現行 `src/types/index.ts` の usage は以下を持つ:

```ts
usage?: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};
```

現行 API はこれに加えて `cost_details.upstream_inference_cost`（BYOK 関連フィールド）、`prompt_tokens_details.cache_write_tokens`、`prompt_tokens_details.audio_tokens` を返す。permissions-stats のコスト/キャッシュ計上に備え、型を以下へ拡張する（すべて optional）。

```ts
usage?: {
  // 既存の required フィールド（変更なし）
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number;
  // 以下、今回追加する optional フィールドのみ
  cost_details?: { upstream_inference_cost?: number };
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; audio_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};
```

この拡張は「現行 usage accounting 文書に載っているフィールドを optional で型に足す」だけに留め、レスポンス JSON の parsing は現状どおり `as ChatCompletionResponse` キャスト（runtime validation なし）のままにする。型に列挙していない usage フィールドを drop / filter する処理は**入れない**（将来 OpenRouter が usage に項目を追加しても runtime では素通りし、型を後追いで広げられる）。

`cost_details` は文書化済みの `upstream_inference_cost` のみを**意図的に narrow に**モデリングし、index signature（`[k: string]: number` 等）は入れない（任意キーを許すと型安全が緩むため）。将来 `cost_details` に未知フィールドが増えても、上記の「キャスト + runtime passthrough」方針により runtime では保持される。ここでの「passthrough」は厳密には **`openrouter.ts` の response parsing が `as ChatCompletionResponse` で parse 済みオブジェクトを**そのまま**返す経路に限った話**である（`JSON.parse` の結果を filter/drop しないため未知フィールドの**実体**は残る）。下流の formatter が usage を手で組み直す（フィールドを個別に拾って別オブジェクトを作る）場合は、その formatter が拾ったフィールドしか伝わらない（だからこそ embedBuilder の複製型を SSOT へ寄せる）。いずれにせよ **TS consumer が未知フィールドへ型安全にアクセスできるわけではない**（型に列挙するまで `usage.cost_details.<新フィールド>` はコンパイルエラーになり、参照には後追いの型拡張が要る）。TS の excess-property check は object literal を型注釈付き変数へ直接代入したときだけ発火するので、未知フィールドを含むテストフィクスチャは現行同様 `as ChatCompletionResponse` キャスト（または注釈なしの mock 戻り値）で記述すれば型エラーにならない。

`prompt_tokens` / `completion_tokens` / `total_tokens` は既存どおり required のまま据え置く（本 change は required/optional の区分を変えない）。これは usage accounting 文書がこの 3 フィールドを基本フィールドとして提示しており、現行コード/既存テストも 3 フィールド存在前提で動いているため。仮に最終ストリームチャンクで partial usage（一部欠落）が観測された場合は、required を緩める判断は本 change のスコープ外として Open Questions 経由で別途扱う（現時点で欠落の根拠はない）。

> `cost_details.cache_discount` は公式 usage 例に無い（research でも未確認）ため**追加しない**。必要が出たら別途確認の上で。

`StreamFinalResult.usage` は `ChatCompletionResponse["usage"]` のエイリアスのまま（`src/types/index.ts`）に保ち、別個の usage 型を新設しない。これにより chat / chatStream 双方で拡張フィールドが同一型として流れ、permissions-stats がどちらの経路の usage も同じ shape で扱える。`openrouter.ts` 内のファイルローカルな `StreamDelta`（export されない実装内 interface）の `usage` も同じく `ChatCompletionResponse["usage"]` を参照しているため、別途広げる必要がなく、型を一本拡張すれば SSE パース経路にも拡張フィールドが自動で行き渡ることを確認する。

#### 重複した usage 型の解消（監査で検出）

`src/utils/embedBuilder.ts` の `splitTextToMultipleMessages()` の `metadata.usage`（現状 L100-107）は、`ChatCompletionResponse.usage` を**手書きで複製した狭い別定義**（`cached_tokens` / `reasoning_tokens` のみで `cost_details` / `cache_write_tokens` / `audio_tokens` を欠く）になっている。型を拡張しても、この複製を放置すると `metadata.usage` の**型**に拡張フィールドが現れない。これは runtime の表示欠落ではなく（TS の型は runtime で消えるため、実体に値が載っていれば JS 上は読める）、**compile-time の型ドリフト**である。すなわち今後 `/model` 詳細や permissions-stats 連携で `cost_details` / `cache_write_tokens` / `audio_tokens` を**型安全に参照しようとした時点で**、複製型が SSOT から取り残されているとアクセスできない（`any` 化やキャストを誘発する）。SSOT を一本化しておけば、表示追加側は型を後追いで広げる必要なく拡張フィールドへ到達できる。
本 change ではこのインライン定義を `usage?: ChatCompletionResponse["usage"]` へ置き換え、SSOT を `src/types/index.ts` に一本化する（表示側は必要なフィールドのみ参照すればよく、optional 拡張フィールドの参照追加は別 change [permissions-stats] の責務）。この置き換えは型のエイリアス化のみで、`messageCreate.ts` から渡している実体（`finalResult?.usage`）は元々 `ChatCompletionResponse["usage"]` なので代入互換は崩れない。

> usage を扱う site を全数確認した結果、本コードベースで usage 型を**手書きで複製/狭め直している**のは `embedBuilder` の `metadata.usage` ただ 1 箇所（`messageCreate.ts` L233 は `usage: finalResult?.usage` で**そのまま passthrough**、別オブジェクトへ組み直していない）。したがって SSOT 一本化は embedBuilder の置換だけで足り、他に narrow を見直す reconstruction site は無い（将来 stats 等で usage を組み直す場合はその change が SSOT を参照する）。

### ストリーミング usage 受信の堅牢化（最終チャンクの安全読み取り）

「ストリーミングの usage 受信箇所が現行どおりであることを確認する」という Goal を満たすため、現行 `chatStream()` の最終チャンク読み取りに**潜在不具合**がある点を監査で確定し、最小限だけ是正する。

現行ループ（`openrouter.ts`）は 1 チャンクにつき `const content = chunk.choices[0]?.delta?.content;` を**先に**評価し、その後で `if (chunk.usage) lastUsage = chunk.usage;` を実行している。さらにこの処理全体は `try { … } catch {}`（parse 失敗を黙って skip）で囲まれている。usage を載せた最終チャンクが `choices: []`（**空配列**）なら `[][0]` は `undefined` で optional chaining が効き安全に通るが、`choices` を**省略**（`undefined`）してくる shape だと `chunk.choices[0]` の時点で TypeError を throw し、`catch` が握り潰す。その結果 `lastUsage` への代入（後段の行）に到達せず、**最終チャンクの usage を取りこぼす**。これは送信フラグ撤去とは独立の既存リスクだが、本監査の usage 受信検証で必ず踏むため同 PR で塞ぐ。

是正は最小限（SSE parser 全体の再設計は [tool-calling-foundation](../tool-calling-foundation/design.md) の責務で本 change では触らない）:

- `chunk.usage` / `chunk.model` / `chunk.provider` の取り込みを `choices` アクセス**より前**に行う（content 抽出が throw しても usage は捕捉済みにする）。
- 配列アクセスを `chunk.choices?.[0]?.delta?.content` に変えて `choices` 省略でも throw しない（`StreamDelta.choices` を `choices?:` に緩める。空配列・省略の双方を許容）。あわせて型と runtime を揃えるため `choices[].delta` も `delta?:` に optional 化する（`?.delta?.content` と整合。usage 専用の最終チャンクは choice に `delta` を持たないことがあるため、型上も present を前提にしない）。

回帰テストは観測した実 wire shape に合わせるが、**`choices` 省略の最終 usage チャンク**ケースも 1 本加え、usage が保持されることを assert する（observation で `choices: []` 固定だと判明しても、防御として throw しない実装は維持する）。

### 変更対象ファイル

- 修正: `src/llm/openrouter.ts` — (1) `usage:{include:true}` を 2 箇所（`chat()` / `chatStream()`）から削除し、destructure で deprecated フラグのみ明示 strip（`usage` param 全体 + `stream_options.include_usage` キーのみ、widened local 型）、(2) `chatStream()` の最終チャンク読み取りで `usage`/`model`/`provider` を `choices` アクセスより前に取り込み、配列アクセスを `chunk.choices?.[0]?.delta?.content` に変更（`choices` 省略でも usage を落とさない）。`StreamDelta.choices` を optional 化し、`choices[].delta` も optional（`delta?:`）にして optional-chaining と型を一致（usage 専用チャンクは `delta` を持たない想定）
- 修正: `src/types/index.ts` — `ChatCompletionResponse.usage` 型に `cost_details` / `cache_write_tokens` / `audio_tokens`（optional）を追加
- 修正: `src/utils/embedBuilder.ts` — `splitTextToMultipleMessages()` の `metadata.usage` インライン定義を `ChatCompletionResponse["usage"]` のエイリアスに置換（重複型の解消）
- 修正: `tests/unit/llm/openrouter.test.ts` — body アサーション「リクエストボディが正しくJSONシリアライズされる」（`toEqual({ ...request, usage: { include: true } })`）を `usage` キーを含まない期待値へ更新
- 確認のみ: `src/services/chatService.ts`（`PDF_PARSER_PLUGIN` を `hasFile` 時に付与する PDF parser 経路）
- 確認、必要なら写像のみ修正: `getCredits()`（`/key`）— payload field `data.limit_remaining` が現行どおりなら無変更、機械的 rename を検出した場合のみ `{ remaining }` 契約を保って写像を是正

## Tasks

- [ ] `openrouter.ts` の `chat()` / `chatStream()` から `usage:{include:true}` を削除し、destructure で deprecated フラグのみ明示 strip（`usage` param 全体 + `stream_options.include_usage` キーのみ、siblings は保持。widened local 型でキャスト。public method への cast/untyped 経由の混入を塞ぐ）
- [ ] `chatStream()` の最終チャンク読み取りを堅牢化: `usage`/`model`/`provider` の取り込みを `choices` アクセス前に移し、`chunk.choices?.[0]?.delta?.content` に変更（`StreamDelta.choices` を optional 化、`choices[].delta` も `delta?:` に optional 化して optional-chaining と型を一致）。`choices` 省略の usage チャンクで usage を落とさないことを回帰テストで担保（SSE parser 全体の再設計は tool-calling-foundation の責務、本 change は usage 読み取り経路のみ）
- [ ] `tests/unit/llm/openrouter.test.ts` の body アサーション（`toEqual({ ...request, usage: { include: true } })`）を `usage` キー無しへ更新（**この修正なしでは既存テストが落ちる**）
- [ ] usage 型に `cost_details.upstream_inference_cost` / `prompt_tokens_details.cache_write_tokens` / `audio_tokens` を追加（optional）。`StreamFinalResult.usage` / `StreamDelta.usage` が `ChatCompletionResponse["usage"]` のエイリアスのままで、別個の usage 型を新設していないことを確認
- [ ] `src/utils/embedBuilder.ts` の `splitTextToMultipleMessages()` の `metadata.usage` インライン定義を `ChatCompletionResponse["usage"]` のエイリアスへ置換（重複型を解消し SSOT を一本化。代入互換は元から `finalResult?.usage` 由来なので維持）
- [ ] 拡張後に `bun typecheck` / 既存テストを通し、usage を読む全 consumer（`embedBuilder` 表示、`StreamFinalResult` 経由の `messageCreate` 受け渡し等）が optional 追加のみで壊れないことを確認（追加フィールドはすべて optional なので型エラーは出ない想定。唯一の代入互換ポイントは embedBuilder のエイリアス化なので、ここが緑であることを担保。新フィールドの**表示/集計追加は本 change のスコープ外**で permissions-stats の責務）
- [ ] 回帰テスト（client parsing の検証）: **送信 body に `usage` キーが無くても** レスポンスの parsing が維持されることを確認。`chat()` は mock レスポンスに `usage`（**required 3 フィールド `prompt_tokens`/`completion_tokens`/`total_tokens` + `usage.cost` + `usage.cost_details.upstream_inference_cost` 等の新 optional 拡張フィールド**を含む。`cost` は top-level ではなく `usage` 配下）を載せ、`ChatCompletionResponse.usage` がそのまま返り `usage.cost` / `usage.cost_details.upstream_inference_cost` を読めることを assert。この「required 3 + 新 optional」を 1 本に同居させることで required/optional の境界（3 フィールドは required 据え置き、拡張はすべて optional）を fixture 上で固定する。`chatStream()` は **content delta を持たず `usage` を載せた最終 SSE チャンク**を `data: [DONE]` の直前に置いた mock ストリームを用意し（streaming の usage は最終チャンクにのみ届くため、通常の delta チャンクに載せるテストにしない）、`StreamFinalResult.usage` に拡張フィールドが保持されることを assert。最終チャンクの正確な shape は research facts では未確証だが、**拘束力のある受け入れ条件は「client 側の安定した不変条件」**（OpenRouter の wire 契約ではなく、こちらの parser が守るべき性質）に置く: すなわち `choices: []`（空配列）でも `choices` 省略（`data: {"usage":{...}}`）でも、最終チャンクの usage が `StreamFinalResult.usage` に保持されること。どちらの shape も OpenRouter が必ずそう emit するという主張ではない（観測で寄せる前提は下記）。この両ケースを assert すれば、実 wire が `[]` でも省略でも parsing が壊れない（上記「ストリーミング usage 受信の堅牢化」の防御を担保）。実 wire shape の観測（具体的 model/コマンドでの実 SSE 記録）は**推奨だが必須ブロッカーにはしない**（observation が取れたらフィクスチャをその形へ寄せて補強する）。**分類を明示**: usage-accounting docs が確認するのは「usage が**最終 SSE チャンク**に含まれる」ことまでで、最終チャンクが `choices: []` か `choices` 省略かは未確証。テスト/フィクスチャ上、**`choices` 省略ケースは「観測済みの OpenRouter 挙動」ではなく防御的互換**（defensive compatibility）として扱う（test 名/コメントにその旨を明記し、確認できた実 shape を後から記録する）。これは「サーバが usage を自動返却する」ことの証明ではなく、client が送信フラグに依存せず両 shape で usage を拾えることの検証である。あわせて送信 body から `usage` キーが消えたことを assert（`chatStream()` 側は新規に body アサーションを 1 本追加）。**さらに strip 不変条件のテストを追加**: `chat()` / `chatStream()` 双方で、deprecated フラグを載せた**キャスト済み request**（`{ model, messages, usage: { include: true }, stream_options: { include_usage: true } } as ChatCompletionRequest`）を渡し、シリアライズ後の body に **`usage` キーが無い**かつ **`stream_options.include_usage` が無い**ことを assert する（注入が `include_usage` だけなら `stream_options` 自体が省かれる。typed callsite が省く normal ケースだけでなく cast/untyped 注入を strip が塞ぐことを担保。この test が無いと「injection 削除のみ」でも緑になり invariant が未検証になる）。strip は `usage` を destructure で whole 除去する実装なので、テストは `usage` の**値に依らず**（`{include:true}` に限らず任意値でも）key 全体が消える policy を担保する書き方にする（例: 非自明な `usage` 値を 1 ケース足すか、「値は問わず `"usage" in body` が false」で assert）。**siblings 保持も 1 本テストする**（narrow strip が design 上の不変条件であり、未テストだと「whole bag drop」実装でも緑になり invariant が破られるため）: `stream_options: { include_usage: true, some_future_key: "x" }` を載せたキャスト request を渡し、body の `stream_options` に `include_usage` が**無く** `some_future_key` が**残る**ことを assert する。なお `chatStream()` のこれら body テストでは、generator が最後まで回り切るよう**最小の有効 mock SSE**（現行 parser が完走する `data: [DONE]` 単独、または content チャンク 1 本 + `[DONE]`）を返し、`for await` で**完全にドレイン**してから `mockFetch.mock.calls` を読む（途中 return だと `fetch` 観測や最終結果経路が不安定になりフレーキーになるため）。※ `chatStream()` は **async generator** なので、呼ぶだけでは body の `fetch` が走らない（generator 本体は最初の `.next()` まで実行されない）。body アサーション前に**ストリームを最低 1 回イテレートして消費**する（`[DONE]` を含む mock レスポンスで完走させてから `mockFetch.mock.calls` を読む）。※ mock は「サーバが usage を自動返却する」ことの証明ではなく、client が送信フラグに依存しないことの検証である
- [ ] `:online`/`web` plugin が不使用であることを grep で確認（非使用の test 追加はしない＝absence の assert は脆い）。`plugins`（PDF parser）維持は既存の `plugins 未指定`/`plugins 指定` テストで担保済み
- [ ] `GET /api/v1/key` の payload field `data.limit_remaining → remaining` 写像が現行仕様で有効か確認。機械的ドリフト（field/envelope rename）を検出したら `{ remaining }` 契約を保ったまま写像だけ是正（意味の再解釈・`/api/v1/credits` への意味的乗り換えはしない）
- [ ] `docs/changes/openrouter-api-audit/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **既存テストの依存（確認済み）**: `tests/unit/llm/openrouter.test.ts` の「リクエストボディが正しくJSONシリアライズされる」だけが `toEqual({ ...request, usage: { include: true } })` で body の**完全一致**を assert しているため、撤去と同 PR で必ず更新する（`toEqual` の完全一致なので、放置すると確実に red）。他の `chat()` body テスト（`plugins 未指定`/`plugins 指定`/`content 配列 round-trip`）は `"plugins" in body` や `body.plugins` 等の**部分一致**のみなので `usage` 撤去では落ちない。`chatStream()` には現状 body アサーションが存在しないため、回帰テストとして body から `usage` キーが消えたことを確認する mock テストを `chatStream()` にも 1 本追加する。
- **`openrouter.ts` streaming の編集競合（tool-calling-foundation と重複）**: 本 change の最終チャンク堅牢化（`StreamDelta.choices` の optional 化・usage 読み取りの順序入れ替え）と、[tool-calling-foundation](../tool-calling-foundation/design.md) の SSE parser 再設計（`tool_calls`/`finish_reason` パース・frame/carry 上限・malformed-frame の protocol 失敗化）は同じ `chatStream()` を触る。役割境界は「本 change = usage 読み取り経路の安全化のみ／TCF = parser 本体の再設計」で分離するが、**先にマージした側にもう一方を rebase** する。TCF が先行する場合、その新 parser でも『`choices` 省略の usage チャンクで usage を落とさない』不変条件を引き継ぐ（本 change の回帰テストをそのまま残す）。
- **credits の監査範囲（受け入れ条件を明示）**: `getCredits()` は OpenRouter の JSON envelope `{ data: { limit_remaining } }`（payload field は `data.limit_remaining`）を、`await response.json()` の結果を local 変数 `data` に受けて `data.data.limit_remaining ?? Infinity` として `{ remaining }` に写像している（変数名 `data` と envelope の `data` が二重になるだけで、参照しているのは payload の `data.limit_remaining` 一段）。監査はこの写像が現行仕様で有効かを確認し、結果を二択で確定する。**(a) payload field `data.limit_remaining` が現行どおり → コード変更なし**（写像据え置き、タスクは「確認済み」でクローズ）。**(b) field/envelope が rename されている等の機械的ドリフトを検出 → public な `{ remaining }` 契約は保ったまま、写像（参照キー、または同一 key-metadata リソースが path rename された場合のエンドポイント文字列）だけを本 change で是正する**（検出したドリフトを直すのが本監査の目的なので別 change へ先送りしない）。境界を明確にする: 許されるのは**同一リソース（API key のメタ情報）の機械的 rename への追従のみ**。`limit_remaining` の**意味の再解釈**（残高 / レート枠の解釈変更）・表示の作り込み・`/api/v1/credits` 等の**意味的に別概念（残高/課金）のエンドポイントへの乗り換え**は、たとえエンドポイント文字列の変更であっても audit を越えるため対象外（必要なら別 change）。

## 参照

- [OpenRouter Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting) — `usage:{include:true}` / `stream_options:{include_usage:true}` は deprecated・no-op、usage/cost は常時自動返却。usage フィールド（`cost`/`cost_details.upstream_inference_cost`/`prompt_tokens_details.{cached_tokens,cache_write_tokens,audio_tokens}`/`completion_tokens_details.reasoning_tokens`）。ストリーミングは最終 SSE チャンクに含まれる
- [OpenRouter Web Search](https://openrouter.ai/docs/guides/features/server-tools/web-search) — `:online` / `web` plugin の deprecated 告知（PDF parser plugin は対象外）
