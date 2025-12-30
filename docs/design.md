# DisQord 設計書

本ドキュメントでは、DisQordのアーキテクチャ、仕様、設計判断を定義する。

実装の進捗・ロードマップは [progress.md](progress.md) を参照。

---

## 1. 仕様概要

### 1.1 呼び出し方法

| 方式 | 対応状況 | 備考 |
| ---- | -------- | ---- |
| メンション | 対応 | `@DisQord 質問` で呼び出し |
| スラッシュコマンド | 対応 | 設定・ヘルプ用途 |
| DM | 非対応 | Guild内のみで動作 |

### 1.2 会話コンテキスト

- **方式**: 単発応答（毎回リセット）
- 過去の会話履歴は保持しない（v1.4.0で対応予定）

### 1.3 スラッシュコマンド一覧

| コマンド | 説明 |
| -------- | ---- |
| `/disqord help` | 使い方を表示 |
| `/disqord status` | Botのステータス（OpenRouter残高等）を表示、ボタンで設定切り替え可能 |
| `/disqord model current` | 現在設定されているモデルを表示 |
| `/disqord model set <model>` | Guildのデフォルトモデルを変更（Autocomplete対応、新しい順ソート、変更時にモデル詳細情報を表示） |
| `/disqord model list` | OpenRouterのモデル一覧ページへ誘導 |
| `/disqord model refresh` | モデルキャッシュを更新 |
| `/disqord config free-only <on\|off>` | Guildの無料モデル限定設定を切り替え |
| `/disqord config release-channel [channel]` | リリースノート配信先チャンネルを設定（省略で無効化） |
| `/disqord config llm-details <on\|off>` | LLM詳細情報表示を切り替え |

### 1.4 応答形式

| 項目 | 仕様 |
| ---- | ---- |
| 送信方式 | 一括送信（Embed形式） |
| 長文対応 | 9000バイト単位で分割、改行位置優先、複数メッセージに分散（ページ番号表示） |
| Typing表示 | LLM応答待機中、8秒間隔で継続表示 |
| Embedカラー | モデルIDから決定論的に色決定（FNV-1aハッシュ、16色パレット） |
| LLM詳細情報 | トークン数、コスト、レイテンシ、TPS等をフッターに表示（ON/OFF切り替え可能、デフォルトON） |

---

## 2. アーキテクチャ

### 2.1 レイヤー構成

```text
┌─────────────────────────────────────────────────────┐
│                    Entrypoint                       │
│                   (src/index.ts)                    │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│                   Bot Layer                         │
│         (events, commands, client)                  │
│  - Discord.jsイベント処理                            │
│  - スラッシュコマンド処理                             │
│  - メッセージ受信・送信                              │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│                 Service Layer                       │
│              (src/services/)                        │
│  - ビジネスロジック                                  │
│  - LLM呼び出し制御                                   │
│  - 設定管理                                         │
└──────────┬─────────────────────┬────────────────────┘
           │                     │
┌──────────▼──────────┐ ┌────────▼─────────────────────┐
│    LLM Layer        │ │      Data Layer              │
│  (src/llm/)         │ │   (src/db/)                  │
│  - OpenRouter通信    │ │  - SQLite操作                │
│  - レート制限管理    │ │  - Repository                │
└─────────────────────┘ └──────────────────────────────┘
```

### 2.2 設計パターン

| パターン | 適用箇所 | 目的 |
| -------- | -------- | ---- |
| Repository | `src/db/repositories/` | データアクセスの抽象化 |
| Service | `src/services/` | ビジネスロジックのカプセル化 |
| 依存性注入 | エントリーポイント | テスタビリティ、疎結合 |

依存性注入は手動コンストラクタ注入を採用。詳細は `src/index.ts` を参照。

---

## 3. DBスキーマ

### 3.1 現行スキーマ

