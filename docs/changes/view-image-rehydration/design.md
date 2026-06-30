---
title: "画像の遅延再注入"
status: planned
priority: medium
summary: "剥がした過去画像をモデル要求時にベストエフォート再取得して当該ターンへ再注入する view_image client tool"
---

# 画像の遅延再注入

## Why

[conversation-context](../conversation-context/design.md) は文脈コストを抑えるため、履歴のメディアを 2 段階で軽量化する。

1. **永続形の参照化**: 画像は base64 を保存せず `PersistedContentPart`（`{type:'image-ref', url, mime, ...}`）として URL + メタだけを保存する。
2. **剥がし（strip）**: リクエスト構築時、最新のメディア user turn より前の image/file part を `[earlier image omitted]` プレースホルダへ置換する（リクエスト配列のみ・保存不変。直前応答が画像内容を言語化済みという前提）。

この設計は通常会話では正しいが、モデルが**過去の特定画像をもう一度「見たい」**ケース（「さっき貼った 1 枚目の図のこの部分を詳しく」「3 つ前の画像と今の画像を比較して」など）では、プレースホルダ化された画像をモデルが取り戻す手段がない。conversation-context は「メディア再取得はベストエフォート」「ロスレスは view-image-rehydration の課題」とし、本 change へ明示的に委譲している（同 doc Decisions「メディア再取得」行、Open Questions「バイト永続化は view-image で判断」）。

本 change は、その構造化参照（どの turn のどの part か）を引数に取り、画像バイトをベストエフォートで再取得して**当該モデルターンに一時的に再注入する** `view_image` client tool を追加する。これにより、毎ターン生バイトを運ぶコストを払わずに、必要なときだけロスレスに過去画像を蘇生できる。

> 本 tool は client tool（`type:"function"`）であり、[tool-calling-foundation](../tool-calling-foundation/design.md) の `ToolRegistry` に登録され `runToolLoop()` の dispatch 対象になる。再取得・再注入の「いつ・どの画像を」はモデルが判断する。

## 依存 / 関連 change

- 先行: [tool-calling-foundation](../tool-calling-foundation/design.md) — `IClientTool`（`name`/`description`/`parameters`/`timeoutMs?`/`isEnabled`/`validate`/`handler(args, ctx, signal, meta)`）として登録し、`runToolLoop()` の dispatch・timeout・cancellation 経路に乗る。`ToolRenderPayload` で Discord 描画フックを使う。**staging のキーは loop が所有する per-dispatch トークン**にする（commit も loop 所有なので、staging→promote の対応付けは loop が握り、meta フィールドの一意性保証に本質的に依存しない）。実装上は基盤 `meta`（契約で `{ requestId, toolCallId, invocationId }`、同 doc が「idempotency/reconciliation 用の実行識別子」と明記）の **`invocationId` を相関キーとして使う**のが第一候補だが、**衝突時の振る舞いを明確化**する: dispatch は v1 で逐次・かつ **rebuild-retry では client handler を再 dispatch しない**（既存 `role:"tool"` 結果を再利用）ため、同一ループ内で staging キーが再生成されることは無い（衝突しない）。万一の foundation 実装で `invocationId` が再利用されうる場合は、**composite `{invocationId, toolCallId}` か loop が採番する単調 dispatch カウンタ**をキーにして衝突を排す。**新たな meta フィールドの追加は不要**（loop 所有トークン or 既存 `invocationId`/`toolCallId` で足りる）
- 先行: [conversation-context](../conversation-context/design.md) — `PersistedContentPart`（`image-ref`）・turn/part 参照・剥がし（`stripHistoricalMedia()`）・「メディア再取得はベストエフォート」契約。本 change はその参照キー設計と `image-ref` の保存メタに依存する
- 連携: [chat-response-v2](../chat-response-v2/design.md) — tool 実行の進捗/結果描画は V2 updater 経由（基盤の `ToolRenderPayload` を透過）

## Goals / Non-Goals

**Goals:**

- 剥がされた**過去画像 1 枚**（= 現在の文脈に含まれ、剥がしプレースホルダとして見えている画像）を、安定参照キーで指定して再取得し、**次のモデルターンの応答生成にロスレス（生バイト）で再注入する** `view_image` client tool を提供する（現在の文脈ウィンドウ外の turn は参照できない。下記「参照キーと turn_ref の凍結」のセキュリティ節）
- 再取得を **2 段フォールバック構造**で行う: (1) `image-ref.url`（Discord CDN URL）を再 fetch、(2) 失効/失敗時、画像バイトを DB に保存していればそれを使用。**ただし (2) は将来の hook であり v1 では配線しない**（v1 の実効は「(1) のみ」）。どちらも不可なら**取得不可を明示する error tool 結果**を返す（throw しない）
- 参照キーを**モデルが履歴から特定できる形**にする（剥がし時のプレースホルダにキーを埋め込み、tool 引数で受ける）
- conversation-context が委ねた「画像バイトを保存するか否か」に決着を付ける（下記 Decisions。**既定は保存しない＝URL 再 fetch のみ**、保存はオプトインの将来拡張）
- 再注入は**当該ターン応答内のみ一時的**で、履歴の `image-ref`（剥がし済み）には影響しない（次ターンで再び剥がし対象に戻る）

**Non-Goals:**

- 動画・音声の再注入（`image-ref` 以外のメディア種別）
- PDF（`file-ref`）の全体再注入。PDF は base64 が重く、再パース戦略も別物 → 別 change
- 複数画像の一括再注入（v1 は 1 tool call = 1 画像。モデルは複数 call で複数枚を取得できる）
- 画像の編集・生成・OCR・サムネイル化（純粋な「再取得して再注入」のみ）
- 剥がし**ポリシー**そのもの（どの part を剥がすか・保存不変・純関数という中核）の再設計（conversation-context の責務）。**ただし本 change は `stripHistoricalMedia()`/hydration に後方互換・opt-in の拡張（キー付きプレースホルダ・`rehydrate` 除外マップ・`eligibleOmittedImageRefs` 返却・再注入 part の soft-pin）を加える**＝既定 off では従来挙動と byte-for-byte 同一だが、**有効時は strip/hydration の挙動を確かに拡張する**。これは「単なる協調」ではなく conversation-context への依存契約 amendment（Open Questions・責務境界で確定）であり、剥がしポリシー中核の再設計とは別物

**将来別 change 候補:**

- 画像バイトの DB/Blob 永続化（CDN 失効に耐えるロスレス保証）→ 容量設計が要るため別 change `media-byte-store`
- PDF/file の再注入 → 別 change
- 動画/音声フレーム抽出・再注入 → 別 change
- foundation が tool 並列実行を入れた場合の再注入マップ atomic reserve/commit → 並列化 change と同時に対応

## 責務境界（conversation-context との分担）

