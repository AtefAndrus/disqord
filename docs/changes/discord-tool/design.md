---
title: "Discord 操作ツール"
status: planned
priority: medium
summary: "LLM に境界付きの Discord 操作（履歴取得/メンバー検索/スレッド作成/ピン/追加文脈取得）を与える client tool 群"
---

# Discord 操作ツール

## Why

[tool-calling-foundation](../tool-calling-foundation/design.md) で client tool calling のループが入ると、LLM は「ツールを呼ぶ → 結果を受け取る → 続きを応答する」ことができる。しかし基盤自体は具体的なツールを持たない。

DisQord はチャット bot として既に Discord 上で動いており、ユーザは「このチャンネルの直近の流れを踏まえて」「○○というメンバーいる？」「これスレッド切って」のような、**Discord そのものに対する小さな操作**を会話の流れで頼みたい。これらは毎回スラッシュコマンドを設計するより、LLM がツールとして必要に応じて呼べる方が自然である。

そこで本 change は、**LLM に与える境界付きの Discord 操作**を `IClientTool` として定義し、基盤の `ToolRegistry` に登録する。鍵は「安全に絞る」ことで、(1) bot の特権 intent から action の upper bound を算出する機構を持ち（v1 の登録 action はいずれも privileged gateway intent を要求しない〔Discord API を叩く action は REST、`fetch_more_context` は履歴ストア読み出し〕ため非拘束だが、将来 gateway 依存 action の scaffold + content 不在注記）、(2) 実行時に **bot とユーザ両方の** Discord 権限を再評価し（ユーザ権限昇格の防止）、403/404/transient を区別した人間可読ヒントへ翻訳し、(3) 設定 allowlist を 3 カテゴリ（read 既定 on / member-lookup・management 既定 off）に分離して多層防御する。

加えて、[conversation-context](../conversation-context/design.md) の「モデル駆動の文脈取得」を実体化する `fetch_more_context` action を提供する。境界を越えた古い履歴をモデル自身が必要なときだけ引ける。

## 依存 / 関連 change

- 先行: [tool-calling-foundation](../tool-calling-foundation/design.md) — `IClientTool`（`name`/`description`/`parameters`/`timeoutMs?`/`isEnabled`/`validate`/`handler`）・`ToolRegistry`・`runToolLoop()` が前提。本 change はここに tool を登録するだけで、protocol ループは持たない
- 連携: [conversation-context](../conversation-context/design.md) — `fetch_more_context` は履歴ストアの session/exchange モデルと予算境界を使う。本 change の他 action（履歴取得等）は live な Discord API を叩く
- 連携: [chat-response-v2](../chat-response-v2/design.md) — tool 結果の Discord 描画（`ToolRenderPayload`）は V2 の updater が解釈する。V2 未実装期は**基盤が受け取る updater インタフェースのスタブ（legacy embed）が描画フォールバック**する（これは描画/updater レイヤの話。tool 自体の可否は `isEnabled` で別管理。後述の `fetch_more_context` の「未実装 tool 用スタブは無い」と混同しない）
- 連携: [permissions-stats](../permissions-stats/design.md) — 管理系 action（pin/スレッド作成）の使用ログ/権限境界は将来 stats 側と整合させうる（本 change では tool 単位の log に留める）

## Goals / Non-Goals

**Goals:**

- 以下の Discord 操作を `IClientTool` として登録する:
  - read（既定 on）: `fetch_recent_messages`（直近メッセージ取得）、`fetch_more_context`（conversation-context の境界外の古い履歴をモデル駆動で取得）
  - member-lookup（既定 off）: `search_members`（メンバー検索）、`member_info`（特定メンバー情報）
  - management（既定 off）: `create_thread`（スレッド作成）、`pin_message`（メッセージのピン留め）
- **intent 由来の action enum（upper bound）**: `client.application.fetch()` → `app.flags`（`ApplicationFlags`）で bot に有効化された特権 intent を判定し、それを超える action をモデルに提示しない upper bound を持つ。**v1 の登録 action はいずれも privileged gateway intent を機能的に要求しない**（Discord API を叩く action は REST ベース、`fetch_more_context` は履歴ストア読み出し）ため、この upper bound は v1 では action を絞らない（gateway 依存 action を足す将来のための scaffold）。`app.flags` の v1 での実効は `GatewayMessageContent` flag による `fetch_recent_messages` の content 不在注記。メンバーデータ露出の consent は flag ではなく専用 opt-in allowlist（既定 off）で取る（下記）
- **403 enrichment**: Discord の権限不足エラーを、必要な権限名を含む人間可読ヒント（`role:"tool"` content）に翻訳して LLM へ返す（LLM はユーザに「○○権限が必要」と説明できる）。404/不正 target/transient は権限問題と**区別**する
- **多層防御**: (a) intent 由来の可用 action upper bound（v1 は REST のため非拘束。将来 scaffold）、(b) guild 設定 allowlist カテゴリ（read 既定 on / member-lookup・management 既定 off）、(c) 実行時の Discord 権限再評価、を**積（intersection）**で適用する。v1 の実効ゲートは (b) ∩ (c)
- action を 3 カテゴリ（**read** / **member-lookup** / **management**）に分離し、allowlist と既定値・description を別管理にする（read 既定 on、member-lookup・management 既定 off）

**Non-Goals:**

- 破壊的/高権限な操作（メンバーの kick/ban/タイムアウト、メッセージ削除、ロールの**作成/削除**、チャンネル管理）は本 change では扱わない
- ロール**付与**（add/remove role）は枠組み（必要権限の算出・ロール階層チェック）だけ設計に含めるが、v1 の登録 action からは外す（403 enrichment の対象例として記述、実装は将来 action）
- server tool（web_search 等）は対象外（[web-search](../web-search/design.md) / [tool-calling-foundation](../tool-calling-foundation/design.md) の server tool 経路）
- tool 結果の凝った Discord 描画ロジック（描画は最小限。`ToolRenderPayload` 透過は基盤任せ）
- DM での実行（基盤同様 guild 前提。`guildId === null` の ctx では全 action `isEnabled=false`）

**将来別 change 候補:**

