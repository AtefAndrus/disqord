# LLM チャット返信の Components V2 化

## Why

現在の LLM チャット返信は `embedBuilder.ts` (271 行) ベースの 1 embed/メッセージで構成され、Discord embed の制約に縛られている: description は 4096 字までで切り詰め、footer text に metadata を詰め込み、長文は 9000 byte 単位で複数メッセージに分割、ページ番号は footer 文字列で擬似実装。停止ボタンだけが ActionRow で外部に置かれている。

Discord が 2025-04 にリリースした **Components V2** (`IS_COMPONENTS_V2` flag) によって、`Container` / `TextDisplay` / `Section` / `Separator` / `MediaGallery` / `File` で柔軟にメッセージレイアウトが組めるようになった。これに移行することで:

- text 表示と添付ファイル表示を統一構造で扱える (multimodal change で扱う入力画像・出力画像・添付ファイルが自然に MediaGallery / File に乗る)
- Section accessory を使えば inline Button が text の隣に置ける (停止ボタンの取扱いが綺麗になる)
- ページ番号 footer の擬似実装をやめて Container の構造で表現できる
- embed 6000 字制限から解放され、TextDisplay 4000 字 × 複数の合算で 1 message あたりの content 密度を上げられる

multimodal change を先行させ、それと統合する形で V2 化を進める。

## Goals / Non-Goals

**Goals:**

- LLM チャット返信メッセージ (`src/bot/events/messageCreate.ts` 経由のフロー) を Components V2 で組み直す
- 既存 UX を保つ:
  - ストリーミング (2 秒間隔の逐次 edit、文字が増えていく見た目) は維持
  - 停止ボタン (Stop) は維持、位置は Section accessory に変更
  - LLM detail footer (Tokens/Cost/Latency/Provider/TPS) は `showLlmDetails` 設定で抑制可、表示位置は末尾 TextDisplay
  - エラーメッセージ (`createErrorEmbed` 経由) も V2 化、color accent で red
  - 停止時の "Stopped" 表示は維持
- 長文は **複数メッセージ分割を継続**。各 message は `Container + TextDisplay(+ Separator)` で V2 化
- 末尾メッセージに metadata Section と停止ボタン (生成中) / "Stopped" 表示 (中断時) / 完了マーク (完了時) を集約
- multimodal change との統合: 出力画像は `MediaGallery`、添付ファイル (例: 生成 PDF / コードファイル) は `File` で表示
- `embedBuilder.ts` の embed-向けユーティリティを退役、置き換えで `containerBuilder.ts` (仮) を新設

**Non-Goals:**

