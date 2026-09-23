---
title: "Discord 操作ツール"
status: planned
priority: medium
summary: "リアクション、投票、スレッド作成、ピン留めを、会話の流れでモデルが行える client tool 群"
---

# Discord 操作ツール

## Why

bot はチャンネルの会話を読んで答えられるが、Discord に対しては返信を書くことしかできない。
「いいねしといて」「この案で投票取って」「これスレッド切って」「これピン留めして」のような小さな操作は、そのたびにスラッシュコマンドを作るより、モデルが会話の流れで tool として呼べる方が自然である。
本 change は、副作用の小さい Discord 操作を `IClientTool` として既存の `ToolRegistry`（`src/llm/tools/registry.ts`）に登録する。

## 依存 / 関連 change

- 前提（実装済み）: [conversation-context](../conversation-context/design.md) — 会話の窓に並ぶメッセージは `m7` のような参照で示され、`read_earlier_messages` / `view_attachment` がその参照を使う。本 change の tool も対象メッセージを同じ参照で受け取る
- 連携: [権限管理](../permissions/design.md) — 設定を変える操作の認可（`ManageGuild`）は同 change の契約に従う

## Goals / Non-Goals

**Goals:**

- 次の 4 つの操作を client tool として登録する
  - `add_reaction`: 会話中のメッセージに絵文字でリアクションする
  - `create_poll`: 会話の中で Discord の投票を作る
  - `create_thread`: 会話中のメッセージから公開スレッドを作る
  - `pin_message`: 会話中のメッセージをピン留めする
- bot の権限だけでなく、依頼したユーザの権限でも実行できる操作に限る（bot を経由した権限の昇格を防ぐ）
- 権限が足りないときは、足りない権限の名前をモデルに返し、モデルがユーザに説明できるようにする
- guild ごとに有効・無効を切り替えられ、既定は無効にする

**Non-Goals:**

- メンバーの kick・ban・タイムアウト、メッセージの削除、ロールやチャンネルの管理
- DM での実行
- 会話の窓より前のメッセージを読むこと（`read_earlier_messages` が担う）

**将来別 change 候補:**

- メッセージ検索（`GET /guilds/{id}/messages/search`）: 2026-03-19 から bot でも使える。窓の外の話題を時期を問わず引けるが、bot と依頼者の双方が読めるチャンネルに絞る制御、NSFW の除外、index 作成中の 202 への再試行が要るので別に設計する。discord.js 14.26.5 にはメソッドが無く、`client.rest` で `Routes.guildMessagesSearch` を呼ぶ
- イベントの作成（`guild.scheduledEvents.create`、`CREATE_EVENTS`）: 「土曜に集まろう」を Discord のイベントにする
- ピン一覧とチャンネル情報の読み取り: 副作用が無く、文脈の補強になる
- メンバー検索（`guild.members.search`）: メンバー情報を外に出す同意の設計が要る
- 非公開スレッド、フォーラムへの投稿

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| tool の形 | 1 操作を 1 tool として登録する | 操作ごとの JSON Schema の方が、1 つの tool の `action` enum に畳むよりモデルの選択が正確で、`isEnabled` も操作ごとに書ける |
| v1 の操作 | リアクション、投票、スレッド作成、ピン留め | どれも REST だけで完結し、特権 intent を足さずに動く。結果は Discord 上で誰にでも見える。リアクションとピンは取り消せ、投票は作成者（bot）かメッセージを管理できる人が消せる。スレッドを消すには `ManageThreads` が要り、作った本人だけでは消せない |
| 有効化の単位 | `/config discord-tools on\|off` で 4 つをまとめて切り替え、既定は off とする。guild 設定の列 `discord_tools_enabled` に保存する | どれも副作用が小さく、1 つずつ切り替える需要は今のところ無い。副作用のある操作を管理者の明示なしに始めない |
| 対象メッセージの指定 | 会話の窓の参照（`m7`）で受け取り、省略時は bot を呼んだメッセージとする。会話履歴が off の guild では、bot を呼んだメッセージだけを対象にできる | モデルに生のメッセージ ID を書かせない。窓に無いメッセージは操作できない |
| 権限の確認 | Discord を変える呼び出しはすべて `discordActionService` の 1 つの認可関数を通し、各操作の実行の直前に、bot と依頼したメンバーの両方が下の「共通の確認」と操作ごとの権限を満たすときだけ実行する | tool は bot の権限で動くので、確かめないとユーザが自分に無い権限（ピン留めなど）を bot 経由で使える。確認を操作ごとに書くと、閲覧権限、タイムアウト、非公開スレッドの参加といった前提の抜けが操作ごとに生じるので、1 か所に集める |
| 必要な権限 | 下の「操作ごとの仕様」の表のとおり。`PIN_MESSAGES` は `MANAGE_MESSAGES` から分かれた権限で、2026-02-23 以降は `MANAGE_MESSAGES` だけではピン留めできない | Discord の API change log（2025-08-20、2025-11-24）と discord.js 14.26.5 の `Message#pinnable` の実装に合わせる |
| 失敗の返し方 | 権限不足（`50013`、`50001`）は足りない権限名を、対象が無い（`10008` など）は対象が無いことを、それ以外は一般的な失敗を、短い JSON でモデルに返す | 権限と not-found を混ぜると、モデルがユーザに誤った対処を伝える |
| 1 応答あたりの上限 | リアクションは 3 個、投票・スレッド・ピンは各 1 回 | モデルが繰り返し呼んでチャンネルを荒らさないようにする。上限を超えた呼び出しは実行せず、上限に達したことを返す |
| 投票の送り方 | Components V2 を使わない別のメッセージとして、bot を呼んだメッセージへの返信で送る | `IS_COMPONENTS_V2` のメッセージには `poll` を付けられない |
| スレッドの重複 | 対象メッセージから `message.startThread()` で作る | 1 つのメッセージには 1 つのスレッドしか作れず、2 回目は Discord が `160004` で断るので、bot 側で重複を防ぐ仕組みが要らない |
| 表示 | tool 独自の表示は作らない | 操作の結果（リアクション、投票、スレッド、ピン）そのものが Discord 上に見える |