- ロール付与/解除 action（`assign_role`）→ 階層チェック実装込みで別 action 化
- リアクション付与、メッセージ編集委譲、チャンネル横断検索など → 将来 action として追加登録

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| ツールの形 | 各 action を独立した `IClientTool` として登録（1 action = 1 tool name） | モデルは tool 名 + JSON Schema で選ぶ。action を 1 つの巨大 tool の `action` enum に畳むより、個別 schema の方がモデルの選択が正確で、`isEnabled` による出し分けも tool 単位で素直 |
| 可用 action の upper bound の算出元 | `client.application.fetch()` の `app.flags`（`ApplicationFlags`）で**実際に有効化された特権 intent**を見る。gateway intent ビット（`client.options.intents`）だけに依存しない。**ただし v1 の登録 action はいずれも privileged gateway intent を機能的に要求しない**（Discord API を叩く action は REST ベース、`fetch_more_context` は履歴ストア読み出し）ため、この upper bound は v1 の action を絞らない（gateway 依存 action のための forward-compat scaffold）。`app.flags` の v1 実効は `GatewayMessageContent` による content 不在注記のみ | gateway intent をコードで指定しても、Developer Portal でトグルしていない privileged intent は**実際には付与されない**。`app.flags` は Discord 側で有効化された状態を反映するため、将来 gateway 依存 action を足したときの真の情報源。メンバー consent をこの flag に紐付けない（REST 検索/単体 fetch は intent 不要で、不要な特権 intent 有効化を強いるのは footgun かつ flag はデータ露出同意の代理にならない）理由は下行 |
| `search_members` / `member_info` の consent | 実装は **`guild.members.search({ query, limit, cache: false })`**（REST `GET /guilds/{id}/members/search`、limit 1-1000）と **`guild.members.fetch({ user: userId, force: true, cache: false })`**（REST `GET /guilds/{id}/members/{user.id}`）。どちらも **GuildMembers privileged intent を必要としない**。**`cache: false`** で LLM 要求の lookup 結果を process member cache に溜めない（プライバシー最小化＝per-response throttle を data minimization 境界として有効に保つ）。consent は専用カテゴリ **member-lookup**（allowlist 既定 **off**、guild 管理者が `/disqord config` で明示 opt-in）で取り、`app.flags` の GuildMembers flag には**紐付けない** | discord.js 14.26.3 に `GuildMemberManager.search()` が存在し REST 検索（`Routes.guildMembersSearch`）を使う（`fetch({query})` は gateway request-guild-members で GuildMembers intent 必須、`list()`〔`GET /guilds/{id}/members`〕も intent 必須だが本 change は両者を使わない）。検索/単体 fetch は intent 不要なので、flag をゲートにすると不要な特権 intent 有効化を強いる footgun + flag は「メンバーデータを LLM に渡してよい」という明示同意の代理にならない。よって member-lookup を独立 opt-in カテゴリにする |
| `fetch_recent_messages` の content | `channel.messages.fetch({limit})` は intent 無しでも構造（id/author/timestamp）は取れるが、**本文は `GatewayMessageContent` 無しだと空**になりうる。content 不在時は tool 結果にその旨を明記 | MessageContent 特権 intent が message body の可視性を決める。content 欠落を黙って空返しすると LLM が「無言だった」と誤認するため明示する |
| 多層防御の合成 | **可用 action = intent 由来の可用集合 ∩ guild 設定 allowlist**。`isEnabled(ctx)` は両方を満たすときだけ true。dispatch 時は基盤がさらに `isEnabled` 再評価 + 実 Discord 権限チェック | intent だけ・allowlist だけでは不足。基盤の「dispatch 時 `isEnabled` 再評価はセキュリティ境界」契約に、Discord 権限の実チェックを足す |
| allowlist のカテゴリと既定 | 3 カテゴリ: **read**（`fetch_recent_messages`/`fetch_more_context`）既定 **on**、**member-lookup**（`search_members`/`member_info`）既定 **off**、**management**（`create_thread`/`pin_message`）既定 **off**。off カテゴリは guild 管理者が `/disqord config` で明示 opt-in。`fetch_more_context` は加えて conversation-context が有効な guild でのみ on | management は副作用、member-lookup はメンバーデータ露出（プライバシー）のため opt-in。read（チャンネル本文/履歴文脈）は副作用が無く文脈改善に直結するため既定 on |
| 権限チェックの主体 | 各 action handler が**実行直前に** `channel.permissionsFor(client.user)` で **bot** の必要 `PermissionFlagsBits` を確認し、欠落なら**実行せず** 403 相当の error 結果（人間可読ヒント）を返す。Discord が投げた 403（`DiscordAPIError` code 50013 等）も同じヒント経路に正規化 | 事前チェックで無駄な API 呼び出しと曖昧な失敗を避ける。実 API 側の 403 も拾って二重防御 |
| ユーザ権限昇格の防止 | tool は **bot の権限**で実行されるため、何もしないと invoking user が自分の持たない権限（履歴閲覧/pin/スレッド作成）を bot 経由で行使できてしまう。そこで read（`fetch_recent_messages` **および `fetch_more_context`**）と management（`pin_message`/`create_thread`）は **invoking member の権限も** `channel.permissionsFor(member)` で確認し、**bot と member の両方**が必要権限を満たすときだけ実行する。**認可チェック用の member は fresh に解決**する（`guild.members.fetch({ user: ctx.userId, force: true, cache: false })`＝REST で最新 role を取得し process cache も汚さない）。**`message.member`（gateway イベント由来）は role 剥奪後に stale な role を持ちうるため authz には使わず**、非権威的な context に留める。**member fetch 失敗時は deny**（権限不明で実行しない）。member 欠落時のヒントは「あなたにこの操作の権限がありません」。**`fetch_more_context` は保存済み履歴を返すが、これも bot と member の両方が当該 channel の閲覧権限を現在も持つこと（`ViewChannel`+`ReadMessageHistory` on `ctx.channel`、live read と同じ runtime チェック）を確認してから reader を呼ぶ**（剥奪された過去の閲覧を曝さない。purge 待ちの eventually-consistent にしない）。`ctx.sessionId` が current guild/channel に属することは conversation-context service が保証（tool は cross-session/cross-channel に読めない） | 全 tool は **current channel/guild**（ユーザが発話した場所）に対してのみ動く（任意チャンネル指定は無い）が、bot 権限での実行は user 権限を超えうる。pin/スレッド作成はモデレーション相当、履歴閲覧（live も persisted も）はユーザに見えない過去を曝しうるため、ユーザ権限と積を取る。member-lookup は current channel 権限と無関係なギルド規模のメンバーデータなので current-channel ベースの user 権限チェックは効かない。v1 は **admin opt-in（既定 off）を consent 境界**とし、opt-in 後は invoking user を問わない（既定 off + 身内利用前提 + admin が露出を承知で有効化、という前提）。ただし **member list が制限された guild / caller と非共有チャンネルのメンバー**では caller が自前の Discord client では見られないデータを bot 経由で得る残余の昇格があるため、**任意の per-caller ゲート（許可ロール / `ManageGuild` / 許可チャンネル）を設定可能にする**（既定は「opt-in 後は全 user 可」、high-privacy guild は絞れる）。詳細・field redaction は Open Questions |
| 403 → ヒント変換 | **Discord 権限**を要する action のみテーブル化し、欠落権限名を含む日本語ヒントへ写像（pin → `PIN_MESSAGES`、メッセージ閲覧 → `VIEW_CHANNEL` + `READ_MESSAGE_HISTORY`、公開スレッド作成 → `ViewChannel` + `CreatePublicThreads`、プライベートスレッド → `ViewChannel` + `CreatePrivateThreads`（`SendMessagesInThreads` は空スレッド作成には不要——スレッド内送信権限なので初期メッセージ投稿時のみ）、（将来）ロール付与 → `ManageRoles` + bot 最上位ロールが対象より上）。`search_members`/`member_info` は Discord 権限を要さない（REST 検索/単体 fetch）ため**このテーブルに含めない**——提示可否は member-lookup opt-in（`isEnabled`、既定 off）の話であり、403/権限経路とは別レイヤ。member_info の 404（guild 不在 user）は権限ではなく not-found 経路 | LLM が原因と対処をユーザに説明できる。raw な `DiscordAPIError` を LLM に渡すと不親切。提示ゲート・権限 403・not-found を混同しない |
| pin の必要権限 | **`READ_MESSAGE_HISTORY` + `PIN_MESSAGES`**（加えて `VIEW_CHANNEL`＝チャンネル可視性）。**`MANAGE_MESSAGES` には依存しない**。事前チェックは `pinnable` の**非権限の前提**（対象が **system message でない**・チャンネルが **viewable**・**voice 系でない**）も含める | discord.js 14.26.x `Message#pinnable` は `if (this.system) return false; if (!this.guild) return true; if (!channel \|\| channel.isVoiceBased() \|\| !channel.viewable) return false;` の後 `permissions.has(ReadMessageHistory \| PinMessages)` で判定（`PinMessages` は `MANAGE_MESSAGES`〔`1n << 13n`〕から独立した `1n << 51n`、discord-api-types 0.38.x）。`if (!this.guild) return true` は DM 用の早期 true だが、本 tool は guild 限定（DM 非対応）なので到達しない。事前チェックを権限だけに絞ると、system message へ pin を試みて Discord の 400/403 で曖昧に失敗する。**target message を fetch して `message.pinnable` を直接見る**か、`pinnable` と同じ集合（system 否定 + viewable + 非 voice + 権限）を再現するかのどちらかに揃え、`PIN_MESSAGES` だけ持つ/`READ_MESSAGE_HISTORY` を欠く bot や system message を取り違えない |
| `fetch_recent_messages` の読み取り権限 | handler は `VIEW_CHANNEL` + `READ_MESSAGE_HISTORY` を事前チェック。欠落なら実行せず 403 ヒント | `GET /channels/{id}/messages` は guild channel で `VIEW_CHANNEL` 必須、`READ_MESSAGE_HISTORY` 欠落だと空配列が返る。content 可視性（MessageContent intent）とは別レイヤ |
| handler の戻り | 基盤契約どおり `{ llmResult: string, render? }`。`llmResult` は**構造を保ったコンパクトな要約文字列**（メッセージ一覧なら `author: text` の行、メンバーなら表示名 + id）。**最大 byte の UTF-8 安全 clip は基盤の責務**（foundation Decisions「tool 結果の serialize」/「最大 byte 上限を loop が UTF-8 安全に強制」）。ただし各 tool は**意味的上限**（返す件数の上限・1 行/フィールド長の上限）を**handler 内で先に**適用し、要約が末尾で切れない clean な形にする | LLM へ渡すのは要約。生 Discord オブジェクトを JSON 丸投げすると context 肥大 + PII 過多。基盤の byte clip は安全網で、件数/フィールド長の意味的境界は tool が持つ。描画は `render` 側 |
| `fetch_recent_messages` の範囲 | **直近のみ**（`limit≤100` の最新メッセージ）。`before`/`after`/`around` の**ページング引数はモデルに公開しない**ので、繰り返し呼んでも live history を遡れない | Discord の Get Channel Messages は `before/after/around` でページングできるため、これを公開すると `fetch_more_context`（conversation-context 予算で律速される古い文脈の経路）を迂回して live history を無制限に遡れてしまう。v1 は「今このチャンネルで起きていること」に限定し、古い文脈は `fetch_more_context` に一本化（任意ページングは将来 action） |
| `fetch_more_context` の境界 | conversation-context の **session/exchange モデルと予算**を再利用し、現在の文脈境界より**古い** exchange を新しい順に追加取得する。引数は「追加で何 exchange/おおよそ何トークン分か」程度に限定し、取得は active exchange 単位（行単位で role 整合を壊さない） | conversation-context が「モデル駆動の文脈取得は両者成立後の発展」と明記。境界選択ロジックを再利用し独自実装を持たない |
| `fetch_more_context` の累積予算（v1） | **1 会話（runToolLoop 1 実行 = 1 session の応答生成）あたりの累積追加 exchange / おおよそトークンに上限を設け、v1 から強制**する。tool は (a) 既に返した exchange 集合（重複除外）と (b) **残り累積予算**を保持し、各呼び出しで `reader(sessionId, alreadyReturnedExchangeIds, min(要求, 残り予算))` を呼ぶ。残りが 0 なら追加取得せず「これ以上の過去文脈は予算上限により取得しません」を `llmResult` に返す。この (a)(b) state は **discord-tool 所有の `fetchMoreContextState` オブジェクト**として `runToolLoop` 1 実行あたり 1 個生成し、`ctx`（基盤の「依存は ctx 経由」契約）に載せて全 dispatch で共有する（ctx は応答生成＝runToolLoop 1 実行ごとに構築されるため自然に loop スコープ。global/static にしない） | 基盤の `MAX_TURNS`/`MAX_TOOL_CALLS_PER_TURN` は「何ターン回すか」を縛るだけで、1 ターン内 or 複数ターンにまたがる **累積取得量**は縛れない。累積上限を v1 から入れないと、モデルが繰り返し呼んで予算境界（context cost 抑制の目的そのもの）を空洞化できる。state を per-loop の ctx 依存に閉じ込めれば基盤契約を壊さず（基盤に可変スロットを足さない）loop スコープを保てる |
| `fetch_more_context` と live fetch の住み分け | `fetch_more_context` = **保存済み履歴ストア**から論理ターンを引く（剥がし済みメディア参照込み）。`fetch_recent_messages` = **live な Discord API** から生メッセージを引く（履歴ストア未保存のチャンネルでも動く） | 情報源が別物。前者は会話文脈の延長、後者は「今このチャンネルで何が起きているか」 |
| timeout | 各 tool に `timeoutMs` を設定（Discord API レイテンシ想定で読み取り系は短め、メンバー検索/履歴取得はやや長め）。基盤の dispatcher 既定で上下限クランプ | Discord API は遅延しうる。基盤の `AbortSignal` race で打ち切る |
| 副作用 action の冪等性 | pin/スレッド作成は基盤の「timeout/cancel = 実行結果不明」セマンティクスを受ける。pin は**自然冪等**（既ピンへの再 pin は無害）。スレッド作成は**非冪等**で、対策は 2 系統: (a) **cross-loop の同時並行**（別応答が同チャンネルに同名スレッドを同時作成）は **process-level な in-flight ガード**。キーは `(guildId, channelId, 正規化 name, threadType)`、**create REST promise が settle するまで（+短い TTL）保持**し、**handler の timeout/cancel では解放しない**（基盤の「timeout = 実行結果不明」セマンティクス。REST がまだ in-flight でスレッドが作られうるため、cancel で即解放すると再要求が二重作成する）。このガードは loop を跨ぐ運用 dedup なので**意図的に per-loop ではなく process scope**——同一 loop 内の dispatch は基盤が逐次なので同時並行は起きず、守るべきは cross-loop。per-loop の `fetchMoreContextState`/`memberLookupState`（プライバシー/予算境界）とは別種の state。(b) **timeout 後にモデルが別ターンで再要求**する逐次重複は、作成前に**直近の active/archived 同名スレッド検出**（ベストエフォート）で抑える。基盤契約 `meta = { requestId, toolCallId, invocationId }` の **`invocationId` は dispatch ごとにユニーク**なので、再要求は新しい invocationId を持ち**それ単体ではクロスリクエストの dedup キーにならない**。invocationId は作成スレッドに紐づくメタ（audit reason 等）として埋め、後続検出が「自分が作った」と帰属判定するのに使う。より強い保証が要れば永続 idempotency record（DB、下記 Open Questions） | 基盤は「副作用安全性は tool 側責務」と明記し idempotency/reconciliation 用に `meta` を渡すが、cross-request 同一性は tool 側が name/heuristic で担保する必要がある。pin は再実行安全、スレッド作成は重複しうる |
| create_thread のチャンネル種別 | `channel.threads.create({name, autoArchiveDuration, type})` は `GuildTextThreadManager` の shape。v1 は **`GuildText` チャンネルのみ対応**（`isEnabled(ctx)` で `ctx.channel.type === ChannelType.GuildText` を判定）。**`GuildAnnouncement`（news）は v1 非対応**: discord.js は news channel では要求 `type` を無視し常に `AnnouncementThread` を作る（`else if (channel.type !== GuildAnnouncement) { resolvedType = type ?? ... }`）ため、`private` 要求が黙って announcement thread になる footgun を避ける。forum/media は `message` 必須の別 shape（`GuildForumThreadManager`）で別途。スレッドの中も非対応 | スレッド作成の API shape と `type` 解決がチャンネル種別で異なる。種別を見ずに提示すると、実行不能なチャンネルや、要求と違う種別のスレッドが黙って作られる（intent ∩ allowlist だけでは塞げない第 3 のゲート） |
| ctx 経由の依存 | `IToolContext` に Discord の `Message`/`channel`/`guild`/`client` 参照（または解決子）と、conversation-context の history reader を載せる。tool は ctx からのみ Discord にアクセス。**session 同一性は tool が導出しない**: ctx は当該応答の **`sessionId`**（conversation-context が triggering message の session 解決で確定済み）を載せる。**bare `sessionId` を単独の authz 境界にしない**——**当該 session+channel にスコープ済みの reader** を ctx に載せる（推奨。tool は別 session/別 channel を読む API 面を持たない）か、raw `sessionId` を渡すなら reader 側で `sessionId` が `ctx.guildId`+`ctx.channelId` に解決することを検証し不一致は reject する（ctx 構築/将来 caller の誤った session 載せに対する二重化）。guild/channel/user から session を推測したり独自 lookup を書いたりしない | 基盤の `IToolContext` は「各 tool が必要とする依存は ctx 経由」と規定。session 解決は conversation-context の責務なので、tool は確定済み `sessionId` を受け取るだけにして契約侵食を防ぐ |

