---
title: "設定パネル（/config の再構成）"
status: planned
priority: high
summary: "/config をサブコマンドの列から 1 つのコマンドにし、カテゴリ別の設定パネルと modal で設定を変える。チャンネル制限と管理ロールもここで設定できるようにする"
---

# 設定パネル（/config の再構成）

## Why

Discord のコマンド選択画面は、サブコマンドとサブコマンドグループの末端をすべて別の項目として並べる（Discord のドキュメント「Currently, subcommands and subcommand groups all appear at the top level in the command explorer」）。
現在の `/config` だけで 9 項目あり、backlog の design がそれぞれサブコマンドを足すと 20 を超えて、`/` を打ったときの一覧が `/config` で埋まる。
設定ごとの説明と現在の値も、サブコマンドの一覧からは読めない。

本 change は `/config` をサブコマンドを持たない 1 つのコマンドにし、実行するとカテゴリ別の設定パネルを返すようにする。
パネルの上では、on/off をボタン、チャンネルやロールを選択メニュー、自由入力を modal で変える。
あわせて、チャンネル制限（許可チャンネル）と管理ロールを、このパネルから設定できる機能として加える。

## 依存 / 関連 change

- 先行: [権限管理](../permissions/design.md) — 共通認可関数 `canManageGuildSettings` を同 change が定める。本 change のすべての書き込みはこの関数で判定する
- 連携: [設定階層化 + LLMパラメータ + カスタムプロンプト](../settings-hierarchy/design.md) — プロンプトと LLM パラメータの編集は本 change のパネルと modal の形に載せる（「スコープ付き設定のページ」）
- 連携: [画像生成](../image-generation/design.md) / [コード実行](../code-execution/design.md) / [Discord 操作ツール](../discord-tool/design.md) / [リリース通知](../release-announcement/design.md) — 各 change の設定は、サブコマンドではなく本 change のパネルの項目として足す
- 関連: [メッセージの解説](../message-explain/design.md) — 許可チャンネルの外では解説を断る

## Goals / Non-Goals

**Goals:**

- `/config` をサブコマンドの無い 1 つのコマンドにし、コマンド選択画面の `/config` を 1 項目にする
- ギルド設定をカテゴリ別のパネルで表示し、説明と現在の値を並べて見せる
- 自由入力の設定を modal で編集し、同時編集と入力の誤りで入力を失わない
- `/status` を状態の表示に専念させ、設定の変更はパネルに集める
- Bot が応答するチャンネルを制限できるようにする（許可チャンネル）
- ギルド設定の変更を、`ManageGuild` を持たないロールに委譲できるようにする（管理ロール）

**Non-Goals:**