```sql
CREATE TABLE guild_settings (
    guild_id TEXT PRIMARY KEY,
    default_model TEXT NOT NULL DEFAULT 'deepseek/deepseek-r1-0528:free',
    free_models_only INTEGER NOT NULL DEFAULT 0,
    release_channel_id TEXT DEFAULT NULL,
    show_llm_details INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

実装: `src/db/schema.ts`

### 3.2 設計方針

| 項目 | 方針 |
| ---- | ---- |
| Discord ID | TEXT型で保存（JavaScriptのNumber精度問題を回避） |
| タイムスタンプ | ISO 8601文字列（`datetime('now')`） |
| Boolean | INTEGER型（0/1）で保存 |
| WALモード | 有効（パフォーマンス向上） |

---

## 4. インターフェース設計

インターフェース定義は以下のファイルを参照:

| インターフェース | ファイル |
| ---------------- | -------- |
| 共通型（GuildId, ChatMessage等） | `src/types/index.ts` |
| IGuildSettingsRepository | `src/db/repositories/guildSettings.ts` |
| ISettingsService | `src/services/settingsService.ts` |
| IChatService | `src/services/chatService.ts` |
| IModelService | `src/services/modelService.ts` |
| ILLMClient | `src/llm/openrouter.ts` |

---

## 5. エラーハンドリング設計

### 5.1 設計方針

- カスタムエラークラスで種別を明確化
- `userMessage` プロパティでユーザー向けメッセージを提供
- 技術的詳細はログのみに出力

### 5.2 エラークラス階層

```text
Error
  └─ AppError (base)
       ├─ RateLimitError (429)
       ├─ InsufficientCreditsError (402)
       ├─ ModerationError (403)
       ├─ InvalidModelError (400 + message pattern)
       ├─ ConfigurationError (400 + message pattern)
       ├─ ModelUnavailableError (500, 502, 503)
       ├─ AuthenticationError (401)
       ├─ TimeoutError (408)
       ├─ BadRequestError (400)
       └─ UnknownApiError (その他)
```

実装: `src/errors/index.ts`

### 5.3 ユーザー向けエラーメッセージ

| エラー種別 | ユーザー向けメッセージ |
| ---------- | ---------------------- |
| レート制限 | リクエスト制限に達しました。{N}秒後に再度お試しください。 |
| クレジット不足 | API残高が不足しています。管理者にお問い合わせください。 |
| コンテンツモデレーション | 入力内容が制限されました。表現を変えてお試しください。 |
| 無効なモデル | 指定されたモデルは存在しません。 |
| 設定エラー | OpenRouterの設定に問題があります。設定URLで確認してください。 |
| モデル利用不可 | モデルが一時的に利用できません。 |
| 認証エラー | Botの設定に問題があります。管理者にお問い合わせください。 |
| タイムアウト | 応答に時間がかかりすぎています。短いメッセージでお試しください。 |
| 不明エラー | 予期しないエラーが発生しました。 |

### 5.4 レート制限の設計

OpenRouterの429エラーには2種類がある:

| 種別 | 説明 | 動作 |
|------|------|------|
| ユーザーレベル | APIキーに対する制限（`X-RateLimit-Reset`あり） | グローバルフラグで全モデルブロック |
| プロバイダーレベル | 特定モデルのアップストリーム制限（ヘッダーなし） | フラグセットなし、他モデル使用可 |

### 5.5 レジリエンス設計

| 項目 | 動作 |
|------|------|
| 単一リクエスト障害 | 他リクエストに影響を与えない |
| エラー応答失敗 | フォールバックでログのみ出力 |
| `unhandledRejection` | ログ出力、プロセス継続 |
| `uncaughtException` | ログ出力、graceful shutdown |

---

## 6. Webhook受信設計

### 6.1 アーキテクチャ

```text
GitHub Release (published)
    ↓ POST + X-Hub-Signature-256
Cloudflare Tunnel
    ↓
Bot HTTPサーバー (/webhook/github)
    ↓ 署名検証
ReleaseNotificationService
    ↓