- `/help` `/status` `/config` `/model` 等 slash command 系の V2 化（embed のままで十分、利得なし）
- `releaseNotificationService` の V2 化（リリースノートは embed が読みやすい、別途検討）
- 新規インタラクション機能の追加（Regenerate / Details toggle / Model-switch 等は将来別 spec）
- 編集後の rendering を legacy 互換に戻す機能（V2 sticky 仕様により不可、戻したい場合は新規送信）
- showLlmDetails の per-response toggle 化（current は per-guild config、本 spec で変えない）
- 古い Discord client での見た目最適化（V2 GA、Discord 側でフォールバックされる）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 実装タイミング | multimodal change の後に着手 | multimodal で扱う画像入出力の表現要件 (MediaGallery / File) が固まってから V2 builder を設計、二度手間回避 |
| メッセージ構造 | 各 message = 1 Container、1〜3 TextDisplay (chunk) + 必要に応じ Separator + 末尾 message のみ Section + Button | community 事例 (discord.js toolkit / TripBot) と一致。1 message に大量 chunk を詰めるパターンは実例少なく、リスク高い |
| 長文分割の単位 | 1 TextDisplay あたり **3800 字** (4000 字上限から 200 字の安全マージン)、超過時は次の TextDisplay へ。1 message あたり **3 TextDisplay まで** (~11400 字)、超過時は次の message へ | TextDisplay の char limit は公式未明記だが community 報告で 4000、安全マージンを取る。1 message に 3 chunk なのは Section + Separator 含め 40 components 枠を温存するため |
| ストリーミング edit | 既存ロジック (2 秒間隔) を踏襲、V2 で組んだ Container を毎回 edit | sticky flag 制約と整合。初期送信から V2、edit も V2、最終も V2 |
| 初期 placeholder | `Container { TextDisplay("生成中...") + Section[Stop button] }` | 現状の `createStreamingEmbed("生成中...")` 相当を V2 化 |
| 停止ボタン位置 | 最終 message の末尾 Section accessory | 現状は ActionRow で外置き。V2 では text と紐付けて配置できる |
| ボタン migration | message が増えるごとに、前 message の Section + Button を除去、新 message の末尾に Section + Button を配置 | 「停止ボタンは常に最新 message にだけある」を維持。現状ロジックと一致 |
| Metadata footer | 完了時、最終 message の Section 内 TextDisplay (`showLlmDetails=true` のみ) | 現状の embed footer 相当。色変更で目立たせない、説明テキスト的に配置 |
| Container accent color | model id hash の 16色パレットを `setAccentColor` に流用 | 現状の embed color と同じ運用、変更最小 |
| Author / model badge | 先頭 message の最初の TextDisplay 行に `**Model:** xxx` を入れる (現状の `embed.author.name`) | V2 には embed author 相当がなく、TextDisplay 内 markdown で表現 |
| エラー表示 | `Container { accent_color: red, TextDisplay(エラー本文) }` | `createErrorEmbed` の役割を V2 で再現 |
| 停止時表示 | 最終 message の Section から Button を削除、Section 内 TextDisplay に "🛑 Stopped" 追記 | 現状の "Stopped" footer 相当 |
| `embedBuilder.ts` の扱い | 退役。chat 用関数 (`createStreamingEmbed` / `splitTextToMultipleMessages`) を削除、slash command 系で使われる `createEmbed` / `createErrorEmbed` / `createSuccessEmbed` / `getColorForModel` / `splitTextIntoChunks` は残す | slash command の embed UI は本 spec では変えない。`statusMessage.ts` / `handlers.ts` / `releaseNotificationService.ts` から引き続き利用 |
| 新規 builder ファイル | `src/utils/chatContainerBuilder.ts` を新設 | embed-V2 を完全に分離。V2 関連の型 (`ContainerBuilder`, `TextDisplayBuilder`, etc.) を集中させる |
| 多言語化 / i18n | しない (現状の hardcoded ja を踏襲) | 別 spec が立つまで現状維持 |
| MediaGallery (画像出力) | multimodal change の出力部と接続。V2 Container 内に `MediaGallery` を組み込む API を builder に持たせる | multimodal の入力画像表示と統合 |
| File 添付 (生成ファイル) | multimodal change が File を扱う場合、Container 内 `File` で配置 | 同上 |
| 旧 client 互換性 | 配慮しない | V2 は GA、Discord client 側でフォールバック処理 |
| `ephemeral: true` 経路の修正 | 該当箇所があれば `flags: MessageFlags.Ephemeral` に置換 (本 spec では chat 返信が ephemeral ではないので不要、エラー系で残存していないか確認) | v14.19 で deprecated。本 spec の scope 内では発生しないはずだが grep で漏れ確認 |

## Design

### アーキテクチャ

```text
ChatService.generateResponseStream()
        │ (stream of ChatChunk)
        ▼
messageCreate.ts handler
        │
        ▼
ChatContainerBuilder (NEW)
        ├ buildStreamingContainer(text, model, color, isLast): ContainerBuilder
        ├ buildFinalContainer(text, model, color, metadata, isLast): ContainerBuilder
        ├ buildErrorContainer(message): ContainerBuilder
        ├ buildStoppedContainer(text, model, color, isLast): ContainerBuilder
        └ splitTextIntoTextDisplayChunks(text, maxCharsPerChunk, maxChunksPerMessage): string[][]
                                                                      ↑          ↑
                                                                      │          └ 配列の配列 = メッセージ単位
                                                                      └ TextDisplay 単位
        │
        ▼
channel.send / message.edit
  ({ components: [container], flags: MessageFlags.IsComponentsV2 })
```

### メッセージ構造のレイアウト例

#### ケース A: 短文応答 (≤3800 字), 完了済み, showLlmDetails=true

```text
Container (accent: model color)
├ TextDisplay  "**Model:** GPT-5-mini\n\n<full response, ≤3800 chars>"
├ Separator (small, no divider)
└ Section
    ├ TextDisplay  "Tokens: 123+456=579 | Cost: $0.001 | Latency: 1234ms | TPS: 45.2"
    └ accessory: (no button — completed)
```

