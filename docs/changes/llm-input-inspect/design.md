---
title: "LLM 入力の表示（コンテキストメニュー）"
status: in-progress
priority: medium
summary: "bot の返答を右クリックして「アプリ → LLM 入力を見る」を選ぶと、その返答を生成したときに OpenRouter へ送った入力と生成のメタデータを、実行した本人にだけ見える返信で返す"
---

# LLM 入力の表示（コンテキストメニュー）

## Why

bot の返答が期待と違ったとき、モデルに何が渡っていたか（システムプロンプト、会話履歴として入ったメッセージ、tool の結果）を確認する手段が今は無い。
返答を右クリックするだけで、その返答を生成したときの入力を確認できるようにする。

## 依存 / 関連 change

- 連携: [メッセージの解説（コンテキストメニュー）](../message-explain/design.md) — 同じ message command の種類を使う。`interactionCreate.ts` の message command 分岐と、`generate-readme.ts` が chat input 以外をコマンド表から除く変更は、先に実装する側が入れ、後の側はそれを使う。
- 関連: [OAuth BYOK](../oauth-byok/design.md) — 利用者のキーで生成した返答の入力を読めるかは、その利用者の OpenRouter 側の設定とキーに依存する。扱いは Open Questions / Risks の「BYOK で生成した返答」に書いた。

## Goals / Non-Goals

**Goals:**

- bot の返答メッセージの右クリックメニューに「LLM 入力を見る」を追加する。対象は `messageCreate.ts` が返す返答（メンションへの返答と、自動応答チャンネルでの返答）である。
- 返答を生成した各 generation について、OpenRouter が保存した入力と出力、モデル、プロバイダ、token 数、コストを返す。
- tool loop の複数 turn、Web 検索失敗後の再生成、ツイート画像の再試行など、1 件の返答が複数の generation から成る場合も、すべてを生成順に返す。
- 停止された返答とエラーで終わった返答も、それまでに始まった generation を返す。エラーで終わった返答では、エラー表示のメッセージを右クリックしても引ける。

**Non-Goals:**

