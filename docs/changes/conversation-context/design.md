---
title: "対話UX改善"
status: planned
priority: high
summary: ""
---

# 対話UX改善

## Why

現状、Botへの各メッセージは独立して処理され、会話の文脈が保持されない。ユーザは毎回文脈を説明し直す必要があり、自然な対話体験を阻害している。また、LLMの応答品質に不満がある場合の再試行手段がない。

## Goals / Non-Goals

**Goals:**

- 直近n件の会話履歴をLLMに送信し、文脈を保持した対話を実現
- 回答の再生成機能で応答品質の改善手段を提供
- メッセージ編集による再生成で入力ミスの修正を容易に

**Non-Goals:**

- 会話履歴のDB永続化（Discord APIが情報源）
- スレッド単位の会話管理
- 会話の分岐・ツリー構造

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 履歴の保存先 | Discord API fetch | DB肥大化を回避、Discordが情報源 |
| 再生成の履歴管理 | DB（response_generations） | Discord APIでは世代管理不可 |
| 編集再生成の対象 | 最新の応答のみ | 履歴の複雑化を避ける |

## Design

### コンテキスト対話

**変更対象ファイル**:

- `src/services/chatService.ts` - Discord APIから履歴取得、複数メッセージ対応
- `src/bot/events/messageCreate.ts` - channelId抽出
- `src/bot/commands/config.ts` - `context`サブコマンド追加（履歴件数設定）

**DBスキーマ変更**:

```sql
ALTER TABLE guild_settings ADD COLUMN context_limit INTEGER NOT NULL DEFAULT 5;
```

**実装方法**:

```typescript
// チャンネルから直近n件のメッセージを取得
const messages = await channel.messages.fetch({
  limit: contextLimit * 2 // メンション付きメッセージとBot応答を考慮
});

// Botメンション付きメッセージとBot応答をフィルタリング
const conversationMessages = messages
  .filter(m => m.mentions.has(botId) || m.author.id === botId)
  .reverse() // 古い順に並び替え
  .slice(-contextLimit) // 直近n件のみ
  .map(m => ({
    role: m.author.id === botId ? 'assistant' : 'user',
    content: m.content.replace(/<@!?\d+>/g, '').trim()
  }));
```

**設計メモ**:

- デフォルト: 5件、0-20件設定可能
- DB不要（Discordが真実の情報源）
- 削除されたメッセージは取得できない（許容範囲）
- Discord APIレート制限: 50リクエスト/秒（十分）
- システムプロンプト: 全会話に付与

---

### 回答再生成機能

**変更対象ファイル**:

- `src/db/schema.ts` - `response_generations`テーブル追加
- `src/bot/events/messageCreate.ts` - 再生成ボタン追加、インタラクション処理
- `src/services/chatService.ts` - 再生成ロジック、履歴保存

**DBスキーマ変更**:

```sql
CREATE TABLE response_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    user_message_id TEXT NOT NULL,
    bot_message_id TEXT NOT NULL,
    generation_number INTEGER NOT NULL DEFAULT 1,
    prompt TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_response_user_msg ON response_generations(user_message_id);
```

**UI設計（Components V2）**:

[chat-response-v2](../chat-response-v2/design.md) でチャット返信が Components V2 化されるため、再生成 UI も V2 で組み、同じ `chatContainerBuilder` を再利用する（embed の「フィールド」は V2 に存在しないため、旧設計の「折りたたみフィールド」を V2 構造へ置き換える）。

- 最新の応答は Container 直下の TextDisplay でメイン表示。
- 再生成ボタンは **Section accessory**（Button）として配置する。Section は accessory 必須なので、ボタンを置く間だけ Section を使う（chat-response-v2 の停止ボタンと同じ作法）。`custom_id` に対象メッセージ ID を埋める。
- 前回の応答は **Spoiler 指定した Container**（`ContainerBuilder.setSpoiler(true)`）に「前回の応答 (第N世代)」見出し付きで格納し、クリックで展開する（旧 embed の「折りたたみフィールド」の V2 代替）。最新 Container と前回 Container は、両者の本文が **1 message の全 TextDisplay 合計 4000 字**に収まる場合のみ同一 message の `components` 配列に並べる。超える場合は前回応答を別 message の Spoiler Container にするか、先頭 N 字に切り詰めて表示する。
- 全送信・edit で `allowedMentions: { parse: [] }` を強制（V2 の TextDisplay は本文と同じ ping 挙動のため）。
- メッセージは `flags: MessageFlags.IsComponentsV2` で送信（一度 V2 にすると legacy へ edit-back 不可）。

**設計メモ**:

- 世代番号を管理（第1世代、第2世代...）
- 最大保存世代数: 5世代（古いものは削除）
- ボタンは5分間有効（タイムアウト後は新規メンションで呼び出し）
- 1 Container は最大 10 components（discord-api-types: holds up to 10 components）、メッセージ全体は 40 components。components 数は最新 + 前回 spoiler の二段構成でも余裕。**ただし TextDisplay は 1 message 合計 4000 字制約があり、2 世代の本文を同居させると超過しやすい**点が実質的な制約（上記 UI 設計参照）

---

### メッセージ編集再生成

**変更対象ファイル**:

- `src/bot/events/messageUpdate.ts` - 新規作成
- `src/services/chatService.ts` - 編集検知、再生成ロジック

**実装内容**:

1. `messageUpdate`イベントでメンション付きメッセージの編集を検知
2. 最新のBot応答を更新（古い応答は保持しない）
3. 編集は最新の回答に対してのみ有効（過去の会話には影響しない）

**設計メモ**:

