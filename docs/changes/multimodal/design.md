# マルチモーダル対応

## Why

現在Botはテキスト入力のみ受け付けるが、ユーザはDiscordに画像を添付して質問することが多い。画像認識対応モデルを活用することで、画像に関する質問や説明が可能になる。

## Goals / Non-Goals

**Goals:**

- Discord画像添付をLLMに送信し、マルチモーダル対応モデルで画像認識を実現
- モデル選択時にマルチモーダル対応状況を表示

**Non-Goals:**

- 音声・動画の処理
- 画像生成（出力側のマルチモーダル）
- Bot側での画像のリサイズや前処理

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 画像URL取得元 | Discord CDN | 永続的URL、追加ストレージ不要 |
| 非対応モデルへの送信 | 警告表示 | サイレント無視よりユーザ体験が良い |
| 最大画像数 | 10枚 | OpenRouter制限に準拠 |

## Design

**変更対象**:

- `src/bot/events/messageCreate.ts` - 画像添付検知、URL抽出
- `src/services/chatService.ts` - 画像URLを含むメッセージ送信
- `src/llm/openrouter.ts` - `content: [{type: "image_url"}]`対応
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
  | { type: "image_url"; image_url: { url: string } };
```

**実装内容**:

1. **画像添付検知**:
   - `message.attachments`から画像ファイル（png, jpg, jpeg, gif, webp）を抽出
   - Discord CDN URLを取得

2. **マルチモーダルメッセージ送信**:
   - テキスト + 画像URLを`content`配列として送信
   - 画像が複数ある場合はすべて送信（最大10枚）

3. **モダリティ表示**:
   - `/disqord model set`でマルチモーダル対応モデルの場合、`input_modalities`/`output_modalities`を表示
   - 例: 「対応入力: text, image」「対応出力: text」

**設計メモ**:

- 非マルチモーダルモデルに画像を送信するとエラー → 警告表示
- 画像URL有効期限: Discord CDNは永続的（削除されない限り）
- サポート画像形式: png, jpg, jpeg, gif, webp

**参照**:

- [OpenRouter Chat Completions API](https://openrouter.ai/docs) - マルチモーダル入力は`messages[].content`を配列にし、`{type: "text", text: "..."}`, `{type: "image_url", image_url: {url: "..."}}`を含める
- [discord.js Message.attachments](https://discord.js.org/docs/packages/discord.js/14.16.3/Message:Class#attachments) - `message.attachments`コレクションから画像URLを取得、`attachment.contentType`で画像判定

## Tasks

- [ ] Discord画像添付対応（メンション時に画像を含めてLLMに送信）
- [ ] マルチモーダル対応モデルの表示（`input_modalities`/`output_modalities`表示）
- [ ] 画像URL対応（Discord CDN経由、最大10枚）