#### ケース B: 長文応答 (~10000 字), 完了済み

```text
[Message 1]
Container (accent: model color)
├ TextDisplay  "**Model:** xxx\n\n<chars 1..3800>"
├ TextDisplay  "<chars 3801..7600>"
└ TextDisplay  "<chars 7601..10000>"

[Message 2]
Container (accent: model color)
├ TextDisplay  "<chars 10001..end>"
├ Separator
└ Section
    ├ TextDisplay  "ページ 2/2 | Tokens: ... | Cost: $..."
    └ accessory: (none)
```

#### ケース C: ストリーミング途中 (生成中)

```text
[Latest message]
Container (accent: model color)
├ TextDisplay  "<current partial text up to N chars>"
├ Separator
└ Section
    ├ TextDisplay  "生成中..."
    └ accessory: Button (Danger, 🛑 停止, custom_id: "stop_response_<msgId>")
```

#### ケース D: 停止時

```text
[Latest message]
Container (accent: model color)
├ TextDisplay  "<partial text>"
├ Separator
└ Section
    ├ TextDisplay  "🛑 Stopped | xx.xs | Tokens: ..."
    └ accessory: (none — button removed)
```

#### ケース E: エラー

```text
Container (accent: RED)
└ TextDisplay  "## ⚠️ エラー\n\n<error message>"
```

#### ケース F: multimodal 統合後 (画像出力含む)

```text
Container (accent: model color)
├ TextDisplay  "**Model:** xxx\n\n<text response>"
├ MediaGallery
│   ├ item: image_1.png (alt: "Generated chart")
│   └ item: image_2.png (alt: "Generated diagram")
├ File
│   └ analysis.csv
├ Separator
└ Section
    ├ TextDisplay  "Tokens: ... | Cost: $... | Latency: ..."
    └ accessory: (none)
```

### 変更対象

**新規ファイル:**

- `src/utils/chatContainerBuilder.ts` — V2 Container builder 群、上記の `buildStreamingContainer` / `buildFinalContainer` / `buildErrorContainer` / `buildStoppedContainer` + chunking utility
- `tests/unit/utils/chatContainerBuilder.test.ts`

**修正対象:**

- `src/bot/events/messageCreate.ts` — `embedBuilder.ts` 依存を `chatContainerBuilder` に置換、`updateStreamingMessages` を V2 ベースに書き換え、`channel.send`/`edit` 呼び出しの `embeds:` を `components:` + `flags: MessageFlags.IsComponentsV2` に変更
- `src/utils/embedBuilder.ts` — chat 専用関数 (`createStreamingEmbed`, `splitTextToMultipleMessages`) を削除。slash command で使う `createEmbed` / `createErrorEmbed` / `createSuccessEmbed` / `getColorForModel` / `splitTextIntoChunks` は残す
- `src/utils/buttonBuilder.ts` — `createStopButton` を ActionRow → 単独 ButtonBuilder に変更 (Section accessory として使うため)、または新たに `createStopButtonAccessory()` を追加して旧関数併存
- `src/bot/events/interactionCreate.ts` — `handleButtonInteraction` の停止処理ロジックはそのまま (`custom_id: stop_response_*` パース不変)、ただし停止後の message 更新で V2 container を edit するように調整
- 関連 unit test 群:
  - `tests/unit/bot/events/messageCreate.test.ts` — mock の `embeds: [...]` 検証を `components: [...]` + `flags` 検証に書き換え
  - `tests/unit/utils/embedBuilder.test.ts` — 削除関数のテスト削除
  - `tests/unit/bot/events/interactionCreate.test.ts` — 停止フローの V2 整合

### TextDisplay chunking ロジック

```ts
// chatContainerBuilder.ts
const MAX_CHARS_PER_TEXT_DISPLAY = 3800;
const MAX_TEXT_DISPLAYS_PER_MESSAGE = 3;

export function splitTextIntoMessages(text: string): string[][] {
  // 1. 改行優先で 3800 字単位 chunk に分割 (現状の splitTextIntoChunks ロジック流用)
  const chunks = splitByCharCount(text, MAX_CHARS_PER_TEXT_DISPLAY);
  // 2. MAX_TEXT_DISPLAYS_PER_MESSAGE ごとに message にグルーピング
  const messages: string[][] = [];
  for (let i = 0; i < chunks.length; i += MAX_TEXT_DISPLAYS_PER_MESSAGE) {
    messages.push(chunks.slice(i, i + MAX_TEXT_DISPLAYS_PER_MESSAGE));
  }
  return messages;
}
```