## Design

### 共通の確認

認可関数は、操作のたびに次を順に確かめ、1 つでも満たさなければ実行せず、どの条件で断ったかを返す。

1. 依頼者を `guild.members.fetch({ user, force: true, cache: false })` で取り直す。取れなければ断る。1 回の応答は tool のターンを重ねて数分続きうるので、応答の開始時に取ったメンバーや gateway 由来の `message.member` では、途中でロールを外されたことを反映できない。
2. 取り直したメンバーで `canReadConversation()`（`src/services/messageAuthorization.ts`）を呼ぶ。bot と依頼者の双方がそのチャンネルの `ViewChannel` と `ReadMessageHistory` を持ち、非公開スレッドなら依頼者がその参加者か `ManageThreads` を持つことを確かめる。`permissionsFor()` は `ViewChannel` が無いときも他の権限ビットを立てたまま返し、スレッドでは親チャンネルの権限を返すので、この確認を操作ごとの権限の確認で代えない。
3. 依頼者がタイムアウト中（`communicationDisabledUntilTimestamp` が現在より後）なら、guild の所有者か `Administrator` を持つ場合を除いて断る。Discord はタイムアウト中のメンバーに閲覧と履歴の読み取りしか許さないが、`permissionsFor()` はタイムアウトを反映しない。
4. チャンネルがロックされたスレッドなら、bot と依頼者の双方に `ManageThreads` を求める。ロック中のスレッドでメッセージを送るには `ManageThreads` が要り、スレッドの `permissionsFor()` は親チャンネルの権限を返すだけでロックを反映しない。
5. 下の表の、操作ごとの権限を bot と依頼者の双方が持つことを確かめる。

### 操作ごとの仕様

| tool | 引数 | Discord の操作 | 操作ごとの権限（bot と依頼者の双方） |
| ---- | ---- | -------------- | ------------------------------------ |
| `add_reaction` | `emoji`（Unicode の絵文字、またはこの guild のカスタム絵文字の名前）、`message_ref`（任意） | `message.react()` | `AddReactions` |
| `create_poll` | `question`（300 字まで）、`answers`（2〜10 個、各 55 字まで）、`duration_hours`（1〜768、既定 24）、`allow_multiselect`（既定 false） | `channel.send({ poll })` を bot を呼んだメッセージへの返信として送る | 送信権限、`SendPolls` |
| `create_thread` | `name`（100 字まで）、`message_ref`（任意） | `message.startThread({ name })` | `CreatePublicThreads` |
| `pin_message` | `message_ref`（任意） | `message.pin()`。事前に `message.pinnable` を見る | `PinMessages` |

- 送信権限は、スレッドの中では `SendMessagesInThreads`、それ以外では `SendMessages` である。スレッドの権限は親チャンネルから継承されるが、スレッド内の送信だけは別の権限で決まる。返信として送るのに要る `ReadMessageHistory` は共通の確認に含まれる。
- `add_reaction` で常に `AddReactions` を求めるのは、Discord がまだ誰も付けていない絵文字を付けるときに `AddReactions` を要求するためである。既に付いている絵文字に重ねるだけなら要らないが、その区別を省く。
- カスタム絵文字に使えるロールの制限（`GuildEmoji.roles` が空でない）があるときは、bot と依頼者の双方がそのロールのどれかを持つときだけ使う。
- `create_thread` はテキストチャンネル（`ChannelType.GuildText`）でだけ提示する。アナウンスチャンネルでは discord.js が要求した種別を無視してアナウンススレッドを作り、スレッドの中ではスレッドを作れない。
- `add_reaction` のカスタム絵文字は、guild の絵文字キャッシュから名前で引く。見つからなければ実行せず、使える絵文字が無いことを返す。
- `pin_message` の `message.pinnable` は、システムメッセージと閲覧できないチャンネルを弾く。権限が足りているのに `pinnable` が false のときは、その理由を返す。

### 変更対象ファイル

