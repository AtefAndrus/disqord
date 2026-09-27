---
title: "Discord の情報を読む tool とイベントの作成"
status: investigating  # investigating | planned | in-progress | implemented
priority: medium       # high | medium | low
summary: "ピン留め一覧、チャンネル情報、サーバーのイベント一覧をモデルが読める tool と、イベントを作る tool"
---

# Discord の情報を読む tool とイベントの作成

## Why

「このチャンネルのピン留めに何があったっけ」「このチャンネルって何用?」「今週のイベントは?」のような質問に、bot は答えられない。
ピン留めは会話の窓より古いことが多く、チャンネルの説明（トピック）とイベントは会話の中に現れない。
また、「土曜 20 時に集まろう」を Discord のイベントにするには、人が手で作る必要がある。

## 依存 / 関連 change

- 前提（実装済み）: [discord-tool](../discord-tool/design.md) — 副作用のある Discord 操作の認可（`discordActionService` の共通の確認）、1 応答あたりの上限、「Discord 操作」の設定。イベントの作成はこの仕組みに載せる
- 前提（実装済み）: [conversation-context](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/conversation-context/design.md) — 会話の窓、`read_earlier_messages` と `view_attachment`、窓の参照（`m7`）
- 関連: [poll-results](../poll-results/design.md) — 投票の結果は tool にせず窓で扱う

## Goals / Non-Goals

**Goals:**

- 次の読み取りの tool を足す。どれも副作用が無い
  - `list_pins`: 今のチャンネルのピン留めを読む
  - `get_channel_info`: 今のチャンネル（スレッドなら親チャンネルも）の名前、種類、トピックなどを読む
  - `list_events`: サーバーの予定されたイベントを読む
- 副作用のある `create_event` を足し、サーバーのイベントを作れるようにする
- 読み取りの tool は、依頼者と bot の双方が見られるものだけを返す

**Non-Goals:**

- 他のチャンネルのピン留めや情報を読むこと（依頼者が見られるかの確認を広げる必要があり、使い道がはっきりしてから扱う）
- イベントの編集、削除、参加者の一覧
- ステージのイベントの作成（Manage Channels、Mute Members、Move Members を要し、bot にそこまで渡したくない）
- 繰り返しのイベント（`recurrence_rule`）の作成

**将来別 change 候補:**

- メンバー検索、メッセージ検索（[discord-tool](../discord-tool/design.md) の将来別 change 候補を参照）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| context に常に入れるか tool にするか | tool にする | どれも毎回の応答で要る情報ではなく、常に入れると token を使う。モデルが要るときに取りに行く |
| 読み取りの tool を有効にする設定 | 「会話履歴」が on の guild で提示する。新しい設定は作らない | どれも、そのチャンネルやサーバーの参加者が見られるものを読むだけで、会話履歴を読むことと性質が近い。`read_earlier_messages` と同じく `ctx.conversation` があるときに提示する |
| `create_event` を有効にする設定 | 「Discord 操作」の on/off に含める | 副作用があり、他の Discord 操作と同じく管理者の明示なしに始めない |
| ピン留めの対象 | 今のチャンネルだけ。窓と同じ窓に入る判定（`messageEligibility`）と読み取りの確認（`canReadConversation`）を通し、返したメッセージに窓の参照（`m7`）を振る | 窓の外のメッセージを読む点は `read_earlier_messages` と同じなので、同じ判定と確認を使う。参照を振ると、ピン留めの添付を `view_attachment` で開ける |
| チャンネル情報の範囲 | 今のチャンネルの名前、種類、トピック、カテゴリー名、NSFW、低速モード、作成日時。スレッドなら親チャンネルの名前とトピックも | どれもチャンネルを見られる人に表示される情報である。権限の上書きやメンバー一覧は含めない |
| イベント一覧の絞り込み | ボイスとステージのイベントは、依頼者と bot の双方がそのチャンネルの View Channel を持つときだけ返す。外部のイベントは返す | Discord はボイスとステージのイベントの取得に、そのチャンネルの View Channel を求める。bot の権限で取った一覧をそのまま返すと、依頼者が見られないチャンネルのイベントが漏れる |
| 作れるイベントの種類 | 外部（場所を文字で持つ）とボイスチャンネル | ステージは Non-Goals の理由で外す |
| イベント作成の権限 | 外部は bot と依頼者の双方にサーバー単位の Create Events を求める。ボイスは双方にそのチャンネルの Create Events、View Channel、Connect を求める。加えて discord-tool の共通の確認（依頼者の取り直し、閲覧、タイムアウト）を通す | Discord が求める権限を bot と依頼者の双方に当てはめ、bot を経由した権限の昇格を防ぐ |
| ボイスチャンネルの指定 | モデルはチャンネル名で指定し、実行の直前に REST で取ったサーバーのボイスチャンネルから名前で引く。同名が複数あれば実行せず候補の名前を返す | モデルに ID を書かせない。同名の取り違えで別のチャンネルにイベントを作らない |
| 日時 | モデルに時差付きの ISO 8601 で書かせ、開始が現在より後、終了が開始より後であることを確かめる。外部のイベントは終了を必須にする | 外部のイベントには終了時刻が必須である。現在日時は既存の system メッセージ（JST）でモデルに渡っている |
| イベントの公開範囲 | サーバーのメンバーだけ（`GUILD_ONLY`） | Discord が今受け付ける公開範囲はこれだけである |
| 作成の上限と中断 | 1 応答 1 回。中断した呼び出しにも数える | 投票と同じく、中断後に再試行すると二重に作られうる |