| 関心事 | conversation-context | view-image-rehydration（本 change） |
| ------ | -------------------- | ----------------------------------- |
| `image-ref` の永続保存（URL/メタ） | 所有（`PersistedContentPart`） | 参照キー設計に必要な**最小メタの追加だけ提案**（part stable id） |
| 剥がし（`stripHistoricalMedia()`） | 所有（純関数・保存不変・剥がしポリシー中核） | **後方互換・opt-in の拡張を依頼**: image-ref プレースホルダへの参照キー埋め込み + `rehydrate` 除外（当該 part を剥がさない）+ `eligibleOmittedImageRefs` 返却。既定 off で従来挙動、有効時のみ拡張（amendment は Open Questions で確定） |
| 画像バイトの再取得 | 「ベストエフォート」とだけ規定し委譲 | **所有**（URL 再 fetch → DB バイト → 取得不可 UX の 2 段フォールバック） |
| 画像バイトを DB に保存するか | 「view-image で判断」と委譲 | **決着**（既定: 保存しない。オプトインの将来拡張） |
| 再注入したバイトの寿命 | 関与しない | **所有**（当該ターンのみ一時的。履歴 `image-ref` は不変） |

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 参照キーの形 | `turn_ref` + `part_index` の組（`{turn_ref, part_index}`）。`turn_ref` は剥がしプレースホルダに埋めた**会話ローカルの短い ID**（生 DB `turn_id` を露出しない）。`part_index` は**その turn の永続 `content_json`（`PersistedContentPart[]`）配列の 0 始まり index**（text part も含む全 part を通した index。剥がしや並べ替えでズレない安定参照） | モデルが履歴テキストから特定でき、かつ DB の internal id を漏らさない。永続配列の index に固定することで、剥がし（プレースホルダ置換は in-place で順序不変）後も同じ index で同じ part を指せる。同一 turn 内に複数画像があるケースも解決 |
| 再取得の対象適格性 | 再注入できるのは**実際に剥がされた（omitted）image part だけ**。`stripHistoricalMedia()` がプレースホルダ化と同時に**剥がした (turn_ref, part_index) キーの集合 `eligibleOmittedImageRefs`** を生成し、`runToolLoop()` の**最初の request 構築時に凍結**してループ全体で tool ctx に渡す。handler preflight は**この集合への membership を必須**にし、非メンバ（剥がされていない現ターン画像・range 内だが未剥がしの image-ref・text part）は実行せず `forbidden_ref` | preflight が「turn_ref 存在 + range + image-ref 種別」だけだと、剥がされていない（＝既に request に生バイト/URL で載っている）画像をモデルが推測参照して**二重添付**でき、Goals の「剥がしプレースホルダとして見えている画像だけ」境界を破る。剥がし時に生成した omitted 集合を唯一の権威とすることで、適格性・in-context・image-ref 種別を 1 つの membership 判定に集約する |
| プレースホルダへのキー埋め込み（image-ref のみ） | conversation-context の剥がしを `[earlier image omitted #<turn_ref>.<part_index>]` 形式へ拡張（**view-image 有効時のみ**。無効時は従来の `[earlier image omitted]`）。**キーを付けるのは剥がした `image-ref` part だけ**。剥がした `file-ref`（PDF 等）は **キー無しのプレースホルダのまま**にする（例 `[earlier file omitted]`／従来の無印） | モデルがキーを「見える」ことで `view_image` を正しい引数で呼べる。tool 無効ガード時はキーを出さず誤誘導を防ぐ。**file-ref は本 change の Non-Goal（PDF 再注入は別 change）**なので、file part にキーを付けるとモデルが必ず `forbidden_ref`（非 image-ref）になる呼び出しへ誘導される。キーを image-ref に限定し、`eligibleOmittedImageRefs`（image-ref のみ）と一致させて、無駄な失敗 call を構造的に防ぐ |
| `turn_ref` の生成（per-loop nonce 付き） | リクエスト構築（hydration）時に、その文脈に含めた turn へ**安定な短 ID を採番**。**ID は「ループ単位の nonce ＋ turn 連番」**（表記例 `k7t1`, `k7t2`。`k7` は**説明用の短縮表現**で、実値の強度は下記）。同一リクエスト内で turn ↔ turn_ref は 1:1。**文法は `[A-Za-z0-9]+` に制限し `.` を含めない**。プレースホルダ `#<turn_ref>.<part_index>` と再注入マップキー `"<turn_ref>.<part_index>"` は `.` を区切りに使うため `turn_ref` に `.` を許さず（`part_index` は非負整数で `.` なし＝区切り一意）。**nonce の非再利用要件**: 古いループ由来の ref が**まだ文脈に残りうる間は nonce を再利用しない**こと。実現は (a)〔推奨〕**セッションローカルの単調増加ループ世代カウンタ**を base62 等で短く符号化（同一セッションで決して再利用されない＝衝突確率ゼロ。ランダム性不要）。**ただし (a) はカウンタが process restart をまたいで耐久（per-session/per-conversation で永続化し、前回までに発行した最大世代より上から再開）でなければならない**。in-memory のみで restart 時に振り直すと、過去ループの assistant 本文に literal で残った旧 ref（例 `k1t1.0`）が restart 後の新ループ世代 `k1` と一致し、**凍結マップ membership を誤って通過して現文脈内の別 turn の画像を誤蘇生**しうる（nonce の fail-closed 保証が restart で破れる）。耐久カウンタを持てない構成では (b) を使う。または (b) **ランダム nonce なら ≥ 64 bit を base62 で符号化**（48 bit は下限ぎりぎりで高頻度 bot では誕生日衝突余地が残るため 64 bit を最小とする。各ループが新規に引くため restart をまたいでも衝突は無視でき、永続不要）。`k7` のような 1–2 文字の literal 値は採らない | 連番だけだと、過去ループの assistant 本文/履歴に残った `#t1.0` 等の古い ref を**現ループでも `t1` が別 turn を指す**状況でモデルが転記すると、誤った画像を蘇生しうる（membership ゲートは文脈外 turn は弾くが、現文脈内の別 turn への取り違えは弾けない）。**per-loop nonce を付けると、別ループ由来の ref は現ループの凍結マップに一致せず `forbidden_ref` で fail-closed**（誤った画像ではなく安全な取得不可へ縮退）。**この保護は nonce が世代間で再利用されないことに依存する**ので非再利用/十分なエントロピーを要件化する。**1 つの `runToolLoop()` 呼び出し内で凍結**し不変。採番は凍結マップ内で衝突なし（カウンタ/連番は自明、hash 採用時は衝突検出 + 再採番） |
| 再取得元（1 段目） | `image-ref.url`（Discord CDN URL）を **再 fetch**。SSRF 防御として **Discord CDN ホスト allowlist** に限定し、`mime` allowlist（image/png,jpeg,gif,webp）と最大 byte で検証 | conversation-context が URL を保存する前提。CDN URL は失効しうる（後段フォールバック）。任意 URL fetch は SSRF になるため保存済み Discord ホストに限定 |
| 再取得元（2 段目） | 画像バイトを DB に保存している場合のみ DB バイトを使用する **hook**。**v1 では provider を配線せず（依存ゼロ）1 段目失敗＝取得不可** | バイト保存は容量問題（後述）。既定で安全側に倒し、保存はオプトインの将来拡張として hook だけ開けておく |
| 画像バイトを保存するか（委譲事項の決着） | **既定: 保存しない（URL 再 fetch のみ）**。理由: 画像は剥がし対象になるほど古く参照確率が低い一方、bytes 保存は SQLite/ディスクを線形に肥大させる。保存は guild オプトイン + TTL + 容量上限つきの**別 change `media-byte-store`** に切り出す | conversation-context の「base64 を保存しない」方針と整合。容量設計を伴うため本 change のスコープ外。本 change は「保存されていれば使う」フォールバック点だけ用意 |
| tool 引数 | `{ turn_ref: string, part_index: integer >= 0 }`（必須）。自然言語の説明引数は取らない | モデルが履歴のプレースホルダから機械的に転記できる最小形。曖昧な自由文参照を避け validate を厳密化 |
| 再注入の寿命 | **当該モデルターンの応答生成内のみ一時的**。再取得した画像は **`role:"tool"` 結果には URL/メタ要約だけ**を返し、生バイト（`image_url`）は**直後の次ターン request 構築時に「再注入指示」として該当 turn の剥がしを当該 part だけ解除**して載せる | OpenRouter の `role:"tool"` content は基本テキスト。画像を「モデルに見せる」には user/assistant の `image_url` part として送る必要がある。剥がし解除は request 配列のみ・1 part・1 ターンに限定し履歴は不変 |
| 再注入の運搬方法（commit は loop 所有・abort-aware） | `runToolLoop()` が保持する**「このループ中に再注入された画像マップ」`Map<"<turn_ref>.<part_index>", { dataUrl, mime, byteLength }>`** へ data URL を載せ、**次ターンの hydration で `stripHistoricalMedia()` に「再注入マップ」を渡して当該 part をその data URL で残す**。**ただし handler は live マップを直接 mutate しない**: handler は取得済みバイトを `meta.invocationId` キーの**per-call staging スロット**へ置き、live マップへの promote は **loop が当該 call の結果を「成功 `role:"tool"`」として accept した後（基盤の `request cancel > timeout > handler 結果` の signal 再確認・分類を経て）に限り**行う。timeout/cancel/abandon で分類された call の staging は **promote せず破棄** | tool は履歴を直接書き換えない（基盤契約）。基盤は「timeout で abandon した handler が遅れて完了しうる／副作用安全性は tool 側が abort-aware に担保」と規定するため、**handler が成功時に live マップを無条件 put すると、loop が既に `timeout`/`cancelled` を確定した後に late 完了した handler が次リクエストへ画像を漏らす**。commit を loop の accept 段に寄せ、モデルが実際に受け取る `role:"tool"` 結果（成功 or error/cancel）と再注入マップを一致させる。**Set ではなく Map に取得済みバイトを載せる**ことで、hydration が CDN URL を再び上流に取りに行かせず、bot 側で失効検出済みの data URL をそのまま使える |
| preflight/取得の判定順（唯一の権威） | **(1) 適格性/参照検証**（turn_ref 解決・`part_index` range・image-ref 種別・`eligibleOmittedImageRefs` membership）NG → `forbidden_ref` → **(2) `exhaustedRehydrationRefs` member → `budget_exceeded`** → **(3) 再注入マップに既存 → 冪等成功（再 fetch しない）** → **(4) `MAX_REHYDRATED_IMAGES` 超過 → `limit_exceeded`** → **(5) fetch**（下記「`reason` の確定的優先順位」へ）。下の reason 優先順位リストと同一順序 | セキュリティ/参照ゲートが最優先。exhausted を冪等成功より先にしないと、予算で諦めたキーに stale なマップ entry が残った場合に成功と誤判定し degrade-loop に戻る（exhaustion が支配する）。過去画像を無制限に蘇生するとトークン/ボディが膨張し剥がしの意味が消える |
| 取得不可時の UX | throw せず**構造化 error tool 結果**（`{ ok:false, reason:"expired"\|"fetch_failed"\|"not_found"\|"too_large"\|"unsupported_mime"\|"forbidden_ref"\|"limit_exceeded"\|"budget_exceeded"\|"timeout" }`）を `role:"tool"` で返し、モデルに「その画像はもう取得できない／今は見られない」と続行させる。**`not_found` は v1 では到達不能（reserved）**: byte-store provider 未配線の v1 は「CDN 失効かつ保存なし」を `expired` で返すため、`not_found` を返すのは byte-store 導入後のみ。v1 の handler 契約・UI・テストは `not_found` を期待してはならない（型 union には将来用に予約のみ）（`expired`=権威的/恒久寄りの失効・不可〔非 transient な非 2xx＝`401`/`403`/`404`/`410`/`451` および `400` 等 catch-all 4xx。下記 fetch 優先順位の唯一の定義に従う〕、`fetch_failed`=一時的取得不可〔DNS/接続失敗・`5xx`・`429`・redirect ホップ上限〕、`too_large`=画像のバイトサイズ超過、`limit_exceeded`=同時再注入枚数の上限超過、`budget_exceeded`=トークン/画像枚数予算で次リクエストに載せられず当該ループで打ち切り〔再 fetch しない〕、`timeout`=再 fetch の deadline 超過/中断〔deadline と user cancel は handler では同一ラベル。実際の cancel 判別は foundation の loop が行う＝下記〕） | 基盤の「handler は throw/timeout でも必ず結果」契約に沿う。ユーザ向けには tool 結果として穏当に縮退 |
| 描画 | `ToolRenderPayload` で「過去画像 #<turn_ref>.<part_index> を再取得しました／取得できませんでした」程度の控えめな進捗のみ。再取得画像そのものを Discord に再投稿はしない | 同じ画像をチャンネルに二重投稿しない。描画失敗は基盤契約どおり tool 結果生成と分離 |
| `viewImageEnabled`（キー埋め込みゲート・strip より前に確定） | (a) guild の履歴機能（conversation-context）が有効 **AND** (b) 現在選択モデルが画像入力対応（`isMultimodalCapable !== false`）。**eligible 集合には依存しない** | プレースホルダにキーを埋めるか否かは strip より前に決まらねばならない（strip が key 埋めを行い、その strip が eligible 集合を生むので、eligible 集合に依存させると鶏卵になる）。history+capability だけで決まる |
| `isEnabled`（tool 提示ゲート・strip 後に評価可） | `viewImageEnabled` **AND**〔可能なら〕凍結 `eligibleOmittedImageRefs` が非空。後者は `buildTools(ctx)` が eligible 集合確定後に走る場合の最適化（無駄な tool call を減らす） | 提示の抑制も同じ `viewImageEnabled` を基にするので「キーは埋まったのに tool が無い」乖離は起きない（eligible 空ならプレースホルダ自体が無い）。順序上 eligible 集合が未確定なら (c) は省略可で、preflight が `forbidden_ref` で安全に縮退する |
| モデルの画像入力対応ゲート | `view_image` の提供と再注入は、ライブ画像添付と**同じ** `ModelService.isMultimodalCapable(model, "image")` の tri-state を再利用する。`false`（非対応確定）→ `isEnabled=false`（tool を出さない）。`null`（メタ取得不可/`architecture` 欠落で不明）→ 既存挙動どおり**透過**（tool を出し、再注入も行い、最終判断は OpenRouter 400 に委ねる）。`true` → 有効。判定に必要な active model（または capability フラグ）は `IToolContext` 経由で渡す | 再注入は次リクエストに `image_url` part を足すので、text-only モデルに送ると**成功 tool 結果のあとに上流 model error** を招く。新しいゲートを発明せず、`messageCreate` がライブ画像で既に使っている tri-state（`false`=中止 / `null`=透過 / `true`=続行）と一貫させる |

