---
title: "LLM チャット返信の Components V2 化"
status: in-progress
priority: high
summary: "LLM チャット返信を Components V2（Container/Section）化"
---

# LLM チャット返信の Components V2 化

## Why

現在の LLM チャット返信は `embedBuilder.ts` (271 行) ベースの 1 embed/メッセージで構成され、Discord embed の制約に縛られている: description は 4096 字までで切り詰め、footer text に metadata を詰め込み、長文は 9000 byte 単位で複数メッセージに分割、ページ番号は footer 文字列で擬似実装。停止ボタンだけが ActionRow で外部に置かれている。

Discord が 2025-04 にリリースした **Components V2** (`IS_COMPONENTS_V2` flag) によって、`Container` / `TextDisplay` / `Section` / `Separator` / `MediaGallery` / `File` で柔軟にメッセージレイアウトが組めるようになった。これに移行することで:

- text 表示と添付ファイル表示を統一構造で扱える (multimodal change で扱う入力画像・出力画像・添付ファイルが自然に MediaGallery / File に乗る)
- Section accessory を使えば inline Button が text の隣に置ける (停止ボタンの取扱いが綺麗になる)
- ページ番号 footer の擬似実装をやめて Container の構造で表現できる
- embed の構造的制約（description 4096 字・全体 6000 字・footer/author の固定枠）から解放され、text/画像/ファイルを 1 つの Container 構造で柔軟に組める（TextDisplay は 1 message 合計 4000 字制約だが、複数 message へシームレスに分割できる）

multimodal change を先行させ、それと統合する形で V2 化を進める。

## Goals / Non-Goals

**Goals:**

- LLM チャット返信メッセージ (`src/bot/events/messageCreate.ts` 経由のフロー) を Components V2 で組み直す
- 既存 UX を保つ:
  - ストリーミング (2 秒間隔の逐次 edit、文字が増えていく見た目) は維持
  - 停止ボタン (Stop) は維持、位置は Section accessory に変更
  - LLM detail footer (Tokens/Cost/Latency/Provider/TPS) は `showLlmDetails` 設定で抑制可、表示位置は末尾 TextDisplay (Section ではない)
  - エラーメッセージ (`createErrorEmbed` 経由) も V2 化、color accent で red
  - 停止時の "Stopped" 表示は維持
- 長文は **複数メッセージ分割を継続**。各 message は `Container + TextDisplay(+ Separator)` で V2 化
- 末尾メッセージに metadata TextDisplay (完了 / "Stopped") を配置。**Stop button は生成中のときだけ Section accessory として置く** (Section は accessory 必須なので、ボタン不要な状態では Section を使わない)
- multimodal change との統合: 出力画像は `MediaGallery`、添付ファイル (例: 生成 PDF / コードファイル) は `File` で表示
- `embedBuilder.ts` の embed-向けユーティリティを退役、置き換えで `containerBuilder.ts` (仮) を新設

**Non-Goals:**

- `/help` `/status` `/config` `/model` 等 slash command 系の V2 化（embed のままで十分、利得なし）
- `releaseNotificationService` の V2 化（リリースノートは embed が読みやすい、別途検討）
- 編集後の rendering を legacy 互換に戻す機能（V2 sticky 仕様により不可、戻したい場合は新規送信）
- showLlmDetails の per-response toggle 化（current は per-guild config、本 spec で変えない）
- 古い Discord client での見た目最適化（V2 GA、Discord 側でフォールバックされる）

**将来別 change 候補:**