- 入力本文を bot の DB に保存すること。保存は OpenRouter の入出力ログに任せ、bot は generation ID だけを持つ。理由は Decisions の「入力の取得元」に書いた。
- 定期実行の投稿、メッセージの解説（ephemeral 返信）など、`messageCreate.ts` を通らない生成。返答の記録（`reply_records`）に載らないため、右クリックされたメッセージから generation を引けない。
- 自動応答チャンネルで返答するかを決めた判定の入力。判定は `/responses` ではなく Decisions API（`decideNoul`）で行い、generation の入出力ログに載らない。判定の結果とモデルは `Reply gate` のログ行に残り、管理 API のログで確認できる。
- 各 generation がどの種類の turn か（tool の続き、Web 検索なしの再生成、ツイート画像を除いた再試行、コンテキスト超過後の tool なしの回答）の表示。この区別は chat service と tool loop の中でしか分からず、OpenRouter のメタデータにも無いので、表示するには種類を別に記録する必要がある。生成順と各 generation の入力を見れば区別できるので、記録は足さない。
- Discord 側の材料（会話の窓にどのメッセージが入ったか、添付の元 URL）の表示。OpenRouter に渡した形で足りると判断した。

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 入力の取得元 | OpenRouter の `GET /api/v1/generation/content?id=` と `GET /api/v1/generation?id=` | 前者は保存された入力と出力を、後者はモデル、token 数、コストを返す。bot の DB に入力本文を持たないので、画像や PDF を含む入力で DB が肥大化せず、保存期間の管理も要らない。OpenRouter の文書では入出力ログの保存期間は 3 か月以上である（Input & Output Logging のページ）。OpenAPI 定義は `/generation/content` の 403 を「management key 専用」と書いているが、2026-10-29 に bot の通常の API キーで両方を呼び、入力と出力が返ることを確認した |
| 入出力ログの前提 | bot のキーで生成した入力が保存されるよう、デプロイ先の OpenRouter アカウントで Input & Output Logging を有効にし、API キーの絞り込みで bot のキーを除外しない。README の運用者向けの節にこの前提を書く | `/generation/content` が入力を返すのは、ログを有効にした後の generation だけである。設定はアカウント側にあり bot から確認できないので、運用者が設定する前提として明記する |
| 返す入力の形 | OpenRouter が保存した形のまま返し、bot が送った形への変換はしない | bot は Responses API（`POST /responses`）の `input` 配列を送るが（`src/llm/openrouter.ts` の `toResponsesInput`）、OpenRouter は Chat Completions の `messages` の形で保存する。2026-10-29 に tool を使った 2 turn の生成で確認したところ、tool の呼び出しは assistant の `tool_calls`、tool の結果は `role: "tool"` のメッセージ、推論の本文は assistant の `reasoning_content` として残り、暗号化された推論は入らなかった。保存された `output` は本文（`completion`）と推論（`reasoning`）の文字列だけで、ある generation が出した tool の呼び出しはその generation の `output` には無く、次の generation の入力に現れる。bot 側で送った形へ戻す変換は、保存されていない情報を補えないので行わない |
| bot が保存するもの | 返答ごとの generation ID の列 | OpenRouter から入力を引くための鍵である |
| generation ID の取り方 | HTTP 応答を受け取った時点で、状態コードの判定と本文の読み取りより前に `X-Generation-Id` 応答ヘッダーから取る。ヘッダーが無いときはストリームの `response.created` イベントの `response.id`、非ストリームでは応答本文の `id` で補い、同じ ID は 1 件にまとめる | ヘッダーは本文より先に届くので、`response.created` を受け取る前の停止や切断でも ID が残る。エラー応答もストリームを読まずに例外になるため（`chat()` と `chatStream()` の `handleErrorResponse()` 呼び出し）、ヘッダーで取らないと再試行前の generation が落ちる。2026-10-29 に、ストリーミングの成功応答（200）と存在しないモデルを指定したエラー応答（400）の両方で `x-generation-id` が付くことを確認した。400 のように受け付ける前に拒否されたリクエストの ID は、両方の endpoint で 404 になる。応答ヘッダー自体を受け取れなかった試行（接続の失敗）は ID が無いので記録の対象外である |
| 返答の記録を作る条件 | 会話履歴の設定に関係なく、`messageCreate.ts` が返答するときは常に `reply_records` を作る | 今は会話履歴が有効なギルドでしか作られず（`src/bot/events/messageCreate.ts:397`）、無効なギルドでは右クリックされたメッセージから返答を特定できない。重複配信の抑止（同じトリガーの記録が既にあれば返答しない）も常に掛かるようになるが、これは履歴設定に依存すべき動作ではない。自動応答の判定で黙ると決まったときは、今と同じく保留中の記録をページの無いまま消す（`deletePendingWithoutPages`）。会話の窓が記録を読むのは履歴が有効なときだけなので（`src/services/conversationWindow.ts:395`）、無効な間の返答の扱いは変わらない。履歴を後から有効にすると、無効な間の返答も記録があるため会話の窓に入りうる |
| 右クリックされたメッセージから返答を引く方法 | まず `findByPage()` でページとして引き、無ければ、bot 自身のメッセージで返信先（`message.reference.messageId`）があるときに限り `findByTrigger()` でトリガーとして引く | エラーで終わった返答では、本文の無いページは削除され（`cleanupBotMessagesOnFatalError`）、エラー表示は記録の確定後に `message.reply()` で別に送られ、ページとして登録されない（`src/bot/events/messageCreate.ts:753-764`）。エラー表示をページとして登録する方法は、`appendPage()` が確定前の記録にしか書けず（`src/db/repositories/replyRecord.ts:112-126`）、記録はエラー表示を送る前に `failed` で確定しているので採らない。返信先のトリガーから引けば、記録の意味を変えずにエラー表示から generation に届く |
| 利用できる人 | 「サーバーの管理」権限か `/config` の管理者ロールを持ち（既存の `canManageGuildSettings()`）、かつ返答のあるチャンネルの履歴を今読める人（既存の `checkConversationAccess()`。`ViewChannel` と `ReadMessageHistory`、非公開スレッドではスレッドへの参加を見る。ボイスチャンネルとステージチャンネルでは、このコマンドの側で `Connect` も確認する） | 入力には、投稿者が後から削除したメッセージや、窓の外から tool で読んだ古いメッセージがそのまま残る。誰でも見られると、削除した発言をこのコマンドで掘り起こせてしまう。管理者に限れば、bot の挙動を調べる用途は満たせる。設定の管理権限は履歴の閲覧権限を含まないので（`src/services/settingsAuthorization.ts:14` は `ManageGuild` とロールしか見ない）、`ReadMessageHistory` を持たない管理者が入力経由で古いメッセージを読めないよう、履歴の認可も別に掛ける。Discord はボイスチャンネルのメッセージ取得に `Connect` も要求するが、`checkConversationAccess()` はこれを見ないので（`src/services/messageAuthorization.ts:31`）、その分をコマンド側で足す。共有関数のほうを直すと会話履歴の認可も変わるため、それは Open Questions / Risks の「ボイスチャンネルの履歴認可」に残す |
| `default_member_permissions` | `ManageGuild` を設定し、加えて実行時にも上の判定を行う | 前者で一般の利用者のメニューに出なくなる。管理者ロールの持ち主には前者だけでは出ないので、サーバー側の連携サービス設定で許可してもらう。前者はサーバー管理者が上書きできるため、実行時の判定を省けない |
| 返信の公開範囲 | ephemeral | 入力の中身をチャンネルに出さない |
| 表示形式 | Components V2 の TextDisplay に generation ごとの要約を 1 行ずつ出し、全体は JSON ファイルを添付して、添付ごとに File コンポーネント（`attachment://<ファイル名>`）を置く。`followUp()` で続けて送る添付も同じ | 入力は会話履歴を含むと数十 KB になり、メッセージには収まらない。JSON ならそのまま検索や差分比較に使える。Components V2 のメッセージでは、コンポーネントから参照されない添付は表示されない。`reasoning.md` の添付も同じ形で File コンポーネントを置いている（`src/utils/chatContainerBuilder.ts:555`） |
| JSON に入れる内容 | generation ごとに `/generation/content` の `input` と `output` と `error`、`/generation` のメタデータ、取得に失敗した endpoint とその理由 | turn が進むと後の入力は前の入力を含むので重複するが、各 generation で OpenRouter が保存した内容をそのまま示すことを優先する。重複を除く加工をすると、保存された内容との照合ができなくなる |
| 画像と PDF のデータ | bot の側では置き換えない | OpenRouter は画像と PDF のデータを `[OR_REDACTED]` に置き換えて保存する。2026-10-29 に、user メッセージの画像（data URL）、PDF（`file_data`）、tool の結果に入れた画像のいずれも、`/generation/content` が `[OR_REDACTED]` で返すことを確認した |
| 大きすぎるときの扱い | JSON 全体が interaction の `attachment_size_limit` を超えたら generation ごとのファイルに分け、1 件でも上限を超える generation はファイルを付けずに、要約にそのサイズと省略した旨を書く。添付が 10 件を超える分は `followUp()` の ephemeral メッセージで続けて送る。要約は 4000 文字に収まらない分を「他 N 件は JSON を参照」にまとめる | 上限を超えたものを切り詰めると、どこが欠けたか分からない JSON になり、保存された内容との照合という目的に反する。Discord の 1 メッセージの添付は 10 件までで、TextDisplay の合計は 4000 文字までである |
| 取得の失敗と締め切り | generation ごとに 2 つの endpoint を並行して呼び、generation は生成順に 1 件ずつ処理する。endpoint ごとに成否を記録し、片方が失敗しても成功した側は返す。失敗した generation があっても次の generation へ進む。全体の締め切りは defer から 60 秒とし、締め切りまでに取得できなかった generation は「時間切れ」として要約と JSON に書く | `/generation/content` の 404 は入力が保存されていないか、まだ反映されていないことを表す。`/generation` の 404 は、受け付ける前に拒否されたリクエストか、まだ反映されていないことを表す。401、403、429、5xx、通信失敗は理由をそのまま記録する。途中で停止した generation も保存される（2026-10-29 にストリームを途中で切り、15 秒後に `/generation` が `cancelled: true` を、`/generation/content` が入力と途中までの出力を返すことを確認した）。interaction token は 15 分で失効するが、1 件あたり数秒の取得に 15 分近く待つ理由は無く、60 秒で打ち切れば返答を受け取れないまま待たせる時間が短くなる |
| コマンド名 | `LLM 入力を見る`（ローカライズなし） | bot の UI は日本語だけで提供している |