## Design

### 全体像

```text
runToolLoop（tool-calling-foundation）
  ├─ hydration（conversation-context）
  │     └─ stripHistoricalMedia(parts, { rehydrate: Map<key,{dataUrl,mime,byteLength}>, viewImageEnabled })
  │           ├─ 剥がした image-ref は [earlier image omitted #<turn_ref>.<part_index>]（view-image 有効時のみキー付き）
  │           ├─ 剥がした file-ref（PDF 等）はキー無しプレースホルダ（本 change の対象外）
  │           └─ rehydrate マップに含まれる part は剥がさず、取得済み dataUrl を image_url として残す
  ├─ モデルが view_image({turn_ref, part_index}) を tool_call
  ├─ dispatch（基盤）→ view_image.handler:
  │     ├─ preflight（ctx 依存）: turn_ref を凍結マップで解決、part_index 範囲・対象 part が image-ref か、かつ凍結 eligibleOmittedImageRefs に含まれる（= 実際に剥がされた画像）か
  │     ├─ 1) image-ref.url を CDN host allowlist + mime + byte 検証つきで再 fetch（redirect 追跡防御）
  │     ├─ 2) 失敗 & DB バイトあり → DB バイト（v1 は既定で無し → 常に miss）
  │     ├─ 成否を role:"tool" 結果へ（成功: メタ要約のみ・生バイトは載せない / 失敗: error 理由）
  │     └─ 成功時は取得バイトを meta.invocationId の per-call staging へ（live マップへは put しない）
  ├─ loop が当該 call を「成功 role:"tool"」として accept したら staging → 再注入マップへ promote
  │     （timeout/cancel/abandon 分類なら staging を破棄＝漏れない）
  └─ 次ターン hydration で再注入マップを stripHistoricalMedia へ渡し当該 part を data URL で蘇生
```

### 変更対象ファイル

**新規:**

- `src/llm/tools/viewImage.ts` — `IClientTool` 実装（`view_image`）。`parameters`（JSON Schema）・`validate`・`handler`・`isEnabled`・`ToolRenderPayload` 生成
- `src/services/imageRehydrator.ts` — 参照キー解決（turn_ref → turn）と 2 段フォールバック再取得（CDN 再 fetch / DB バイト）、mime/byte/host 検証
- `tests/unit/llm/tools/viewImage.test.ts` — `validate`（shape のみ: turn_ref が string でない / part_index が負・非整数 → 基盤が実行前に弾く）、handler preflight（unknown turn_ref / 範囲外 part_index / image-ref でない part / **`eligibleOmittedImageRefs` 非メンバ（剥がされていない現ターン画像）** → `forbidden_ref` error 結果 / 上限超過 → `limit_exceeded`）、CDN 再 fetch 成功、失効→取得不可、mime/byte 拒否、**handler は staging（`meta.invocationId`）へ stage するだけで live 再注入マップは直接書かない・loop が成功 accept で promote / cancel・timeout 分類で破棄**、isEnabled、冪等
- `tests/unit/services/imageRehydrator.test.ts` — host allowlist、redirect 追跡防御、mime allowlist + magic-byte 検査、byte 上限、DB バイトフォールバック（**storage インタフェースを mock した将来パスの検証であり、v1 が byte store を同梱する含意ではない**）

**修正:**

- `src/llm/tools/registry.ts`（基盤） — `view_image` を登録。`isEnabled` は **`viewImageEnabled`（history 有効 && `isMultimodalCapable(model,"image") !== false`）＋〔可能なら〕eligible 集合非空**（guild 履歴有効だけでは不十分。text-only モデルへ提示しない）
- conversation-context の hydration / `stripHistoricalMedia()` — 引数に `viewImageEnabled` と `rehydrate` 再注入マップを受け、プレースホルダにキーを埋め込み、マップに含まれる part は剥がさず dataUrl で残す。**戻り値として剥がした image part の `(turn_ref, part_index)` キー集合 `eligibleOmittedImageRefs` を返す**（preflight 適格性判定の権威）（**本 change は協調インタフェースの追加を conversation-context に依頼**。実装本体は conversation-context 側）
- conversation-context の `turn_ref` 採番 — hydration が文脈 turn に安定短 ID を振り、`runToolLoop()` 1 呼び出し内で凍結したマップ（turn_ref マップ + `eligibleOmittedImageRefs`）を tool ctx へ渡す
- `src/llm/toolLoop.ts`（基盤、軽微） — ループ状態に「再注入マップ」を持ち、次ターン hydration へ渡す経路（基盤側に汎用の「per-loop scratch state」フックがあればそれを使う。無ければ ctx 経由の mutable 参照を 1 つ追加）

### 参照キーと turn_ref の凍結