- `/model` の再構成。`/model set` は数百件のモデルから autocomplete で選ぶ必要があり、選択メニュー（最大 25 件）に収まらない
- `/cron`、`/connect`、`/disconnect`、`/stats`、`/release-note` の構成。それぞれの design のまま独立したコマンドにする
- 旧 `/config <sub>` との並存。サブコマンドを持つコマンドは単体では実行できず、同名で両方の形を持てないので、一度に置き換える

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| コマンドの形 | `/config` をサブコマンドもオプションも持たない 1 つのコマンドにする | 選択画面の項目が 1 つになる。on/off だけを `/config toggle setting:<choice> enabled:on\|off` に集める案は、チャンネル一覧、管理ロール、通知先、パラメータのサブコマンドが残り、項目が 14 前後から減らないので採らない。設定を 1 つの modal にまとめる案は、設定ごとに認可、確認、保存の単位が違い、1 回の送信に収まらないので採らない |
| パネルの公開範囲 | ギルド設定のパネルはチャンネルに公開する。ユーザー単位の設定と、拒否、確認、入力エラーは押した本人にだけ見える（ephemeral）返信にする | 公開のメッセージはクライアントの再読み込みで消えず、誰がいつ何を変えたかをチャンネルの全員が見られる。ギルド設定は全員の応答に効くので、見えてよい。ユーザー単位の設定は本人以外に見せる理由が無い |
| コマンドの既定権限 | `default_member_permissions` を付けない | 付けると `ManageGuild` を持たない管理ロールの持ち主と、ユーザー単位の設定を変える一般メンバーの一覧からも消える。管理ロールは Bot の DB にあり、Discord のコマンド権限とは連動しない |
| 認可の単位 | 書き込みのたびに、その時点のメンバー情報で判定する。ギルド設定は `canManageGuildSettings`、管理ロールそのものの変更は `ManageGuild` のみ、ユーザー単位の設定は本人のみ | パネルは開いた後も長く残るので、開いた時点の判定を使い回すと、権限を外された人が古いパネルから書き込める。判定するのはボタン、選択メニュー、modal の送信、確認の押下のすべてである |
| ページの分け方 | カテゴリ別のページにし、ページは先頭の String Select で切り替える | 1 メッセージの部品は 40 個まで（レイアウトの部品を含む）で、設定 1 つを「Section + TextDisplay + Button」で描くと 3 個使う。全設定を 1 枚に並べると上限に近づき、backlog の設定が加わると超える |
| on/off の操作 | ボタンの `customId` に設定する値を入れる（`/status` の `status_set:<key>:on\|off` と同じ形） | 連打や、同じパネルを別の人が押した場合に、反転ではなく指定した値に揃う |
| チャンネル一覧の編集 | 現在の一覧の表示、「追加」（Channel Select で選んだものを足す）、「削除」（String Select で一覧から選んで外す）の差分操作にする | 1 つの Channel Select に現在の一覧を初期値として入れて置き換える方式は、選択の上限 25 件を超える一覧を扱えず、同時に編集した別の人の追加を消す。現在の自動応答チャンネルに件数の上限は無い |
| 自由入力 | modal で編集する。modal を開いた時点の設定の版を `customId` に入れ、送信時に同じトランザクションで版を比べて、違えば保存しない | modal の送信は開いてから数分後になりうる。`customId` は 100 文字までなので、開いた時点の値そのものは入らず、版の番号を入れる |
| 入力の復旧 | 検証エラーと版の衝突のときは、送信内容を下書きとして保持し、本人にだけ見える返信に「入力を修正する」ボタンを付ける。押すと下書きを入れた modal を開き直す | modal の送信への応答では、別の modal を開けない（modal を開けるのは、アプリケーションコマンド（コンテキストメニューを含む）、ボタン、選択メニューへの最初の応答だけである）。下書きを持たないと、長い入力を最初から打ち直させることになる |
| 確認が要る設定 | 有効化の前に確認文を読ませる設定（コード実行）は、ボタン → 本人にだけ見える確認文と「有効にする」ボタン → 反映の 2 段にする。確認ボタンの `customId` に対象の設定と値を入れる | 1 回の押下で切り替わると確認文を挟めない。確認ボタンに対象を固定すると、別の操作の確認として使い回せない |
| `/status` との役割分担 | `/status` は稼働状態、残高、設定の要約の表示に専念し、「設定を開く」ボタンを付ける。モデル一覧のキャッシュを更新するボタン（`status_model_refresh`）は設定の変更ではないので `/status` に残す。ボタンは `/config` と同じパネルを返す | 設定を変える入口が 2 つあると、認可と表示を 2 か所で保つことになる。パネルの再描画は DB の設定だけで行い、OpenRouter の残高を取りに行かない（取りに行くと、外部 API の遅延と失敗が設定の操作に混ざる） |
| 既に投稿された `/status` のボタン | 旧形式（`status_set:*`、`status_toggle_*`）が押されたら、設定を変えずに「`/config` を使う」旨を本人にだけ返す | 過去の `/status` のメッセージはチャンネルに残り、ボタンも押せる。旧ボタンでの書き込みを残すと、パネルと別の入口を保ち続けることになる |
| チャンネル制限の既定 | 全チャンネル許可 | 既存の動作を保ち、制限は明示的に設定したときだけ効かせる |
| 自動応答チャンネルと許可チャンネル | 許可チャンネルが優先する。許可外のチャンネルは自動応答に登録されていても応答しない | 許可チャンネルは Bot を閉じ込めるための設定であり、自動応答がそれを越えられると、制限に抜け道ができる |

