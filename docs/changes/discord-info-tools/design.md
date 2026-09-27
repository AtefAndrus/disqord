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
- 前提（実装済み）: [conversation-context](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/conversation-context/design.md) — 会話の窓、`read_earlier_messages` と `view_attachment`、窓の参照（`m7`）、応答ごとの REST の上限
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

- テキストチャンネルとその中のスレッド以外での利用。ボイスやステージのチャンネルのテキストチャットは、メッセージを読むのに Connect も要るなど権限の前提が異なり、[discord-tool](../discord-tool/design.md) と同じく対象にしない
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
| 読み取りの tool を有効にする設定 | 「会話履歴」が on の guild で提示する。新しい設定は作らない | どれも、そのチャンネルやサーバーの参加者が見られるものを読むだけで、会話履歴を読むことと性質が近い。`read_earlier_messages` と同じく、`ctx.conversation` があり、`ctx.toolsAllowed` が false でないとき（モデルが tool に対応するとき）に提示する |
| 読み取りの tool を提示するチャンネル | テキストチャンネル（`GuildText`）と、その中の公開・非公開スレッド | Non-Goals のとおり。discord-tool と同じ範囲にそろえる |
| 読み取りの権限の確認 | 読み取りの tool の呼び出しのたびに、discord-tool の共通の確認のうち 1 と 2（依頼者の REST での取り直しと `canReadConversation()`）を通す。取り直しに失敗したら読まずに失敗を返す。3 と 4（タイムアウトとロックされたスレッド）は求めない | 1 回の応答は tool のターンを重ねて数分続きうるので、応答の開始時の状態で判断すると、途中でロールを外された依頼者にも読ませてしまう。タイムアウト中のメンバーも閲覧と履歴の読み取りは許され、ロックされたスレッドも読めるので、書き込みのための 3 と 4 を読み取りに掛けない |
| `create_event` を有効にする設定 | 「Discord 操作」の on/off に含める | 副作用があり、他の Discord 操作と同じく管理者の明示なしに始めない |
| ピン留めの対象 | 今のチャンネルだけ。窓に入る判定（`messageEligibility`）を通したものだけを返し、返したメッセージに窓の参照（`m7`）を振る。bot の複数ページの返答は、ピン留めされたページだけを 1 件として返す（ほかのページは含めない）。参照はそのページを指す | 窓の外のメッセージを読む点は `read_earlier_messages` と同じなので、同じ判定を使う。参照を振ると、ピン留めの添付を `view_attachment` で開ける |
| 読み取りの REST の上限 | 読み取りの tool が行う REST の呼び出しは、権限の確認のための取り直し（依頼者、チャンネル、bot、非公開スレッドの参加確認）を含めてすべて、`read_earlier_messages` と同じ応答ごとの上限（`TOOL_REST_LIMIT`）から使う。権限の確認の途中で上限に達したら、何も読まずに `{"error":"rest_budget_exhausted"}` を返す。読み取りの途中で達したら、それまでに確かめ終えた分だけを返し、`stop_reason` に `rest_budget_exhausted` を入れ、`has_more` を true にする | 読み取りの tool は応答の中で何度も呼ばれうるので、どれか 1 つの取得でも上限の外にあると、繰り返しで rate limit を使い切る。取得の種類ごとに数えるかを決めるのではなく、読み取りの tool の REST をすべて 1 つの上限で数える |
| チャンネル情報の範囲 | 今のチャンネルの名前、種類、トピック、カテゴリー名、NSFW、低速モード、作成日時。スレッドなら親チャンネルの名前とトピックも。親チャンネルとカテゴリーも REST で取り直す | どれもチャンネルを見られる人に表示される情報である。権限の上書きやメンバー一覧は含めない |
| イベント一覧の絞り込み | ボイスとステージのイベントは、依頼者と bot の双方がそのチャンネルの View Channel を持ち、かつそのチャンネルを @everyone が見られるときだけ返す。非公開のチャンネルのイベントは、件数も返さない。判定に使うチャンネルは、呼び出しごとに `GET /guilds/{id}/channels` を 1 回呼んでまとめて取り直す。一覧に無いチャンネルのイベントは返さない。一覧に載っていることは権限の判定の代わりにせず、載っているチャンネルでも依頼者と bot の双方の View Channel を確かめる（Discord は 2026-11-16 から bot が見られないチャンネルを一覧から除くが、接続中のボイスチャンネルは View Channel が無くても残りうる）。外部のイベントは返す。権限で絞った後に、期間で絞り、件数で切る | Discord はボイスとステージのイベントの取得に、そのチャンネルの View Channel を求める。bot の権限で取った一覧をそのまま返すと、依頼者が見られないチャンネルのイベントが漏れる。さらに返答は今のチャンネルの全員が読むので、依頼者だけが見られる非公開のチャンネルのイベントも、返答を通して他の参加者に漏れる。今のチャンネルの読者が見られるかを正確に確かめるには読者全員の権限が要るので、誰でも見られるチャンネルに限る。予定と開催中のイベントは最大 100 件あり、イベントごとにチャンネルを取ると REST の呼び出しがイベントの数だけ増えるので、チャンネルは一覧でまとめて取る |
| 作れるイベントの種類 | 外部（場所を文字で持つ）とボイスチャンネル | ステージは Non-Goals の理由で外す |
| イベント作成の権限 | 外部は bot と依頼者の双方にサーバー単位の Create Events を求める。ボイスは双方にそのチャンネルの Create Events、View Channel、Connect を求める。加えて、今のチャンネルに対する discord-tool の共通の確認を通す | Discord が求める権限を bot と依頼者の双方に当てはめ、bot を経由した権限の昇格を防ぐ |
| ボイスチャンネルの指定 | モデルはチャンネル名で指定する。実行の直前に REST でサーバーのチャンネルを取り、ボイスチャンネルのうち依頼者と bot の双方が View Channel を持つものだけから名前で引く。見つからなければ `channel_not_found`、2 つ以上なら `channel_ambiguous` を返し、候補の名前は返さない | モデルに ID を書かせない。依頼者が見られないチャンネルは候補にしないので、その存在を知らせない。同名の候補はどれも同じ名前でモデルが選べないので、名前を返しても役に立たない |
| 日時 | モデルに時差付きの ISO 8601 で書かせ、開始が現在より後、終了が開始より後であることを確かめる。外部のイベントは終了を必須にする | 外部のイベントには終了時刻が必須である。現在日時は既存の system メッセージ（JST）でモデルに渡っている |
| イベントの公開範囲 | サーバーのメンバーだけ（`GUILD_ONLY`） | Discord が定める公開範囲はこれだけである |
| 作成の上限と中断 | 1 応答 1 回。中断した呼び出しにも数える | 投票と同じく、中断後に再試行すると二重に作られうる |
| 作成の結果 | 成功は `{"ok":true,"url":"https://discord.com/events/<guild>/<event>"}` だけを返し、`terminal` にする | tool loop は、`terminal` の結果を、見積もりのトークン数が固定長の結果の枠（`FIXED_RESULT_TOKENS` から `CALL_ID_TOKEN_ALLOWANCE` を引いた値）以内のときだけ予算を使い切っていても通す（`src/llm/tools/toolHandler.ts` の `fixedLength`）。URL だけの結果はこの枠に収まるが、名前や説明を返すと長さが入力で変わって枠を超えうる。枠を超えると、作った後に結果が `result_too_large` に置き換わり、モデルが失敗と伝える。名前と日時はモデル自身が引数に書いたものである |