- **評価順序（鶏卵回避・必須）**: ループ開始時に 1 回だけ次の順で確定する。(1) `viewImageEnabled` = history 有効 && `isMultimodalCapable(model,"image") !== false`（eligible 集合に依存しない）。(1.5) **hydration（stateful な caller）が nonce + `turn_ref` マップを採番**する（カウンタ/乱数の生成という副作用は caller 側に置く）。(2) `stripHistoricalMedia()` を **`viewImageEnabled`・凍結 `turn_ref` マップ・`rehydrate` マップを引数に**走らせ、**キー付きプレースホルダ**と `eligibleOmittedImageRefs` を生成。**`stripHistoricalMedia()` 自身は nonce/ID 状態を内部生成しない**（純関数・保存不変を保つため、turn_ref マップは外から受け取り、変換済み parts と `eligibleOmittedImageRefs` を返すだけ）。(3) `eligibleOmittedImageRefs` と `turn_ref` マップを凍結。(4) tool 提示（`buildTools`/`isEnabled`）は `viewImageEnabled`（＋可能なら eligible 非空）で評価。**(1)→(2) の向きは不可逆**（key 埋め込みを eligible 集合に依存させない）。これにより「キーは埋めたのに tool は無い」「tool は出たがキーが無い」の双方の乖離が起きない。
- `turn_ref` は **`runToolLoop()` の 1 呼び出し（= 1 ユーザ発話への応答）内で不変**。hydration が文脈に含めた turn 群へ採番し、tool ctx に `Map<turn_ref, { turnId, parts: PersistedContentPart[] }>` を凍結して渡す。
- 採番は**ループ単位の短 nonce ＋ turn 連番**（例 `k7t1`, `k7t2`…。`k7` がこのループの nonce）。読みやすさは連番部分で確保しつつ、nonce で過去ループ由来の ref を世代分離する（上記 Decisions「`turn_ref` の生成」と同一規則）。**同一ループ内で振り直さない**（ターンをまたいで tool 引数とプレースホルダが食い違うのを防ぐ）。**生成方式に関わらず、凍結マップ内で turn_ref は衝突しない**こと（nonce + 連番は自明に衝突なし。`turn_id` の bounded hash を使うなら衝突検出 + 再採番が必須。衝突は別 turn の画像を誤って指す＝別ユーザ画像漏洩になりうるため許容しない）。
- **耐久性の範囲（per-loop ephemeral・nonce で fail-closed）**: `turn_ref` は **1 `runToolLoop()` 呼び出し内でのみ有効な request ローカル ID** で、**ユーザの発話をまたいで安定とは限らない**（次の発話＝新しいループでは nonce + 連番が振り直される）。これは問題にならない: プレースホルダは毎ループの hydration で**そのループの turn_ref で再描画**され、モデルが見るのは常に現ループの ref だから、過去ループの ref を覚えて転記する必要がない。`view_image` 引数として有効なのは「今モデルに見えているプレースホルダの ref」だけで durable な名前ではない。**ただし過去ループの assistant 本文/履歴テキストに古い ref（例 `k6t1`）が残ることはある**。**per-loop nonce が無いと、古い `t1` が現ループでも `t1` として別 turn に一致してしまい誤蘇生になりうる**。nonce を付けることで、古いループ由来の ref は現ループ nonce（例 `k7`）と一致せず**凍結マップ解決に失敗 → `forbidden_ref`**（誤った画像ではなく安全な取得不可へ縮退）。これは「文脈ウィンドウ外 turn」を弾く membership ゲートでは防げない「現文脈内の別 turn 取り違え」を、ref 名前空間の世代分離で塞ぐもの。
- **適格性集合 `eligibleOmittedImageRefs` も凍結**: `stripHistoricalMedia()` が剥がし（プレースホルダ化）と同時に、剥がした image part の `(turn_ref, part_index)` キー集合を返す。`runToolLoop()` は **最初の request 構築時**にこの集合を凍結し、turn_ref マップと同じく tool ctx へ渡す（ループ中の新規 user turn 追加は無いので文脈 turn 集合は安定し、集合も安定する）。**preflight はこの凍結初期集合のみを参照し、毎ターンの最新 strip 結果は見ない**: 再注入で pin され当該ターンの strip 対象から外れた key も「元々 omitted だった」ので member のまま残り、同じ画像への 2 回目以降の `view_image` 呼び出し（冪等成功を期待）が誤って `forbidden_ref` にならない。
- `view_image` の **`validate` は引数の shape のみ**（基盤契約: ctx を持たない pre-execution gate）。`turn_ref` の凍結マップ解決・`part_index` 範囲・対象 part が `image-ref` か・**`eligibleOmittedImageRefs` の member か**は **ctx が要るので handler 冒頭の preflight** で検証し、不成立は実行せず `forbidden_ref` の error tool 結果にする（未知 turn_ref / 範囲外 / `image-ref` 以外 / **剥がされていない part**）。
- セキュリティ: `turn_ref` は会話ローカル ID なので、モデルが**現在の文脈に含まれない turn**（別チャンネル/別ユーザの履歴、文脈ウィンドウ外）を指せない。凍結マップに無い ID は handler preflight で解決できず弾かれる。さらに `eligibleOmittedImageRefs` の membership を要求することで、**現ターンに既に生バイト/URL で載っている未剥がし画像の二重添付**（剥がされていない image-ref への推測参照）も防ぐ。これは「再取得できるのは現文脈に剥がしプレースホルダとして見えている画像だけ」という Goals の制約の実装根拠でもある。

### 再取得（imageRehydrator）

1. **CDN 再 fetch**（SSRF 防御込み）:
   - `image-ref.url` を URL parse し、**スキームが `https:`** かつ **ホスト（`url.hostname`）が Discord CDN allowlist（`cdn.discordapp.com` / `media.discordapp.net`）に exact match**、**かつ既定ポート（`url.port === ""` ＝ 443。明示ポートを許さない）**、**かつ URL に埋め込み資格情報が無い（`url.username === "" && url.password === ""`）**ことを確認（部分一致や subdomain 含意を許さない厳密一致。`url.hostname` はポートも userinfo も含まないので別途ポート/資格情報検査が要る）。allowlist 外 / 非 https / 非既定ポート / 埋め込み資格情報あり → `forbidden_ref`（任意 URL/ポートを fetch させない・匿名 fetch の保証を URL 検証側でも明示）。
   - `fetch(url, { signal, redirect: "manual" })`（基盤の timeout `AbortSignal` を尊重）。**匿名 fetch**: bot token / Authorization / cookie などの認証情報は一切付けない（Discord CDN URL は署名付きクエリで自己完結。資格情報を SSRF 経路に載せないため）。**redirect は自動追跡しない**: 3xx が返ったら `Location` を**現リクエスト URL を base に絶対 URL へ解決**（相対 redirect 対応）してから正規化し、上記 allowlist（https + host exact match + 既定ポート）で再検証する。外れていれば `forbidden_ref`（`fetch` 既定の redirect 追跡で allowlist 外へ飛ぶ抜け道を塞ぐ）。許容ホストへの redirect のみ手動で追い、**各ホップで同じ解決＋再検証**を行う（ホップ上限あり）。redirect 後も**資格情報を引き継がない**（匿名のまま）。
   - **まず HTTP ステータス/トランスポートで分類**: 権威的失効（`403`/`404`/`410`）は `expired`、transient（DNS/接続失敗・`5xx`・ネットワーク）は `fetch_failed` として確定し、いずれも**body の MIME/サイズは見ずに**2 段目へ（誤って `unsupported_mime` に落とさない。`expired` と `fetch_failed` を分け、後者は永続消失と誤伝達しない）。
   - **2xx の成功応答にのみ body 検証を適用**: mime 確定は **magic-byte を一次権威**にする（PNG/JPEG/GIF/WebP のシグネチャ。mislabeled なバイトを信頼済み `data:` 画像として送らないための真のゲート。SSRF とは別の健全性チェック）。`Content-Length`（あれば事前）と**実読み取りバイト**が `MAX_REHYDRATE_BYTES` 以下であることを検証（読み取り途中で上限超過なら中断 → `too_large`）。**`Content-Type` の扱い（false-negative を避ける）**: (i) `Content-Type` が**具体的な image type**（essence へ parse 後 image allowlist に一致。`image/png; charset=binary` のような parameter は落とす）なら、それと magic-byte の整合を確認して採用。(ii) `Content-Type` が**欠落 / generic**（`application/octet-stream` 等。Discord CDN/プロキシが正しい image type を返さないケース）なら、**ヘッダで `unsupported_mime` に落とさず**、保存済み `image-ref.mime`（allowlist 内であること）と magic-byte の整合で mime を確定する。(iii) `Content-Type` が**具体的な非 image type**（`text/html` 等）、または **magic-byte がどの allowlist 画像とも一致しない**ときだけ `unsupported_mime`。OK なら確定 mime で base64 化して data URL を作り、再注入マップ用に `{ dataUrl, mime, byteLength }` を返す（`byteLength` は実読み取りバイト数）。