登録済み全Guild (release_channel_id設定あり)
```

### 6.2 設計方針

- 署名検証: HMAC-SHA256、timing-safe比較
- 処理対象: `release`イベントの`released`アクションのみ
- インフラ設定: [infrastructure-setup.md](infrastructure-setup.md) を参照

---

## 7. 将来計画（設計骨子）

詳細設計は実装時に本セクションへ追記する。

### v1.3.4 設定上書きバグ修正

**目的**: `setGuildModel`がモデル変更時に他の設定（`releaseChannelId`等）をnullで上書きするバグを修正

---

#### 問題の概要

**現象**: `/disqord model set` 実行時に、リリース通知チャンネル設定が消失する

**根本原因**: `settingsService.setGuildModel()` が既存設定を取得せずに部分更新を実行

**影響箇所**: `src/services/settingsService.ts:40-45`

```typescript
// 現行コード（バグあり）
async setGuildModel(guildId: string, model: string): Promise<GuildSettings> {
  return this.repo.upsert(guildId, {
    guildId,
    defaultModel: model,
    updatedAt: new Date().toISOString(),
  });
}
```

**バグの発現フロー**:

1. `setGuildModel` が `releaseChannelId` を含まないオブジェクトでupsertを呼び出し
2. `GuildSettingsRepository.upsert` で `settings.releaseChannelId ?? null` により `null` が設定される
3. `ON CONFLICT DO UPDATE SET release_channel_id = excluded.release_channel_id` で既存値が `null` に上書き

---

#### 修正方針

**変更対象**:

- `src/services/settingsService.ts` - `setGuildModel`メソッド修正

**修正内容**:

```typescript
// 修正後
async setGuildModel(guildId: string, model: string): Promise<GuildSettings> {
  const existing = await this.getGuildSettings(guildId);
  return this.repo.upsert(guildId, {
    ...existing,
    defaultModel: model,
    updatedAt: new Date().toISOString(),
  });
}
```

**設計メモ**:

- `setFreeModelsOnly`, `setReleaseChannel` と同じパターンに統一
- 既存設定をスプレッドしてマージすることで、未指定フィールドの上書きを防止

---

#### テスト追加

**変更対象**:

- `tests/unit/services/settingsService.test.ts`

**テストケース**:

```typescript
test("既存設定を維持しつつモデルを更新", async () => {
  const existingSettings = createMockGuildSettings({
    guildId: "guild-123",
    defaultModel: "old-model",
    releaseChannelId: "channel-456",
  });
  (mockRepo.findByGuildId as ReturnType<typeof mock>).mockResolvedValueOnce(existingSettings);

  await settingsService.setGuildModel("guild-123", "new-model");

  expect(mockRepo.upsert).toHaveBeenCalledWith(
    "guild-123",
    expect.objectContaining({
      defaultModel: "new-model",
      releaseChannelId: "channel-456", // 維持されていること
    }),
  );
});
```

---

### v1.4.0 即時UX改善

**目的**: すぐに体感できるUX向上（ストリーミング、停止ボタン、prefix削除、自動応答チャンネル）

---

#### ストリーミング対応

**変更対象**:

- `src/llm/openrouter.ts` - `stream: true`対応、SSE処理
- `src/services/chatService.ts` - ストリーミングレスポンス処理、進行中リクエスト追跡
- `src/bot/events/messageCreate.ts` - メッセージ更新ロジック

**設計メモ**:

**キャンセルと課金**:

- **非ストリーミングリクエスト**: クライアント側でキャンセルしてもサーバー側で処理継続、フル課金
- **ストリーミングリクエスト（対応プロバイダー）**: 接続中断で即座に処理・課金停止
- **対応プロバイダー**: OpenAI、Anthropic、Fireworks、Cohere、DeepInfra等20+
- **非対応プロバイダー**: Google、AWS Bedrock、Groq、Mistral等20+

**実装方式**:

1. `Map<messageId, AbortController>` で進行中リクエストを追跡
2. SSEストリーミングでトークンを受信
3. 2秒ごとにDiscordメッセージを更新（レート制限: 5回/5秒 = 1回/秒、余裕を持って2秒間隔）
4. 完了時にMapから削除

**参照**:

- [OpenRouter Streaming API](https://openrouter.ai/docs/api/reference/streaming) - `stream: true`でSSE有効化、2秒ごとにメッセージ更新推奨

---

#### 停止ボタン

**変更対象**:

- `src/bot/events/messageCreate.ts` - 初期メッセージ送信、ボタン追加
- `src/bot/events/interactionCreate.ts` - ボタンクリック処理
- `src/services/chatService.ts` - AbortController管理、abort()呼び出し

**UI設計**:

```
┌─────────────────────────────┐
│ 回答生成中...               │
│                             │
│ [🛑 停止]                   │
└─────────────────────────────┘
```

**実装フロー**:

1. メンション受信→初期メッセージ送信（「回答生成中...」+ 🛑停止ボタン）
2. ストリーミング開始、2秒ごとにメッセージ更新（ボタン保持）
3. 完了→ボタン削除、最終応答表示
4. 停止ボタンクリック→AbortController.abort()、停止メッセージ表示

**設計メモ**:

- ボタンのcustomIdに`stop_${messageId}_${timestamp}`を使用
- プログレスバーは不要（進捗は不明なため）
- エラーハンドリング:
  - プロバイダーが非対応の場合、キャンセル警告を表示
  - 既に完了したリクエストへのキャンセルはエラー応答

**参照**:

- [OpenRouter Streaming API](https://openrouter.ai/docs/api/reference/streaming) - ストリーミングキャンセルは`AbortController`で実装、プロバイダーによって対応状況が異なる
- [discord.js ButtonBuilder](https://discord.js.org/docs/packages/discord.js/14.16.3/ButtonBuilder:Class) - ボタンコンポーネントの作成方法

---

#### prefix削除

**変更対象**:

- `src/bot/commands/disqord.ts` - コマンド名変更（`disqord` → なし）

**実装内容**:

- `/disqord help` → `/help`
- `/disqord status` → `/status`
- `/disqord model set` → `/model set`
- 全コマンドから`disqord`プレフィックスを削除

**設計メモ**:

- コマンド登録時に`name: "help"`のように変更
- ユーザー確認不要、即座に適用

---

#### 自動応答チャンネル

**変更対象**:

- `src/db/schema.ts` - guild_settings拡張
- `src/bot/events/messageCreate.ts` - 自動応答判定ロジック
- `src/bot/commands/disqord.ts` - `config auto-reply`サブコマンド追加

**DBスキーマ変更**:

```sql
ALTER TABLE guild_settings ADD COLUMN auto_reply_channels TEXT; -- JSON array
```

**コマンド設計**:

```
/config auto-reply add <channel>
  - 指定チャンネルを自動応答リストに追加
  - チャンネル/スレッドの両方対応