- Regenerate Button / Details toggle / Model-switch Button（新規インタラクション。本 spec は「現状 UX を V2 で再現」が目的）→ 別 change `chat-response-interactions` として独立
- stream chunking の markdown 賢化（` ``` ` block / table の境界を尊重した chunking）→ Phase C の手動回帰で実害を確認してから判断

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 実装タイミング | multimodal change の後に着手 | multimodal で扱う画像入出力の表現要件 (MediaGallery / File) が固まってから V2 builder を設計、二度手間回避 |
| メッセージ構造 | 各 message = 1 Container、Model badge / 本文 / metadata の TextDisplay + 必要に応じ Separator + 末尾 message のみ Section + Button。**1 message 内の全 TextDisplay 合計 ≤ 3800 字** | community 事例 (discord.js toolkit / TripBot) と一致。文字数上限は per-component ではなく **1 message の全 TextDisplay 合計 4000 字**（discord.js guide）なので、本文・badge・footer を合算して管理する |
| 長文分割の単位 | **1 message の全 TextDisplay 合計で 3800 字**（Discord 上限 4000 字から 200 字マージン）。Model badge・本文・metadata footer を**合算**してこの予算に収め、超過分は次の message へ。本文の実効上限 ≈ 3800 −(badge+footer) ≈ 3700 字/message | discord.js guide が「全 text display components の合計 4000 字」と明記（**per-component ではなく 1 message 合計**）。したがって 1 message ≈ 1 本文チャンク（~3700 字）で分割する。components 数は message 全体 40 枠に十分収まる |
| ストリーミング edit | 既存ロジック (2 秒間隔) を踏襲、V2 で組んだ Container を毎回 edit | sticky flag 制約と整合。初期送信から V2、edit も V2、最終も V2 |
| 初期 placeholder | `Container { TextDisplay("生成中...") + Section[Stop button] }` | 現状の `createStreamingEmbed("生成中...")` 相当を V2 化 |
| 停止ボタン位置 (生成中) | 最終 message に `Section + accessory: Button(Danger)` を末尾配置。**この Section が唯一の Section 使用箇所**。Section 子は `TextDisplay("生成中...")` 1 つ | Discord Section は accessory 必須なので、ボタンが要る間しか Section を使えない |
| ボタン migration | message が増えるごとに、前 message から末尾 Section を edit で削除 (生成中表示も含めて消える)、新 message の末尾に Section + Button を新設配置 | 「停止ボタンは常に最新 message にだけある」を維持。現状ロジックと一致 |
| Metadata footer (完了 / 停止時) | 最終 message の末尾を **Section ではなく裸の `TextDisplay`** に置換 (`Separator(small)` + `TextDisplay("Tokens: ... \| ...")` または `TextDisplay("🛑 Stopped \| ...")`) | Section から Button を抜くと invalid (Section は accessory 必須)。完了 / 停止時は Section 自体を消す |
| Container accent color | model id hash の 16色パレットを `setAccentColor` に流用 | 現状の embed color と同じ運用、変更最小 |
| Author / model badge | 先頭 message の最初の TextDisplay 行に `**Model:** xxx` を入れる (現状の `embed.author.name`) | V2 には embed author 相当がなく、TextDisplay 内 markdown で表現 |
| エラー表示 | `Container { accent_color: red, TextDisplay(エラー本文) }` | `createErrorEmbed` の役割を V2 で再現 |
| 停止時表示 | 最終 message から Section を削除、代わりに `Separator + TextDisplay("🛑 Stopped \| xx.xs \| Tokens: ...")` を末尾配置 | 上記 Metadata footer と同じ理由で Section は外す |
| Mention safety | **全 `channel.send` / `message.edit` / `message.reply` 経路で `allowedMentions: { parse: [] }` を強制**。`message.reply()` 経路では追加で `repliedUser: false` を併用 (元投稿者の意図しない ping を防ぐ、現状の messageCreate.ts:92 と同じ) | TextDisplay は legacy embed.description と違い content と同じ ping 挙動。送信ヘルパに必ず allowedMentions を含めて、edit 経路で漏れないよう builder の型シグネチャ側で強制する |
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
        └ splitTextIntoMessages(text, badgeChars, footerChars): string[]
                                          ↑           ↑
                                          │           └ その message の footer 文字数（合計予算から差し引く）
                                          └ その message の Model badge 文字数（合計予算から差し引く）
            ※ 戻り値 = message ごとの本文（1 message の全 TextDisplay 合計 ≤ 3800 字を保証）
        │
        ▼
channel.send / message.edit / message.reply
  ({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], repliedUser: false },  // mention safety、reply 経路では repliedUser も
  })
```

### メッセージ構造のレイアウト例

