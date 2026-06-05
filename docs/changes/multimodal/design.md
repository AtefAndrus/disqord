# マルチモーダル対応

## Why

現在Botはテキスト入力のみ受け付けるが、ユーザはDiscordに画像やPDFを添付して質問することが多い。画像認識対応モデルやOpenRouterのPDF解析を活用することで、画像・文書に関する質問や説明が可能になる。

OpenRouter は 2025-04 に PDF/ファイル入力を GA しており（`type:"file"` content part）、モデルがネイティブ対応していなくても OpenRouter 側でパースして渡せる。画像入力（`type:"image_url"`）と同じ仕組みの延長で実装できるため、画像と PDF/ファイルを本 change にまとめて扱う。

## Goals / Non-Goals

**Goals:**

- Discord画像添付をLLMに送信し、マルチモーダル対応モデルで画像認識を実現
- Discord の PDF/ファイル添付を `type:"file"` content part として送信し、文書内容に基づく回答を実現
- モデル選択時にマルチモーダル対応状況を表示

**Non-Goals:**

- 音声・動画の処理
- 画像生成（出力側のマルチモーダル）
- Bot側での画像のリサイズや前処理
- PDF 以外のドキュメント形式（docx / xlsx 等）のネイティブ対応（OpenRouter が対応する範囲に依存。初期は PDF を主対象とする）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 画像URL取得元 | Discord CDN | 追加ストレージ不要。ただし添付 URL は **署名付き（`ex`/`is`/`hm` パラメータ）で有効期限あり**のため、LLM へは受信後すぐ渡す（長時間後の再利用は不可。必要なら Bot 側取得→data URL 化） |
| ファイル(PDF)の渡し方 | `type:"file"` の `file.file_data` に Discord CDN URL または `data:application/pdf;base64,...`（data URL）を入れる | OpenRouter 公式の現行仕様。URL 直渡しが可能なら base64 化不要で軽い。CDN URL が OpenRouter から取得できない場合は Bot 側で取得して data URL 化する（実装時に確認） |
| PDF 解析エンジン | 初期は `cloudflare-ai`（無料の Markdown 変換） | 追加課金なしで開始できる。スキャン文書精度が必要になれば `mistral-ocr`（$2/1000ページ）、モデルがネイティブ対応なら `native`（入力トークン課金）に切替。`pdf-text` プラグインは deprecated（`cloudflare-ai` にリダイレクト）のため使わない |
| 非対応モデルへの送信 | 警告表示（画像）/ OpenRouter 自動パースに委譲（PDF） | 画像は非対応モデルでエラーになるため警告。PDF は非対応モデルでも OpenRouter がパースして渡すため透過的 |
| 最大画像数 | 実装上は 10 枚を上限 | OpenRouter に普遍的な上限の公式記載は無くなり「モデル・プロバイダ依存」となった。超過はエラーになり得るため安全側に 10 枚で頭打ちにし、モデル選択時に注意喚起する |

## Design

**変更対象**:

- `src/bot/events/messageCreate.ts` - 画像/PDF 添付検知、URL抽出
- `src/services/chatService.ts` - 画像URL・ファイルを含むメッセージ送信
- `src/llm/openrouter.ts` - `content: [{type: "image_url"}]` / `[{type: "file"}]` 対応
- `src/types/index.ts` - `ChatMessage`型拡張
- `src/utils/modelDetailsFormatter.ts` - モダリティ表示フォーマッター追加

**型拡張**:

```typescript
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string | ChatMessageContent[];
}

export type ChatMessageContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };
  // file_data は Discord CDN URL もしくは "data:application/pdf;base64,..." の data URL
```

PDF 解析エンジンは OpenRouter のリクエストに `plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }]` を付けて指定する（エンジン名・プラグイン形は実装時に最新 docs で確認）。`cloudflare-ai` は無料。

**実装内容**:

1. **画像/ファイル添付検知**:
   - `message.attachments`から `attachment.contentType` で判定
   - 画像（png, jpg, jpeg, gif, webp）→ `type:"image_url"`、Discord CDN URLを取得
   - PDF（`application/pdf`）→ `type:"file"`、`filename` と `file_data`（CDN URL or data URL）を取得

2. **マルチモーダルメッセージ送信**:
   - テキスト + 画像URL + ファイルを`content`配列として送信
   - 画像が複数ある場合はすべて送信（実装上の上限 10 枚）
   - PDF を含む場合は `plugins` で解析エンジン（初期は `cloudflare-ai`）を指定

3. **モダリティ表示**:
   - `/disqord model set`でマルチモーダル対応モデルの場合、`input_modalities`/`output_modalities`を表示
   - 例: 「対応入力: text, image」「対応出力: text」

**設計メモ**:

- 非マルチモーダルモデルに画像を送信するとエラー → 警告表示
- PDF は非対応モデルでも OpenRouter がパースして渡すため、画像のような警告は不要（解析エンジン課金には注意）
- 画像URL有効期限: Discord CDN の添付 URL は **署名付きで期限がある**（`ex`/`is`/`hm` クエリパラメータ）。メッセージ受信→LLM 送信は即時なので通常は問題ないが、期限切れで失敗する場合は Bot 側で取得して data URL 化する
- サポート画像形式: png, jpg, jpeg, gif, webp
- サポート文書形式: PDF（`application/pdf`）。初期は `cloudflare-ai` エンジン（無料）
- 解析後アノテーション（`hash` 付き）を再利用すれば同一 PDF の再パース課金を避けられる（最適化、初期スコープ外）

**参照**:

- [OpenRouter Chat Completions API](https://openrouter.ai/docs) - マルチモーダル入力は`messages[].content`を配列にし、`{type: "text", text: "..."}`, `{type: "image_url", image_url: {url: "..."}}`を含める
- [OpenRouter PDF / File inputs](https://openrouter.ai/docs/guides/overview/multimodal/pdfs) - `{type: "file", file: {filename, file_data}}`。解析エンジンは `plugins` で指定（`cloudflare-ai` 無料 / `mistral-ocr` / `native`）。`pdf-text` は deprecated
- [discord.js Message.attachments](https://discord.js.org/docs/packages/discord.js/14.26.3/Message:Class#attachments) - `message.attachments`コレクションから URL を取得、`attachment.contentType`で画像/PDF判定

## Tasks

- [ ] Discord画像添付対応（メンション時に画像を含めてLLMに送信）
- [ ] Discord PDF/ファイル添付対応（`type:"file"` content part、`plugins` で `cloudflare-ai` エンジン指定）
- [ ] `file_data` の渡し方を確認（CDN URL 直渡しが効くか、効かなければ Bot 側取得 → data URL 化）
- [ ] マルチモーダル対応モデルの表示（`input_modalities`/`output_modalities`表示）
- [ ] 画像URL対応（Discord CDN経由、実装上の上限 10 枚）
- [ ] `ChatMessageContent` 型に `file` バリアント追加、`openrouter.ts` で `content` 配列に file を載せる