## Design

### 全体像

```text
ToolRegistry（tool-calling-foundation）
  ├─ register(fetchRecentMessagesTool)   ← read（allowlist 既定 on）
  ├─ register(searchMembersTool)         ← member-lookup（allowlist 既定 off）
  ├─ register(memberInfoTool)            ← member-lookup（allowlist 既定 off）
  ├─ register(fetchMoreContextTool)      ← read（conversation-context 依存）
  ├─ register(createThreadTool)          ← management（allowlist 既定 off）
  └─ register(pinMessageTool)            ← management（allowlist 既定 off）

buildTools(ctx):
  available = intentAvailableActions(ctx.appFlags)   // ApplicationFlags 由来 upper bound（v1 は全 action）
              ∩ guildAllowlist(ctx.guildId)          // カテゴリ別設定（read on / member-lookup・management off）
  → isEnabled(ctx)===true の tool だけ tools 配列へ

dispatch（基盤の dispatch envelope 内）:
  ├─ isEnabled(ctx) 再評価（NG → error 結果）              // セキュリティ境界
  ├─ handler 実行前に channel.permissionsFor(bot) で必要権限を確認
  │     ├─ bot 欠落 → 実行せず 403 ヒント（error 結果）
  │     └─ read/management は channel.permissionsFor(member) も確認  // ユーザ権限昇格の防止
  │           └─ member 欠落 → 「あなたに権限がありません」（error 結果）
  ├─ handler 本体（throw/timeout/cancel でも基盤が error 結果を保証）
  └─ explainDiscordError: 50013/50001→権限ヒント / 10008 等→not-found / 他→一般エラー
```