**Discord Section に関する制約**: Section は `accessory` (Button or Thumbnail) が **required** であり、accessory なしで使うと payload が invalid。完了状態 / 停止状態で「ボタンを消したい」場合は **Section を使わず、Container 直下に Separator + TextDisplay (metadata) を並べる**形にする。Stop button を出す stream 中だけ Section を使う。なお discord.js の `SectionBuilder.accessory` は TS 型上 `optional`（`ButtonBuilder | ThumbnailBuilder | undefined`）だが、Discord API プロトコルでは必須。型に従って省略すると送信時にサーバ側エラーになるため、実装では必ず accessory をセットする。

#### ケース A: 短文応答 (badge+本文+footer の合計 ≤3800 字), 完了済み, showLlmDetails=true

```text
Container (accent: model color)
├ TextDisplay  "**Model:** GPT-5-mini"           ← モデル badge
├ TextDisplay  "<full response>"                 ← 本文 (badge + footer と合算して 1 message 合計 ≤3800 字)
├ Separator (small, no divider)
└ TextDisplay  "Tokens: 123+456=579 | Cost: $0.001 | Latency: 1234ms | TPS: 45.2"
```

#### ケース B: 長文応答 (~10000 字), 完了済み

全 TextDisplay 合計が 1 message 4000 字上限なので、**本文は 1 message あたり ~3700 字**（badge/footer 予約分を引いた残り）で分割する。

```text
[Message 1]
Container (accent: model color)
├ TextDisplay  "**Model:** xxx"          ← badge
└ TextDisplay  "<本文 chars 1..~3700>"   ← この message の合計 ≤3800 字

[Message 2]
Container (accent: model color)
└ TextDisplay  "<本文 chars ~3701..~7400>"

[Message 3]
Container (accent: model color)
├ TextDisplay  "<本文 chars ~7401..end>"
├ Separator
└ TextDisplay  "ページ 3/3 | Tokens: ... | Cost: $..."   ← footer 分も合計予算に含む
```

#### ケース C: ストリーミング途中 (生成中)

```text
[Latest message]
Container (accent: model color)
├ TextDisplay  "**Model:** xxx"
├ TextDisplay  "<current partial text up to ~3800 chars>"
├ Separator
└ Section
    ├ TextDisplay  "生成中..."
    └ accessory: Button (Danger, 🛑 停止,
                         custom_id: "stop_response_<triggerMessageId>")
                                                  ← 入力ユーザの msg.id (Bot 返信前に既知)
```

#### ケース D: 停止時

```text
[Latest message]
Container (accent: model color)
├ TextDisplay  "**Model:** xxx"
├ TextDisplay  "<partial text>"
├ Separator
└ TextDisplay  "🛑 Stopped | xx.xs | Tokens: ..."   ← Section ではなく裸の TextDisplay
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
├ File  analysis.csv
├ Separator
└ TextDisplay  "Tokens: ... | Cost: $... | Latency: ..."
```