## Design

### 変更対象ファイル

- 新規: `src/llm/tools/discord/listPins.ts` / `getChannelInfo.ts` / `listEvents.ts` / `createEvent.ts`
- 新規: `src/services/discordInfoService.ts` — 読み取りの tool の実装。応答ごとに作り、依頼者と bot の権限を確かめてから読む
- 修正: `src/llm/tools/registry.ts` — `IToolContext` に読み取りの窓口（`DiscordInfoContext`）を足し、`DiscordToolContext` に `createEvent` を足す
- 修正: `src/services/conversationWindow.ts` — ピン留めを窓の判定と参照の付与に通す関数を足す
- 修正: `src/services/discordActionService.ts` — `createEvent` と、イベント用の権限の確認
- 修正: `src/services/chatService.ts` / `src/bot/events/messageCreate.ts` — 会話履歴が有効なときに `DiscordInfoContext` を作って載せる。`clientToolInvoked` を立てる
- 修正: `src/index.ts` — 4 つの tool を登録する
- 修正: `README.md` — 招待に必要な権限に Create Events と Connect を足す
- 修正: `scripts/e2e/scenarios.ts` — 名前を指定して走るシナリオ

### 実装内容

- 読み取りの tool の結果は、`read_earlier_messages` と同じく `resultBudgetTokens` に収まるよう切り詰める。ピン留めは新しい順に並べ、収まらない分は `has_more` で示す。
- `list_pins` は `GET /channels/{id}/messages/pins` を最大 50 件取り、窓に入る判定を通ったものだけを返す。判定で外れたもの（他の bot の発言など）は件数だけを返す。
- `get_channel_info` はチャンネルを REST で取り直して読む。キャッシュのチャンネルは discord-tool の共通の確認と同じ理由で使わない。
- `list_events` は `GET /guilds/{id}/scheduled-events?with_user_count=true` を使い、終わったものと取り消されたものを除いて開始の早い順に最大 20 件を返す。各イベントは名前、説明、開始と終了、状態、場所またはチャンネル名、興味ありの人数を持つ。
- `create_event` は discord-tool の `execute`（認可、上限、エラーの分類）に載せる。成功したらイベントの名前と開始日時とリンクを返す。
- tool の description に、ユーザが頼んだときだけイベントを作ると書く。

### e2e

`bun run e2e discord-info` を名前を指定したときだけ走らせ、会話履歴を有効にすることを要件にする。
テスト bot が、チャンネルのトピックとピン留めの 1 件を尋ね、REST で読んだ値と返答が合うことを確かめる。
`create_event` は `discord-tools` シナリオに足し、作ったイベントを最後に消す。

## Tasks

- [ ] `DiscordInfoContext` と `discordInfoService` を実装する
- [ ] `list_pins`、`get_channel_info`、`list_events` を実装して登録する
- [ ] `create_event` を `discordActionService` に足して登録する
- [ ] テスト: 依頼者が見られないボイスチャンネルのイベントが一覧に出ないこと、ピン留めが窓の判定を通ること、会話履歴が off の guild で読み取りの tool が提示されないこと、イベント作成の権限（外部とボイス、bot だけが持つ、依頼者だけが持つ）、日時の検証、同名のボイスチャンネル
- [ ] README の招待に必要な権限に Create Events と Connect を足す
- [ ] e2e シナリオ `discord-info` を足し、`discord-tools` にイベント作成を足し、AGENTS.md の End-to-end 節に実行条件を書く
- [ ] 手動確認: 本番の bot を、Create Events と Connect を足した招待 URL で認可し直す
- [ ] `docs/changes/discord-info-tools/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **一覧のイベントの View Channel の判定（未検証）**: bot の権限で取った一覧に、依頼者が見られないボイスチャンネルのイベントが含まれるかを確かめていない。含まれない前提にはせず、本 change の絞り込みで除く。
- **ピン留めの件数**: 50 件を超えるピン留めは読まない。古いピン留めが要る場面が出たら `before` で続きを取る。

## 参照

- Discord Guild Scheduled Event Resource（`developers/resources/guild-scheduled-event.mdx`）— 種類ごとの必須項目、種類ごとの権限、List Scheduled Events の `with_user_count`
- Discord Message Resource（`developers/resources/message.mdx`）— Get Channel Pins（最大 50 件、`before`、`has_more`）