### 変更対象ファイル

**新規:**

- `src/llm/tools/discord/index.ts` — 6 tool 定義のエクスポート + registry への登録ヘルパ（基盤の `ToolRegistry.register()` を呼ぶ）
- `src/llm/tools/discord/intentActions.ts` — `intentAvailableActions`（v1 は全 action を返す upper bound）+ `AppFlagsState`（known/unknown）+ `messageContentVisibility`（`GatewayMessageContent(|Limited)` 判定の tri-state、content 注記用）
- `src/llm/tools/discord/permissions.ts` — action ごとの必要 `PermissionFlagsBits`（pin=`ViewChannel`+`ReadMessageHistory`+`PinMessages`〔`Message#pinnable` と同集合〕、read=`ViewChannel`+`ReadMessageHistory`、thread=public/private 別）+ `channel.permissionsFor(bot)` チェック + `explainDiscordError`（権限欠落/`50013`/`50001`→権限ヒント、`10008`/`10003`/`10007`→not-found、他→一般エラーに分類）
- `src/llm/tools/discord/fetchRecentMessages.ts` — `channel.messages.fetch({limit})` ラッパ + 読み取り権限チェック + 要約整形（content 不在の明示）
- `src/llm/tools/discord/searchMembers.ts` — `guild.members.search({query, limit})` ラッパ + 要約整形
- `src/llm/tools/discord/memberInfo.ts` — 特定メンバー情報（ロール/参加日等の安全な部分集合）
- `src/llm/tools/discord/fetchMoreContext.ts` — conversation-context の境界外 exchange を追加取得する reader 呼び出し
- `src/llm/tools/discord/createThread.ts` — `channel.threads.create({name, autoArchiveDuration, type})` ラッパ（`GuildText` 種別判定 + public/private 権限 + 重複ガード）
- `src/llm/tools/discord/pinMessage.ts` — `channel.messages.pin(id, reason)` ラッパ（`message.pinnable`〔権限 + system/voice/viewable〕チェック）
- `tests/unit/llm/tools/discord/*.test.ts` — intent upper bound、allowlist カテゴリ（read on / member-lookup・management off）、dispatch 時 isEnabled、pin の `READ_MESSAGE_HISTORY`/`PIN_MESSAGES` 欠落 → 403 ヒント（`ManageMessages` のみでは不可、`PinMessages` だけで `ReadMessageHistory` 欠でも不可）、pin の非権限拒否（system message / 非 viewable / voice）、read の `VIEW_CHANNEL`/`READ_MESSAGE_HISTORY` 欠落、thread の public/private 別権限、非対応チャンネル種別での非提示、content 不在の明示、`member_info` の snowflake 検証 + 404、`explainDiscordError` 分類、スレッド重複ガード、fetch_more_context の境界 + 累積予算上限 + state per-loop

**修正:**

- `src/llm/tools/registry.ts`（基盤）への登録呼び出しを `index.ts`（DI 構成）から行う。`IToolContext` に Discord 依存（client/message 参照、appFlags キャッシュ、history reader、**当該応答の `sessionId`**〔conversation-context が解決済み〕、**fresh 解決した invoking member**〔ctx 構築時＝per-response に `guild.members.fetch({user, force:true, cache:false})` で 1 回解決し、**sync な per-caller ゲート（`isEnabled`）と read/management の権限チェックの双方が再利用**＝handler ごとの再 fetch を避けつつ stale な `message.member` を authz に使わない。response 内の数秒で role 変化は問題にしない〕、**loop スコープ state（`fetchMoreContextState` / `memberLookupState`）**）を載せる経路を追加（state は per-runToolLoop に構築。global/static にしない）
- `src/db/repositories/guildSettings.ts` / `src/services/settingsService.ts` / `src/types/index.ts` — guild 設定に**有効 action allowlist**（`enabled_tool_actions` 等の JSON カラム or 個別フラグ）を追加。`GuildSettings` に型追加
- `src/bot/commands/config.ts` / `handlers.ts` — `/disqord config` に tool action の有効/無効を切り替える UI（カテゴリ単位: read 既定 on、member-lookup・management 既定 off）。**member-lookup には任意の per-caller ゲート設定**（許可ロール / `ManageGuild` / 許可チャンネル。既定は「opt-in 後は全 user 可」）も持たせる。README コマンド一覧は AUTO セクションで自動反映
- `src/bot/client.ts` / `src/index.ts` — `app.flags` を起動時に一度取得してキャッシュ（後述の取得タイミング。**fetch 失敗時は `{status:"unknown"}`**＝v1 tool は無効化せず content 注記のみ不確定。fail-closed は将来の gateway 依存 action だけに適用）。**GuildMembers intent は v1 の登録 action では不要**（member 系は REST）。gateway intent 配列は現状のままでよい

> 注: gateway intent（`client.ts` の `intents` 配列）に GuildMembers / GuildPresences を**足す必要は v1 では無い**（`search_members`/`member_info` は REST、`fetch_recent_messages` は intent 無しでも構造取得可）。`app.flags` は将来 gateway 依存 action を足したときの upper bound 兼、`GatewayMessageContent` による content 不在注記の情報源。intent を増やす場合は CLAUDE.md の「特権 intent は Developer Portal トグルが要る」点に留意する。

### intent 由来の action enum

```ts
// src/llm/tools/discord/intentActions.ts
import { ApplicationFlags, type ApplicationFlagsBitField } from "discord.js";

export type DiscordToolAction =
  | "fetch_recent_messages"
  | "search_members"
  | "member_info"
  | "fetch_more_context"
  | "create_thread"
  | "pin_message";

// app.flags 由来の「intent 的に成立しうる action」upper bound。
// v1 の登録 action はいずれも privileged gateway intent を機能的に要求しない
//（search/member 単体 fetch は REST、message fetch は intent 無しでも構造取得可、
//  fetch_more_context は履歴ストア読み出し）ため、
// v1 では全 action を返す（upper bound は非拘束）。実効ゲートは allowlist カテゴリ
// （buildTools）+ 実行時権限。将来 gateway 依存 action（presence / メンバー列挙 via gateway 等）を
// 足したときに、ここで対応 flag を見て upper bound から外す（intent 無しでは提示しない）。
export function intentAvailableActions(_flags: AppFlagsState): Set<DiscordToolAction> {
  // v1 は flags を参照せず全 action を返す（known/unknown いずれでも upper bound は同じ）。
  return new Set<DiscordToolAction>([
    "fetch_recent_messages",
    "search_members",
    "member_info",
    "fetch_more_context",
    "create_thread",
    "pin_message",
  ]);
}

// app.flags は known/unknown を明示的に表現する（起動時 fetch 失敗を「無効」と断定しないため）。
export type AppFlagsState =
  | { status: "known"; flags: Readonly<ApplicationFlagsBitField> }
  | { status: "unknown" };

// MessageContent の可視性は tri-state（gating ではなく content 注記用）。
// fetchRecentMessages handler が「本文無し」を説明する文言の選択に使う。
export function messageContentVisibility(s: AppFlagsState): "enabled" | "disabled" | "unknown" {
  if (s.status === "unknown") return "unknown";
  return s.flags.has(ApplicationFlags.GatewayMessageContent) ||
    s.flags.has(ApplicationFlags.GatewayMessageContentLimited)
    ? "enabled"
    : "disabled";
}
```