/config auto-reply remove <channel>
  - 指定チャンネルを自動応答リストから削除

/config auto-reply list
  - 現在の自動応答チャンネルリストを表示
```

**実装内容**:

1. **自動応答判定**:
   - `auto_reply_channels`配列に含まれるチャンネル/スレッドでメンション不要
   - Bot自身のメッセージには応答しない
   - 他のBotのメッセージには応答しない

2. **スレッド対応**:
   - 親チャンネルIDが`auto_reply_channels`に含まれる場合、すべてのスレッドで自動応答
   - 個別スレッドIDも追加可能（優先度: スレッド > 親チャンネル）

3. **権限管理との関係**:
   - `allowed_channels`: Botが応答可能なチャンネルのホワイトリスト（制限機能）
   - `auto_reply_channels`: メンション不要で自動応答するチャンネル（拡張機能）
   - `auto_reply_channels`は`allowed_channels`のサブセットであるべき

**設計メモ**:

```typescript
function shouldAutoReply(message: Message, autoReplyChannels: string[]): boolean {
  if (message.channel.isThread()) {
    return autoReplyChannels.includes(message.channel.id) ||
           autoReplyChannels.includes(message.channel.parentId);
  }
  return autoReplyChannels.includes(message.channel.id);
}
```

**参照**:

- [discord.js BaseChannel](https://discord.js.org/docs/packages/discord.js/14.16.3/BaseChannel:Class) - チャンネル・スレッド判定に`isThread()`メソッドを使用
- [discord.js ThreadChannel](https://discord.js.org/docs/packages/discord.js/14.16.3/ThreadChannel:Class) - `parentId`プロパティで親チャンネルIDを取得

---

### v1.5.0 対話UX改善

**目的**: 直近n件の会話履歴をLLMに送信し、文脈を保持した対話を実現。回答の再生成とメッセージ編集による再生成機能を追加。

---

#### コンテキスト対話

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

#### 回答再生成機能

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

- LLM応答の下に「🔄 再生成」ボタンを配置
- クリック時に同じプロンプトで新しい応答を生成
- 前の応答は折りたたみフィールドに移動（「前回の応答 (第N世代)」）
- 最新の応答は常にメインコンテンツに表示

**設計メモ**:

- 世代番号を管理（第1世代、第2世代...）
- 最大保存世代数: 5世代（古いものは削除）
- ボタンは5分間有効（タイムアウト後は新規メンションで呼び出し）

---

#### メッセージ編集再生成

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

---

### v1.6.0 設定階層化 + LLMパラメータ + カスタムプロンプト

**目的**: Guild/Channel/User単位で設定を上書き可能に、LLMパラメータをモデルごとに最適化、カスタムシステムプロンプトを設定可能に

**変更対象**:

- `src/db/schema.ts` - `channel_settings`, `user_settings`テーブル追加、`llm_params`カラム追加
- `src/db/repositories/` - 新規Repository追加
- `src/services/settingsService.ts` - 階層解決ロジック
- `src/services/modelService.ts` - デフォルトパラメータ取得
- `src/llm/openrouter.ts` - パラメータ適用

**DBスキーマ変更**:

```sql
CREATE TABLE channel_settings (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    model TEXT,
    system_prompt TEXT,
    llm_params TEXT,  -- JSON: {temperature, top_p, ...}
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id)
);