## Design

### 変更対象ファイル

- 新規: `src/bot/commands/inspectInput.ts` — `ContextMenuCommandBuilder` による定義。
- 新規: `src/bot/events/inspectInputCommand.ts` — 認可、返答の引き当て、OpenRouter からの取得、要約と JSON の組み立て、ephemeral 返信。
- 修正: `src/bot/commands/index.ts` — `commandDefinitions` に加える。
- 修正: `src/bot/events/interactionCreate.ts` — `isMessageContextMenuCommand()` の分岐を、`isChatInputCommand()` の判定より前に置く。
- 修正: `src/llm/openrouter.ts` — 応答ヘッダーの `X-Generation-Id`（無ければ `response.created` か応答本文の `id`）から ID を読み、エラー応答を例外にする前に呼び出し側へ渡す。`/generation` と `/generation/content` を呼ぶメソッドを `ILLMClient` に足す。
- 修正: `src/llm/toolLoop.ts`、`src/services/chatService.ts` — 1 件の返答で始まった generation の ID を、再生成と再試行の分も含めて集め、`generateChatResponse()` の結果で返す。
- 修正: `src/db/schema.ts`、`src/db/repositories/replyRecord.ts`、`src/services/replyRecordService.ts` — generation ID の表と、その追加と一覧の操作。
- 修正: `src/bot/events/messageCreate.ts` — 履歴設定に関係なく返答の記録を作り、返答の確定時（完了、停止、エラーのいずれも）に generation ID を保存する。
- 修正: `scripts/generate-readme.ts` — chat input 以外をコマンド表から除く（message-explain が先に入れていれば不要）。
- 修正: `src/bot/commands/handlers.ts` — `/help` の手書きのコマンド一覧に 1 行足す。
- 修正: `README.md` — コマンド一覧の AUTO ブロックの外に 1 行足し、入出力ログを有効にする前提を書く。