- **取得元**: `const app = await client.application.fetch(); const flags = app.flags;`。`flags` は `ApplicationFlagsBitField` で `.has(ApplicationFlags.X)` 判定。
- **値（discord-api-types 0.38.x / discord.js 14.26.x 確認済み）**: `GatewayGuildMembers=16384`(`1<<14`) / `GatewayGuildMembersLimited=32768`(`1<<15`)、`GatewayMessageContent=262144`(`1<<18`) / `GatewayMessageContentLimited=524288`(`1<<19`)。**両ビット（無印 / Limited）を OR で評価**する。discord-api-types の定義どおり、**無印は 100 サーバ以上**の bot、**Limited は 100 サーバ未満**の bot（Bot Settings 由来）に立つフラグで、サーバ数でどちらが立つか変わるため両方見る。v1 で実際に参照するのは `messageContentVisibility`（tri-state、content 注記）のみ。
- **取得タイミング / `unknown` 時の扱い（v1 は非ゲート、fail-closed は将来 action のみ）**: 起動時（`ready` 後）に一度 `fetch` して **`AppFlagsState`**（`{status:"known", flags}` / `{status:"unknown"}`）でキャッシュ。intent 有効化はランタイムでまず変わらないため毎リクエスト fetch は不要。**fetch 失敗時は `{status:"unknown"}`**。**v1 は upper bound が非拘束なので `unknown` でも tool は 1 つも無効化されない**（v1 action は flag に依存しない＝これは "fail-closed" ではない）。`unknown` が実効を持つのは `messageContentVisibility` が `"unknown"` を返し、content 不在注記を「不明または無効の可能性」と断定回避する点**のみ**（content が実際に来れば注記は付かない。member-lookup は flag 非依存）。**fail-closed が要るのは将来 gateway 依存 action**で、それらは `status==="unknown"` のとき提示しない（unknown を「有効」と誤認して特権 action を出さないため）。長時間稼働での反映遅延が気になるなら TTL or 再起動で更新（Open Questions）。

### tool 定義と多層防御

各 tool の `isEnabled(ctx)` は次を AND で判定する:

1. `ctx.guildId !== null`（DM 不可）
2. `intentAvailableActions(ctx.appFlags).has(action)`（intent 由来 upper bound。v1 は全 action true。将来 gateway 依存 action 用）
3. `ctx.allowlist.has(action)`（guild 設定カテゴリ。read 既定 on / member-lookup・management 既定 off）
4. （`fetch_more_context` のみ）conversation-context が当該 guild で有効
5. （`create_thread` のみ）`ctx.channel.type === ChannelType.GuildText`（news/forum/media とスレッド内は v1 非対応。理由は Decisions 参照）
6. （`search_members`/`member_info` のみ）member-lookup の **per-caller ゲート**が未設定、または invoking member（ctx に **fresh 解決**した role/permission/`ctx.channelId`）がそれを満たす（許可ロール / `ManageGuild` / 許可チャンネル）。既定（ゲート未設定）は全 user 可。**このゲートは `isEnabled` に入れて基盤の dispatch 再評価（セキュリティ境界）に乗せる**（config だけ持って enforcement 経路に無いと opt-in 後に全 user が呼べてしまう）

> 上記 2-6 は「**そもそも実行しうるか**」のゲートで、`tools` 提示前に効く。具体的な Discord 権限（pin の `PIN_MESSAGES` 等）は handler が実行直前にチェックする別レイヤ（権限は実行時に剥奪されうるため build 時判定に含めない）。
>
> チャンネル種別の前提: 全 tool は **`ctx.channel`**（triggering message が届いた場所）に対してのみ動く。`ctx.channel` は message を配信した以上 **text-based（`messages.fetch`/`pin` を持つ）が構築上保証**されるので、`fetch_recent_messages`/`pin_message` の `ctx.channel.messages.*` 前提は満たされる。voice 系/system message/非 viewable での pin 不能は `message.pinnable`（target fetch 後）が弾く。`create_thread` だけは API shape/`type` 解決がチャンネル種別で割れるため `GuildText` を明示ゲート（上記 5）。**将来、別チャンネルを `channelId` 引数で対象にする action を足す場合は、`messages.*` を持つチャンネル種別の positive allowlist を別途設ける**（current channel 限定の v1 では不要）。

`buildTools(ctx)` はこれを満たす tool だけを `tools` 配列に出す。**基盤は dispatch 時に `isEnabled(ctx)` を再評価**するので、出した後に設定が変わっても無効化が効く（基盤のセキュリティ境界）。さらに handler が実 Discord 権限を確認する（下記）。

```ts
// 例: pin_message（management カテゴリ、allowlist 既定 off）
export const pinMessageTool: IClientTool<{ messageId: string }> = {
  name: "pin_message",
  description: "指定したメッセージをこのチャンネルにピン留めする。PIN_MESSAGES（とメッセージ履歴の閲覧）権限が必要。",
  parameters: {
    type: "object",
    properties: { messageId: { type: "string", description: "ピン留めするメッセージの ID" } },
    required: ["messageId"],
    additionalProperties: false,
  },
  timeoutMs: 8000,
  isEnabled(ctx) {
    return (
      ctx.guildId !== null &&
      intentAvailableActions(ctx.appFlags).has("pin_message") &&
      ctx.allowlist.has("pin_message")
    );
  },
  validate(args) {
    if (typeof args !== "object" || args === null) return { ok: false, error: "object required" };
    const id = (args as { messageId?: unknown }).messageId;
    if (typeof id !== "string" || !/^\d{17,20}$/.test(id))
      return { ok: false, error: "messageId must be a snowflake" };
    return { ok: true, value: { messageId: id } };
  },
  // 基盤契約どおり handler(args, ctx, signal, meta)。meta = { requestId, toolCallId, invocationId }
  async handler(args, ctx, signal, meta) {
    // target を fetch（404 = Unknown Message〔10008〕→「メッセージが見つかりません」、権限と別扱い）し、
    // message.pinnable（権限 + system/voice/viewable）を直接評価。
    const check = await ensurePinnable(ctx, args.messageId);
    if (!check.ok) return { llmResult: check.hint }; // not-found / 非権限不可 / 権限欠落を区別したヒント
    try {
      // pin は自然冪等（既ピンへの再 pin は無害）なので invocationId による突合は不要
      await ctx.channel.messages.pin(args.messageId, "pinned via LLM tool");
      return { llmResult: `メッセージ ${args.messageId} をピン留めしました。`, render: /* 任意 */ };
    } catch (e) {
      // explainDiscordError: 50013/50001→権限ヒント / 10008/10003→not-found / 他→一般エラー
      return { llmResult: explainDiscordError(e, "pin_message") };
    }
  },
};
```

### 403 enrichment（権限 → ヒント）

```ts
// src/llm/tools/discord/permissions.ts
import { PermissionFlagsBits } from "discord.js";

// action → 必要権限と、欠落時に LLM へ返す日本語ヒント。
// 一部 action（create_thread）は引数依存で needs が変わるため関数で返す。
export const ACTION_PERMISSIONS = {
  pin_message: {
    // discord.js 14.26.x Message#pinnable:
    //   if (this.system) return false;
    //   if (!this.guild) return true;  // DM 用（本 tool は guild 限定なので到達しない）
    //   if (!channel || channel.isVoiceBased() || !channel.viewable) return false;
    //   return permissions.has(ReadMessageHistory | PinMessages);  // PinMessages = 1n << 51n
    // → ManageMessages では不可。権限だけでなく system/voice/viewable の前提も pinnable に含む。
    // handler は target を fetch して message.pinnable を直接見るのが最も忠実（権限の再現漏れを避ける）。
    // ここの needs は「権限欠落」を区別したヒント用。非権限の不可（system message 等）は別ヒントへ。
    needs: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.PinMessages,
    ],
    hint: "メッセージのピン留めには bot に「チャンネルを見る」(VIEW_CHANNEL)・「メッセージ履歴を読む」(READ_MESSAGE_HISTORY)・「メッセージのピン留め」(PIN_MESSAGES) 権限が必要です。",
  },
  fetch_recent_messages: {
    needs: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
    hint: "メッセージ取得には bot に「チャンネルを見る」(VIEW_CHANNEL) と「メッセージ履歴を読む」(READ_MESSAGE_HISTORY) 権限が必要です。",
  },
  // 将来: assign_role → ManageRoles + bot 最上位ロールが対象ロールより上
} as const;
// search_members / member_info は Discord 権限を要求しない（REST 検索/単体 fetch）ので ACTION_PERMISSIONS に入れない。
// 提示可否は member-lookup opt-in（isEnabled。既定 off）の話で、403/権限ヒントの経路とは別レイヤ。
// member_info の guild 不在 user は 404（10007）→ explainDiscordError の not-found 経路（権限と混同しない）。

// create_thread は public/private で needs が変わるため引数依存で算出。
// 注: 空スレッド作成（初期メッセージを投稿しない）には CreatePublic/PrivateThreads と ViewChannel で足り、
// SendMessagesInThreads は不要（後者はスレッド「内」への送信権限）。v1 は初期メッセージを投稿しないため含めない。
// 将来スレッド作成後に初期メッセージを投稿する option を足すなら、そのときだけ SendMessagesInThreads を要求する。
export function threadCreateNeeds(isPrivate: boolean): bigint[] {
  return [
    PermissionFlagsBits.ViewChannel,
    isPrivate ? PermissionFlagsBits.CreatePrivateThreads : PermissionFlagsBits.CreatePublicThreads,
  ];
}
```