CREATE TABLE user_settings (
    user_id TEXT PRIMARY KEY,
    model TEXT,
    system_prompt TEXT,
    llm_params TEXT  -- JSON
);

ALTER TABLE guild_settings ADD COLUMN llm_params TEXT;
```

**LLMパラメータ設計**:

**Phase 1: モデルごとのデフォルトパラメータ**:

1. `/api/v1/models` APIレスポンスに含まれる`default_parameters`を使用
2. `ModelService`でキャッシュ時に保存
3. `chatService`がモデルのデフォルトパラメータを取得して適用

**Phase 2: ユーザー設定可能パラメータ**:

- `/disqord config params set <json>` - パラメータをJSON形式で設定
- `/disqord config params reset` - デフォルトに戻す
- `/disqord config params show` - 現在の設定を表示

**マージロジック**:

1. モデルのデフォルトパラメータを取得
2. Guild設定でマージ
3. Channel設定でマージ
4. User設定でマージ
5. `supported_parameters`でバリデーション

**参照**:

- [OpenRouter Parameters](https://openrouter.ai/docs/api/reference/parameters)
- [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models)

**設計メモ**:

- 優先順位: User > Channel > Guild > Model Default > OpenRouter Default
- NULL値は上位設定を継承
- 無効なパラメータはバリデーションで拒否

---

#### カスタムシステムプロンプト

**変更対象**:

- `src/bot/commands/disqord.ts` - `prompt`サブコマンド追加
- `src/bot/commands/handlers.ts` - promptハンドラー追加
- `src/services/settingsService.ts` - プロンプト取得・設定ロジック
- `src/services/chatService.ts` - システムプロンプトの適用

**コマンド設計**:

```
/disqord prompt set <scope> <prompt>
  - scope: guild | channel | user
  - prompt: システムプロンプト（最大2000文字）