## Design

### tool の引数

| tool | 引数 |
| ---- | ---- |
| `list_pins` | なし |
| `get_channel_info` | なし |
| `list_events` | `from`、`until`（どちらも任意、時差付き ISO 8601）。開催中のイベントと、開始がこの範囲に入る予定のイベントを返す。`from` を省くと現在、`until` を省くと上限なし |
| `create_event` | `kind`（`external` か `voice`）、`name`（1〜100 字）、`start`（時差付き ISO 8601）、`end`（時差付き ISO 8601。`external` では必須、`voice` では任意）、`location`（1〜100 字。`external` では必須、`voice` では指定しない）、`channel_name`（`voice` では必須、`external` では指定しない）、`description`（任意、1〜1000 字。空文字列は指定しなかったものとして扱う） |

`validate` は上の必須と長さ、`kind` ごとの組み合わせ、日時の書式を確かめる。
現在より後か、終了が開始より後かは、実行の直前の時刻で handler が確かめる。

### 変更対象ファイル

- 新規: `src/llm/tools/discord/listPins.ts` / `getChannelInfo.ts` / `listEvents.ts` / `createEvent.ts`
- 新規: `src/services/discordInfoService.ts` — 読み取りの tool の実装。呼び出しのたびに共通の確認を通してから読む
- 修正: `src/services/discordActionService.ts` — 共通の確認の 1 と 2 を読み取りからも呼べる関数に分ける。`createEvent` を足す。イベントは今のチャンネルでなく作成先の権限を確かめ、成功時にリンクを返すので、既存の `execute`（対象メッセージの解決と `{"ok":true}` の結果）とは別の実行関数にし、上限の数え方だけを共有する。権限不足（`50013`）の分類は、既存の分類が今のテキストチャンネルと既存の操作の権限名から組み立てるので使わず、イベントの種類ごとに求めた権限（外部なら Create Events、ボイスなら Create Events、View Channel、Connect）から、bot に足りないものを名前で返す
- 修正: `src/llm/tools/registry.ts` — `IToolContext` に読み取りの窓口（`DiscordInfoContext`）を足し、`DiscordToolContext` に `createEvent` を足す
- 修正: `src/services/conversationWindow.ts` — ピン留めを窓に入る判定と参照の付与に通す関数を足す。応答ごとの REST の上限を共有する
- 修正: `src/services/chatService.ts` / `src/bot/events/messageCreate.ts` — 会話履歴が有効なときに `DiscordInfoContext` を作って載せる。読み取りの呼び出しと `createEvent` の呼び出しでも、既存の Discord 操作と同じくメソッドごとに包んで `clientToolInvoked` を立てる（立てないと、作成の後にモデルへの要求が失敗したときの再試行でイベントが二重に作られうる）
- 修正: `src/index.ts` — 4 つの tool を登録する
- 修正: `README.md` — 招待に必要な権限に Create Events と Connect を足す
- 修正: `scripts/e2e/scenarios.ts` / `scripts/e2e/index.ts` — 名前を指定して走るシナリオ