- 編集検知は無制限（時間制限なし）
- 最新の応答のみを更新（履歴の複雑化を避ける）
- 会話履歴には編集後の内容を保存
- `messageUpdate(oldMessage, newMessage)` で `newMessage.content` を読むには `GatewayIntentBits.MessageContent` 特権インテントが必要（guild チャンネルの場合）。現クライアントの intents 設定を実装時に確認する
- キャッシュにない message は `oldMessage` が **partial**（`.content` が null）になり得る。`oldMessage.partial` チェック、または `oldMessage.content ?? ""` でガードする（v14.16→14.26 で挙動変化なし）

**参照**:

- [OpenRouter Chat Completions API](https://openrouter.ai/docs) - `/api/v1/chat/completions`エンドポイントで会話履歴は`messages`配列に複数メッセージを送信
- [discord.js Client Events](https://discord.js.org/docs/packages/discord.js/14.26.3/Client:Class) - `messageUpdate`イベントで編集を検知（`MessageContent` intent 必要、`oldMessage` は partial になり得る）
- [discord.js Message.fetch](https://discord.js.org/docs/packages/discord.js/14.26.3/TextChannel:Class#fetch) - `channel.messages.fetch({limit: n})`で履歴取得

---

### 連携: コード実行サンドボックスの会話跨ぎ永続化

[`code-execution`](../code-execution/design.md) change は v1 では **per tool call sandbox** (1 リクエスト = 新規 sandbox 作成 → exec → 破棄) を採用しており、変数や import が会話跨ぎで持続しない。本 change (本体は Discord API fetch ベースで DB 永続化なしの方針) と組み合わせて、コード実行サンドボックスの会話跨ぎ永続化を Phase 2 以降のスコープとして検討する。

**重要な技術的制約**:

`detached sandbox` だけでは「変数・import 持続」は実現できない。microsandbox の `sandbox.exec("python", ["-c", code])` は毎回新プロセスを起動するため、Python のグローバル変数や import は exec 跨ぎで消える (filesystem 状態と sandbox プロセス自体は detached で残る)。本物の Jupyter ライクな体験には、sandbox 内に **言語ごとの long-lived REPL kernel / interpreter** (Python なら IPython kernel、Node なら `node --interactive` プロセス、bash なら interactive shell) を常駐させ、code を stdin で送る形が必要。これは microsandbox の単純な `exec` API では足りず、`ExecHandle.takeStdin()` を使った双方向通信や、Jupyter Kernel Protocol の薄いブリッジを sandbox 内に立てる等の設計が要る。

**設計ストア**: 上述の通り「会話 ID で sandbox を引く」必要があるが、本 change 本体は **Discord API fetch で会話履歴を取得し DB 永続化しない**方針。そのため、persistent sandbox 用には:

- (a) Discord 会話の **channelId** (または thread id) を直接 sandbox name のキーとし、サーバ側に持つ map は in-memory のみ (Bot 再起動で消える、ただし sandbox 自体は detached で生存)、起動時に `Sandbox.list()` で発見 + 名前で復元、または
- (b) `sandbox_sessions` のような小さなテーブルを別途追加して mapping を永続化

のいずれか。(a) のほうが既存方針 (DB 不要) と整合的だが、起動時の reconcile ロジックが必要。

microsandbox SDK 側にはこの用途に使える API が揃っている（npm `microsandbox@0.5.4`）: `SandboxBuilder.idleTimeout(secs)` / `.maxDuration(secs)` で生存期間を設定して `.createDetached()` で常駐起動、Bot 再起動後は **会話キーを sandbox 名に埋めた** `Sandbox.startDetached(name)` で再接続、`Sandbox.list()` で既存 sandbox を列挙して名前突合できる（sandbox 名は 128 UTF-8 バイト以内）。per-conversation persistent sandbox を実装する際はこれらを利用する（v1 の per-call lifecycle では未使用）。

**検討事項 (本 change の Phase 2 以降のスコープ候補)**:

- 会話単位での sandbox 生存期間 (TTL、最大同時保持数)
- sandbox の起動・破棄イベントと会話開始・終了の対応付け (会話の境界をどう検知するか)
- 言語切替時の挙動 (同じ会話で `python` → `bash` を切り替えたいケース)。microsandbox の `Sandbox` は image (= 言語) を生成時に確定するため、言語切替は新 sandbox 作成 (= 状態破棄) を伴う。これを許容するか、(conversation_id, language) のキーで複数 sandbox を持つか
- REPL kernel の常駐方式 (起動時に kernel プロセスを spawn、`ExecHandle.takeStdin()` で stdin pipe、レスポンスを stdout で受ける薄いプロトコル設計)
- LXC + Coolify 上で多数の detached microVM を抱える際のメモリ予算
- プロセスクラッシュ後の孤児 sandbox 検出 (`Sandbox.list()` + キーマップ突合)
- 共有チャンネル文脈での privacy: 「同じ会話」をどう定義するか (チャンネル / 投稿 / DM / ユーザ単位)、別ユーザの sandbox を覗かれないモデル設計

## Tasks

- [ ] 会話履歴（Discord APIから取得、DB不要）
  - `channel.messages.fetch()`で直近n件取得
  - コンテキスト設定（デフォルト5件、0-20件）
- [ ] 回答再生成ボタン（Components V2: Section accessory ボタン + 前回応答を Spoiler Container、`chatContainerBuilder` 再利用、DBマイグレーション: `response_generations`）
- [ ] メッセージ編集再生成（最新回答のみ対象、`messageUpdate`イベント。`MessageContent` intent / partial ガード確認）
- [ ] `/help`コマンド一覧の動的生成（SlashCommandBuilderから自動生成）
- [ ] `docs/changes/conversation-context/` 削除（リリース完了時、git 履歴がアーカイブ）