2. **DB バイトフォールバック**: **2 段目を試みるのは 1 段目が `expired` / `fetch_failed`（＝URL レベルの取得失敗で、保存バイトが代替になりうる）のときだけ**。`too_large`（CDN で取得した画像が上限超過。v1 は同一エンコード前提でフォールバックしない。**将来 byte-store が CDN とは別エンコード/別サイズのオリジナル〔例: CDN がリサイズ/変換版を返し store はオリジナルを保持〕を持ちうる場合の fallback 可否は `media-byte-store` 側で確定**する）・`unsupported_mime`（実体が画像でない）・`forbidden_ref`・`limit_exceeded`・`budget_exceeded`・`timeout` は 2 段目へ落とさない（store が救えない/呼ぶべきでない失敗）。`imageRehydrator` は **optional な byte-store provider を注入で受ける**設計にし、**v1 はこの provider を配線しない（依存ゼロ）** ので 2 段目クエリは存在しない。provider が無い限り、返る reason は **1 段目の reason そのまま**（CDN 失効なら `expired`）。`not_found` は **byte-store provider 注入後に「URL 失効 かつ store に未保存」を区別するための reason** で、**v1 では返さない**（v1 で「CDN 失効＋保存なし」は `expired`）。これで v1 の terminal reason が一意になる（テスト/UX が `expired` を期待できる）。**store バイトも 1 段目と同じ検証（mime allowlist essence・magic-byte・`MAX_REHYDRATE_BYTES`）を `data:` 化の前に通す**（store 由来でも未検証バイトを信頼済み画像として送らない。byte-store の保存時検証契約で代替してよいが、その場合も「検証済みである」ことを明記する）。テストは provider を mock して 2 段目パスを検証するが、これは将来配線の単体検証であって v1 が store を同梱する含意ではない。
3. いずれも不可なら error tool 結果。`role:"tool"` content は短い構造化テキスト（生バイトは載せない）。
4. **timeout/cancel**: 再 fetch は基盤の `AbortSignal`（handler に渡るのは `AbortSignal.any([requestSignal, timeoutSignal])`）を渡すため、deadline 超過/ユーザ cancel いずれでも `fetch` が `AbortError` を投げる。これを catch して `reason:"timeout"` の error 結果へマップする（handler は throw を外へ漏らさない＝基盤の no-throw envelope 契約に沿う。基盤側も最終フォールバックで包むが、本 handler でも明示 catch して構造化理由を付ける）。**handler 段で deadline と user cancel を区別しないのは安全**: foundation の loop が **race 結果採用前に signal 状態を再確認し `request cancel > timeout > handler 結果` の優先順位で分類**する権威を持つ（tool-calling-foundation の dispatch 契約）。実際に user cancel だった場合、loop は handler の `reason:"timeout"` 結果を**cancellation 結果で上書きし、以降モデルへの再リクエストを行わない**ので、**モデルが stale な `timeout` を見て続行することはない**。逆に純粋な deadline 超過のときだけ loop は継続し、モデルは `reason:"timeout"` を次ターンで受け取る。よって handler 側の同一ラベルは loop の cancel/timeout 分類を壊さない（disambiguation は loop の責務）。

**`reason` の確定的優先順位（最初に成立したものを採用）**: 各失敗を 1 つの reason に確定的に分類する（同じ失敗を別 reason に揺らさない。モデル/ユーザ向け回復策が reason ごとに違うため）。**HTTP ステータス/トランスポートを先に分類し、MIME/サイズ/magic 検査は 2xx の成功レスポンスにのみ適用する**（失効した 403/404 応答は非画像 body を持つことが多く、先に MIME を見ると `expired` を `unsupported_mime` に誤分類して 2 段目フォールバックを飛ばすため）。

preflight（fetch 前に確定。上の「preflight/取得の判定順」と同一）:

1. `forbidden_ref` — 適格性（未知 turn_ref / stale-nonce ref / 範囲外 / 非 image-ref / 非 omitted）または URL 検証（非 https / allowlist 外ホスト / redirect 先 allowlist 外）。**セキュリティ/参照ゲートが最優先**。**モデル向け reason は単一の `forbidden_ref` だが、内部ログは (a) 参照/適格性失敗（モデルの誤参照＝想定内）と (b) URL/host 検証失敗（保存済み `image-ref` の互換性問題＝将来 Discord CDN ホスト追加などメンテ対象）を別カテゴリに分類**する（運用時に「モデルのミス」と「データ互換性の劣化」を切り分けられるように。reason 文字列は同一でも観測性を分ける）。
2. `budget_exceeded` — キーが `exhaustedRehydrationRefs` に在る（当該ループで予算により既に諦め済み。再 fetch しない）。
3. （成功・非 reason）再注入マップに既存キー → **冪等成功**（再 fetch せず既存 `{dataUrl,...}` を再利用）。
4. `limit_exceeded` — `MAX_REHYDRATED_IMAGES` 超過（再注入枠が無いので取得自体を試みない）。

fetch（トランスポート → ステータス → body の順で確定）:

1. `timeout` — `AbortSignal` 発火（deadline/cancel）。
2. `expired` — **権威的に消えた/不可（permanent 寄り）**: HTTP `401`/`403`/`404`/`410`/`451`、**および上記 transient 以外のその他非 2xx 4xx（`400` 等の catch-all）**。ステータスで確定し body の MIME/サイズは見ない（**URL は妥当だが実体が消えた/到達不可**）→ 2 段目へ。
3. `fetch_failed` — **一時的に取得不可（transient/未完了）**: DNS/接続失敗・ネットワークエラー・`5xx`・`429`（rate limit）・**redirect ホップ上限超過 / ホップ上限後の予期せぬ `3xx`**（allowlist 内に留まったまま完了できなかったケース。allowlist 外への redirect は `forbidden_ref` が先取り）。`expired` と分けるのは、永続的に消えたとは限らない（後で再試行可）旨を正しく伝えるため（conversation-context の「purge は authoritative 404/403 のときだけ・transient では消さない」哲学と一貫）→ 2 段目へ。
4. `too_large` — **2xx 応答に対してのみ**。`Content-Length` 事前判定 or 実読み取りが `MAX_REHYDRATE_BYTES` 超過。
5. `unsupported_mime` — **2xx 応答に対してのみ**。`Content-Type` が**具体的な非 image type**（essence parse 後 image allowlist 外。例 `text/html`）、**または magic-byte がどの allowlist 画像とも不一致**（**正常応答だが画像として使えない**。`expired` ではない）。**欠落/generic な `Content-Type`（`application/octet-stream` 等）は単独では `unsupported_mime` にしない**: 保存済み `image-ref.mime`（allowlist 内）+ magic-byte 整合で救済する（上記 2xx body 検証 (ii)）。magic-byte が一致しないときのみ `unsupported_mime`。

2 段目（DB バイト）:

1. `not_found` — **byte-store 導入後のみ**。2 段目（DB バイト）も miss（URL 失効かつ store 未保存）。**v1 は 2 段目が無いので返さず、`expired` で確定**する（byte-store 導入時に「失効だが store にあり救済」と「失効かつ store にも無し＝`not_found`」を区別できるよう reason を予約）。

優先順位は上から評価し、最初に成立した reason を返す（例: allowlist 外への redirect は、その先が 404 でも `forbidden_ref`。403/404 の CDN 応答が HTML/JSON body でも `unsupported_mime` ではなく `expired`）。

> **v1 の実効フォールバック段数**: v1 は既定で画像バイトを保存しないため、2 段目は常に miss し、再取得は**実質「CDN 再 fetch のみ」**。2 段フォールバック構造は `media-byte-store` 導入時に DB バイト優先へ無改造で切り替えられるよう**点だけ用意**したもので、v1 で動的に効くのは 1 段目だけである旨を明記する（誤って「v1 で失効に強い」と読まれないように）。
>
> CDN URL の data URL 直渡しではなく**再 fetch + 再 base64** にする理由: OpenRouter に `image_url` を URL 直渡しすると上流が CDN を取りに行くが、失効 URL はそこでも失敗し**制御不能な provider エラー**になる。bot 側で先に取得して data URL 化すれば、失効を**取得段階で検出**して穏当な tool 結果へ縮退できる。OpenRouter の `image_url` は URL でも base64 data URL でも受理する（参照: multimodal docs）。

### 再注入の運搬（剥がし解除）