### 実装内容

- 読み取りの tool の結果は、`read_earlier_messages` と同じく `resultBudgetTokens` に収まるよう切り詰める。ピン留めは新しい順に並べる。`has_more` は、結果の予算で省いた分があるとき、REST の上限で確かめ終えなかった分があるとき、Discord の応答の `has_more` が true（取得した 50 件より古いピン留めがある）のときに true にする。
- `list_pins` は `GET /channels/{id}/messages/pins` を最大 50 件取り、窓に入る判定を通ったものだけを返す。判定で外れたもの（他の bot の発言など）は件数だけを返す。
- `get_channel_info` はチャンネルを REST で取り直して読む。キャッシュのチャンネルは discord-tool の共通の確認と同じ理由で使わない。
- `list_events` は `GET /guilds/{id}/scheduled-events?with_user_count=true` を使い、終わったものと取り消されたもの、権限で見られないものを除く。開催中（`ACTIVE`）のものと、開始が期間に入る予定（`SCHEDULED`）のものを、別々の一覧で返す。どちらも開始の早い順に最大 20 件で、20 件を超えた残りがあるとき、または結果の予算に収めるために省いたイベントがあるときに、その一覧の `has_more` を true にする。予定の残りは、モデルが `from` と `until` を狭めて取る。開催中のものは期間では絞らず、20 件を超える分は読めない。Discord の一覧にはページングが無く、予定と開催中のイベントは guild あたり最大 100 件なので、開催中が 20 件を超える場合と、開始が全く同じ予定が 20 件を超える場合だけは、全部を読めない。各イベントは名前、説明、開始と終了、状態、場所またはチャンネル名、興味ありの人数を持つ。
- tool の description に、ユーザが頼んだときだけイベントを作ると書く。

### e2e

`bun run e2e discord-info` を名前を指定したときだけ走らせ、会話履歴を有効にすることを要件にする。
テスト bot が、チャンネルのトピックとピン留めの 1 件を尋ね、REST で読んだ値と返答が合うことを確かめる。
`create_event` は `discord-tools` シナリオに足す。
作ったイベントは、作成者である bot 自身のトークン（`.env` の `DISCORD_TOKEN`）で消す。作成者は Create Events だけで自分のイベントを消せるので、テスト bot に Manage Events を足さずに済む。

