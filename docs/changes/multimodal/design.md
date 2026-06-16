# マルチモーダル対応

## Why

現在 Bot はテキスト入力のみ受け付けるが、ユーザは Discord に画像や PDF を添付して質問することが多い。
画像認識対応モデルと OpenRouter の PDF 解析（file-parser plugin）を組み合わせれば、画像や文書に関する質問・要約・説明が可能になる。

OpenRouter は 2025-04 に PDF/ファイル入力を GA しており（`type: "file"` content part）、モデルがネイティブ対応していなくても OpenRouter 側でテキスト化して渡せる。
画像入力（`type: "image_url"`）と同じ仕組みの延長で扱えるため、画像と PDF を本 change にまとめる。

**出力モダリティ（生成画像／生成ファイル）は本 change の対象外**。出力側のリッチ表現は後続 change `chat-response-v2` の MediaGallery / File コンポーネント経路で扱う。本 change は **入力**マルチモーダルに限定する。

## Goals / Non-Goals

**Goals:**

- Discord 画像添付を LLM に送信し、マルチモーダル対応モデルで画像認識を実現
- Discord の PDF 添付を `type: "file"` content part として送信し、文書内容に基づく回答を実現
- `OpenRouterModel` および `/models` マッピングを `inputModalities` / `outputModalities` / `supportedParameters` で拡張（後続 Phase の土台）
- `/disqord model set` 応答の embed に対応モダリティを表示
- 非マルチモーダルモデルに画像を送ろうとした際の事前警告

**Non-Goals:**

- 音声・動画の処理
- 出力マルチモーダル（生成画像／ファイルの受信表示）。`chat-response-v2` で扱う
- Bot 側での画像のリサイズ・前処理
- PDF 以外のドキュメント形式（docx / xlsx / mp3 等）のネイティブ対応
- 画像 `detail` フィールドのユーザ制御 UI
- `annotations[].file.hash` を使った PDF 再パース回避（将来最適化）
- ユーザ単位での PDF 解析エンジン切替 UI（`settings-hierarchy` で検討）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 画像 URL 取得元 | Discord CDN URL を直渡し | 追加ストレージ不要。Discord 受信 → 即時 OpenRouter 送信のフローなので、署名付き URL（`ex`/`is`/`hm`）の期限切れは実害無し。base64 化フォールバックは初期スコープ外 |
| ファイル (PDF) の渡し方 | `type: "file"` の `file.file_data` に Discord CDN URL を直渡し | OpenRouter 公式仕様。URL 直渡しが効かないケースが観測されたら別 change で fetch → data URL 化を追加 |
| PDF 解析エンジン | `cloudflare-ai` 固定（無料の Markdown 変換） | 課金なしで開始可能。精度が必要なら `mistral-ocr`（$2/1000ページ）、モデルがネイティブ対応なら `native`。`pdf-text` は deprecated（`cloudflare-ai` にリダイレクト） |
| `plugins` の送出タイミング | PDF content part が含まれる場合のみ送出 | `plugins` を省略しても PDF パースは走るが、意図表明と実装分岐を単純化するため明示送出 |
| `image_url.detail` フィールド | 送らない（OpenRouter default `"auto"` に委譲） | 当面のユーザ要件なし。後で `/config` に出す余地は残す |
| 非マルチモーダルモデル × 画像 | 送信前 `ModelService.isMultimodalCapable(modelId, "image")` で判定。`true` → 続行、`false` → 警告 + 中止、`null`（モデル詳細取得不可 or `architecture` メタ欠落で `inputModalities` が空） → 透過し OpenRouter 400 に委ねる | 二重防衛で UX と堅牢性を両立。tri-state で「非対応確定」「不明」「対応」を区別。メタ欠落を `false` に潰さない |
| 非マルチモーダルモデル × PDF | 透過（事前判定なし） | OpenRouter file-parser が非ネイティブモデルにテキスト化して渡す |
| 添付拒否（MIME） | サポート外 MIME を含むメッセージは警告 embed → 送信中止。テキストだけのフォールバックはしない | 「画像/PDF で質問」という意図を silently 落とすのは害になる |
| 添付サイズ上限 | 設けない（Discord 側の制約に律する） | Bot 独自の上限はユーザ体験を複雑化させる。OpenRouter が 400/413/422 を返したら既存エラー経路で透過（詳細はエラーパス表） |
| テキスト無しメッセージ（添付のみ） | 許可。`ChatUserInput.text` に空文字を渡し、`messages[0].content` を `parts` のみで組む | 「画像/PDF だけで聞きたい」というユースケースは自然。事前の `messageCreate` 早期 return（content 空 + 添付なし）は維持し、添付がある場合は処理を進める |
| 画像枚数の上限 | 設けない（Discord 自体が 1 メッセージあたり最大 10 attachments） | 自前で count を持つ理由がない |

