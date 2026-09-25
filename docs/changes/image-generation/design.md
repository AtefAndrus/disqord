---
title: "画像生成"
status: investigating
priority: medium
summary: "OpenRouter で画像を生成し、生成画像と生成ファイルを Discord の MediaGallery / File で表示する"
---

# 画像生成

## Why

会話の流れで「この内容の図を作って」と頼まれても、Bot はテキストしか返せない。
OpenRouter には画像生成の手段が複数あるが、どれを使っても、生成された画像を Discord のメッセージとして見せる仕組みが現在のコードに無い。
現在の返信は本文、推論の表示、footer を Components V2 の `TextDisplay` で組み立てており、添付は推論の全文を入れる `reasoning.md` の 1 件しか扱わない。

本 change は、画像の生成（producer）と、検証済みの生成物を `MediaGallery` / `File` として返信に組み込む描画（planner）を 1 つの release 単位として設計する。
描画だけを先に出しても生成物を作る側が無く、利用者から見える変化が無いためである。
planner は画像に限らない生成物を扱う形にし、[コード実行](../code-execution/design.md) が生成ファイルの表示に再利用する。

## 依存 / 関連 change

- 前提（実装済み）: [Responses API への移行](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/responses-api-migration/design.md) と [tool-calling-foundation](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/tool-calling-foundation/design.md) — client tool の登録と実行、server tool の送出、`usage` の parser がある
- 前提（実装済み）: [推論の表示](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/reasoning-output/design.md) — `reasoning.md` の `File` 添付と、編集時の添付の消去を実装済みで、planner はこの添付と同じメッセージに生成物を並べる
- 連携: [コード実行](../code-execution/design.md) — 生成ファイルの表示に本 change の planner を使う。どちらが先に実装されても、planner は本 change の仕様どおりに実装する
- 先行: [ギルド設定変更の共通認可](https://github.com/AtefAndrus/disqord/blob/72517eb35f9d3e8928a954f83e12da2f445d9424/docs/changes/permissions/design.md) — 画像生成のトグルの変更は同 change の共通認可関数で判定する
- 先行: [設定パネル（/config の再構成）](https://github.com/AtefAndrus/disqord/blob/67291dde3d1ca40f9243d10430e98c3600341dbf/docs/changes/config-panel/design.md) — 画像生成のトグルは同 change の「機能」ページの項目として足す
- 連携: [使用統計](../usage-stats/design.md) — 画像生成の費用を保存対象に含める

## Goals / Non-Goals

**Goals:**

- 画像生成を有効にした guild で、モデルが必要と判断したときに画像を生成し、返信に画像として表示する
- 画像の producer を 1 つ選び、その応答を検証済みのバイト列、MIME、ファイル名、代替テキストを持つ内部の生成物（`ResponseArtifact`）へ正規化する
- 生成物ごとの失敗を警告（`ArtifactWarning`）として本文と一緒に表示し、1 件の失敗で回答全体を失敗にしない
- 本文、推論の表示、生成物、警告、footer を Discord の component 数と添付の上限に収める planner を作る
- 画像生成の費用を footer の費用に含め、1 回の生成で作る画像の枚数に上限を置く

**Non-Goals:**

- 画像の編集（入力画像を参照する image-to-image）、動画と音声の出力
- 生成物の永続保存、再ホスト、履歴からの再取得
- 入力画像と入力 PDF の解析（実装済みの入力マルチモーダル）
- OpenRouter の `openrouter:fusion` / `openrouter:advisor` / `openrouter:subagent`。複数モデルの比較は `/model` で切り替えて聞き直せば足り、上位や下位のモデルへの自動委譲は 1 回の返信の費用と使われるモデルを利用者から予測しにくくするため、採らない

**将来別 change 候補:**

- `/image <prompt>` のような、会話のモデルを介さない明示コマンド。本 change の producer と planner をそのまま使える

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| release 単位 | producer と planner を 1 フォルダで出す | planner だけでは表示するものが無く、producer だけでは表示できない |
| producer | 画像専用の Images API（`POST /api/v1/images`）を、client tool `generate_image` の handler から呼ぶ | 候補の比較は Design「producer の比較」。応答が base64 のバイト列と MIME を持つので外部 URL を取得せずに済み、呼び出し回数と費用を Bot 側で数えられる |
| 画像生成のモデル | 環境変数 `IMAGE_GENERATION_MODEL` で Bot 全体に 1 つ決める | 会話のモデル（`/model`）とは別物であり、画像モデルの料金は 1 枚あたりで会話のモデルと桁が違う。guild ごとの選択は需要を見てから別 change で扱う |
| 1 回の生成で作る枚数 | handler 1 回につき `n = 1`、1 回の生成（1 回の `runToolLoop()`）で最大 `IMAGE_GENERATION_MAX_IMAGES`（既定 4）枚。上限に達した後の呼び出しは生成せずに上限到達を tool の結果として返す | client loop の `MAX_TOOL_CALLS_PER_TURN` と `MAX_TURNS` だけでは 1 回の生成で 30 枚を超えうる。1 枚ずつ呼ばせると、上限の判定と失敗の切り分けが 1 枚単位になる |
| 有効化ゲート | `guild_settings.image_generation_enabled`（既定 0）と、環境変数 `IMAGE_GENERATION_ENABLED`（既定 `false`） | 1 枚ごとに課金されるので opt-in にする。環境変数は、料金や挙動が変わったときに guild の設定を触らずに止めるためのもの |
| トグルの認可 | [ギルド設定変更の共通認可](https://github.com/AtefAndrus/disqord/blob/72517eb35f9d3e8928a954f83e12da2f445d9424/docs/changes/permissions/design.md) の共通認可関数 `canManageGuildSettings` で判定する | 1 枚ごとに課金されるので、ほかのギルド設定の書き込みと同じく一般メンバーには切り替えさせない |
| トグルの置き場所 | [設定パネル](https://github.com/AtefAndrus/disqord/blob/67291dde3d1ca40f9243d10430e98c3600341dbf/docs/changes/config-panel/design.md) の「機能」ページに、Web 検索と同じ 1 回の押下で切り替わる on/off の項目として置く。確認の 2 段は挟まない。`/status` は状態を表示するだけにする | 課金を伴う点は Web 検索と同じで、外部へのデータの持ち出しは会話のモデルへの送信の範囲を超えないので、有効化の前に読ませる確認文が要らない |
| tool の結果としてモデルへ返す内容 | 成否、生成したファイル名、改訂されたプロンプトがあればそれ。画像そのものと URL は返さない | モデルが本文に URL や base64 を書き写す経路を作らない。画像をモデルに見せる必要は無く、見せると入力トークンの費用が増える |
| 生成物の境界 | producer は検証済みのバイト列だけを `ResponseArtifact` にする。planner と描画は URL、data URL、base64 文字列を受け取らない | 出所を失った共通層では、取得先の検証やサイズの強制を producer ごとに適用できない |
| MIME | magic byte で PNG / JPEG / WebP / GIF を判定して `MediaGallery` に入れる。それ以外（SVG を含む）は `File` として扱う | 応答の `media_type` は省略されうる（OpenAPI 定義の `ImageGenerationResponse`）。SVG は Discord client のインライン表示が安定しない |
| 代替テキスト | 生成に使ったプロンプトを、省略記号を含めて UTF-16 code unit で 1024 以内に収まるよう、code point の途中で切らずに切り詰める。切り詰めたときは末尾に省略記号を置く | `MediaGallery` の item の description は最大 1024 文字で、超えると message の送信や編集全体が失敗する。`@discordjs/builders` の検証は JavaScript の `string.length`（UTF-16 code unit）で数えるので、code point で 1024 に収めても補助面の文字が多いと超える |
| ファイル名 | `img_<生成の requestId>_<連番>.<拡張子>` の ASCII 名にする | 同名の添付による `attachment://` 参照の衝突を防ぎ、編集の再試行で同じ生成物を識別するため |
| ストリーミング中の表示 | 生成中は「画像を生成中」の進捗だけを出し、画像は回答の確定時に最後のページへ添付する | 途中のページ編集のたびに画像を再アップロードすると、通信量と rate limit の消費が増える |
| 成功判定 | 本文か生成物のどちらかが 1 つでもあれば成功とし、両方が空ならエラー表示にする | 画像だけを返した回答を「（応答なし）」と表示しないため |
| 警告の表示 | footer の前に専用の `TextDisplay` を置き、Markdown を escape した警告を最大 5 件、各 200 code points まで出す。超過分は「ほか N 件」とまとめる。警告の文字数は、escape 後の長さで 1 メッセージの文字数とバイト数の予算（`chatContainerBuilder.ts` の共有予算）から先に差し引き、本文の分割をその残りで行う | 部分的な失敗を利用者に伝えるため。`TextDisplay` を分けても 1 メッセージの予算は本文と共有なので、差し引かずに足すと上限を超える |
| 自動の再試行との関係 | `generate_image` が 1 回でも実行された生成では、Web 検索の失敗時の再試行とツイート画像を外した再試行（`generateChatResponse` のループ全体のやり直し）をしない | 再試行はループ全体をやり直すので、生成済みの画像を捨てて枚数の上限と費用を 2 回分使う。現在の再試行も、`read_earlier_messages` と `view_attachment` が実行された後はやり直さない（`clientToolInvoked`）ので、同じ判定に `generate_image` を加える |
| mention の抑止 | 既存の payload builder（`allowedMentions: { parse: [] }` を常に含む）を通して送る | 生成物と警告を載せたメッセージだけ別経路で送ると、mention の抑止が漏れうる |

## Design

### producer の比較

OpenRouter から画像を得る方法は 3 つあり、どれも OpenAPI 定義（`https://openrouter.ai/openapi.json`）と docs に記載がある。
2026-09-24 に定義と docs を読んで比較した。
どの方法も wire 上の応答は実測していない。

| 方法 | 画像の受け取り方 | Bot 側の制御 | 採否 |
| ---- | ---------------- | ------------ | ---- |
| (a) server tool `openrouter:image_generation` を `tools` に載せる | output item `OutputImageGenerationServerToolItem`（`id` / `status` / `type` が定義され、`imageUrl` / `imageB64` / `result` / `prompt` / `revisedPrompt` は任意）。docs ではモデルへの tool の結果は `{ status: "ok", imageUrl }` | 回数を縛る `parameters` が無い。実行はリクエスト直下の `max_tool_calls` の 1 ステップを消費する | 採らない |
| (b) Images API `POST /api/v1/images` を client tool から呼ぶ | 応答の `data[]` が `b64_json`（必須）と `media_type`（任意）を持ち、`usage.cost` に費用が入る | handler の呼び出しごとに Bot が枚数と費用を数えられる | 採る |
| (c) Responses API の `modalities: ["text", "image"]` | output item `image_generation_call` の `result` に base64（OpenAPI 定義の例による） | 会話のモデル自身が画像を出力できる場合に限られる | 採らない |

(a) を採らない理由は 3 つある。
1 つ目は、画像が URL で返りうることである。
どのフィールドに値が入るかは定義からは決まらず、URL で返る場合は Bot がその URL を取得する必要がある。
その取得には、HTTPS と取得先の origin の allowlist、redirect ごとの宛先の再検証、private や loopback などへの接続の拒否（SSRF 対策）、読み取り中のバイト数の上限が要るが、許可すべき origin は docs に書かれていない。
2 つ目は、モデルに URL が渡ることである。
モデルがその URL を本文に書き写すと、期限付きの URL が返信に残る。
3 つ目は、回数の制御である。
server tool の実行はリクエスト直下の `max_tool_calls` を消費し、その上限は Web 検索と、Web 検索が無効で、会話履歴があり、モデルが tool に対応するときに載せている `openrouter:datetime` と共有される（`src/services/chatService.ts` の `serverTools` の組み立て）。
画像の枚数だけを縛る手段は無い。

(c) を採らない理由は、会話のモデルが画像出力に対応している場合にしか使えないことである。
guild が `/model` で選ぶのは会話のためのモデルであり、画像のために会話のモデルを変えさせることになる。

(b) の短所は 2 つある。
会話のモデルが function calling に対応していないと使えないことと、tool の往復で 1 ターン増えることである。
前者は、既存の client tool（`read_earlier_messages` / `view_attachment`）が同じ条件で動いていることから受け入れる。
対応していないモデルでは、画像生成を有効にしていても tool を載せない。

### 変更の全体像

```text
messageCreate
  → chatService.generateChatResponse()
      guild 設定を読む → 画像生成が有効で、モデルが tools に対応していれば generate_image を有効にする
  → runToolLoop()
      モデルが generate_image を呼ぶ
        → handler: 枚数の上限を確認 → POST /api/v1/images（n = 1）
                 → b64 を decode → サイズと magic byte を検証 → ResponseArtifact を生成の結果に積む
                 → モデルへは成否とファイル名だけを返す
  → runToolLoop() が返る（本文、usage、artifacts、warnings）
  → messageCreate の finalization
      ResponseLayoutPlanner: 本文のページ、推論の表示、生成物、警告、footer を DiscordResponseMessagePlan[] に割り付ける
      → 各ページを送信または編集（files と attachments を plan どおりに指定）
```

client tool の有効化には、現在の条件の見直しが要る。
現在の `generateChatResponse` は、会話履歴を読む設定が有効なときにだけモデルの `supportsTools` を調べ、client tool（`read_earlier_messages` / `view_attachment`）を載せている。
画像生成は履歴の設定と独立に有効にできる必要があるので、画像生成が有効な場合にもモデルの詳細を取得して `supportsTools` を判定する。

### producer（`generate_image`）

- 引数は `prompt`（1 文字以上、上限は実装時に Images API の制約を見て決める）と、任意の `aspect_ratio`（`ImageGenerationRequest.aspect_ratio` の enum から Bot が許すものだけ）とする。`quality`、`size`、`n` はモデルに選ばせず、Bot の設定で固定する
- handler は `POST /api/v1/images` を `{ model: IMAGE_GENERATION_MODEL, prompt, n: 1, ... }` で呼ぶ。`signal` は既存の tool の timeout と停止ボタンに従う
- 応答の `data[0].b64_json` を decode する前に、encoded の長さで上限を確認する。decode 後のサイズも `IMAGE_GENERATION_MAX_BYTES` で確認する
- magic byte で形式を判定し、許可した形式でなければ警告にして生成物にしない
- 応答の `usage.cost` を、その生成の画像費用として積む。報告が無い場合は 0 と見なさず、footer で「費用不明」を示す
- 失敗（HTTP エラー、上限超過、検証失敗）は、モデルへは失敗として返し、利用者には警告として表示する

### 内部の型

```ts
export interface ResponseArtifact {
  kind: "image" | "file";
  bytes: Uint8Array;
  mime: string;
  filename: string;
  /** MediaGallery の description。1024 code points に切り詰め済み */
  description?: string;
}

export interface ArtifactWarning {
  message: string;
}
```

生成の結果（`ToolLoopResult` とその上の chat の結果）に `artifacts: ResponseArtifact[]` と `warnings: ArtifactWarning[]` を足す。
生成物は tool の handler が作るので、`IToolHandlerResult` に生成物を渡す経路を足すか、tool の context に生成物の収集先を持たせるかは実装時に決める。
どちらの場合も、モデルへ返す `llmResult` には生成物を入れない。

### planner（`ResponseLayoutPlanner`）

planner は、本文のページ分割の結果、推論の表示、生成物、警告、footer の metadata を受け取り、メッセージごとの計画（`DiscordResponseMessagePlan`）の列を返す。
各計画は、そのメッセージの components、新しくアップロードする files、編集で残す既存の attachment を持つ。

planner が守る Discord の制約は次のとおりである（2026-09-24 に Discord の API リファレンスで確認）。

- 1 メッセージの component は、入れ子を含めて合計 40 個まで
- `MediaGallery` の item は 1〜10 個、各 item の description は 1024 文字まで
- 添付は 1 メッセージ 10 件まで。1 ファイルの既定の上限は 20 MiB、1 リクエストの合計は 25 MiB まで
- Container の直接の子の数の上限は、現在のリファレンスでは見つからなかった（未検証）。planner は 40 個の上限だけを強制し、実機で確かめる

現在の 1 ページの Container が消費する component は固定ではないので、planner はページごとに実際の数を数える。
本文は `---` の区切り（`splitAtThematicBreaks`）で最大 `MAX_THEMATIC_BREAKS_PER_PAGE`（8）個の `Separator` と、その間の `TextDisplay` に分かれる。
推論の表示が有効なページには推論の `TextDisplay` が 1 つ加わり、推論が長いときは `reasoning.md` の `File` も加わる（`src/utils/chatContainerBuilder.ts` の `addBadgeAndBody`）。
先頭ページのモデル名、footer の `Separator` と metadata も数に入れる。

生成物は最後のページの本文の後、警告と footer の前に置く。
画像は 1 つの `MediaGallery` にまとめ、10 枚を超える分と、component 数、添付件数、合計バイト数の上限に収まらない分は、続くメッセージへ送る。
続くメッセージにも収まらない分は送らず、件数を警告に出す。
`reasoning.md` は添付の件数と合計バイト数の予算を先に使う。

### 送信と編集

新しいメッセージの送信は、既存の `toComponentsV2Payload` に plan の files を渡す。
既存のメッセージの編集では、plan が残す attachment と新しい files を明示する。
現在の `toComponentsV2EditPayload` は、files を渡すときはその files を付け、渡さないときは `attachments: []` で添付を消している（`reasoning.md` が停止やエラーの表示に残らないようにするため）。
Discord の API v10 では、編集で files を付けると既存の添付に追加され、残す添付は `attachments` に列挙する。
そのため、同じページを `reasoning.md` 付きで編集し直したときに添付が重複するかは確かめていない（未検証）。
planner は、編集で残す attachment を常に明示し、未参照の添付を残さない payload を作る。

最初の編集が失敗した場合は、メッセージを取得し直してファイル名で反映済みの生成物を確かめ、未反映の生成物を 1 件ずつ 1 度だけ再試行する。
再び失敗した生成物は警告に変えて除外し、残りで計画を作り直す。

### footer

現在の footer は `usage.cost` を `Cost:` に、`server_tool_use_details.web_search_requests` を `Searches:` に出しており、server tool の費用（`cost_details.server_tool_cost`）は読み込むが表示していない。
本 change は、画像生成の費用を `Cost:` に合算し、生成した枚数を `Images: N` として足す。
Images API の費用は Responses API の `usage` とは別の応答で届くので、合算は chat の結果を組み立てる側で行う。

### DB と設定

```sql
ALTER TABLE guild_settings ADD COLUMN image_generation_enabled INTEGER NOT NULL DEFAULT 0;
```

切り替えは [設定パネル](https://github.com/AtefAndrus/disqord/blob/67291dde3d1ca40f9243d10430e98c3600341dbf/docs/changes/config-panel/design.md) の「機能」ページの on/off で行う。`/status` は現在の値を表示する。

| 変数 | 既定 | 用途 |
| ---- | ---- | ---- |
| `IMAGE_GENERATION_ENABLED` | `false` | 機能全体の有効化 |
| `IMAGE_GENERATION_MODEL` | 実装時に `GET /api/v1/images/models` から選ぶ | 画像生成に使うモデル |
| `IMAGE_GENERATION_MAX_IMAGES` | `4` | 1 回の生成で作る画像の上限 |
| `IMAGE_GENERATION_MAX_BYTES` | 実装時に決める（20 MiB 未満） | decode 後の 1 枚の上限 |

### 変更対象ファイル

- 新規: `src/llm/tools/generateImage.ts` — client tool `generate_image`（Images API の呼び出し、decode、検証）
- 新規: `src/utils/responseLayoutPlanner.ts` — component 数、添付、警告の割り付け
- 修正: `src/types/index.ts` — `ResponseArtifact` / `ArtifactWarning` / `DiscordResponseMessagePlan`
- 修正: `src/llm/tools/registry.ts` と `src/llm/toolLoop.ts` — handler から生成物を結果へ渡す経路
- 修正: `src/services/chatService.ts` — tool の有効化条件、画像費用の合算
- 修正: `src/utils/chatContainerBuilder.ts` — `MediaGallery` と生成物の `File`、警告の `TextDisplay`、footer の `Images:`、編集の payload
- 修正: `src/bot/events/messageCreate.ts` — plan に従った送信と編集、再試行
- 修正: `src/utils/configPanel.ts` と `src/bot/events/configPanelHandler.ts` — 「機能」ページの項目と認可
- 修正: `src/utils/statusMessage.ts` — 状態の表示
- 修正: `src/db/` と `src/config/envVars.ts` — 列と環境変数
- 修正: `scripts/` の preview fixture — 画像 1 枚、10 枚超、警告あり、推論の添付と同居

## Tasks

- [ ] Images API を実 API で 1 回呼び、`data[].b64_json` / `media_type` / `usage.cost` の wire 形を fixture にする（数セントで済むモデルを選ぶ）
- [ ] `IMAGE_GENERATION_MODEL` の既定と、`quality` / `size` の固定値を `GET /api/v1/images/models` の料金を見て決める
- [ ] 編集で `files` を付けたときの既存の添付の扱いと、`reasoning.md` の重複の有無を Discord で確かめる
- [ ] Container の直接の子の数に上限があるかを実機で確かめる
- [ ] `generate_image` の handler（枚数の上限、decode 前後のサイズ、magic byte、失敗の警告化）とテスト
- [ ] `ResponseLayoutPlanner`（component 数、`MediaGallery` の 10 件、添付 10 件、合計サイズ、`reasoning.md` との同居、Separator の数、警告の予算）とテスト
- [ ] `chatContainerBuilder` と `messageCreate` の送信、編集、再試行とテスト
- [ ] `guild_settings` の列、設定パネルの「機能」ページの項目、`/status` の表示、認可、環境変数
- [ ] footer の費用の合算と `Images:`
- [ ] `bun run preview` の fixture を足す
- [ ] `bun run e2e` に画像生成のシナリオを足すかを決める（1 回ごとに画像の費用がかかる）
- [ ] README に費用とトグルを追記
- [ ] `docs/changes/image-generation/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **wire 形は未実測**: Images API の応答は OpenAPI 定義と docs の例でしか見ていない。`media_type` が省略される場合は magic byte だけで判定する
- **server tool を採らない判断の前提**: (a) の output item に `imageB64` が常に入るなら、URL の取得は不要になり、(a) の短所は回数の制御とモデルへの URL の受け渡しだけになる。実測で分かった場合も、回数の制御のために (b) を維持する見込みだが、そのときに比較し直す
- **function calling に対応しないモデル**: そのモデルを選んだ guild では画像生成が効かない。設定パネルと `/status` で、有効でも使えない状態であることを示すかを実装時に決める
- **費用の予測**: 1 枚の費用はモデルと `quality` / `size` で大きく変わる。上限の枚数と固定値を決めるまで、1 回の返信の最大費用は見積もれない
- **生成物の寿命**: 永続保存しないので、Discord のメッセージが消えれば画像も消え、再生成しない限り再表示できない

## 参照

- [OpenRouter Image Generation（Images API）](https://openrouter.ai/docs/guides/overview/multimodal/image-generation.md) — `POST /api/v1/images`、モデルの一覧
- [OpenRouter Image Generation Server Tool](https://openrouter.ai/docs/guides/features/server-tools/image-generation.md) — `openrouter:image_generation` のパラメータと、モデルへ返る `{ status, imageUrl }`
- [OpenRouter Server Tools](https://openrouter.ai/docs/guides/features/server-tools.md) — `max_tool_calls` が server tool のステップを数えること
- OpenRouter の公開 OpenAPI 定義（`https://openrouter.ai/openapi.json`）— `ImageGenerationRequest` / `ImageGenerationResponse`、`OutputImageGenerationServerToolItem`、`OutputItemImageGenerationCall`、`ResponsesRequest.modalities`
- [Discord Components Reference](https://docs.discord.com/developers/components/reference) — `MediaGallery`、`File`、component 数の上限
- [Discord Edit Message](https://docs.discord.com/developers/resources/message#edit-message) — 編集時の添付の保持と追加