## Design

### 変更対象ファイル

- 修正: `src/bot/commands/config.ts` — サブコマンドを削り、単体の `/config` にする
- 修正: `src/bot/commands/handlers.ts` — `/config` はパネルを返す。`/config` のサブコマンドの handler と autocomplete を削る
- 新規: `src/utils/configPanel.ts` — ページごとのパネルの組み立てと `customId` の生成と解釈
- 新規: `src/bot/events/configPanelHandler.ts` — パネルのボタン、選択メニュー、modal の送信の処理
- 修正: `src/bot/events/interactionCreate.ts` — 選択メニューと modal の送信を上の handler へ振り分ける（現在はスラッシュコマンド、autocomplete、ボタンだけを扱う）。旧 `/status` ボタンを案内に置き換える
- 修正: `src/utils/statusMessage.ts` — 切り替えボタンを外し、設定の要約と「設定を開く」ボタンにする
- 修正: `src/db/schema.ts` / `src/db/repositories/guildSettings.ts` / `src/types/index.ts` / `src/services/settingsService.ts` — `allowed_channels`、`settings_version`、`updated_by` の列と、その読み書き
- 修正: `src/bot/events/messageCreate.ts` — 許可チャンネルの確認を応答判定に加える
- 修正: `src/bot/commands/help.ts`、`scripts/generate-readme.ts` の出力（README のコマンド一覧）— `/config` の説明をパネルに合わせる

### DB スキーマ変更

```sql
ALTER TABLE guild_settings ADD COLUMN allowed_channels TEXT;          -- JSON array。NULL = 全チャンネル許可
ALTER TABLE guild_settings ADD COLUMN settings_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guild_settings ADD COLUMN updated_by TEXT;                -- 最後に変更したユーザー ID
```

パネルの「最終変更」は `updated_by` と既存の `updated_at` から表示する。

`admin_role_id` の列は [権限管理](../permissions/design.md) が加える。
`settings_version` は `guild_settings` の行を書き換えるたびに 1 増やす。
版は行全体で 1 つとし、設定ごとには持たない。
別の設定が変わっただけでも modal の送信が衝突として扱われるが、その場合は下書きを保ったまま開き直せば済み、設定ごとに版の列を持つより単純である。
modal が比べるのは、編集する値を持つ行の版である。[設定階層化](../settings-hierarchy/design.md) が加える `channel_settings` と `user_settings` も、同じ意味の `version` 列を行ごとに持つ。

### ページ

| ページ | 項目 | 部品 |
| ------ | ---- | ---- |
| 応答 | 無料モデル限定、LLM 詳細表示、推論表示、ツイート展開 | 各項目に Section（名前、説明、現在の値）と on/off のボタン |
| 機能 | Web 検索、会話履歴、画像生成、Discord 操作、コード実行 | 同上。コード実行は確認の 2 段 |
| チャンネル | 自動応答チャンネル、許可チャンネル | 一覧の表示、追加の Channel Select、削除の String Select |
| 管理 | 管理ロール、リリース通知先 | Role Select（1 件）、Channel Select（1 件）、それぞれに「解除」ボタン |
| プロンプトとパラメータ | [設定階層化](../settings-hierarchy/design.md) の guild と channel のスコープ | 「スコープ付き設定のページ」 |