### Streaming flow の擬似コード

```ts
const messages: Message[] = [];
let fullText = "";
let lastUpdate = 0;

// 初期送信
const initialContainer = buildStreamingContainer("生成中...", modelName, color, true);
messages.push(await channel.send({
  components: [initialContainer],
  flags: MessageFlags.IsComponentsV2,
}));

// ストリーム
for await (const chunk of stream) {
  if (chunk.done) { finalResult = chunk; break; }
  fullText += chunk.content;
  if (Date.now() - lastUpdate < STREAM_UPDATE_INTERVAL) continue;

  await updateStreamingMessages(messages, fullText, modelName, color);
  lastUpdate = Date.now();
}

// 完了時
await updateFinalMessages(messages, finalResult.fullText, modelName, color, metadata);
```

`updateStreamingMessages` は `splitTextIntoMessages(fullText)` で必要 message 数を計算し、不足分は新規送信、余剰分は削除、各 message を V2 Container で edit。「最終 message にのみ Section + Button」のルールに従う。

### 既存テストの破壊範囲

- `tests/unit/bot/events/messageCreate.test.ts` (現状 14 個前後の test): mock の検証部分が `embeds` → `components` + `flags` に変わる
- `tests/unit/utils/embedBuilder.test.ts`: `createStreamingEmbed` / `splitTextToMultipleMessages` の test を削除、chunking 関連は `chatContainerBuilder.test.ts` 側に移植
- `tests/unit/bot/events/interactionCreate.test.ts`: 停止ボタン押下後の reply 検証を V2 化

## 参照

### Discord 公式