- `view_image` の成功時、handler は取得済みの data URL を **`meta.invocationId` キーの per-call staging スロットへ置く**（既存の live マップキーがあれば再 fetch せず冪等成功＝staging も既存値を指す）。**handler は live の再注入マップ `Map<"<turn_ref>.<part_index>", { dataUrl, mime, byteLength }>` を直接書かない**。
- **commit（staging → live マップ promote）は loop が所有する**: 基盤が当該 call の結果を `request cancel > timeout > handler 結果` で分類し、**「成功 handler 結果」として `role:"tool"` を accept したときだけ** loop が staging を live マップへ promote する。timeout/cancel/abandon と分類された call は staging を **破棄**（promote しない）。これにより、loop が `timeout`/`cancelled` を確定した後に late 完了した handler の取得バイトが次リクエストへ漏れることを防ぎ、モデルが受け取る `role:"tool"` 結果（成功/失敗）と再注入マップの内容を常に一致させる（基盤の「副作用安全性は tool 側が abort-aware に担保」要請を、commit を loop の accept 段へ寄せることで満たす）。
- 次ターンの request 構築（hydration → `stripHistoricalMedia()`）で、このマップに含まれる part は**剥がさず、handler が取得済みの `dataUrl` を `image_url` として残す**（CDN URL 直渡しはしない＝上流に再取得させない）。
- **ターン順序**: tool を call した**そのターンの assistant message には画像は載らない**。OpenRouter の通常 tool フロー上、画像が文脈に入るのは `role:"tool"` 結果を受けた**次のモデルリクエスト**から（このとき hydration が再注入マップを反映する）。`role:"tool"` 成功結果は「画像を取得し**次のモデルリクエストへ再注入待ちにした**」旨に留め、**「次で必ず見える」と断定しない**（実際に request に載るかは次ターンの予算/pin/総数検証で確定するため。下記「再注入 turn のピン留め」の verify-or-degrade と整合させ、成功 tool 結果と実体の乖離を作らない）。モデルが同ターンで見えないことを前提に動けるようにする。これは tool calling の標準的な往復であり想定どおり。
- **再注入 turn のピン留め（soft-pin + 確定的縮退）**: 次ターンの hydration が**トークン予算で当該 turn を文脈から落とすと**、`view_image` が成功を返したのに画像がモデルに届かない齟齬が起きる。これを 1 つの確定的優先規則で扱う（「必ず含める」と「諦める」の両論併記を排す）:
  1. **soft-pin（最優先の保持対象）**: 再注入マップに含まれる (turn_ref, part_index) の turn は、予算逼迫時の**eviction 順序で履歴文脈の中の最優先保持**にする（通常の古い exchange より先に他を落とす）。conversation-context の境界選択ルールに「再注入 pin は通常の予算落としより優先」を加える協調。
  2. **不可縮減オーバーフロー時のみ縮退**: 他の落とせる文脈（古い exchange・他のメディア剥がし）を最大限落としてもなお当該再注入画像を載せると予算/モデル画像枚数上限を超える場合に限り、その再注入を**載せない**。pin は絶対保証ではない（巨大画像 1 枚が単独で予算を超えることがあるため）。
  3. **verify-or-degrade（成功と実体の乖離を残さない）**: request builder は組み立て後に「再注入マップの各 part が実際に request 配列へ載ったか」を検証し、未載のキーがあれば、短い注記（例: `[note: previously re-fetched image #<turn_ref>.<part_index> could not be re-attached due to context limits; proceed without it or ask the user to re-share]`）でモデルに矛盾を伝える。**注記の挿入位置は provider 可搬な位置に固定**する: **会話途中に独立した `role:"system"` メッセージを差し込まない**（後置 system/developer メッセージは OpenAI 互換 provider 間で扱いが揺れ、tool-call 整合〔assistant `tool_calls` ↔ `role:"tool"` の連続〕も乱しうる）。代わりに **(a) 当該ループの起点である最新 user turn の content 末尾にテキストとして追記**（conversation-context が author ラベルを user 本文へ描画するのと同じ「本文へ inline」パターン。tool-call 列を一切触らない）、それが難しい構成なら **(b) 既に precedence 解決済みの先頭 system prompt 末尾へ追記**する。いずれも**新規メッセージを増やさず既存メッセージの本文に足す**ので、`tool_calls`/`role:"tool"` の隣接規約を破らない。これにより `role:"tool"` の成功（「再注入待ちにした」）と、次リクエストで実際に画像が無いことの矛盾を、モデルが認識できる注記で埋める。
  4. **degrade-loop の遮断（exhausted 集合）**: 注記を入れた（＝予算で載せられなかった）当該キーは、再注入マップから外すと同時に**per-loop の `exhaustedRehydrationRefs` 集合に記録**する。`view_image` の preflight は、**`eligibleOmittedImageRefs` の member であっても `exhaustedRehydrationRefs` に入っているキーは再取得せず `budget_exceeded` の error 結果**を返す（凍結 eligible 集合だけだと、同じキーが「fetch 成功→予算で drop→注記→モデルが再度 call→また drop」の無限ループに陥るため、一度予算で諦めたキーは当該ループ内で確定的に打ち切る）。`exhaustedRehydrationRefs` も再注入マップ同様 `runToolLoop()` のローカル状態で、次のユーザ発話（新ループ）では空に戻る。
  5. **exhausted の二重ゲート不変条件（map と hydration の両消費者を支配）**: 再注入状態には**消費者が 2 つ**ある — (i) `view_image` handler preflight（exhausted を見て `budget_exceeded`）と (ii) hydration/`stripHistoricalMedia()`（live 再注入マップを直接読んで当該 part を data URL で残す）。preflight だけを exhausted ゲートにすると、live マップに残ったままのキーを (ii) が**同ループ内の後続リクエストで再び載せ**、すでにモデルへ送った「載せられなかった」注記と矛盾し 400/degrade を再発させる。よって**キーを exhausted にする操作は単一の不変条件として規定**する: **(A) live 再注入マップおよび当該キーの per-call staging から物理的に除去し、(B) `exhaustedRehydrationRefs` に追加し、(C) hydration は `rehydrate` を honor する前に `exhaustedRehydrationRefs` のキーを必ず除外する**（A の取りこぼしに対する belt-and-suspenders。`stripHistoricalMedia()` には `rehydrate` と併せて `exhaustedRehydrationRefs` を渡し、後者を優先して当該 part を剥がしへ戻す）。pre-send 縮退（上記 4）も post-send 400 retry（下記「上流拒否」）も**この同一不変条件**を使い、exhausted 化を「マップから消す + 集合に入れる + hydration が無視」の 3 点セットで完結させる。
- **同時実行・上限の原子性**: tool-calling-foundation v1 は **dispatch を sequential**（現 call が settle/abandon するまで次 handler を開始しない）と規定するため、複数 `view_image` call が並行して容量チェックを跨ぐレースは v1 では起きない。本 change の冪等・上限判定は**この逐次 dispatch 前提**に依存する（キー単位の冪等 + サイズ判定は単一実行者で安全）。将来 foundation が並列実行を入れる場合は、再注入マップに atomic な reserve/commit を足す（将来別 change 候補に記載）。
- 寿命: マップは `runToolLoop()` のローカル状態なので、**ユーザの次発話（新しい `runToolLoop()` 呼び出し）では空に戻る**。履歴 `image-ref` は不変なので、次の会話では再び剥がし対象。
- 上限: `マップのサイズ <= MAX_REHYDRATED_IMAGES`。新規キー追加が上限を超えるなら handler が error 結果（`reason:"limit_exceeded"`）を返し、マップには積まない（既存キーの再要求は枚数を増やさないので冪等成功）。
- **リクエスト全体の画像数/サイズとの整合**: `MAX_REHYDRATED_IMAGES` は**再注入分だけ**の上限で、次リクエストの**総画像数**（現ターン添付 + 再注入）や body サイズ・トークン予算は別管理。OpenRouter はプロバイダ/モデルで画像枚数上限が異なるため、(a) 再注入画像のコストを conversation-context の**予算予約に算入**する。ここで予約は **2 つの別物を区別**して扱う:
  - **body サイズ予約**: data URL の**符号化後長**で測る（base64 で約 4/3 ＋ `data:<mime>;base64,` プレフィクス ＋ JSON 文字列エスケープのオーバーヘッド。生 `byteLength` で予約すると 1/3 強過小評価する）。これは request ボディ/ペイロード長の見積りで、data URL 長から決定的に計算できる。
  - **画像トークン予約**: 画像が消費する**入力トークン**は body byte 数ではなく **provider/モデルの画像課金方式（タイル分割・解像度依存等）**で決まり、`data:` バイト長からは導けない。`supported_parameters`/モデルメタにも枚数・トークン上限は載らないことが多い。よって**正確推定は狙わず、再注入画像 1 枚あたり保守的な固定トークン量を予約**する（過大に倒し、足りなければ後段で縮退）。pin/縮退の判断は body サイズと画像トークンの**両予約の最大充足側**で行う。
  (b) **pre-send に**総数がモデル上限を超える/予算に収まらないと判別できる場合は載せず、上記「再注入 turn のピン留め」の **verify-or-degrade**（同 request 内への注記〔挿入位置は上記 provider 可搬規則〕+ exhausted 記録）で縮退する。送信後に上流が拒否する**残余**ケースは下記「上流拒否（post-send）への対処」で扱う（画像トークン量は確実に pre-send 算定できないので post-send フォールバックが最終防御）。