- 未実装の change の項目は、その change が実装されたときにページへ足す。
- ページの先頭に String Select でページの切り替えを置き、その下に「最終変更: <ユーザー>（<時刻>）」を出す。
- 空にしたときの意味は項目ごとに文言で示す。自動応答チャンネルは「自動応答なし」、許可チャンネルは「全チャンネルで応答」、管理ロールは「`ManageGuild` の持ち主だけが変更できる」、リリース通知先は「通知しない」である。
- 押されるたびに DB から設定を読み直して、同じメッセージを `update()` で描き直す。

### customId

- 形は `cfg:<page>:<action>[:<args>]` とし、100 文字以内に収める（ID は Discord の snowflake で 20 桁以内）。
- on/off は `cfg:<page>:set:<key>:on|off`、ページの切り替えは `cfg:page`、modal は `cfg:modal:<item>:<scope>[:<channelId>]:<version>` とする。
- 確認は `cfg:confirm:<key>:<value>` とする。

### スコープ付き設定のページ

[設定階層化](../settings-hierarchy/design.md) のプロンプトと LLM パラメータは、次の形で編集する。

- 公開のパネルでは guild と channel のスコープを扱う。対象のスコープを String Select で選び、channel のときは Channel Select で対象のチャンネルを選ぶ。
- 各項目に、そのスコープの保存値、実際に効いている値、その値がどのスコープ由来かを表示する。
- 操作は「編集」（modal）と「上書きを削除」（そのスコープの値を消して上位を継承させる）の 2 つである。
- guild と channel への書き込みは `canManageGuildSettings` で判定する。
- user スコープは、パネルの「自分の設定」ボタンから本人にだけ見えるパネルで扱い、本人だけが書き換えられる。
- modal の `customId` には、開いた時点のスコープと対象チャンネルを入れる。modal を開いた後にパネルのページやスコープの選択が変わっても、送信先は変わらない。

### modal の下書き

本 change がリリースする時点のページには modal で編集する項目が無い。
この節の仕組み（版の比較と保存を同じトランザクションで行うこと、下書き、「入力を修正する」）は、最初に modal の項目を持つ change（[設定階層化](../settings-hierarchy/design.md)）が、本節の仕様どおりに実装する。

- 下書きは送信ごとに短い ID を採番してメモリへ保持し、15 分で捨てる。下書きには本人、ギルド、項目、スコープ、対象チャンネルを記録し、「入力を修正する」ボタンの `customId`（`cfg:draft:<id>`）にはその ID を入れる。同じ項目で失敗を 2 回続けても、それぞれのボタンがそれぞれの送信内容を開き直す。
- ボタンを押したのが下書きの本人でなければ断る。
- 再起動で下書きは消える。その後に「入力を修正する」が押されたら、下書きが無い旨と、`/config` から開き直す案内を返す。
- 版の衝突のときは、現在の保存値と送信した下書きの両方を本人にだけ見せ、「入力を修正する」で下書きから編集し直せるようにする。

### チャンネル制限

- `allowed_channels`: NULL = 全チャンネル許可、配列 = 指定チャンネルのみ。
- 判定は `messageCreate` の応答判定で、メンションと自動応答の両方より先に行う。許可外のチャンネルでは何も返さない。
- スレッドは、そのスレッド自身か親チャンネルが許可されていれば許可する。自動応答チャンネルの判定（`messageCreate.ts` の `shouldRespond` がチャンネル自身、次に親を見る）と同じ扱いにし、公開スレッドも許可チャンネルとして登録できる。
- 最後の 1 つを外すと NULL（全チャンネル許可）に戻り、その旨を表示する。
- 許可外のチャンネルを自動応答に登録したときは、登録したうえで「許可チャンネル外のため応答しない」と表示する。

### 管理ロール

- `admin_role_id` の意味と認可は [権限管理](../permissions/design.md) が定める。本 change はその設定の入口を「管理」ページに置く。
- 管理ロールの変更と解除は `ManageGuild` を持つメンバーだけができる。委譲されたロールの持ち主が委譲先を付け替えられないようにするためである。
- ロールが削除されると、誰もそのロールを持たなくなるだけで、`ManageGuild` の持ち主は引き続き変更できる。