- 新規: `src/llm/tools/discord/addReaction.ts` / `createPoll.ts` / `createThread.ts` / `pinMessage.ts` — 各 tool の schema、`validate`、handler
- 新規: `src/services/discordActionService.ts` — discord.js を呼ぶ実装。対象メッセージの解決、bot と依頼者の権限確認、Discord のエラーの分類、1 応答あたりの上限を持つ
- 修正: `src/llm/tools/registry.ts` — `IToolContext` に、応答ごとに作る Discord 操作の窓口（`DiscordToolContext`）を足す。tool は discord.js を直接触らない
- 修正: `src/services/conversationWindow.ts` — 窓の参照（`m7`）からメッセージ ID を引く関数を `ConversationToolContext` に足す
- 修正: `src/services/chatService.ts` / `src/bot/events/messageCreate.ts` — 設定が有効な guild で `DiscordToolContext` を作って ctx に載せる
- 修正: `src/index.ts` — 4 つの tool を登録する
- 修正: `src/db/schema.ts` / `src/db/repositories/guildSettings.ts` / `src/services/settingsService.ts` / `src/bot/commands/config.ts` — `discord_tools_enabled` の列、setter、`/config discord-tools`、`/status` の表示
- 修正: `scripts/e2e/scenarios.ts` — 名前を指定して走るシナリオ
- テスト: `tests/unit/llm/tools/discord/*.test.ts` / `tests/unit/services/discordActionService.test.ts`

### DBスキーマ変更

`guild_settings` に `discord_tools_enabled INTEGER NOT NULL DEFAULT 0` を足す。
追加の仕方は `web_search_enabled` と同じく、`src/db/schema.ts` で列の有無を見て `ALTER TABLE` する。

### 実装内容

- `isEnabled(ctx)` は、`toolsAllowed` が false でなく、`ctx.discord` があるときに true を返す。`ctx.discord` は guild の設定が有効なときにだけ作るので、DM と無効な guild では tool を提示しない。`create_thread` はチャンネルの種別も見る。
- `DiscordToolContext` は応答ごとに作り、依頼者の ID、bot を呼んだメッセージ、上限のカウンタを持つ。メンバーは持たず、共通の確認が操作のたびに取り直す。
- handler は `AbortSignal` を受け取るが、Discord への要求が送られた後の中断では結果が分からない。リアクションとピンは繰り返しても害が無く、スレッドは Discord が重複を断るので、中断後の再試行で二重に作られることは無い。投票だけは中断後に再試行すると二重になりうるので、1 応答 1 回の上限を、中断した呼び出しにも数える。
- モデルに返す結果は `{"ok":true}` か `{"ok":false,"reason":"missing_permission","who":"bot","permissions":["PinMessages"]}` のような短い JSON にする。

### e2e

`bun run e2e discord-tools` を名前を指定したときだけ走らせ、`/config discord-tools on` を要件にする。
テスト bot が bot にリアクション、投票、スレッド作成、ピン留めを頼み、REST でそれぞれの結果（対象メッセージのリアクション、投票のメッセージ、スレッド、ピン一覧）を読んで確かめる。
シナリオの最後に、作ったスレッドとピンを片付ける。

## Tasks

- [ ] `discord_tools_enabled` の列と `/config discord-tools`、`/status` の表示を足す
- [ ] `DiscordToolContext` と `discordActionService`（対象の解決、権限の確認、エラーの分類、上限）を実装する
- [ ] 4 つの tool を実装して登録する
- [ ] テスト: 共通の確認（取り直しの失敗、`ViewChannel` の無い依頼者、非公開スレッドの非参加者、タイムアウト中の依頼者と管理者の例外、ロックされたスレッド）、操作ごとの権限（bot だけが持つ、依頼者だけが持つ、`ManageMessages` だけではピン留めできない）、ロール制限付きの絵文字、上限、エラーの分類、チャンネル種別による非提示、無効な guild と DM での非提示
- [ ] e2e シナリオ `discord-tools` を足し、AGENTS.md の End-to-end 節に実行条件を書く
- [ ] `docs/changes/discord-tool/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **`SEND_POLLS` の bot への適用（未検証）**: `SendPolls` が bot の投票作成にも要求されるかは Discord の文書から確かめられていない。bot 側の事前確認には含め、実装時に権限を外した bot で挙動を確かめる。
- **モデルの呼びすぎ**: tool があると、頼まれていないのにリアクションや投票をするモデルがありうる。tool の description に「ユーザが頼んだときだけ使う」と書き、e2e とログで様子を見る。

## 参照

- [Discord API change log](https://github.com/discord/discord-api-docs/blob/main/developers/change-log.mdx) — `PIN_MESSAGES` の分離（2025-08-20）と適用開始日（2026-02-23）、Search Guild Messages（2026-03-19）
- [Discord Poll Resource](https://discord.com/developers/docs/resources/poll) — 投票の文字数と期間の上限
- discord.js 14.26.5 のソース — `Message#pinnable`（`structures/Message.js`）、`GuildTextThreadManager#create` がアナウンスチャンネルで種別を無視する分岐（`managers/GuildTextThreadManager.js`）