- **上流拒否（post-send）への対処（retry-vs-note の確定）**: pre-send で「載せても大丈夫」と判断しても、**予測不能なモデル/プロバイダ画像枚数上限**で OpenRouter が**送信後に 400 拒否**しうる。拒否された request にはもう注記を差し込めない（既に送って失敗）ので、次の確定規則で扱う:
  1. **第一防御は pre-send 回避**（(a) の予算予約 + 既知の画像枚数上限の事前チェック）。正確にすれば post-send 拒否は稀。
  2. **retry を発火する確定的トリガー（メッセージ文字列に依存しない）**: **プロバイダ 400 はどの画像が原因かを示さないことが多い**ため、「画像起因か」をエラー本文の pattern-match で当てに行かない（脆く非決定的）。代わりに**ステータス + 当該 request の構成だけで決める**: **(i) HTTP `400`（client error）で拒否され、かつ (ii) その request が再注入画像を 1 枚以上含み、かつ (iii) server tool 非提示**の 3 条件が揃ったときだけ、bounded 1 retry を行う。`429`/`5xx` 等の非 400 は画像ペイロード起因ではない（transient/容量無関係）ので retry せず通常エラー経路、再注入画像ゼロの 400 も画像起因ではないので通常エラー。これで「画像起因と判別できるもの」を**保守的だが完全に決定的な条件**に置き換える（条件不成立＝通常エラー）。retry では**当該 request の再注入画像を全件外す**（部分プルーニングで原因を当てに行かない。条件 (ii) が成立する以上、外せば画像ペイロードは確実に縮む）。外した**全 (turn_ref, part_index) を上記「exhausted の二重ゲート不変条件」で exhausted 化**する（live 再注入マップ/staging から除去 + `exhaustedRehydrationRefs` に追加 + 以降の hydration が無視）。これにより retry 後の同ループ後続リクエストの hydration が同じ画像を再び載せ直すことはない。それらを列挙した 1 つの注記を**上記 verify-or-degrade と同じ provider 可搬な挿入位置**（最新 user turn 本文末尾、難しければ先頭 system prompt 末尾。独立 `role:"system"` メッセージは増やさない）に添えて再送する。これで「どの 1 枚を消すか」の非決定性を排し、retry が再注入ゼロで確実に通る形にする（現ターン添付の画像は再注入ではないので外さない）。**この保守トリガーの代償は「画像と無関係な 400 でも 1 回だけ無駄 retry しうる」こと**だが、bounded 1 回・再注入ありの 400 限定なので許容する（無駄 retry も画像を外すだけで client tool 結果は再利用、副作用なし）。image-free retry がなお失敗すれば通常 API エラーへ。**デバッグ性の保全**: 画像起因でない request-shape バグが「画像を外した retry が偶然通る」ことで 1 回マスクされうるので、**retry 前に元の失敗 request 形状（モデル/総画像数/再注入キー一覧）と上流エラー本文を warn ログに残す**（retry が成功しても元の 400 は観測可能に保つ）。
  3. **retry は「同一 assistant 継続リクエストの transport 再送」であって tool の再 dispatch ではない**: 直前の assistant `tool_calls` と各 `role:"tool"` 結果は**そのまま再利用**し（client tool handler を再実行しない＝既実行の client 側副作用を二重化しない）、変更するのは**履歴 user content から再注入 image part を外す（プレースホルダへ戻す）だけ**。`tool_calls` ↔ `role:"tool"` の対応は触らないので**メッセージ列は tool-call-valid のまま**。
  4. ただし**その request に server tool が同居していた場合は再送しない**（server tool は OpenRouter がリクエストごとに再実行するため二重実行・二重課金になる。client tool 結果の再利用は安全だが server tool は再送で再走する。foundation の「全リクエスト自動再試行はしない」方針と一貫）。**「同居」の確定的判定 = 再送しようとしている当該 request に server tool が 1 つでも `tools` 配列へ提示（advertised）されているか**で判断する（`runToolLoop()` が受け取った `serverTools` 引数が非空かどうか。基盤は client tool と server tool を同一 `tools` 配列で再送するため、この提示有無は **request 組立側が確定的に知れる**）。**「実際に server tool が走ったか（invoked）」では判定しない**: 400 拒否された request には使える assistant 応答が無く実行有無を事後に確証できないため、提示されていれば**保守的に再送禁止**とする（提示ゼロ＝client tool だけのループでのみ再送可。これにより判定が常に決定的で、server tool 二重課金リスクをゼロに倒す）。server tool 同居時・retry でもなお失敗時は、foundation の**通常 API エラー経路へ委ね**（view-image 固有の silent retry はしない）、外した ref は exhausted のまま次へ持ち越す。
  - 結論: **pre-send 不適合 = 同 request 内 note / post-send `400` 拒否（再注入画像 ≥1 ・server tool 非提示）= bounded 1 transport 再送〔再注入全件 drop + 全件 exhausted + 列挙注記・tool 結果は再 dispatch せず再利用〕/ それ以外（非 400・再注入ゼロ・server tool 同居・retry 後再失敗）= 通常エラー**。これで「retry か note か」「どの画像を外すか」「tool 副作用の二重化」の非決定性/リスクを、エラー本文 parse なしの**ステータス + request 構成**だけで決定的に解消する。

### tool スキーマ（骨子）

```ts
// src/llm/tools/viewImage.ts
export const viewImageTool: IClientTool<{ turn_ref: string; part_index: number }> = {
  name: "view_image",
  description:
    "Re-fetch and re-attach a previously-omitted image from the conversation history " +
    "(referenced by the [earlier image omitted #<turn_ref>.<part_index>] placeholder) " +
    "so you can look at it again in detail. One image per call.",
  parameters: {
    type: "object",
    properties: {
      turn_ref: {
        type: "string",
        pattern: "^[A-Za-z0-9]+$", // delimiter-safe（'.' 不可）。区切り曖昧性を schema で防ぐ
        maxLength: 64,
        description: "The <turn_ref> shown in the placeholder verbatim (e.g. k7t3)",
      },
      part_index: { type: "integer", minimum: 0, description: "The <part_index> in the placeholder" },
    },
    required: ["turn_ref", "part_index"],
    additionalProperties: false,
  },
  // history 有効 && model が画像入力対応（isMultimodalCapable !== false; null は透過）&&〔可能なら〕eligible 集合が非空
  isEnabled: (ctx) => ctx /* historyEnabled && imageCapable(model)!==false && eligibleOmittedImageRefs.size>0 */ != null,
  validate: (args) => {
    /* shape のみ: turn_ref:string / part_index:int>=0。turn の存在/種別は ctx 依存なので handler preflight */
  },
  // handler: preflight（凍結マップで turn_ref 解決・part_index 範囲・image-ref 種別・eligibleOmittedImageRefs membership）
  //        → imageRehydrator（CDN 再 fetch）→ 成功なら meta.invocationId の staging へ {dataUrl,mime,byteLength} を stage
  //        （live 再注入マップへの promote は loop が成功 role:"tool" accept 時に行う。handler は live マップを直接書かない）
  handler: async (args, ctx, signal, meta) => {
    /* ... returns { llmResult, render? }（throw/timeout/cancel でも構造化 error 結果） ... */
  },
};
```

> `validate` は引数の **shape** だけを担う（基盤契約: `JSON.parse` 後の runtime 検証で、ctx を持たない）。`turn_ref` の存在・`part_index` 範囲・`image-ref` 種別・`eligibleOmittedImageRefs` membership（実際に剥がされた画像か）は ctx（凍結マップ + 凍結適格性集合）が要るため `handler` 冒頭の **preflight** で検証し、不成立なら error tool 結果（`forbidden_ref`）にする。基盤は validate 不適合を実行前に弾くが、ctx 依存の検証は handler 内で行うのが分担として自然。

### 定数

- `MAX_REHYDRATE_BYTES`: 1 枚あたり再取得を許可する最大バイト（例 8MB。剥がし対象は古い画像なので保守的に）。
- `MAX_REHYDRATED_IMAGES`: 1 ループ内で同時再注入できる枚数（例 3）。
- CDN host allowlist: `cdn.discordapp.com`, `media.discordapp.net`（exact match）。**運用注記**: Discord が将来別の CDN ホスト名を導入すると、その URL は `forbidden_ref` になる（exact 一致のため）。これは安全側の既知の互換性ポイントで、**疑わしいユーザ操作ではなくメンテ対象**として扱う（ホスト追加で対応。ログは compat 失敗として分類）。
- **信頼境界は host レベル（path は検査しない）**: 許可ホスト上であれば redirect 先の path は問わない。これは意図的な決定で、(1) URL は**ユーザ/モデル供給ではなく**保存済み `image-ref`（Discord 添付由来）から来る、(2) host は public Discord CDN に固定、ため path-prefix 検証は不要。もし将来「元の添付 URL path のみ許可」へ狭めたくなったら path-prefix 検査を足す（現状は不要）。
- mime allowlist: `image/png`, `image/jpeg`, `image/gif`, `image/webp`（既存 `SUPPORTED_IMAGE_MIME` と一致）。

## Tasks