### Discord の部品について実測したこと

2026-09-25 に、tester bot に一時的なギルドコマンドを登録して確かめた（PC とスマホのクライアント）。

- ephemeral の Components V2 メッセージで、ボタン、複数選択の Channel Select（`default_values` で初期値を表示）、Role Select を押して、`update()` で描き直せた。公開のメッセージ上のボタンは、現在の `/status` で既に動いている。
- modal の Label の中の Text Input、Radio Group、Checkbox Group（10 項目）、Channel Select、Checkbox が PC とスマホで表示でき、送信した値を discord.js 14.27.0 の `getTextInputValue`、`getRadioGroup`、`getCheckboxGroup`、`getSelectedChannels`、`getCheckbox` で読めた。
- Checkbox Group を `min_values: 0` にするときは、部品に `required: false` も付ける必要がある。付けないと API が `COMPONENT_REQUIRED_ZERO_MIN_VALUES` で modal を拒否する。Component Reference の Checkbox Group の構造表にも、`required` が true のとき `min_values` は 1 以上とある。
- `getCheckboxGroup` の値は選択肢の順ではなく、チェックした順で返る。保存するときは集合として扱う。

## Tasks

- [ ] `guild_settings` に `allowed_channels`、`settings_version`、`updated_by` を追加し、書き込みのたびに版を 1 増やして変更者を記録する
- [ ] `/config` を単体コマンドにし、パネルを返す
- [ ] 「応答」「機能」「チャンネル」「管理」のページと、`customId` の生成と解釈
- [ ] ボタンと選択メニューで、書き込みのたびに認可を判定する（管理ロールの変更は `ManageGuild` のみ）
- [ ] チャンネル一覧の追加と削除（26 件以上の一覧のページ送りを含む）
- [ ] コード実行など確認の要る設定の 2 段の操作
- [ ] `messageCreate` に許可チャンネルの判定を加える
- [ ] `/status` を表示に専念させ、「設定を開く」ボタンを付ける。旧形式のボタンは案内を返す
- [ ] handler の単体テスト（認可の失効、確認ボタンの対象の固定、チャンネル一覧の差分操作、旧ボタン）
- [ ] `/help` と README のコマンド一覧を更新する
- [ ] 手動確認: PC とスマホで `/config` の各ページを開き、ボタンと選択メニューで設定を変えて、表示と反映を確かめる
- [ ] 手動確認: 管理ロールの持ち主（`ManageGuild` なし）でギルド設定を変えられ、管理ロールそのものは変えられないことを確かめる
- [ ] `docs/changes/config-panel/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- `/config` を何度も実行すると、公開のパネルがチャンネルに溜まる。古いパネルも押せば DB から描き直すので誤った値は保存しないが、見た目は散らかる。前のパネルを bot が消すかは、実際の使われ方を見て決める。
- スクリーンリーダーで同名のボタン（「on」「off」）を区別できるかは未検証である。ボタンの label に設定名を含めれば避けられる見込みがあり、手動確認で見る。
- e2e はギルド設定を DB の直接更新で切り替えるので、パネルの操作は e2e で確かめられない（bot はボタンを押せない）。handler の単体テストと手動確認で補う。

## 参照

- [Discord: Application Commands](https://docs.discord.com/developers/interactions/application-commands) — サブコマンドが選択画面で別項目になること、オプションと choices の上限、`default_member_permissions`
- [Discord: Component Reference](https://docs.discord.com/developers/components/reference) — 部品の種類と上限（1 メッセージ 40 個、modal 5 個、選択 25 件、Checkbox Group 10 項目）
- [Discord: Receiving and Responding](https://docs.discord.com/developers/interactions/receiving-and-responding) — 3 秒以内の最初の応答、token の 15 分、modal を開ける応答