### DBスキーマ変更

```sql
CREATE TABLE IF NOT EXISTS reply_generations (
  trigger_msg_id  TEXT NOT NULL REFERENCES reply_records(trigger_msg_id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,       -- 生成を始めた順
  generation_id   TEXT NOT NULL,          -- OpenRouter の gen-...
  PRIMARY KEY (trigger_msg_id, seq)
);
```

`reply_records` の削除（ギルド退出、チャンネル削除）に連動して消える。
既存の DB には `CREATE TABLE IF NOT EXISTS` で追加され、既存の返答には generation ID が無いので「記録がありません」と返す。

### 実装内容

1. interaction を受けたら 3 秒以内に `deferReply({ flags: Ephemeral })` を返す。
2. DM などギルドの外での実行、管理者でない実行者、返答のあるチャンネルの履歴を読めない実行者は、理由を返して終える。
3. Decisions の「右クリックされたメッセージから返答を引く方法」で返答の記録を引く。記録が無いか、記録に generation ID が無ければ「この bot の返答ではないか、記録がありません」を返す。
4. Decisions の「取得の失敗と締め切り」に従って各 generation を取得する。`/generation/content` が全件 404 のときは、OpenRouter 側の反映が遅れているか、入出力ログが無効な場合があるので、「少し待ってから再実行し、それでも無ければ OpenRouter の入出力ログの設定を確かめてください」を添える。
5. JSON を `llm-input-<トリガーの message ID>.json`（分けるときは `llm-input-<トリガーの message ID>-<seq>.json`）として添付し、要約と合わせて `editReply()` で返す。

### 設計メモ

generation ID の収集は、tool loop の結果ではなく chat service の 1 回の呼び出しの単位で行う。
Web 検索の失敗後の再生成とツイート画像の再試行は、tool loop を最初からやり直すので、loop の結果だけを見ると先に失敗した loop の generation が落ちるためである。

## Tasks

- [ ] message command の分岐とコマンド表からの除外（message-explain が未実装なら）
- [ ] 応答ヘッダーからの generation ID の取得と、chat service での収集
- [ ] `reply_generations` 表と repository、service の操作
- [ ] 返答の記録を履歴設定に関係なく作る変更と、確定時の ID 保存
- [ ] `/generation` と `/generation/content` の client メソッド
- [ ] コマンドの実装（認可、返答の引き当て、取得、サイズ超過時の分割、要約、添付）
- [ ] unit テスト（ID の収集、エラー表示からの引き当て、管理権限と履歴の認可、endpoint ごとの失敗、締め切り、サイズ超過時の分割）
- [ ] `/help` と README の追記（コマンドの 1 行と、入出力ログを有効にする前提）
- [ ] 手動確認: 開発用サーバーで tool を使った返答を右クリックし、全 turn の入力が JSON に入っていることを確認する
- [ ] `docs/changes/llm-input-inspect/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **入出力ログが無効なときの応答（未確認）**: 入出力ログを有効にしていないアカウントの generation で、`/generation/content` が 404 を返すか、空の入力を返すかは確認していない。開発用のアカウントは有効なので、無効な場合の表示は 404 の扱いで足りると見込んでいるが、本番のキーのアカウントで有効かも未確認である。実装後の手動確認で、本番の返答を右クリックして確認する。
- **BYOK で生成した返答**: oauth-byok が実装されると、利用者のキーで生成した返答の入力は、その利用者の OpenRouter アカウントの入出力ログ設定に従って保存される（推測）。bot のキーでは他アカウントの generation を読めない可能性が高く、その場合はこのコマンドで見られない。未確認であり、oauth-byok の実装時に確認する。
- **ボイスチャンネルの履歴認可**: `checkConversationAccess()` はボイスチャンネルとステージチャンネルで `Connect` を確認しないので、会話履歴と `read_earlier_messages` の認可にも同じ不足がある。このコマンドとは独立した既存の問題であり、直すかどうかは別に決める。
- **e2e テスト**: bot は message command を実行できないので、e2e のシナリオにはできない。ID の収集と保存は unit テストで、コマンドの表示は手動確認で見る。