- **事前チェック（bot + ユーザの両方）**: handler は `channel.permissionsFor(ctx.client.user)` で **bot** の `needs` を確認し、欠落があれば**実行せず** `hint` を返す。さらに read/management は `channel.permissionsFor(invokingMember)` で **invoking member** も `needs` を満たすか確認し、欠落なら「あなたにこの操作の権限がありません（`<権限名>`）」を返す（**ユーザ権限昇格の防止**。member-lookup は対象外＝admin opt-in + per-caller ゲート）。**invokingMember は `guild.members.fetch({ user: ctx.userId, force: true, cache: false })` で fresh 解決**する（`message.member` は role 剥奪後に stale になりうるので authz には使わない。fetch 失敗は deny）。`create_thread` は `type`（public/private）から `threadCreateNeeds()` で needs を決める。**pin は権限に加え `pinnable` の非権限前提も見る**: target message を fetch して `message.pinnable` を直接評価する（system message・voice 系チャンネル・非 viewable を権限欠落と取り違えず、「このメッセージはピン留めできません（system message / 対応していないチャンネル）」と別ヒントにする）。pin の評価順序を明示: **(1)** invoking member の `ViewChannel`+`ReadMessageHistory`+`PinMessages`（昇格防止）→ **(2)** bot の同権限 + target fetch + `message.pinnable`（bot 視点の権限 + system/voice/viewable の非権限前提）→ **(3)** `messages.pin`。`message.pinnable` は **bot 視点の可否**で member 権限を含まないため、(1) を省略しない。
- **事後正規化（エラー分類）**: Discord 例外は `DiscordAPIError` の code で分類し、**全例外を権限ヒントに丸めない**（404/不正 target/transient を権限問題と誤説明させない）:
  - `50013`（Missing Permissions）/ `50001`（Missing Access）→ 権限 `hint` 経路（事前チェックで漏れたチャンネル上書き等の保険）。
  - `10008`（Unknown Message）/ `10003`（Unknown Channel）/ `10007`（Unknown Member）→ 「対象が見つかりません」（権限と混同しない）。
  - それ以外（rate limit・5xx・transient）→ 「Discord API 呼び出しに失敗しました（一時的）」の一般エラー。
  - この分類を `explainDiscordError(e, action)` に集約し、各 handler の `catch` から呼ぶ。
- **ロール付与（将来 action の例）**: `ManageRoles` 権限に加え、**bot の最上位ロールが対象ロールより上**でなければ Discord は 403。階層は `guild.members.me.roles.highest.comparePositionTo(targetRole) > 0` で判定し、足りなければ「bot のロールを対象ロールより上に配置してください」とヒントする。

### action 一覧（read / member-lookup / management）

| action | カテゴリ | 主要 API | 必要権限/intent | allowlist 既定 |
| ------ | ------- | ------- | -------------- | ------------- |
| `fetch_recent_messages` | read | `channel.messages.fetch({limit≤100})`（最新のみ。`before/after/around` は非公開） | `VIEW_CHANNEL` + `READ_MESSAGE_HISTORY`（実行時チェック）。content の可視性は別途 `GatewayMessageContent` に依存（無くても構造は取得可） | on |
| `search_members` | member-lookup | `guild.members.search({query, limit≤1000, cache:false})`（REST `Routes.guildMembersSearch`） | intent/権限不要。consent は member-lookup opt-in（flag に紐付けない）+ 任意 per-caller ゲート | **off** |
| `member_info` | member-lookup | `guild.members.fetch({user: userId, force: true, cache: false})`（REST `GET /guilds/{id}/members/{user.id}`、intent/権限不要） | consent は member-lookup opt-in + 任意 per-caller ゲート。`userId` は `validate` で snowflake（`/^\d{17,20}$/`）必須。guild 不在 user は 404（`10007`）→ not-found 結果 | **off** |
| `fetch_more_context` | read | conversation-context history reader（境界外 exchange） | conversation-context が当該 guild で有効。**加えて bot と invoking member の両方**の `VIEW_CHANNEL`+`READ_MESSAGE_HISTORY`（on `ctx.channel`、`fetch_recent_messages` と同じ read 権限集合）を reader 呼び出し前に**実行時チェック**（剥奪された過去文脈を persisted 経路で曝さない＝ユーザ権限昇格防止。**runtime 境界**にするため purge 待ちにしない）。conversation-context の hydrate 時 REST 再検証/purge は eventually-consistent な**補完**で、この runtime チェックの代替にはしない | on（context 有効時） |
| `create_thread` | 管理 | `channel.threads.create({name, autoArchiveDuration: ThreadAutoArchiveDuration.*, type})`（`GuildText` のみ、初期メッセージ無し） | 共通 `ViewChannel`、public: `CreatePublicThreads`、private: `CreatePrivateThreads`（`type` 依存で実行時チェック）。**`SendMessagesInThreads` は空スレッド作成には不要**（スレッド内送信権限。初期メッセージを投稿する将来 option でのみ要求） | **off** |
| `pin_message` | 管理 | `channel.messages.pin(id, reason)` | `VIEW_CHANNEL` + `READ_MESSAGE_HISTORY` + `PIN_MESSAGES`（`Message#pinnable` と同集合、`MANAGE_MESSAGES` では不可）。加えて非権限の前提（対象が system message でない・チャンネルが viewable・voice 系でない）も `pinnable` に含まれる | **off** |