/disqord prompt show [scope]
  - scope省略時: 現在の有効なプロンプトを表示（優先順位適用後）
  - scope指定時: 指定スコープのプロンプトのみ表示

/disqord prompt reset [scope]
  - scope省略時: ユーザー設定をリセット
  - scope指定時: 指定スコープの設定をリセット
```

**デフォルトシステムプロンプト**:

```
You are a helpful AI assistant in a Discord server.
- Keep responses concise and clear
- Use Discord-supported markdown only (no H4+, tables, horizontal rules)
- Be respectful and informative
```

**設計メモ**:

- 優先順位: User > Channel > Guild > Default
- NULL値は上位プロンプトを継承
- プロンプトは全メッセージの先頭に追加（`role: "system"`）
- 最大長: 2000文字（Discord制限を考慮）

**参照**:

- [OpenRouter Chat Completions API](https://openrouter.ai/docs) - システムプロンプトは`messages`配列の最初の要素として`{role: "system", content: "..."}`形式で送信

---

### v1.6.0 マルチモーダル対応

**目的**: Discord画像添付をLLMに送信し、マルチモーダル対応モデルで画像認識を実現

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
- 最大画像数: 10枚（OpenRouter制限）
- サポート画像形式: png, jpg, jpeg, gif, webp

**参照**:

- [OpenRouter Chat Completions API](https://openrouter.ai/docs) - マルチモーダル入力は`messages[].content`を配列にし、`{type: "text", text: "..."}`, `{type: "image_url", image_url: {url: "..."}}`を含める
- [discord.js Message.attachments](https://discord.js.org/docs/packages/discord.js/14.16.3/Message:Class#attachments) - `message.attachments`コレクションから画像URLを取得、`attachment.contentType`で画像判定

---

### v1.7.0 Web Search

**目的**: LLMにWeb検索機能を付与し、最新情報を取得可能に

**変更対象**:

- `src/db/schema.ts` - guild_settings拡張
- `src/services/chatService.ts` - モデルIDに`:online`サフィックス付与
- `src/bot/commands/config.ts` - `web-search`サブコマンド追加

**DBスキーマ変更**:

```sql
ALTER TABLE guild_settings ADD COLUMN web_search_enabled INTEGER NOT NULL DEFAULT 0;
```

**コマンド設計**:

```
/config web-search <on|off>
  - ON: モデルIDに`:online`サフィックスを自動付与
  - OFF: 通常のモデルIDを使用（デフォルト）
```

**実装内容**:

1. **Web Search有効化**:
   - 設定ONの場合、LLMリクエスト時にモデルIDに`:online`を追加
   - 例: `deepseek/deepseek-r1-0528:free` → `deepseek/deepseek-r1-0528:free:online`

2. **費用警告**:
   - Web Search有効化時に警告メッセージを表示
   - 「Web検索は追加費用が発生します。詳細はOpenRouter料金ページを参照してください。」

3. **ステータス表示**:
   - `/status`にWeb Search設定状態を追加

**設計メモ**:

- OpenRouter `:online` サフィックスで有効化
- 追加費用: モデルによって異なる（通常+$0.01〜$0.05/リクエスト）
- 対応モデル: `:online`サフィックスに対応しているモデルのみ

**参照**:

- [OpenRouter Chat Completions API](https://openrouter.ai/docs) - Web検索有効化: モデルIDに`:online`サフィックス追加（例: `model:online`）、またはリクエストに`plugins: [{id: "web"}]`を含める

---

### v1.8.0 複数モデル並列

**目的**: 同じ質問を複数モデルに投げて比較、最適なモデル選択の支援

**変更対象**:

- `src/services/chatService.ts` - 並列リクエスト、エラーハンドリング
- `src/bot/commands/model.ts` - `compare`サブコマンド追加
- `src/bot/events/messageCreate.ts` - 複数Embed送信ロジック

**コマンド設計**:

```
/model compare <model1> <model2> [model3] [model4]
  - 2〜4モデルを指定
  - 各モデルで同じプロンプトを実行
  - 結果を別々のEmbedで表示