注: `MediaGallery` / `File` を使う場合、メッセージ payload の `files: [...]` 配列に AttachmentBuilder を **必ず添付**し、`MediaGallery.items[].media.url` や `File.file.url` を `attachment://<filename>` 形式で参照する。V2 が無効化するのは「attachments 配列の自動 unfurl」だけで、`files` payload upload + `attachment://` 参照のパスは V2 でも維持される ([Discord File component spec](https://docs.discord.com/developers/components/reference))。

### 変更対象ファイル

**新規:**

- `src/utils/chatContainerBuilder.ts` — V2 Container builder 群、上記の `buildStreamingContainer` / `buildFinalContainer` / `buildErrorContainer` / `buildStoppedContainer` + chunking utility
- `tests/unit/utils/chatContainerBuilder.test.ts`

**修正:**

- `src/bot/events/messageCreate.ts` — `embedBuilder.ts` 依存を `chatContainerBuilder` に置換、`updateStreamingMessages` を V2 ベースに書き換え、`channel.send`/`edit` 呼び出しの `embeds:` を `components:` + `flags: MessageFlags.IsComponentsV2` + **`allowedMentions: { parse: [] }`** に変更。`custom_id` には現状実装と同じく `triggerMessageId` (入力ユーザの `message.id`、Bot 返信送信前に既知) を埋める
- `src/utils/embedBuilder.ts` — chat 専用関数 (`createStreamingEmbed`, `splitTextToMultipleMessages`) を削除。slash command で使う `createEmbed` / `createErrorEmbed` / `createSuccessEmbed` / `getColorForModel` / `splitTextIntoChunks` は残す
- `src/utils/buttonBuilder.ts` — `createStopButton` を ActionRow → 単独 ButtonBuilder に変更 (Section accessory として使うため)、または新たに `createStopButtonAccessory()` を追加して旧関数併存
- `src/bot/events/interactionCreate.ts` — `handleButtonInteraction` の停止処理ロジックはそのまま (`custom_id: stop_response_*` パース不変、抽出された ID は `triggerMessageId` = ユーザ入力 msg.id として `chatService.cancelRequest()` に渡す既存実装と一致)、ただし停止後の message 更新で V2 container を edit するように調整
- 関連 unit test 群:
  - `tests/unit/bot/events/messageCreate.test.ts` — mock の `embeds: [...]` 検証を `components: [...]` + `flags` 検証に書き換え
  - `tests/unit/utils/embedBuilder.test.ts` — 削除関数のテスト削除
  - `tests/unit/bot/events/interactionCreate.test.ts` — 停止フローの V2 整合

### TextDisplay chunking ロジック

**制約**: Discord は **1 message 内の全 TextDisplay の合計文字数を 4000 字**に制限する（per-component ではなく、discord.js guide の仕様）。よって分割は「1 message = 合計 3800 字」を単位にする。Model badge と metadata footer もこの合計に含むため、本文の実効予算はそれらを引いた残り。

```ts
// chatContainerBuilder.ts
const MAX_TOTAL_CHARS_PER_MESSAGE = 3800; // 1 message の全 TextDisplay 合計（Discord 4000 から安全マージン）

// 本文を「1 message に載る本文量」ごとに分割。各要素 = 1 message の本文。
// badgeChars / footerChars はその message に同居する badge・footer の文字数（合計予算から差し引く）。
export function splitTextIntoMessages(
  text: string,
  badgeChars: number,
  footerChars: number,
): string[] {
  const bodyBudget = MAX_TOTAL_CHARS_PER_MESSAGE - badgeChars - footerChars;
  // 改行優先で bodyBudget 単位に分割（現状の splitTextIntoChunks ロジック流用）。各 chunk が 1 message の本文。
  return splitByCharCount(text, bodyBudget);
}
```

注: **Model badge `**Model:** xxx` と metadata footer も合計 4000 字予算に含まれる**。badge は ~30 字・footer は ~80 字程度なので、本文の実効上限は 1 message あたり ~3700 字前後。components 数（badge + 本文 + Separator + footer/Section ≈ 4〜5）は message 全体 40 枠に十分収まる。本文を複数 TextDisplay に割っても合計予算は変わらないため、1 message は基本 1 本文 TextDisplay で良い。

### Streaming flow の擬似コード

```ts
const messages: Message[] = [];
let fullText = "";
let lastUpdate = 0;

// 初期送信 (Stop button の custom_id には triggerMessage.id を埋める = ユーザ入力 msg.id)
const initialContainer = buildStreamingContainer({
  text: "生成中...",
  modelName,
  color,
  triggerMessageId: triggerMessage.id,
  isLast: true,
});
messages.push(await channel.send({
  components: [initialContainer],
  flags: MessageFlags.IsComponentsV2,
  allowedMentions: { parse: [] },  // ping safety
}));

// ストリーム
for await (const chunk of stream) {
  if (chunk.done) { finalResult = chunk; break; }
  fullText += chunk.content;
  if (Date.now() - lastUpdate < STREAM_UPDATE_INTERVAL) continue;

  await updateStreamingMessages(messages, fullText, modelName, color, triggerMessage.id);
  // updateStreamingMessages 内の各 send / edit は必ず allowedMentions: { parse: [] } を渡す
  lastUpdate = Date.now();
}

// 完了時
await updateFinalMessages(messages, finalResult.fullText, modelName, color, metadata);
// updateFinalMessages も同様、message.reply 経路を含む場合は repliedUser: false も付与
```

`updateStreamingMessages` / `updateFinalMessages` の関数シグネチャは `{ allowedMentions: AllowedMentions }` を **常に内部で組み立てて呼び出し側に強制**する形にし、引数で上書きできない設計にする (mention 漏れ事故防止)。

`updateStreamingMessages` は:

1. `splitTextIntoMessages(fullText, badgeChars, footerChars)` で必要 message 数を計算（各 message の全 TextDisplay 合計 ≤ 3800 字）
2. 不足分は新規送信、余剰分は削除
3. 各 message を V2 Container で edit
4. 「最後の message にのみ Section + Stop Button」「他の message は Section なし」のルールに従う
5. **PATCH rate limit 対策**: 各 edit は最低 `STREAM_UPDATE_INTERVAL = 2000ms` 間隔。Discord から 429 を受けた場合は当該 edit をスキップして次サイクルで再試行 (`Retry-After` ヘッダがあれば respect、なければ次の 2 秒サイクルまで待機)。Bot がクラッシュしても次回起動時に message が中途半端な状態で残るリスクは許容 (再生成すれば良い、別 spec の conversation-context で取扱い)
6. **メッセージ追加時の "停止ボタン移動コスト"**: 本文が 1 message の合計予算（~3700 字）を超えて新 message が作られた瞬間、前 message から Section を除去 (edit 1 回) + 新 message を Section 付きで送信 (1 回) で計 2 操作。これは新 message 追加時のみなので頻度は低い。stream 中に発生する場合でも `STREAM_UPDATE_INTERVAL` の debounce 内で同じサイクルで処理

### 既存テストの破壊範囲

- `tests/unit/bot/events/messageCreate.test.ts` (現状 14 個前後の test): mock の検証部分が `embeds` → `components` + `flags` に変わる
- `tests/unit/utils/embedBuilder.test.ts`: `createStreamingEmbed` / `splitTextToMultipleMessages` の test を削除、chunking 関連は `chatContainerBuilder.test.ts` 側に移植
- `tests/unit/bot/events/interactionCreate.test.ts`: 停止ボタン押下後の reply 検証を V2 化

## Tasks

### Phase A: builder の新設 (multimodal 未着手でも先行可能)

- [x] `src/utils/chatContainerBuilder.ts` の API 設計確定 (build* 4 種 + splitTextIntoMessages)
- [x] chunking ロジック実装 (`MAX_TOTAL_CHARS_PER_MESSAGE=3800` = 1 message の全 TextDisplay 合計。badge/footer 文字数を差し引いた残りが本文予算)
- [x] build* 関数群実装
- [x] unit test (`tests/unit/utils/chatContainerBuilder.test.ts`)

### Phase B: messageCreate.ts の置き換え (multimodal 完了後)

- [x] `messageCreate.ts` を V2 ベースに書き換え
- [x] `updateStreamingMessages` → V2 版に
- [x] 停止ボタンを Section accessory として配置
- [x] エラー path も V2 化
- [x] `embedBuilder.ts` の chat 専用関数を削除
- [x] `buttonBuilder.ts` を Section accessory 用に調整

### Phase C: テスト整備

- [x] `messageCreate.test.ts` の mock 検証を V2 化
- [x] `embedBuilder.test.ts` から削除関数の test を除去
- [ ] `interactionCreate.test.ts` の停止ボタン test を V2 化 (該当テストファイルが存在せず、`interactionCreate.ts` 自体も停止ボタンの message 更新には関与しないため対象外。詳細は Design 節参照)
- [ ] 手動回帰: 短文 / 長文 / ストリーミング / 停止 / エラー / multimodal (画像 + ファイル) の 6 シナリオ

### Phase D: multimodal 統合

- [ ] multimodal change 側の出力画像処理が `MediaGallery` を返す前提で、`chatContainerBuilder` に `media` 引数を追加
- [ ] 添付ファイル (`File`) の取り扱いも同様

### Phase E: 後片付け

- [ ] `docs/changes/chat-response-v2/` 削除 (リリース完了時、git 履歴がアーカイブ)

## Open Questions / Risks

- **TextDisplay の char limit（確定: 1 message 合計 4000 字）**: discord.js guide が「The amount of text across all text display components cannot exceed 4000 characters」と明記＝**per-component ではなく 1 message 内の全 TextDisplay 合計 4000 字**。本設計はこれを前提に `MAX_TOTAL_CHARS_PER_MESSAGE=3800`（200 字マージン）で **1 message ≈ 本文 3700 字**に分割する（badge/footer も合計予算に含む）。公式 Component Reference 自体には数値の明記がないため、Phase C の手動回帰で長文 (1万字以上) を実機に流し、合計 4000 で正しく次 message に送られることを最終確認する。
- **components 数の枠（ネスト子も数える）**: 完了時 = Container + badge + 本文 + Separator + footer TextDisplay = **5**、生成中 = Container + badge + 本文 + Separator + Section + Section内TextDisplay + Button = **7**。いずれも下記の上限内。本文を複数 TextDisplay に割っても合計文字 4000 制約が先に効くため、通常 1 本文 TextDisplay。
- **Container 内の component 数上限 = 10**: discord-api-types の `APIContainerComponent` JSDoc に「A Container is a top-level layout component that holds **up to 10 components**」と明記（Discord 公式 docs 準拠）。Section は別途 1–3 子の制約。**メッセージ全体は 40 components**（ネスト子も含む）。現設計（1 Container = 5〜7 components）は Container 10・メッセージ 40 のいずれにも余裕がある。
- **停止ボタンの移動コスト**: 長文ストリーミング中、message を追加するたびに前 message の Section を edit でボタン除去、新 message に Section 追加で edit。`STREAM_UPDATE_INTERVAL = 2000ms` の debounce 内で同サイクル処理するため、Discord channel-level PATCH rate limit (5/5s) には収まるはず。429 受信時は当該 edit をスキップして次サイクルで再試行 (`Retry-After` ヘッダがあれば respect)。
- **multimodal 統合のタイミングずれ**: V2 spec を先に書き、multimodal 着手後に Phase B 以降。multimodal の API が固まる前に Phase A を着手する場合、`MediaGallery` / `File` のスロットは builder 側に「将来追加」枠だけ用意して中身は noop。
- **stream 中の partial markdown**: Markdown table や code block が途中で切れている場合、TextDisplay 末尾でレンダリングが崩れる。現状 embed でも同じ問題があり許容しているが、V2 で chunk 境界が増えると目立つ可能性。気になるなら chunking ロジックで「\`\`\`block を尊重して切る」ヒューリスティック追加検討、本 spec scope 外。
- **ephemeral 経路の漏れ**: 本 spec では chat 返信が ephemeral ではないため影響なしの見込みだが、`ephemeral: true` を grep して deprecated 警告が残っていないか念のため確認 (Phase B 着手時)。
- **`code-execution` change との連携**: 本 spec が提供する `chatContainerBuilder` の streaming updater は code-execution の tool call 中の進捗表示 (「コード実行中...」) で利用される。code-execution が `chat-response-v2` 完成前に Phase C に着手する場合は updater stub + legacy 描画フォールバックが必要。共通 primitive は本 spec の builder にのみ集約し、code-execution は **独自の `codeContainerBuilder` (tool 結果出力専用)** を別途持つ (chat の text stream と code 実行結果は構造的に異なるため、無理に共通化しない)。
- **`conversation-context` / `model-compare` との V2 一貫性**: ユーザ方針により、回答再生成 UI（[conversation-context](../conversation-context/design.md)）とモデル比較表示（[model-compare](../model-compare/design.md)）も Components V2 で組む。両者は本 spec の `chatContainerBuilder`（特に `buildFinalContainer` / 前回応答の折りたたみ相当・モデル別 Container）を再利用する想定で、本 spec が先行して builder を確定させる。再生成ボタンや「比較」用の Section accessory は本 spec の停止ボタンと同じ「Section は accessory 必須」「allowedMentions 強制」ルールに従う。なお Regenerate ボタン等の **新規インタラクションのハンドラ実装**は引き続き各 change 側の責務（本 spec は描画 primitive のみ提供）。

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