## Design

**変更対象ファイル:**

- 修正 `src/types/index.ts` — `ChatMessage`, `ChatCompletionRequest`, `OpenRouterModel` 拡張。新型 `ChatMessageContent` / `ChatPlugin`
- 修正 `src/llm/openrouter.ts` — `OpenRouterModelResponse` 拡張、`listModelsWithPricing` マッピング更新、`chat` / `chatStream` の payload で `plugins` 透過
- 修正 `src/services/modelService.ts` — `ModelDetails` に modality 追加、`isMultimodalCapable()` 追加
- 修正 `src/services/chatService.ts` — `ChatUserInput` 導入、`generateResponse{,Stream}` シグネチャ変更、PDF 時 `plugins` 付与
- 修正 `src/bot/events/messageCreate.ts` — `attachmentParser` 呼び出し、事前 capability チェック、新シグネチャで chatService を呼ぶ
- 修正 `src/utils/modelDetailsFormatter.ts` — `formatModalities()` 追記（**既存ファイル**。新規ではない）
- 修正 `src/bot/commands/handlers.ts` — `modelSet` embed に対応モダリティ field を追加
- 新規 `src/services/attachmentParser.ts` — Discord `Message.attachments` → `ChatMessageContent[]` 変換
- 修正 `tests/helpers/mockFactories.ts` — fixture を新フィールドに追従

**型シグネチャ:**

```ts
// src/types/index.ts
export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageContentPart {
  type: "image_url";
  image_url: { url: string };
}

export interface FileContentPart {
  type: "file";
  file: { filename: string; file_data: string };
}

export type ChatMessageContent =
  | TextContentPart
  | ImageContentPart
  | FileContentPart;

export interface FileParserPlugin {
  id: "file-parser";
  pdf?: { engine: "cloudflare-ai" | "mistral-ocr" | "native" };
}
export type ChatPlugin = FileParserPlugin;

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string | ChatMessageContent[];
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  plugins?: ChatPlugin[];
}

export interface OpenRouterModel {
  id: string;
  name: string;
  created: number;
  contextLength: number;
  pricing: {
    prompt: string;
    completion: string;
    image?: string;
    request?: string;
  };
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters?: string[];
}
```

`/api/v1/models` レスポンスは modality 情報を `architecture.input_modalities` / `architecture.output_modalities` の **ネスト** に持つ点に注意（top-level の `input_modalities` / `output_modalities` は `null` で返ることがある）。`supported_parameters` は top-level の `string[]`（provider integration docs の `supported_features` とは別）。マッピング側で `architecture?.input_modalities ?? []` のように fallback する。

```ts
// src/llm/openrouter.ts
interface OpenRouterModelResponse {
  data: Array<{
    id: string;
    name: string;
    created: number;
    context_length: number;
    pricing: { prompt: string; completion: string; image?: string; request?: string };
    architecture?: {
      input_modalities?: string[];
      output_modalities?: string[];
      modality?: string;        // legacy 形式 "text->text" など
      tokenizer?: string;
      instruct_type?: string | null;
    };
    supported_parameters?: string[];
  }>;
}
```

**`attachmentParser` API:**

```ts
// src/services/attachmentParser.ts
export type AttachmentRejectReason = "UNSUPPORTED_MIME" | "MISSING_MIME";

export interface AttachmentParseResult {
  parts: ChatMessageContent[];
  hasPdf: boolean;
  hasImage: boolean;
  rejected: Array<{ filename: string; reason: AttachmentRejectReason }>;
}

export const SUPPORTED_IMAGE_MIME: ReadonlySet<string>;
export const SUPPORTED_FILE_MIME: ReadonlySet<string>;
export const PDF_PARSER_PLUGIN: ChatPlugin;

export function parseAttachments(
  attachments: Collection<string, Attachment>,
): AttachmentParseResult;
```

`Attachment.contentType` は `string | null` のため、`null` の添付は `MISSING_MIME` として `rejected` に積み、`UNSUPPORTED_MIME`（既知だが Bot がサポート外）と区別する。拡張子フォールバック判定は本 change では入れず、ログ・警告メッセージでユーザに MIME 不明である旨を伝える。

