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

**変更対象**:

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

**変更対象**:

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

**UI設計**:

- LLM応答の下に再生成ボタンを配置
- クリック時に同じプロンプトで新しい応答を生成
- 前の応答は折りたたみフィールドに移動（「前回の応答 (第N世代)」）
- 最新の応答は常にメインコンテンツに表示

**設計メモ**:

- 世代番号を管理（第1世代、第2世代...）
- 最大保存世代数: 5世代（古いものは削除）
- ボタンは5分間有効（タイムアウト後は新規メンションで呼び出し）

---

### メッセージ編集再生成

**変更対象**:

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

**参照**:

- [OpenRouter Chat Completions API](https://openrouter.ai/docs) - `/api/v1/chat/completions`エンドポイントで会話履歴は`messages`配列に複数メッセージを送信
- [discord.js Client Events](https://discord.js.org/docs/packages/discord.js/14.16.3/Client:Class) - `messageUpdate`イベントで編集を検知
- [discord.js Message.fetch](https://discord.js.org/docs/packages/discord.js/14.16.3/TextChannel:Class#fetch) - `channel.messages.fetch({limit: n})`で履歴取得

## Tasks

- [ ] 会話履歴（Discord APIから取得、DB不要）
  - `channel.messages.fetch()`で直近n件取得
  - コンテキスト設定（デフォルト5件、0-20件）
- [ ] 回答再生成ボタン（前の回答も表示可能、DBマイグレーション: `response_generations`）
- [ ] メッセージ編集再生成（最新回答のみ対象、`messageUpdate`イベント）
- [ ] `/help`コマンド一覧の動的生成（SlashCommandBuilderから自動生成）