- [ ] conversation-context へ協調インタフェース追加を依頼/実装: `stripHistoricalMedia()` が `viewImageEnabled`（プレースホルダにキー埋め込み）と `rehydrate` 再注入マップを受け、**剥がした image part の `(turn_ref, part_index)` 集合 `eligibleOmittedImageRefs` を返す**。`turn_ref` 採番（衝突なし）+ 凍結マップ（turn_ref マップ + 適格性集合）を hydration が tool ctx へ渡す。**再注入 turn の pin（予算落とし対象外）** + 再注入画像のトークン/サイズを**予算予約に算入**し、未載なら成功と乖離させず注記へ縮退
- [ ] `src/services/imageRehydrator.ts`: turn_ref 解決（凍結マップ）+ optional byte-store provider（v1 未配線）の 2 段フォールバック（CDN host allowlist + 匿名 fetch + redirect 防御 + status 先行分類 / store バイト再検証）+ mime essence/magic/byte 検証 + `expired`/`fetch_failed`/`timeout` の分類
- [ ] `src/llm/tools/viewImage.ts`: `IClientTool`（parameters/validate=shape のみ/handler=preflight〔判定順: forbidden_ref→budget_exceeded→冪等成功→limit_exceeded→取得〕/isEnabled）+ **取得バイトを `meta.invocationId` の staging へ stage（live 再注入マップへは書かない）** + `ToolRenderPayload`
- [ ] 基盤 `registry` に `view_image` 登録（`isEnabled` = `viewImageEnabled`〔history && `isMultimodalCapable!==false`〕＋〔可能なら〕eligible 非空。**guild 履歴有効だけでは不十分**）、`toolLoop` に per-loop 再注入マップ + per-call staging + `exhaustedRehydrationRefs` の保持・**staging→live マップ promote は成功 `role:"tool"` accept 時のみ（cancel・timeout 分類で staging 破棄）**・次ターン hydration への受け渡し・verify-or-degrade（未載キーの注記挿入 + exhausted 記録）・post-send `400` 拒否の bounded 1 rebuild-retry（再注入 ≥1・server tool 非提示時のみ）
- [ ] テスト: validate（shape 不正は基盤が弾く）/ preflight 失敗（unknown turn_ref / **過去ループ nonce の stale ref → `forbidden_ref`（fail-closed）** / 範囲外 / 非 image-ref / 非 omitted（未剥がし）→ `forbidden_ref`、exhausted キー → `budget_exceeded`、上限 → `limit_exceeded`、判定順: exhausted が stale マップ hit を支配）、**loop 所有 commit の abort-aware 性（handler は staging のみ・成功 accept で promote / timeout・cancel 分類で staging 破棄＝次リクエストに漏れない・late 完了 handler が live マップを汚さない）**、CDN 再 fetch 成功・失効（非 transient 非 2xx＝`401`/`403`/`404`/`410`/`451`/catch-all `4xx` は body を見ず `expired`）・transient（DNS/接続/`5xx`/`429` → `fetch_failed`）、**非 2xx の非画像 body を `unsupported_mime` に誤分類しない（status 先行分類）**、host/redirect（相対 Location 解決・匿名・各ホップ再検証）/mime（essence parse）/magic/byte 拒否、**欠落/generic な `Content-Type`（`application/octet-stream`）は header で `unsupported_mime` に落とさず persisted mime + magic で救済 / 具体的非 image type or magic 不一致のみ `unsupported_mime`**、timeout→`timeout`、再注入マップ put・冪等・上限、verify-or-degrade で未載→注記→同キー再 call が `budget_exceeded`（degrade-loop 遮断）、**post-send retry トリガーの決定性**（`400` + 再注入 ≥1 + server tool 非提示でのみ 1 回 rebuild-retry / 非 400・再注入ゼロ・server tool 同居・retry 後再失敗は通常エラー）、isEnabled（text-only モデルで false / `null` は透過）、DB バイトフォールバック（mock provider の将来パス・store バイト再検証）
- [ ] `docs/changes/view-image-rehydration/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **conversation-context の契約修正（passive consumer ではなく依存契約の amendment）**: 本 change は conversation-context（**確定 doc**）の `stripHistoricalMedia()`/hydration 契約に次を**追加要求**する: (1) `viewImageEnabled` 引数とキー付きプレースホルダ、(2) `rehydrate` 再注入マップ引数と当該 part の data URL 据え置き、(3) 戻り値 `eligibleOmittedImageRefs`、(4) 凍結 `turn_ref` マップの採番、(5) 再注入 part の soft-pin を境界選択ルールに織り込む。これらは単なる「協調」ではなく**実装前に合意・着地させるべき依存契約の amendment**であり、conversation-context 側の Tasks/契約にも反映が要る（同 doc は本 change を「連携」として参照済み）。
  - **依存順序の確定（曖昧にしない）**: 本 change は conversation-context を **先行（prerequisite）**として依存する。`stripHistoricalMedia()` の options 拡張（(1)-(3)）と境界選択の pin フック（(5)）は、**後方互換・既定 off の拡張として conversation-context に先に landing する**（または view-image の PR がそれを含む形で同 PR 内に landing し、view-image 配線はその拡張が存在することを前提に乗る）。**順序の制約は「拡張 API の存在が先・view-image の有効化は後」で確定**であり、実装着手時に調整するのは「どの PR がそのコードを物理的に置くか（conversation-context 単独 PR か、view-image の PR が conversation-context ファイルも触るか）」だけである。拡張は既定 off なので、conversation-context に先に入れても**その時点では一切の挙動変化が無く**（view-image 無効 = 従来の strip）、view-image 側が `viewImageEnabled` を真にして初めて有効化される。**契約自体は本 doc で確定**とする。
  - **amendment は後方互換（opt-in）であり、確定 doc を破らない**: (1)-(3) は `stripHistoricalMedia()` の **options 拡張**として入れ、**新引数の既定値が conversation-context の確定契約をそのまま再現する**ことを必須にする。具体的には `viewImageEnabled` 省略/false のとき = 従来どおりプレースホルダは無印 `[earlier image omitted]`、`rehydrate` 省略/空のとき = 全 image/file part を従来どおり剥がす、`eligibleOmittedImageRefs` は**追加の戻り値（既存戻り値は不変）**で view-image 無効時の呼び出し側は無視できる。これにより確定 doc の「最新メディア user turn より前を placeholder へ剥がす・保存不変・純関数」という不変条件は**既定パスで byte-for-byte 保たれ**、view-image はその上に**有効時のみ**乗る拡張になる（＝既存契約の違反ではなく拡張）。
  - **strip を直接拡張する理由（純後段 wrapper を採らない）**: キー埋め込みのプレースホルダ文字列は strip が生成し、`eligibleOmittedImageRefs`（どの part を実際に剥がしたか）も strip の判断そのものから出る。`rehydrate` の pin（どの part を剥がさず残すか）も strip の剥がし対象選定に割り込む。これらは strip の**出力前に**確定する必要があり、剥がし済み配列だけを見る純粋な後段 wrapper では「どれを・なぜ剥がしたか」を再導出できない。よって options 拡張が正しく、純後段ラップは不採用。
  - **(5) の soft-pin は別タッチポイント**: strip とは別に、conversation-context Section 4 の**境界/予算選択**に「再注入 pin は通常の予算落としより優先」フックを足す（こちらも view-image 無効時は no-op の opt-in）。strip 拡張と pin フックの 2 点が conversation-context への amendment の総量で、いずれも既定で従来挙動。
- **per-loop scratch state の置き場（契約は確定・API 名のみ留保）**: 契約は「`runToolLoop()` が per-loop の可変 rehydration state（再注入マップ + `exhaustedRehydrationRefs`）を所有し、`IToolContext` 経由で `view_image` handler に渡す」で確定（tool が履歴を直接書き換えない基盤契約を守りつつ次ターン hydration に影響させる唯一の経路）。基盤 doc に scratch 概念が無いため、**最小侵襲な ctx mutable 参照 1 つ**を第一候補とし、基盤側のフィールド名/API 形だけ実装時に確定する。
- **CDN URL 直渡し vs 再 fetch のコスト**: 全再注入で bot 側 fetch + base64 を行うと帯域/メモリを使う。失効検出の確実性を取って再 fetch を既定にするが、`MAX_REHYDRATE_BYTES`/枚数上限で抑える。将来 `media-byte-store` 導入時は DB バイト優先に切替。
- **画像バイト永続化（`media-byte-store`）**: 本 change は「保存されていれば使う」フォールバック点のみ用意し、保存自体は容量設計（オプトイン・TTL・上限）を伴う別 change に委ねた。CDN 失効が頻発するなら優先度を上げる。
- **モデルの参照精度**: モデルがプレースホルダの `turn_ref`/`part_index` を正確に転記できるか。description と placeholder 形式で機械転記しやすくするが、誤参照は `forbidden_ref` error 結果で穏当に縮退する（実害なし）。
- **pin と予算の優先順位**: 規則は本文「再注入 turn のピン留め」で**確定済み**（soft-pin = 履歴文脈の最優先保持 → 不可縮減オーバーフロー時のみ載せない → verify-or-degrade のシステム注記 → `exhaustedRehydrationRefs` で当該ループ内の再試行を打ち切り）。残る調整余地は、pin が他の有用な exchange を押し出す度合い（予算予約の保守係数）と注記文言のみで、優先規則自体は再オープンしない。
- **総画像数の上限**: retry-vs-note は本文「上流拒否（post-send）への対処」で**確定**（pre-send 不適合 = 同 request 内 note / post-send `400` 拒否〔再注入画像 ≥1・server tool 非提示〕= bounded 1 rebuild-retry + exhausted / それ以外 = 通常エラー。トリガーは**エラー本文 parse なしのステータス + request 構成**で決定的）。残る不確実性は「モデル/プロバイダ別の画像枚数上限を pre-send にどこまで正確に知れるか」（`supported_parameters`/モデルメタに枚数上限は載らないことが多い）で、ここは保守的な既定上限 + post-send フォールバックで吸収する。

## 参照

- [conversation-context design](../conversation-context/design.md) — `PersistedContentPart`（`image-ref`）、`stripHistoricalMedia()`、「メディア再取得はベストエフォート」「バイト永続化は view-image で判断」
- [tool-calling-foundation design](../tool-calling-foundation/design.md) — `IClientTool`（`isEnabled`/`validate`/`handler(args, ctx, signal, meta)`）、`runToolLoop()`、`ToolRenderPayload`、handler は throw/timeout でも必ず結果を返す契約
- [OpenRouter Images & PDFs](https://openrouter.ai/docs/features/multimodal/images) — `image_url`（URL / data URL）content part の送信形
- 既存実装: `src/services/attachmentParser.ts`（`{type:"image_url", image_url:{url}}`、`SUPPORTED_IMAGE_MIME`）
- 既存実装: `src/services/modelService.ts`（`isMultimodalCapable(model, "image")` tri-state）・`src/bot/events/messageCreate.ts`（ライブ画像送信前の capability ゲート。`false`=中止 / `null`=透過 / `true`=続行）