```

**実装内容**:

1. **並列リクエスト**:
   - `Promise.allSettled()`で複数モデルに並列リクエスト
   - 各モデルの応答を個別に処理（一部失敗しても他は継続）

2. **結果表示**:
   - 各モデルの応答を別々のEmbedで表示
   - Embedカラーはモデルごとに決定論的に決定（既存ロジック）
   - 失敗したモデルはエラーEmbedで表示

3. **比較メッセージヘッダー**:
   - 「比較結果: モデルA vs モデルB」
   - 各Embedのタイトルにモデル名を表示

**設計メモ**:

- 最大4モデル同時比較（Discord Embed制限: 10個/メッセージ、余裕を持って4個）
- レート制限考慮: 並列リクエストで制限に達する可能性あり → エラーハンドリング強化
- 費用注意: 複数モデル実行で費用増加 → 警告メッセージ表示

**参照**:

- [Promise.allSettled()](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled)

---

### v1.9.0 設定階層化 + LLMパラメータ + カスタムプロンプト

**目的**: Guild/Channel/User単位で設定を上書き可能に、LLMパラメータをモデルごとに最適化、カスタムシステムプロンプトを設定可能に

**変更対象**:

- `src/db/schema.ts` - `channel_settings`, `user_settings`テーブル追加、`llm_params`カラム追加
- `src/db/repositories/` - 新規Repository追加
- `src/services/settingsService.ts` - 階層解決ロジック
- `src/services/modelService.ts` - デフォルトパラメータ取得
- `src/llm/openrouter.ts` - パラメータ適用

**DBスキーマ変更**:

```sql
CREATE TABLE channel_settings (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    model TEXT,
    system_prompt TEXT,
    llm_params TEXT,  -- JSON: {temperature, top_p, ...}
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id)
);

CREATE TABLE user_settings (
    user_id TEXT PRIMARY KEY,
    model TEXT,
    system_prompt TEXT,
    llm_params TEXT  -- JSON
);

ALTER TABLE guild_settings ADD COLUMN llm_params TEXT;
ALTER TABLE guild_settings ADD COLUMN system_prompt TEXT;
```

**LLMパラメータ設計**:

**Phase 1: モデルごとのデフォルトパラメータ**:

1. `/api/v1/models` APIレスポンスに含まれる`default_parameters`を使用
2. `ModelService`でキャッシュ時に保存
3. `chatService`がモデルのデフォルトパラメータを取得して適用

**Phase 2: ユーザー設定可能パラメータ**:

- `/config params set <json>` - パラメータをJSON形式で設定
- `/config params reset` - デフォルトに戻す
- `/config params show` - 現在の設定を表示

**マージロジック**:

1. モデルのデフォルトパラメータを取得
2. Guild設定でマージ
3. Channel設定でマージ
4. User設定でマージ
5. `supported_parameters`でバリデーション

**参照**:

- [OpenRouter API Documentation](https://openrouter.ai/docs) - チャットパラメータ（temperature、top_pなど）は`/api/v1/chat/completions`のリクエストボディに含める
- [OpenRouter Models API](https://openrouter.ai/docs) - `/api/v1/models`エンドポイントで`default_parameters`と`supported_parameters`を取得

**設計メモ**:

- 優先順位: User > Channel > Guild > Model Default > OpenRouter Default
- NULL値は上位設定を継承
- 無効なパラメータはバリデーションで拒否

---

#### カスタムシステムプロンプト

**変更対象**:

- `src/bot/commands/prompt.ts` - `prompt`コマンド追加
- `src/bot/commands/handlers.ts` - promptハンドラー追加
- `src/services/settingsService.ts` - プロンプト取得・設定ロジック
- `src/services/chatService.ts` - システムプロンプトの適用

**コマンド設計**:

```
/prompt set <scope> <prompt>
  - scope: guild | channel | user
  - prompt: システムプロンプト（最大2000文字）