`SUPPORTED_IMAGE_MIME` = `{"image/png","image/jpeg","image/jpg","image/gif","image/webp"}`
`SUPPORTED_FILE_MIME` = `{"application/pdf"}`
`PDF_PARSER_PLUGIN` = `{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }`

**`ChatService` API:**

```ts
export interface ChatUserInput {
  text: string;
  parts?: ChatMessageContent[];
}

// generateResponse / generateResponseStream は (guildId, input: ChatUserInput, ...) を取る
```

実装の中核:

```ts
const parts = input.parts ?? [];
const hasFile = parts.some((p) => p.type === "file");
const textPart: TextContentPart[] =
  input.text.length > 0 ? [{ type: "text", text: input.text }] : [];
const content: ChatMessage["content"] =
  parts.length > 0 ? [...textPart, ...parts] : input.text;
const request: ChatCompletionRequest = {
  model: settings.defaultModel,
  messages: [{ role: "user", content }],
  ...(hasFile && { plugins: [PDF_PARSER_PLUGIN] }),
};
```

`text` が空文字のときは空の text part を混ぜず、`parts` のみで `content` を組む。`parts` が空かつ `text` も空の状況は `messageCreate` 側で早期 return されるためここには到達しない。

**OpenRouter クライアントの payload 透過:**

`chat()` / `chatStream()` の body 組み立てを次の形に整える。

```ts
const { plugins, ...rest } = request;
const body = {
  ...rest,
  ...(plugins && { plugins }),
  usage: { include: true },
};
```

`plugins` undefined のときは body から完全に欠落することをテストで担保（`"plugins" in body === false`）。

**モダリティ表示:**

```ts
// src/utils/modelDetailsFormatter.ts に追記
export function formatModalities(input: string[], output: string[]): string;
// 例: formatModalities(["text", "image"], ["text"]) → "入力: text, image / 出力: text"
// 空配列は "不明" を返す
```

`handlers.ts` の `modelSet`:

```ts
fields: [
  ...,
  {
    name: "対応モダリティ",
    value: formatModalities(details.inputModalities, details.outputModalities),
    inline: false,
  },
]
```

**エラーパス挙動マップ:**

| 状況 | 検出箇所 | 挙動 |
| ---- | -------- | ---- |
| サポート外 MIME 添付（`UNSUPPORTED_MIME`） | `attachmentParser.parseAttachments` | 警告 embed（ファイル名 + reason）→ 送信中止 |
| MIME 欠落（`Attachment.contentType` が null、`MISSING_MIME`） | 同上 | 警告 embed（「MIME を判定できなかった添付があります」）→ 送信中止 |
| テキスト無し + 添付あり | `messageCreate` | 早期 return せず処理を継続（`ChatUserInput.text = ""`、`parts` のみで送信） |
| テキスト無し + 添付なし | `messageCreate`（既存挙動） | 「メッセージを入力してください。」を返して終了 |
| 画像非対応モデルに画像 | `messageCreate`（`isMultimodalCapable(modelId, "image") === false`） | 警告 embed（現モデル名 + 推奨アクション）→ 送信中止 |
| 画像 × モデル詳細取得不可（`isMultimodalCapable` が `null`） | 同上 | 透過（送信続行）→ OpenRouter 側のエラーに委ねる |
| OpenRouter 400 (BadRequestError) | `openrouter.handleErrorResponse`（既存） | 既存の `BadRequestError` 経路で message を透過 |
| OpenRouter 413 Content Too Large | `openrouter.handleErrorResponse` | 本 change では汎用 `UnknownApiError` 透過で開始。観測頻度が高ければフォローアップ change で `PayloadTooLargeError` を追加し「添付サイズを縮小してください」と案内する |
| OpenRouter 422 Unprocessable Entity | 同上 | 同上（汎用 `UnknownApiError` 透過） |
| 画像 URL fetch 失敗（OpenRouter 側） | OpenRouter エラー | 既存エラー経路で透過 |
| PDF 解析エンジンエラー | OpenRouter エラー | 既存エラー経路で透過 |

**設計メモ:**