- [Components Reference](https://docs.discord.com/developers/components/reference) — `Container` / `TextDisplay` / `Section` / `Separator` / `MediaGallery` / `File` / `Label` の仕様
- [Using Message Components](https://docs.discord.com/developers/components/using-message-components)
- [discord-api-docs source](https://github.com/discord/discord-api-docs/blob/main/developers/components/reference.mdx) — 公式 mdx の生ソース、`Section: 1-3 children`、`MediaGallery: 1-10 items`、`Messages: up to 40 total components` 等の数値ソース
- [Discord API Change Log](https://docs.discord.com/developers/change-log) — V2 リリース 2025-04-22

### 関連 discord.js

- [discord.js PR #10781](https://github.com/discordjs/discord.js/pull/10781) — V2 builders 導入
- [Display Components guide (discord.js)](https://discordjs.guide/legacy/popular-topics/display-components)
- [InteractionReplyOptions (`ephemeral` deprecation)](https://discord.js.org/docs/packages/discord.js/14.19.2/InteractionReplyOptions:Interface)

### 他 bot 実装例 (本 spec の判断根拠)

- [discordjs/discord-toolkit-bot src/index.ts](https://github.com/discordjs/discord-toolkit-bot/blob/main/src/index.ts) — Container + TextDisplay + Section/Button のシンプル構成、認可された参照実装
- [sveltejs/discord-bot src/commands/docs/docs.ts](https://github.com/sveltejs/discord-bot/blob/main/src/commands/docs/docs.ts) — Section + TextDisplay (1600 字 slice) + Link Button "Continue Reading" の preview パターン
- [TripSit/TripBot src/discord/utils/ai/](https://github.com/TripSit/TripBot/tree/main/src/discord/utils/ai) — AI bot の Container + 複数 TextDisplay + Separator 反復パターン、content slice 1500 と aggressive truncate
- [finki-hub/discord-bot src/common/utils/pagination.ts](https://github.com/finki-hub/discord-bot/blob/main/src/common/utils/pagination.ts) — V2 + button pagination の最小実装

### Discord API 既知制約 (Issues)

- [discord-api-docs#7528 — >64 media items in V2 → 500 error](https://github.com/discord/discord-api-docs/issues/7528) — 媒体数上限の挙動
- [discord-api-docs#7910 — DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE ignores IS_COMPONENTS_V2 (closed)](https://github.com/discord/discord-api-docs/issues/7910) — defer + V2 の歴史的バグ、現在は解決

## Tasks

### Phase A: builder の新設 (multimodal 未着手でも先行可能)

- [ ] `src/utils/chatContainerBuilder.ts` の API 設計確定 (build* 4 種 + splitTextIntoMessages)
- [ ] chunking ロジック実装 (`MAX_CHARS_PER_TEXT_DISPLAY=3800`, `MAX_TEXT_DISPLAYS_PER_MESSAGE=3`)
- [ ] build* 関数群実装
- [ ] unit test (`tests/unit/utils/chatContainerBuilder.test.ts`)

### Phase B: messageCreate.ts の置き換え (multimodal 完了後)

- [ ] `messageCreate.ts` を V2 ベースに書き換え
- [ ] `updateStreamingMessages` → V2 版に
- [ ] 停止ボタンを Section accessory として配置
- [ ] エラー path も V2 化
- [ ] `embedBuilder.ts` の chat 専用関数を削除
- [ ] `buttonBuilder.ts` を Section accessory 用に調整

### Phase C: テスト整備

- [ ] `messageCreate.test.ts` の mock 検証を V2 化
- [ ] `embedBuilder.test.ts` から削除関数の test を除去
- [ ] `interactionCreate.test.ts` の停止ボタン test を V2 化
- [ ] 手動回帰: 短文 / 長文 / ストリーミング / 停止 / エラー / multimodal (画像 + ファイル) の 6 シナリオ

### Phase D: multimodal 統合

- [ ] multimodal change 側の出力画像処理が `MediaGallery` を返す前提で、`chatContainerBuilder` に `media` 引数を追加
- [ ] 添付ファイル (`File`) の取り扱いも同様

### Phase E: 後片付け

- [ ] `docs/changes/chat-response-v2/` 削除 (リリース完了時、git 履歴がアーカイブ)

## Open Questions / Risks

- **TextDisplay の真の char limit**: 公式未明記、community 報告ベースで 4000。`MAX_CHARS_PER_TEXT_DISPLAY=3800` が安全マージン込みで現実的だが、Discord 側の挙動変化で 3800 がはみ出る可能性。Phase A の unit test では mock のため検出できない、Phase C の手動回帰で長文 (1万字以上) を流して挙動確認必須。
- **40 components/message 枠**: 1 Container + 3 TextDisplay + 1 Separator + 1 Section (内 1 TextDisplay + 1 Button) = 8 components/message。十分余裕あり。
- **停止ボタンの移動コスト**: 長文ストリーミング中、message を追加するたびに前 message の Section を edit でボタン除去、新 message に Section 追加で edit。edit 回数が増えるため Discord rate limit (`PATCH /channels/{}/messages/{}`: 5/5s/channel) と相性が悪い。Phase B 実装時に rate limit hit が出ないか確認、出るなら `BUTTON_MOVE_DEBOUNCE_MS` のような閾値を入れる。
- **multimodal 統合のタイミングずれ**: V2 spec を先に書き、multimodal 着手後に Phase B 以降。multimodal の API が固まる前に Phase A を着手する場合、`MediaGallery` / `File` のスロットは builder 側に「将来追加」枠だけ用意して中身は noop。
- **stream 中の partial markdown**: Markdown table や code block が途中で切れている場合、TextDisplay 末尾でレンダリングが崩れる。現状 embed でも同じ問題があり許容しているが、V2 で chunk 境界が増えると目立つ可能性。気になるなら chunking ロジックで「\`\`\`block を尊重して切る」ヒューリスティック追加検討、本 spec scope 外。
- **ephemeral 経路の漏れ**: 本 spec では chat 返信が ephemeral ではないため影響なしの見込みだが、`ephemeral: true` を grep して deprecated 警告が残っていないか念のため確認 (Phase B 着手時)。

## Out of Scope (将来別 spec 候補)

- **Regenerate Button / Details toggle / Model-switch Button**: 本 spec は「現状 UX を V2 で再現」が目的。新規インタラクションは別 change `chat-response-interactions` として独立。
- **`/help` `/status` `/config` `/model` の V2 化**: 静的・設定系で V2 の利得が小さく、移行コストに見合わない。
- **`releaseNotificationService` の V2 化**: リリースノートは embed の構造が読みやすく、また「ユーザがリアクションで反応する」用途で legacy 互換が望ましい。
- **stream chunking の markdown 賢化**: ` ``` ` block / table の境界を尊重した chunking。Phase C の手動回帰で実害を確認してから判断。