/prompt show [scope]
  - scope省略時: 現在の有効なプロンプトを表示（優先順位適用後）
  - scope指定時: 指定スコープのプロンプトのみ表示

/prompt reset [scope]
  - scope省略時: ユーザー設定をリセット
  - scope指定時: 指定スコープの設定をリセット
```

**デフォルトシステムプロンプト**:

```
You are a helpful AI assistant in a Discord server.
- Keep responses concise and clear
- Use Discord-supported markdown only (no H4+, tables, horizontal rules)
- Be respectful and informative
```

**設計メモ**:

- 優先順位: User > Channel > Guild > Default
- NULL値は上位プロンプトを継承
- プロンプトは全メッセージの先頭に追加（`role: "system"`）
- 最大長: 2000文字（Discord制限を考慮）

**参照**:

- [OpenRouter Chat API](https://openrouter.ai/docs/api-reference) - システムプロンプトは`messages`配列の最初に`{role: "system", content: "..."}`として送信

---

### v1.10.0 権限管理 + AI改善

**目的**: Bot利用を特定チャンネル/ロールに制限

**変更対象**:

- `src/db/schema.ts` - guild_settings拡張
- `src/bot/events/messageCreate.ts` - 権限チェック追加
- `src/bot/commands/disqord.ts` - configサブコマンド追加

**DBスキーマ変更**:

```sql
ALTER TABLE guild_settings ADD COLUMN allowed_channels TEXT;  -- JSON array
ALTER TABLE guild_settings ADD COLUMN admin_role_id TEXT;
```

**設計メモ**:

- `allowed_channels`: NULL=全チャンネル許可、配列=指定チャンネルのみ
- `admin_role_id`: 設定変更権限を持つロール

**参照**:

- [discord.js PermissionsBitField](https://discord.js.org/docs/packages/discord.js/14.16.3/PermissionsBitField:Class) - `member.permissions.has()`で権限チェック
- [discord.js GuildMember](https://discord.js.org/docs/packages/discord.js/14.16.3/GuildMember:Class) - `member.roles.cache.has(roleId)`でロール所属確認

---

## 8. 参考情報

### API・SDK関連

- [OpenRouter API Documentation](https://openrouter.ai/docs) - メインドキュメント（チャット、モデル、ストリーミング、マルチモーダルなど）
- [OpenRouter TypeScript SDK](https://www.npmjs.com/package/@openrouter/sdk) - 公式TypeScript SDK（型安全なAPI呼び出し）
- [discord.js v14 Documentation](https://discord.js.org/docs/packages/discord.js/14.16.3) - 現在使用中のバージョンのドキュメント
- [discord.js Guide](https://discordjs.guide/) - 初心者向けガイド（コマンド、イベント、デプロイなど）

### インフラ・ツール関連

- [GitHub Webhook Events](https://docs.github.com/en/webhooks/webhook-events-and-payloads) - Webhook署名検証、イベントペイロード
- [Bun Runtime](https://bun.sh/docs) - JavaScript/TypeScriptランタイム（HTTP、SQLite、テストなど）

### 実装時に役立つリソース

**エラーハンドリング**:

- OpenRouterエラーコード: 400（Bad Request）、401（Unauthorized）、402（Insufficient Credits）、403（Moderation）、408（Timeout）、429（Rate Limit）、500/502/503（Model Unavailable）

**レート制限**:

- Discord API: メッセージ取得 50回/秒、メッセージ送信 5回/5秒
- OpenRouter: ユーザーレベル制限（全モデル）とプロバイダーレベル制限（特定モデル）の2種類

**Discord制限**:

- メッセージ長: 2000文字
- Embed description: 4096文字
- Embed数: 10個/メッセージ
- ボタン数: 5個/ActionRow、最大5行（合計25個）