- **`fetch_recent_messages`**: `parameters` は `limit`（1-100 にクランプ、Discord の fetch 上限）**のみ**。`before/after/around` は schema に出さず、handler も付けない（直近のみに固定。古い文脈は `fetch_more_context`）。要約は新しい順 or 古い順を明記。content 不在時は注記を行に含める: flag が **無効**と分かるときは `（メッセージ本文は取得できません: MessageContent intent 無効）`、起動時 `app.flags` 取得失敗で **flag 不明**のときは `（メッセージ本文が無い場合 MessageContent intent が不明または無効の可能性）`（不明を「無効」と断定しない。bot 宛て/自身のメッセージは intent 無しでも content が来うる）。
- **`search_members`**: member-lookup カテゴリ（既定 off）。v1 の schema/clamp 制約（Open Question ではなく確定）: `query` 必須・**非空かつ最小 2 文字**（username/nickname の前方一致）、`limit` は **schema 上限 25・既定 10**（Discord API の 1000 は使わず大幅に下げる）。返すフィールドは `表示名 (@username, id)` のみ（ステータス/メール等は返さない）。**累積上限**: 1 runToolLoop あたりの累積結果件数・クエリ回数を **`ctx.memberLookupState`**（discord-tool 所有、per-runToolLoop、**member-lookup カテゴリ全体〔`search_members` + `member_info`〕で共有**、`fetchMoreContextState` と同パターン）でクランプし、返した member id を dedupe する（1 応答内で異なる 2 文字プレフィックスを繰り返して大量列挙する迂回を **per-response で throttle** する。`MAX_TOOL_CALLS_PER_TURN` はプライバシー境界にならない）。上限到達後は「メンバー検索の上限に達しました」を返す。**ただし state は per-runToolLoop**（応答ごとにリセット）**なので、別プロンプト/別セッションに分割した cross-response の列挙は止まらない**——これは per-response の throttle であって durable な anti-enumeration quota ではない。許容根拠: member-lookup データはそもそも当該 guild メンバーが Discord UI で閲覧可能であり、admin opt-in（既定 off）が consent 境界。durable な guild/user scoped quota が要るかは Open Questions。
- **`member_info`**: member-lookup カテゴリ（既定 off）。`userId` 必須で `validate` が snowflake（`/^\d{17,20}$/`）を強制（`messageId` と同じ。生 string が REST route に乗るため不正入力を弾く）。要約は安全な部分集合（表示名・id・参加日・ロール名の一部）。単体の `guild.members.fetch({ user: userId, force: true, cache: false })` は intent/権限を要さない（`cache:false` で lookup 結果を member cache に溜めない）。guild に居ない userId は Discord が 404（`10007` Unknown Member）→ 「該当メンバーが見つかりません」を返し、権限エラーと混同しない。**`search_members` と同じ `ctx.memberLookupState` の累積予算を共有**する（exact-ID の `member_info` を繰り返してメンバーデータ〔参加日/ロール〕を大量に enrich/列挙する迂回を **per-response で throttle**。モデルが直近メッセージから多数の user id を抽出して enrich するケースを想定。返した member id を dedupe し、累積件数を per-loop でクランプ。`MAX_TOOL_CALLS_PER_TURN` はプライバシー境界にならない）。上限到達後は「メンバー情報取得の上限に達しました」を返す。**cross-response の列挙が止まらない点・durable quota の要否は `search_members` と同じ**（上記の per-response throttle の注記参照）。
- **`fetch_more_context`**: 引数は `additionalExchanges`(数) か `approxTokens` 程度。conversation-context の境界選択（exchange 単位・新しい順・reply seed）を**現在境界より古い側**へ延長して呼ぶ。返りは history reader が整形した文脈断片。**重複取得防止**のため、既に文脈に含まれる exchange は除外する（reader 側が現境界を知る）。**累積予算**: 1 会話あたりの追加取得 exchange/トークンに上限（上記 Decisions）。各要求は残り予算で clamp し、上限到達後は新たな過去文脈を返さず明示する。

### fetch_more_context と conversation-context の接合

- conversation-context は「session 内の active exchange を新しい順に予算内で採用」する境界ロジックを持つ（同 doc Section 4）。`fetch_more_context` は**その境界の外側（より古い exchange）**を、モデルが明示要求したときだけ追加で hydrate する。
- 接合点: conversation-context は `session_id` を提供し、境界構築を repository/service として持つ。本 tool は ctx 経由でその reader と **`ctx.sessionId`**（当該応答の確定済み session。tool は session を自前で導出しない）を受け取り、`(ctx.sessionId, currentBoundaryOldestTurnId or 既出 exchange 集合, additionalBudget)` を渡して古い側を引く。**独自に SQL を書かない**（境界整合・剥がし・予算は conversation-context の責務）。`additionalBudget` は**本 tool が保持する残り累積予算**（上記 Decisions）で clamp した値を渡す。
- 権限ガード: reader を呼ぶ**前に** **bot と invoking member の両方**の `ViewChannel`+`ReadMessageHistory`（on `ctx.channel`、`fetch_recent_messages` の read 権限集合を再利用）を確認する（read 系のユーザ権限昇格防止。剥奪された過去の閲覧を persisted 経路で曝さない）。**これは runtime 境界**で、bot/member いずれかが権限を失っていれば reader を呼ばない（conversation-context の hydrate 再検証/purge は eventually-consistent な補完であって、この runtime チェックの代替にはしない）。
- session/channel 境界（authz）: **bare `ctx.sessionId` を単独の authz 境界にしない**。ctx には**当該応答で解決済みの current session+channel にスコープ済みの reader**を載せ、tool はそれ越しにしか読めない構造にする（別 session/別 channel を読む API 面を tool に与えない）。raw `sessionId` を渡す経路を取る場合でも、reader 側で **`sessionId` が `ctx.guildId`+`ctx.channelId` に解決すること**を検証し、不一致は reject する（ctx 構築や将来の caller が誤った session を載せても別チャンネル履歴を hydrate しない防御。conversation-context の session 解決契約に依存しつつ二重化）。
- 累積 state の寿命: 既出 exchange 集合・残り予算は `ctx.fetchMoreContextState`（discord-tool 所有、`runToolLoop` 1 実行＝1 応答生成あたり 1 個生成）に保持する。ctx は応答生成ごとに DI 経路（chatService）で構築されるため自然に loop スコープになり、基盤の `IToolContext`（可変スロットを基盤に足さない）契約を壊さない。global/static には持たせない。
- conversation-context **未導入の guild / 未実装期**は `isEnabled=false` で `fetch_more_context` を**そもそも tools 配列に出さない**。基盤（tool-calling-foundation）には「未実装 tool 用のスタブ」は無い（基盤のスタブ／legacy embed フォールバックは描画 updater 側の話）。history reader が ctx 経由で渡らなければ `isEnabled` が false を返すだけで、UX 上のフォールバックが要るなら本 change 側が担う。

## Tasks