- Discord CDN の添付 URL は署名付きで有効期限あり（`ex`/`is`/`hm`）。受信 → 即時 OpenRouter 送信なら通常問題にならない。観測されたら別 change で fetch → data URL 化を追加
- サポート画像形式: png, jpeg, gif, webp（OpenRouter 公式 docs に列挙された MIME のみ。`image/jpg` は対応外で、Discord も通常 `image/jpeg` を返す）
- サポート文書形式: PDF（`application/pdf`）。初期は `cloudflare-ai` エンジン
- `pricing.image` は本 change では表示しない（embed への投影は将来検討）
- `annotations[].file.hash` キャッシュは将来最適化（Open Questions 参照）

## テスト計画

| 対象 | テストファイル | 観点 |
| ---- | -------------- | ---- |
| `attachmentParser.parseAttachments` | `tests/unit/services/attachmentParser.test.ts`（新規） | 画像のみ / PDF のみ / 混在 / `UNSUPPORTED_MIME` / `MISSING_MIME`（`contentType: null`）/ empty collection |
| `OpenRouterClient.chat{,Stream}` | `tests/unit/llm/openrouter.test.ts` | `plugins` undefined 時に body のキー自体が存在しないこと、`plugins` あり時の payload、`content` 配列（text + image_url + file 混在）の round-trip |
| `OpenRouterClient.listModelsWithPricing` | 同上 | `architecture.input_modalities` / `architecture.output_modalities` の mapping、`architecture` 欠落時の `[]` フォールバック、top-level の null をそのまま無視すること |
| `ChatService.generateResponse{,Stream}` | `tests/unit/services/chatService.test.ts` | `parts` 空（既存挙動）/ あり時の `messages[0].content` 配列化 / `file` 含む時のみ `plugins` 付与 / `text` 空 + `parts` ありで `parts` のみで送信 |
| `ModelService.isMultimodalCapable` | `tests/unit/services/modelService.test.ts` | `(modelId, "image")` / `(modelId, "file")` で `true` / `false` / `null`（`getModelDetails` が `null` を返すケース） |
| `formatModalities` | `tests/unit/utils/modelDetailsFormatter.test.ts` | text-only / multimodal / 空配列ガード（"不明"） |
| `messageCreate` ハンドラ | `tests/unit/bot/events/messageCreate.test.ts` | 画像 + 対応モデル、画像 + 非対応モデル（警告 + chatService 未呼び出し）、PDF、`UNSUPPORTED_MIME`、`MISSING_MIME`、添付のみ（text 空 + 画像）、添付なし regression |

**Mock 戦略**（CLAUDE.md 準拠）:

- `fetch` は `mock()` でグローバル置換
- `Message.attachments` 用の最小 fixture を `tests/helpers/` 配下に置き、`Collection<string, Attachment>` 形（`{ url, contentType, name, size }`、`contentType` は `string | null` を許可）で渡せるようにする
- `/models` レスポンス fixture は公開 API の構造に揃え、modality 情報を `architecture.input_modalities` / `architecture.output_modalities` のネストで含める（top-level の `input_modalities` / `output_modalities` は通常 null）
- `ModelService` モックは modality 系フィールド（`inputModalities` / `outputModalities` / `supportedParameters`）を返せるよう `createMockModelService()` を拡張

## Tasks

### Phase 1: 型・モデルメタ拡張（挙動変更なし）

- [ ] `src/types/index.ts` に `ChatMessageContent` 系 / `ChatPlugin` / `OpenRouterModel`（`inputModalities` / `outputModalities` / `supportedParameters?`）拡張
- [ ] `src/llm/openrouter.ts` `OpenRouterModelResponse` に `architecture?` ネスト + top-level `supported_parameters?` 追加、`listModelsWithPricing` で `architecture?.input_modalities ?? []` 形のマッピングを実装
- [ ] `src/services/modelService.ts` `ModelDetails` 拡張 + `isMultimodalCapable(modelId: string, kind: "image" | "file"): Promise<boolean | null>` 追加（`null` = 判定不能 / モデル詳細取得失敗 / `architecture` メタ欠落で `inputModalities` 空）
- [ ] `tests/helpers/mockFactories.ts` fixture 更新（post-mapping の `OpenRouterModel` に `inputModalities` / `outputModalities` を追加。API レスポンス形 `architecture` ネストは `tests/unit/llm/openrouter.test.ts` 側で扱う）
- [ ] 既存テストの型追従、`isMultimodalCapable(modelId, kind)` のユニットテスト追加

### Phase 2: モダリティ表示

- [ ] `src/utils/modelDetailsFormatter.ts` に `formatModalities()` 追記
- [ ] `src/bot/commands/handlers.ts` `modelSet` embed に「対応モダリティ」field 追加
- [ ] `tests/unit/utils/modelDetailsFormatter.test.ts` に `formatModalities` テスト追加