## Tasks

- [ ] 共通の確認の 1 と 2 を読み取りから呼べるように分け、`DiscordInfoContext` と `discordInfoService` を実装する
- [ ] `list_pins`、`get_channel_info`、`list_events` を実装して登録する
- [ ] `create_event` を `discordActionService` に足して登録する
- [ ] テスト: 依頼者が見られないボイスチャンネルのイベントが一覧に出ないこと、応答の途中で依頼者の閲覧権限が外れたら読み取りが断られること、タイムアウト中のメンバーとロックされたスレッドでは読み取りが通ること、権限の確認の途中と読み取りの途中のそれぞれで REST の上限に達したときの結果、`list_events` の期間の絞り込み、開催中と予定の別々の上限と `has_more`、50 件より古いピン留めがあるときに `has_more` が true になること、複数ページの bot の返答のうちピン留めしたページだけが返ること、イベントを結果の予算で省いたときに `has_more` が true になること、イベント作成の `50013` がイベントの種類に合った権限名で返ること、`create_event` の後に再試行されないこと、ピン留めが窓に入る判定を通ること、ピン留めの判定が REST の上限で止まること、会話履歴が off の guild とテキスト以外のチャンネルで読み取りの tool が提示されないこと、イベント作成の権限（外部とボイス、bot だけが持つ、依頼者だけが持つ）、引数の検証（`kind` ごとの必須、長さ、日時）、依頼者が見られない同名のボイスチャンネルが候補に入らないこと、@everyone が見られないボイスチャンネルのイベントが一覧に出ないこと、tool 非対応のモデルで読み取りの tool が提示されないこと、同名が 2 つ以上のときに名前を返さないこと
- [ ] README の招待に必要な権限に Create Events と Connect を足す
- [ ] e2e シナリオ `discord-info` を足し、`discord-tools` にイベント作成と bot のトークンでの片付けを足し、AGENTS.md の End-to-end 節に実行条件を書く
- [ ] 手動確認: 本番の bot を、Create Events と Connect を足した招待 URL で認可し直す
- [ ] `docs/changes/discord-info-tools/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **イベントの情報の残る漏れ**: ボイスとステージのイベントは @everyone が見られるチャンネルのものだけを返すが、@everyone に閲覧を許したうえでロールやメンバー単位の上書きで閲覧を拒否された人が今のテキストチャンネルを読めると、その人にイベントの名前と日時が返答を通して伝わる。今のチャンネルの読者全員についてイベントのチャンネルを見られるか確かめるには、拒否の上書きの対象ごとに今のチャンネルの閲覧を計算する必要があり、その複雑さに見合わないので受け入れる。
- **添付を開くときの権限**: `list_pins` が参照を振ったピン留めの添付は、既存の `view_attachment` で開く。`view_attachment` は、会話の窓のどのメッセージについても、応答の開始時の依頼者とチャンネルで閲覧を確かめるので、応答の途中で閲覧の権限を失った依頼者も開ける。本 change で生じた性質ではないので、`view_attachment` の確認を呼び出しごとの取り直しに変える変更として別に扱う。
- **ピン留めの件数**: 50 件を超えるピン留めは読まない。古いピン留めが要る場面が出たら `before` で続きを取る。
- **チャンネルの秘匿化**: Discord は 2026-11-16 から、bot が見られないチャンネルを `GET /guilds/{id}/channels` の結果から除く。本 change は bot と依頼者の双方が見られるチャンネルだけを使うので、挙動は変わらない。

## 参照

- Discord Guild Scheduled Event Resource（`developers/resources/guild-scheduled-event.mdx`）— 種類ごとの必須項目、種類ごとの権限、List Scheduled Events の `with_user_count`、名前と場所の長さ
- Discord Message Resource（`developers/resources/message.mdx`）— Get Channel Pins（最大 50 件、`before`、`has_more`）、ボイスチャンネルでのメッセージ取得に要る Connect
- Discord API change log（2026-08-12「Channel Obfuscation for Users and Bots」）