- [ ] `src/llm/tools/discord/intentActions.ts`: `intentAvailableActions`（v1 は全 action を返す upper bound）+ `AppFlagsState`（known/unknown）+ `messageContentVisibility`（tri-state、content 注記用）
- [ ] `app.flags` の起動時取得 + `AppFlagsState` キャッシュ（`ready` 後 `client.application.fetch()`、**fetch 失敗時は `{status:"unknown"}`**）、`IToolContext` への受け渡し
- [ ] `src/llm/tools/discord/permissions.ts`: action→必要 `PermissionFlagsBits`（pin=`ViewChannel`+`ReadMessageHistory`+`PinMessages`〔`Message#pinnable` の権限集合〕、read=`ViewChannel`+`ReadMessageHistory`、thread=public/private 別）+ **bot と invoking member の両方**を `channel.permissionsFor()` で事前チェック（read/management。**ユーザ権限昇格の防止**、member は `ctx.userId` を **fresh fetch**〔`guild.members.fetch({user, force:true, cache:false})`〕で解決。`message.member` は stale role を持ちうるので authz に使わない、fetch 失敗は deny）。pin は加えて `message.pinnable` の**非権限前提**（system message でない・viewable・非 voice）を見て別ヒントに分岐。`explainDiscordError(e, action)`（`50013`/`50001`→権限ヒント、`10008`/`10003`/`10007`→not-found、他→一般エラー）で**全例外を権限に丸めない**分類（ロール階層チェックの枠も用意）
- [ ] read tool: `fetchRecentMessages`（bot+member 読み取り権限チェック + `messageContentVisibility` による content 不在の明示）/ `fetchMoreContext`（bot+member 読み取り権限チェック on `ctx.channel` + conversation-context reader 接合〔`ctx.sessionId`〕 + `ctx.fetchMoreContextState` の累積予算 clamp + 既出 exchange 除外）
- [ ] member-lookup tool（allowlist 既定 off + 任意 per-caller ゲート）: `searchMembers`（`guild.members.search({…, cache:false})` + query 最小長 + `ctx.memberLookupState` 累積クランプ + id dedupe）/ `memberInfo`（`userId` snowflake 検証 + `guild.members.fetch({user, force:true, cache:false})` + 404〔`10007`〕→ not-found + **`searchMembers` と共有の `ctx.memberLookupState` 累積クランプ + id dedupe**）。両者の `isEnabled` に per-caller ゲート判定
- [ ] management tool（allowlist 既定 off）: `createThread`（`GuildText` 種別判定 + public/private 権限 + 重複ガード〔**process-level in-flight ガード**: `(guildId,channelId,name,threadType)` キー・create REST settle まで保持・cancel で解放しない + 作成前の直近 active/archived 同名検出。invocationId は帰属メタ〕）/ `pinMessage`（`message.pinnable` チェック・自然冪等）。handler は基盤契約の `(args, ctx, signal, meta)` シグネチャ
- [ ] guild 設定に action allowlist（`enabled_tool_actions`）を追加（`guildSettings` repo / `settingsService` / `GuildSettings` 型 / `/disqord config` UI）。read 既定 on・member-lookup/management 既定 off のカテゴリ解決。**member-lookup の任意 per-caller ゲート**（許可ロール / `ManageGuild` / 許可チャンネル、既定は全 user 可）の設定/解決
- [ ] `index.ts`（DI）で `ToolRegistry` に 6 tool を登録。`isEnabled` = guildId ∧ intent upper bound ∧ allowlist カテゴリ（∧ context 有効）（∧ create_thread はチャンネル種別）（∧ member-lookup は per-caller ゲート〔許可ロール/`ManageGuild`/許可チャンネル、未設定なら全 user 可〕。dispatch 再評価のセキュリティ境界に乗せる）。`ctx.fetchMoreContextState` / `ctx.memberLookupState` を per-runToolLoop に構築
- [ ] テスト: intent upper bound（v1 は全 action true）、allowlist カテゴリ（read on / member-lookup・management off）、dispatch 時 isEnabled=false の拒否、pin の `READ_MESSAGE_HISTORY`/`PIN_MESSAGES` 欠落 → 403（`ManageMessages` のみでは不可、`PinMessages` だけ＋`ReadMessageHistory` 欠でも不可）、pin の **system message / 非 viewable / voice 系での非権限拒否ヒント**、read の `VIEW_CHANNEL`/`READ_MESSAGE_HISTORY` 欠落、thread の public/private 別権限 + 非対応チャンネル種別での非提示、`explainDiscordError` の分類（`50013`→権限 / `10008`→not-found / 他→一般）、**ユーザ権限昇格の防止**（bot は権限有だが invoking member が `READ_MESSAGE_HISTORY`/`PIN_MESSAGES`/thread 権限を欠く → 拒否。**`fetch_more_context` も bot+member 読み取り権限を要求**。**authz member は fresh fetch で解決**＝`message.member` の stale role に依存しない・fetch 失敗で deny）、**member-lookup の per-caller ゲート**（許可ロール/`ManageGuild`/許可チャンネルを欠く caller は dispatch 時に拒否、未設定なら全 user 可）、content 不在明示（`messageContentVisibility` が enabled/disabled/unknown で文言が変わる）、search の REST 経路（intent 無しでも動く）+ query 最小長/`limit` クランプ（≤25）+ **`memberLookupState` の累積上限**（異なるプレフィックスで繰り返し呼んでも列挙できない・id dedupe。**`search_members` と `member_info` で同一 state を共有**＝exact-ID の member_info 連打でも累積上限・dedupe が効く）、`member_info` の snowflake 検証拒否 + 404、スレッド重複ガード、fetch_more_context の境界外取得 + 重複除外 + **累積予算上限到達時の打ち切り** + state（`fetchMoreContextState`/`memberLookupState`）が per-runToolLoop（global 共有しない）+ `ctx.sessionId` 利用（session を自前導出しない）、DM(guildId=null) で全 off
- [ ] README コマンド一覧（AUTO セクション）反映確認
- [ ] `docs/changes/discord-tool/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **`app.flags` の鮮度 / `unknown` 時の扱い**: 起動時キャッシュのため、稼働中に Developer Portal で intent をトグルしても反映されない。TTL 再取得 or 再起動運用のどちらにするか（運用判断。intent 変更は稀）。**fetch 失敗時は `{status:"unknown"}`**（flag を不明として扱う）。**v1 は upper bound が非拘束なので `unknown` でも tool は無効化されない**（v1 action は flag 非依存）ため、これは厳密には fail-closed ではない。`unknown` の実効は content 不在注記を「不明または無効の可能性」と断定回避する点のみ（content が実際に来れば注記は付かない）。**fail-closed が意味を持つのは将来の gateway 依存 action**で、それらは `status==="unknown"` のとき提示しない。member-lookup は flag に依存しない（opt-in allowlist が consent）ので、flag 取得失敗や intent トグルの反映遅延の影響を受けない。
- **member-lookup のプライバシー（consent・件数上限は決定済み）**: REST 検索/単体 fetch は intent 不要で動く。**専用 member-lookup カテゴリ（既定 off、明示 opt-in、intent flag に非連動）**で consent を取り、`query` 非空 + 最小 2 文字 / `limit` schema 上限 25・既定 10 / 返却フィールドは表示名・@username・id のみ、を v1 で確定（Decisions・action 一覧）。`memberLookupState`（`search_members`+`member_info` 共有）は **per-response の throttle**で、`MAX_TOOL_CALLS_PER_TURN` をプライバシー境界にしない。残る検討: (a) **cross-response の列挙** — state は per-runToolLoop なので別プロンプトに分割した列挙は止まらない。v1 はこれを許容する（member データは guild メンバーが Discord UI で閲覧可能・admin opt-in が consent 境界）が、durable な guild/user scoped quota or audit を入れるかは要検討。(b) opt-in 済み guild でも特定ロール/メンバーを redact するか（high-privacy guild 向けの追加フィルタ。特に `member_info` の role 名/参加日）。(c) **per-caller 認可**: v1 既定は「admin opt-in 後は全 invoking user が member-lookup 可」。member list 制限 guild / 非共有チャンネルのメンバーでは caller が自前では見られないデータを bot 経由で得る残余があるため、**許可ロール / `ManageGuild` / 許可チャンネル**による per-caller ゲートを設定可能にする（既定は全 user 可、絞りたい guild のみ設定）。ハードな per-caller ゲートを v1 必須にするかは要検討。
- **content 不在の扱い**: `GatewayMessageContent` 無効時に `fetch_recent_messages` が本文空で返る。tool を提示し続け content 欠落を明示する案（本設計）と、MessageContent 無効なら提示しない案のトレードオフ（本設計は前者。bot 宛て以外の本文が見えないのは privacy 的にむしろ望ましい場面もある）。
- **`create_thread` の重複ガード強度**: `invocationId` は dispatch ごとにユニークで cross-request dedup キーにならない（Decisions 参照）。timeout 後の逐次再要求は直近同名スレッド検出（ベストエフォート）+ 同時並行は in-flight ガードで抑えるが、これで十分か、永続 idempotency key（DB）を持たせるかは要検討。pin は自然冪等なので対象外。
- **大量メンバー guild での `member_info`**: `guild.members.fetch(userId)` の単体取得は安全だが、cache miss 時の API コスト。limit と件数上限で抑える。
- **`fetch_more_context` の state 検証**: loop スコープの `ctx.fetchMoreContextState`（既出 exchange 集合・残り予算）は `runToolLoop` ごとに生成し ctx 経由で共有する決定済み（Decisions）。残る確認は、ctx を構築する DI 経路（chatService）で per-response に確実に new され global 共有されないことを test で固定する点。

## 参照

- [discord.js ApplicationFlags](https://discord.js.org/docs/packages/discord.js/14.26.4/ApplicationFlags%3AEnum) — `GatewayGuildMembers`(16384)/`GatewayGuildMembersLimited`(32768)/`GatewayMessageContent`(262144)/`GatewayMessageContentLimited`(524288)。`client.application.fetch()` → `app.flags`
- [discord.js GuildMemberManager](https://discord.js.org/docs/packages/discord.js/14.26.4/GuildMemberManager%3AClass) — `search({query, limit})`（REST `GET /guilds/{id}/members/search`、limit 1-1000、intent 不要）と `fetch({query})`（gateway request-guild-members、GuildMembers intent 必須）の区別
- [discord.js GuildTextThreadManager](https://discord.js.org/docs/packages/discord.js/14.26.4/GuildTextThreadManager%3AClass) — `create({name, autoArchiveDuration: ThreadAutoArchiveDuration.*, type: ChannelType.PrivateThread})`
- [discord.js MessageManager](https://discord.js.org/docs/packages/discord.js/14.26.4/MessageManager%3AClass) — `pin(message, reason?)`（`Routes.channelMessagesPin` = PUT `/channels/{channel.id}/messages/pins/{message.id}`。旧 `Routes.channelPin` = `/channels/{id}/pins/{message.id}` は `@deprecated`）/ `unpin`。`Message#pinnable`（guild メッセージ）= `system===false && channel.viewable && !channel.isVoiceBased() && permissions.has(ReadMessageHistory \| PinMessages)`（DM は `!this.guild` で常に true。本 tool は guild 限定）
- [discord.js PermissionsBitField](https://discord.js.org/docs/packages/discord.js/14.26.4/PermissionsBitField%3AClass) — `channel.permissionsFor(client.user)`, `PermissionFlagsBits.PinMessages`/`ReadMessageHistory`/`ViewChannel` 等。403 は `DiscordAPIError` code 50013