### Phase 3: OpenRouter クライアントの plugins 透過

- [ ] `src/llm/openrouter.ts` の `chat` / `chatStream` で `plugins` を明示透過、undefined 時に body から欠落させる
- [ ] `tests/unit/llm/openrouter.test.ts` に plugins 有無 / `content` 配列 round-trip テスト追加

### Phase 4: attachmentParser + ChatService API 拡張

- [ ] `src/services/attachmentParser.ts` 新規（`AttachmentRejectReason` 含む、`MISSING_MIME` で `contentType: null` を区別）
- [ ] `src/services/chatService.ts` `ChatUserInput` 導入、`generateResponse{,Stream}` シグネチャ変更、PDF 時 `plugins` 付与、`text` 空 + `parts` あり対応
- [ ] `tests/unit/services/attachmentParser.test.ts` 新規（`UNSUPPORTED_MIME` / `MISSING_MIME` を区別）
- [ ] `tests/unit/services/chatService.test.ts` 拡張（text-only / image / PDF / 混在 / `text=""` + `parts` あり）

### Phase 5: messageCreate 統合（ユーザ向け挙動変更）

- [ ] `src/bot/events/messageCreate.ts` に `attachmentParser` + `isMultimodalCapable(modelId, "image")` 事前チェック + 新 chatService 呼び出し。添付のみ（text 空）は早期 return せず処理続行
- [ ] `tests/unit/bot/events/messageCreate.test.ts` 拡張（添付あり / `UNSUPPORTED_MIME` / `MISSING_MIME` / 非対応モデル × 画像 / 添付のみ（text 空 + 画像） / 添付なし regression）

### Phase 6: ドキュメント・クリーンアップ（リリース時）

- [ ] CHANGELOG 用 user-facing 文言の整理（`/release` skill 利用時）
- [ ] `docs/changes/multimodal/` 削除（リリース完了時、git 履歴がアーカイブ）

**運用ルール（全 Phase 共通）:**

各 Phase の commit 前に以下を実施する。

1. `bun typecheck && bun test && bun lint`
2. `/codex-review` を実行し findings を確認、valid な指摘は修正（修正後にもう一度 typecheck/test/lint）
3. nit のみに収束したら `git commit`（lefthook の pre-commit が CI と同等の品質チェックを再実行）

## Open Questions

- Discord 署名 URL の有効期限切れリスク: 通常は問題ないが、OpenRouter 内部リトライによる遅延で 403 が発生し得る。観測されたら別 change で fetch → data URL 化を追加
- `pricing.image` を embed 表示するか: 画像対応モデルの課金は `prompt + per-image` のため、明示の方が親切だが本 change スコープ外
- PDF 解析エンジン切替の UX: 当面は env var すら expose しない。`settings-hierarchy` change でガイルド単位設定として持つ可能性
- `annotations[].file.hash` を使った PDF 再パース回避: 別 change で扱う最適化

## 参照

- [OpenRouter Chat Completions API](https://openrouter.ai/docs/api/reference/overview) — `Request` 型、`ContentPart`、`plugins`
- [OpenRouter Multimodal: PDFs](https://openrouter.ai/docs/features/multimodal/pdfs) — `type: "file"` content part、`plugins: [{ id: "file-parser", pdf: { engine } }]`、解析エンジン比較、`annotations[].file.hash` 再利用
- [OpenRouter Multimodal Overview](https://openrouter.ai/docs/guides/overview/multimodal/overview) — `messages` 配列に複数モダリティを混在させる方針
- [OpenRouter API Reference (Models)](https://openrouter.ai/docs/api/reference/models) — 公開 `/api/v1/models` のレスポンス。modality 情報は `architecture.input_modalities` / `architecture.output_modalities`、top-level に `supported_parameters: string[]` を持つ
- [OpenRouter Provider API: Model List](https://openrouter.ai/docs/guides/community/for-providers) — provider 向け仕様。top-level に `input_modalities` / `output_modalities` / `supported_features` を要求するが、これは provider 側が提出する形であり公開 API のレスポンス形とは別。本 change の実装は公開 `/api/v1/models` の形（上の API Reference）に合わせる
- [discord.js Message.attachments](https://discord.js.org/docs/packages/discord.js/14.26.3/Message:Class#attachments) — `Collection<string, Attachment>`、`attachment.contentType`
