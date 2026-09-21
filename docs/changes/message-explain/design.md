---
title: "メッセージの解説（コンテキストメニュー）"
status: planned
priority: medium
summary: "メッセージの右クリックメニュー「アプリ → 解説する」で、そのメッセージの専門用語や背景を本人にだけ見える返信で解説する"
---

# メッセージの解説（コンテキストメニュー）

## Why

会話中に分からない専門用語や前提が出てきたとき、今は bot へメンションして本文を貼り直す必要があり、質問したこと自体もチャンネルに残る。
メッセージの右クリックメニューから一操作で解説を求められ、結果が本人にだけ見えるようにする。

## 依存 / 関連 change

- 連携: [web-search](../web-search/design.md) — 時事的な背景や新しい用語の解説は検索があると正確になる。この change は検索なしで出し、web-search の server tool が chat 経路に載った時点で解説経路にも同じものを渡す。
- 連携: [permissions](../permissions/design.md) — 誰がこのコマンドを使えるかの制限は permissions の共通認可契約に従う。この change 単独では全員が使える。

## Goals / Non-Goals

**Goals:**

- メッセージの右クリックメニューに「解説する」を追加し、対象メッセージの専門用語、略語、背景知識を解説する。
- 解説は実行した本人にだけ見える（ephemeral）返信で出し、通常のチャット返信と同じくストリーミング表示、停止ボタン、長文の分割、`/config llm-details` の footer を備える。
- 対象メッセージの本文に加え、添付の画像と PDF、Components V2 と embed のテキスト、転送メッセージの内容、返信先メッセージの本文を解説の材料にする。範囲は Design の「解説の材料」に定める。

**Non-Goals:**

- 対象メッセージより前の会話履歴を材料にすること。どこまでが同じ話題かを決める基準が無く、無関係な発言を混ぜると解説がずれるためである。会話の境界は [conversation-context](../conversation-context/design.md) が扱う。
- 解説への追加質問（対話の継続）。ephemeral メッセージにはメンションで返信できないため、続きを聞く手段は別途設計が要る。
- DM とグループ DM での利用。モデルや設定がサーバー単位で保存されているため、サーバーの外では使うモデルが決まらない。
- ユーザーインストールでの利用。ユーザーインストールのコマンドは bot が参加していないサーバーでも実行できる。設定は未登録のサーバーでも既定値で作られるので動かすことはできるが、そのサーバーの管理者が関与しないまま OpenRouter の消費が発生するので、誰の負担でどこまで許すかの方針が要る。この change の範囲からは外す。

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| コマンドの種類 | message command（`type: 3`）、`contexts` は Guild のみ、`integration_types` は Guild Install のみ | メッセージの右クリックメニューに出る唯一の種類である（user command はユーザーの右クリックメニューに出る）。実行場所（`contexts`）とインストール形態（`integration_types`）は別々の制限で、理由はそれぞれ Non-Goals に書いた |
| コマンド名 | `解説する`（ローカライズなし） | bot の UI は日本語だけで提供している。message command の名前は大文字小文字と空白を含められ、`ContextMenuCommandBuilder` が日本語名を受け付けることを確認した |
| 返信の公開範囲 | ephemeral | 質問したこと自体を他の参加者に見せず、チャンネルにも残さない。解説を共有したい場合は通常のメンションで聞ける |
| 解説の材料 | 対象メッセージ（本文、V2 のテキスト、embed のテキスト、添付）、転送メッセージの snapshot、返信先 1 件の本文 | 返信先は「何への発言か」という背景そのものである。それより前の履歴は Non-Goals のとおり含めない |
| 返信先を取得できないとき | 返信先なしで解説を続け、返信先を読めなかったことを解説の末尾に注記する | 返信先は補助の材料であり、削除や権限不足で取れないことを理由に対象メッセージの解説まで止める必要はない |
| 指示の渡し方 | `ChatUserInput` に任意の `systemPrompt` を足し、`system` メッセージとして先頭に置く | Responses API への変換は `system` を扱える（`src/llm/openrouter.ts:425`）。専用の service を作ると model 解決と tool loop の呼び出しが二重になる |
| モデル | サーバーの既定モデル（`/model set`） | `/config free-only` を含む既存の設定がそのまま効く。解説専用のモデル設定は、必要になった時点で settings-hierarchy に載せる |
| 返信の描画 | 既存のストリーミング描画を、送信先を差し替えられる形にして再利用する | 分割、停止表示、エラー時の後始末は既に `messageCreate.ts` と `streamingUpdater.ts` にある。interaction 用に書き直すと同じ論理が二重になる |
| 停止ボタンの ID | `interaction.id` を requestId にする | `stop_response_<id>` の処理は ID の出どころを問わないので、ボタン側は変更不要である |
| 15 分の期限への備え | `interaction.createdTimestamp` から 13 分を締め切りとし、処理全体をこの締め切りと競争させる。締め切りが来たら送信先を閉じ、停止表示を 1 回だけ書く | interaction token は 15 分で失効し、以後は返信を編集できない。今は tool が未登録で 1 turn（最大 10 分）で終わるが、tool が載ると最大 5 turn になり期限を超えうる。段階ごとの確認ではなく送信先を閉じる形にする理由は「締め切りとエラー処理」に書いた。2 分の余裕は停止表示の描画に充てる |
| ログの token | logger が行を書き出す直前に、interaction と webhook の URL の token を伏せる | token を含む経路は解説の描画、defer、停止ボタンにまたがる。全てのログが通る 1 か所で伏せれば、経路ごとの対処が要らない |
| エラー時の返信 | 解説経路は専用の try/catch を持ち、エラー表示は必ず ephemeral の返信で出す | `interactionCreate.ts` の既存の catch は chat input の分岐の中にあり、その返信は `Ephemeral` を付けていない。解説の失敗をチャンネルの全員に見せないためである |
| 利用制限 | `default_member_permissions` を設定しない | 権限の設計は permissions change が持つ。先にこの change で独自の制限を入れると、後で共通契約へ移すときに二重になる |
| README のコマンド一覧 | 生成スクリプトは chat input コマンドだけを表にし、解説コマンドは README に手書きで 1 行足す | message command は API が `description` を受け付けないため、生成の元になる説明文が無い。1 件のために説明文の置き場を新設するほどではない |

## Design

### 変更対象ファイル

- 新規: `src/bot/commands/explain.ts` — `ContextMenuCommandBuilder` による定義と、解説用のシステムプロンプト。
- 新規: `src/bot/events/explainCommand.ts` — message command の interaction を受けて材料を組み立て、chat service を呼んで ephemeral 返信へ描画する。
- 修正: `src/bot/commands/index.ts` — `commandDefinitions` に解説コマンドを加える。登録は既存の `rest.put(Routes.applicationCommands(...))` がそのまま行う。
- 修正: `src/bot/events/interactionCreate.ts` — `isChatInputCommand()` の判定より前に `isMessageContextMenuCommand()` の分岐を置く。今は chat input 以外を無言で捨てている（52 行目）。この分岐は既存の try/catch の外に出るので、エラー処理は `explainCommand.ts` が持つ。
- 修正: `src/services/chatService.ts` — `ChatUserInput.systemPrompt` を受け、`buildChatMessages()` で `system` メッセージを先頭に置く。
- 修正: `src/bot/events/streamingUpdater.ts`、`src/bot/events/messageCreate.ts` — Discord への書き込み（編集、追加送信、削除）を送信先の差し替え口経由にし、最終描画、停止表示、エラー時の後始末の関数を両経路から使える場所へ移す。
- 修正: `src/utils/logger.ts` — `Error` の内容を残す形で直列化し、書き出す行から interaction と webhook の URL の token を伏せる。
- 修正: `src/llm/toolLoop.ts` — updater の callback の例外を `console` へ直接出している箇所を logger 経由にする。
- 修正: `scripts/generate-readme.ts` — `generateCommandTable()` に渡す前に chat input 以外を除く。
- 修正: `src/bot/commands/handlers.ts` — `/help` の手書きのコマンド一覧に解説コマンドを 1 行足す。
- 修正: `README.md` — コマンド一覧の AUTO ブロックの外に解説コマンドの使い方を 1 行足す。

### 実装内容

1. interaction を受けたら、対象メッセージと転送の snapshot のテキストと添付の一覧を、キャッシュから切り離した値として同期的に取り出す。discord.js は転送元のチャンネルがキャッシュにあると snapshot をそのチャンネルのメッセージキャッシュに登録する（`node_modules/discord.js/src/structures/Message.js:463`）ので、後から読むと、転送元がその間に編集された場合に転送先の利用者が見ていない内容が混ざるためである。取り出しは同期処理だけで、3 秒の期限を圧迫しない。
2. 続けて 3 秒以内に `deferReply({ flags: Ephemeral })` を返す。defer に失敗したら、LLM は呼ばずにログだけ残して終える。失敗には、interaction が無効か期限切れだと Discord が返した場合と、通信の失敗で Discord が受け付けたか分からない場合があり、後者では token が使える可能性もある。それでも終えるのは、受け付けられたか分からない応答の上に解説を出す手順を持たないためである。ログにはこの 2 種類を区別して残す。
3. 残りの材料を集める（範囲は次の小節「解説の材料」）。返信先を取得し、1 で取り出した添付の一覧を既存の `parseAttachments()` に通し、画像があれば既存の `isMultimodalCapable()` でモデルの対応を確かめる。
4. テキストも添付も無ければ、「解説できる内容がありません」を返して終える。添付の拒否やモデル非対応も、通常のチャット経路と同じ文言で返す。
5. 締め切りを過ぎていなければ、その判定に続けて同期的に、解説用のシステムプロンプトと材料を `generateChatResponse()` に渡す。requestId は `interaction.id` である。
6. 描画は interaction 用の送信先を使う。1 通目は `editReply()` で Components V2 にし、2 通目以降は `followUp({ flags: Ephemeral | IsComponentsV2 })` で足し、編集と削除は interaction token の webhook 経由で行う。

システムプロンプトには、対象メッセージに出てくる専門用語、略語、固有名詞、前提知識を取り出して短く説明すること、発言の意図の推測は必要な範囲にとどめること、確かでない点は確かでないと書くことを指示する。
文面は実装時に調整する。

### 解説の材料

1 件のメッセージからテキストを取り出す規則を一つ定め、対象メッセージと転送の snapshot の両方に同じ規則を使う。

- 本文（`content`）。
- Components V2 のテキスト。Container と Section の内側まで辿り、TextDisplay の本文を出現順に集める。ボタンなどの操作部品は含めない。
- embed のテキスト。title、description、各 field の name と value、footer を集める。この bot の `/status` のように、情報を field に置く embed があるためである。
- 添付の画像と PDF。対象メッセージと snapshot の添付を合わせて `parseAttachments()` に通す。

転送メッセージ（`message_reference.type` が Forward）は `messageSnapshots` の内容を使い、転送元を取りに行かない。
返信先は、メッセージが `MessageType.Reply` で、`message_reference.type` が Default のときだけ取得する。
Discord は `type` の省略を Default と定めているが、discord.js は省略時に `undefined` のまま渡す（`node_modules/discord.js/src/structures/Message.js:376`）ので、`type ?? MessageReferenceType.Default` で比べる。
取得は `fetchReference()` を使わず、reference の `channelId` のチャンネルを `client.channels.fetch()` で得てから、`messages.fetch({ message: messageId, force: true })` で上限時間つきの 1 回だけ取る。
`fetchReference()` はキャッシュ済みのチャンネルを前提とし（`node_modules/discord.js/src/structures/Message.js:798`）、`force` を付けずに取得するので、キャッシュにある返信先を今の権限や削除の有無を確かめずにそのまま返す（`node_modules/discord.js/src/managers/MessageManager.js:104-108`）。
取得に失敗（削除済み、`VIEW_CHANNEL` や `READ_MESSAGE_HISTORY` の不足、ボイスチャンネルのテキストでの `CONNECT` の不足、タイムアウト）したら返信先なしで続け、解説の末尾にその旨を注記する。
返信先から使うのはテキストだけで、添付は含めない。

### 締め切りとエラー処理

締め切りは `interaction.createdTimestamp` から 13 分とし、解説 1 件の処理全体（defer の後の準備、生成、描画）をこの 1 つの締め切りと競争させる。
締め切りを段階ごとに確かめる形は採らない。
準備の待ちはモデル情報の取得のように締め切りを受け取らない呼び出しも含み、描画には discord.js へ渡し済みで取り消せない書き込みもあるので、確認を置く場所を数え上げると漏れが残るためである。

締め切りが来たら、締め切りの処理が次の順に行う。

1. interaction 版の送信先を閉じる。閉じた後は、ストリーミングの更新、最終描画、エラー表示のどれも送信先が受け付けず、何も書き込まない。
2. `cancelRequest(interaction.id)` を呼ぶ。生成中なら生成が止まり、生成中でなければ何も起きない。
3. 表示中の最後のメッセージを期限切れの停止表示に置き換える書き込みを、送信先の表示の待ち行列に入れる。まだ何も描画していなければ、deferred の元応答を置き換える。これが締め切り後に送信先が行う唯一の表示の書き込みである。

interaction 版の送信先は、表示の待ち行列と削除の待ち行列を別々に持ち、それぞれの中では 1 件ずつ実行する。

- 表示の待ち行列は、編集、追加送信、3 の停止表示を受け持つ。閉じる前に受け付けた編集や追加送信は必ず停止表示より先に終わり、後から完了して停止表示を上書きすることがない。
- 削除の待ち行列は、余ったメッセージの削除と、取り残されたメッセージの削除を受け持つ。表示の待ち行列はこちらの完了を待たない。削除には時間の上限を置かない。
- どちらの待ち行列も、1 件が失敗しても後続を実行する。
- interaction 版では、削除に失敗したメッセージを中立化の表示に書き換えず、ログだけ残す。中立化は表示の書き込みであり、削除の待ち行列へ渡したメッセージには表示を書かない規則と両立しないためである。残るのは本人にだけ見える ephemeral のメッセージで、停止ボタンが残っていても押せば「既に完了している」旨が返るだけである（`src/bot/events/interactionCreate.ts:155-168`）。チャンネル版は既存の中立化をそのまま使う。

2 本に分けて保証できるのは、停止表示がアプリの中で削除の完了を待たないことまでである。
discord.js は REST の要求を rate limit の bucket ごとに 1 本の列で送る（`node_modules/@discordjs/rest/dist/index.js:975`、`1334`）ので、削除と編集が同じ bucket に入れば、停止表示の編集は discord.js の中で削除の後に回る。
interaction token の経路で削除と編集が bucket を共有するかは確かめていない。
共有していれば、締め切りの前に始まった削除の rate limit の待ちが 2 分の余裕を使い切り、停止表示が届かないことがありうる。

2 本の待ち行列が同じメッセージを同時に扱わないように、表示中のメッセージの一覧は送信先が持ち、メッセージは削除の待ち行列へ渡した時点でこの一覧から外す。
以後、停止表示を含む表示の書き込みはそのメッセージを対象にしない。
閉じた後に完了した追加送信（停止ボタン付きの新しいメッセージ、または最終描画の続きのページ）は、表示中の一覧に加えず、そのまま削除の待ち行列へ渡す。
既存の finalize 後の後始末（`src/bot/events/streamingUpdater.ts:125-139`）と同じ扱いを、閉じた送信先の中で行う形である。
表示の書き込みの直列化は、interaction token の経路の rate limit が分からない間、同時に複数の表示の書き込みを出さない効果もある。

締め切りに負けた本体の処理は走り続けうるが、その結果は捨てる。
準備の途中で締め切りが来ると、残りの準備（モデル情報や添付の取得）は最後まで走りうる。
これは許容する。準備が行うのは、Discord や OpenRouter からの読み取り、bot の中のキャッシュ更新、未登録のサーバーでの既定設定の保存（`src/services/settingsService.ts:20-36`）で、どれも利用者に見える出力も課金も伴わず、締め切りに関係なくいずれ行われてよい処理だからである。
締め切り後に本体が利用者に影響を与えうるのは、送信先への書き込み（閉じているので何もしない）と生成の開始だけである。
生成の開始は、締め切りの判定と `generateChatResponse()` の呼び出しを同期的に続けて置くことで防ぐ。
`generateChatResponse()` は最初の `await` より前に requestId を登録する（`src/services/chatService.ts:193-194`）ので、判定を通った直後に締め切りが来ても 2 の `cancelRequest()` が効く。
締め切り後に本体で起きたエラーはログだけに残し、通常のエラー表示は出さない。
これらの書き込みも best effort で、token の失効による失敗はログだけ残して諦める。
タイマーは `finally` で必ず解除する。

返信先の取得には、締め切りとは別に数秒の固定の上限を置く。
これは期限を守るためではなく、補助の材料のために解説の開始を待たせないためである。

エラー表示は常に ephemeral で、Components V2 の `buildErrorContainer()` を V2 の編集または送信として出す。
元応答はストリーミングの表示を出した時点で V2 になっており、`IS_COMPONENTS_V2` は外せないので、通常の `content` や embed には戻せない。

- 生成前の失敗（材料の準備、添付の拒否、モデル非対応）は、deferred の元応答を `editReply()` でエラー表示に置き換える。
- 生成後の失敗で受信済みのテキストがあれば、既存の後始末と同じく部分テキストを残して停止ボタンを外し、`followUp()` でエラーを足す。
- 生成後の失敗でテキストが無ければ、元応答をエラー表示に置き換える。
- エラー表示の書き込み自体が失敗したら、ログだけ残して終える。

元応答は削除しない。ephemeral の元応答を消すと、以後の表示を `editReply()` で出せなくなるためである。

### ログに interaction token を残さない

interaction への応答は URL に token を含む経路（`/interactions/<id>/<token>/callback` と `/webhooks/<application id>/<token>/...`）で書き込むので、その経路の情報をそのままログに出すと token が残る。
discord.js の `DiscordAPIError` と `HTTPError` は `url` を持ち、REST の rate limit 情報は `url` に加えて `majorParameter` にも `<application id>/<token>` を入れる（`node_modules/@discordjs/rest/dist/index.js:1464-1467`）。
この経路は解説の描画だけでなく、defer、停止ボタンの `deferUpdate()`、その失敗時の返信でも通り、既存のコードは Discord のエラーをそのまま logger へ渡している（`src/bot/events/streamingUpdater.ts:147`、`src/bot/events/interactionCreate.ts:239` など）。

そこで、logger が行を書き出す直前（`src/utils/logger.ts` の `log()` で、`JSON.stringify` した後の 1 行）に、`/interactions/<数字>/<token>` と `/webhooks/<数字>/<token>` の token 部分を `:token` に置き換える。
Discord のエラーに触れうるログがこの 1 か所を通るように、`src/llm/toolLoop.ts` で `console` へ直接出している箇所（183、189、766 行目の callback の例外と、318 行目の警告）を logger 経由に改める。
updater は Discord へ書き込むので、その例外は token を含む URL を持ちうる。
logger を通らない残りの `console.error` は `src/utils/logFile.ts` のファイル書き込みの失敗だけで、Discord のエラーを受け取らない。
こうすれば、エラーの種類や呼び出し元ごとに対処しなくてよい。

ただし今の logger は素の `Error` を `{}` として書き出す（設計メモ）ので、`console.error` から logger へ移すだけでは callback の例外の内容が消える。
そこで logger の直列化で `Error` を `name`、`message`、`stack` と列挙可能な項目（`DiscordAPIError` の `url`、`status`、`code` など）を持つオブジェクトに直し、その後の 1 行に token の置き換えを掛ける。
既存の `logger.error(..., { error })` の呼び出しも、これでエラーの内容が残るようになる。
置き換えは文字列に対して行うので、URL がエラーの `url` と `message` のどちらに入っていても伏せられる。
管理 API のログ取得（[docs/admin-api.md](../../admin-api.md)）はこの logger が書いたログファイルを返すので、同じく伏せた後の行になる。

rate limit 情報の `majorParameter` は `<application id>/<token>` だけで経路の接頭辞を持たず、この置き換えでは伏せられない。
そのため rate limit 情報はオブジェクトごとログに渡さず、正規化済みの `route`（token は `:token` に置き換わっている）、`method`、`limit`、`retryAfter`、`global` だけを渡す。

### 送信先の差し替え口

`DiscordStreamingUpdater` と `messageCreate.ts` の描画関数は、`Message#edit`、`message.channel.send`、`Message#delete` を直接呼んでいる。
discord.js の `Message#edit` はチャンネルのメッセージ API を呼ぶ（`node_modules/discord.js/src/structures/Message.js:839-842`）ので、interaction の返信を編集するには interaction token の webhook 経路へ切り替える必要がある。
そこで、編集、追加送信、削除の 3 操作と停止ボタンに埋める requestId を持つ送信先を定義し、チャンネル版（既存の挙動）と interaction 版の 2 実装を置く。
ephemeral メッセージをチャンネル API で編集できるかは確かめていないが、この設計は文書化された webhook 経路だけを使うので、その可否に依存しない。

差し替え口を通すのは、ストリーミング中の編集と追加送信、finalize 後に届いた送信の削除、最終描画、停止表示、余ったメッセージの削除と中立化、致命的エラー時の後始末である。
メンション経路のエラー表示（`message.reply()` による別メッセージ）は描画の一部ではないので、差し替え口に入れず `messageCreate.ts` に残す。
interaction 版で元応答の削除を求められたとき（後始末でテキストが空の場合など）は、削除せず中立化の表示に置き換える。

表示中のメッセージの一覧は、今は `DiscordStreamingUpdater` が持ち（`messages`）、`messageCreate.ts` の描画関数がその配列に `push` し、添字で走査しながら余りを削除している（`src/bot/events/messageCreate.ts:285-293`、`399-424`）。
差し替え後はこの一覧の持ち主を送信先に一本化し、描画関数は一覧を直接変更しない。
描画関数は、追加送信が一覧に加わったか（閉じた後に完了して捨てられたか）を送信先の返り値で受け取り、余りの削除は走査の前に一覧の写しを取ってから依頼する。
同じ配列を走査しながら要素を外すと、隣り合う余りのメッセージを飛ばすためである。

### 設計メモ

2026-09-21 に Discord API ドキュメントのリポジトリ（`discord/discord-api-docs`、同日時点の main）の原文で確認した事項は次のとおりである。

- グローバルの message command は 15 個まで、サーバー単位の message command も各サーバーで 15 個まで登録できる（`developers/interactions/application-commands.mdx` の Registering a Command）。
- message command は `description` を受け付けず、取得時は空文字列が返る（同ファイルの Message Commands）。
- Message Content intent が無いアプリでも、message command の対象メッセージの本文は受け取れる（`developers/events/gateway.mdx` の Message Content Intent）。この bot は intent を持っているので、どちらでも本文は届く。
- deferred 応答で付けられるフラグは `EPHEMERAL` だけで、Components V2 にするには Edit Original Interaction Response で `IS_COMPONENTS_V2` を付ける（`developers/interactions/receiving-and-responding.mdx`）。
- followup は `EPHEMERAL` と `IS_COMPONENTS_V2` を同時に付けて送れ、followup の編集と削除の endpoint もある（同ファイルの Followup Messages）。
- interaction token は 15 分有効で、最初の応答は 3 秒以内に返す必要がある（同ファイル）。
- メッセージの取得には `VIEW_CHANNEL` と `READ_MESSAGE_HISTORY` が要り、ボイスチャンネルではさらに `CONNECT` が要る（`developers/resources/message.mdx` の Get Channel Message）。

コードで確認した事項は次のとおりである。

- `ContextMenuCommandBuilder` に名前 `解説する`、`type: 3`、`contexts: [Guild]` を与えると `{"name":"解説する","type":3,"contexts":[0]}` を出力し、検証で弾かれない（discord.js 14.26.5 で実行して確認）。
- その JSON を今の `generateCommandTable()` に渡すと、説明欄が `undefined` の行 ``| `/解説する` | undefined |`` ができる（同上）。生成スクリプトで chat input 以外を除く理由である。
- tool registry は空のまま渡されており（`src/index.ts:45-48`）、1 turn のストリームの上限は 10 分である（`src/llm/toolLoop.ts:130`）。
- `chatService` が requestId を登録するのは `generateChatResponse()` の実行中だけで、呼び出し元の最終描画に入る前に外す（`src/services/chatService.ts:193-233`）。`cancelRequest()` だけでは締め切りを守れず、送信先を閉じる必要がある理由である。
- logger は `meta` を `JSON.stringify` するだけで（`src/utils/logger.ts:13`）、素の `Error` は `message` と `stack` が列挙されないため `{}` になる（`logger.error("x", { error: new Error("detail") })` を実行して確認）。`DiscordAPIError` や `HTTPError` は `url` などを列挙可能な項目として持つので、今の logger でも token を含む `url` が書き出される。

### テスト

- e2e（`bun run e2e`）では検証できない。テスト bot は REST でメッセージを投稿して返信を読む仕組みで、message command の実行はクライアント上の人の操作から始まるためである。
- 材料の組み立ては、本文、入れ子の V2、embed の field、転送の snapshot（V2 と添付を含む）、返信先の成功と失敗、添付の組み合わせで確かめる。返信先の判定は、reference の `type` が Default、省略、Forward の 3 通りで確かめる。
- 解説経路は、空入力、添付の拒否、モデル非対応、defer の失敗、token 失効時の書き込み失敗で確かめる。
- 締め切りは、解決しないモデル情報の取得の途中、元応答の編集中、生成中、複数通の最終描画の途中のそれぞれで来た場合を、解決を手で制御する promise で確かめる。どの場合も、締め切り後に通常の描画と生成の開始が行われないこと、締め切り前に受け付けた編集と追加送信が停止表示より先に完了すること、閉じた後に完了した追加送信（停止ボタン付きのものと、ボタンの無い最終描画の続き）が削除されること、締め切りの前に始まって終わらない削除と締め切りの後に始まった削除のどちらがあっても停止表示の書き込みが行われること、削除の待ち行列へ渡したメッセージに停止表示が書かれないこと、待ち行列の 1 件の失敗が後続を止めないこと、隣り合う複数の余りのメッセージがすべて削除されること、削除の失敗が閉じる前と後のどちらでも中立化の書き込みを生まないこと、表示の書き込みが停止表示の 1 回だけであることを、最終的に残るメッセージの内容で確かめる。
- 生成後のエラーは、プレースホルダーだけでテキストが無い場合、複数通の部分テキストがある場合、エラー表示の書き込み自体が失敗する場合で確かめ、停止ボタンが外れること、部分テキストが残ること、エラーの followup が ephemeral で V2 であることを確かめる。
- 偽の token を含む `DiscordAPIError` と `HTTPError`（callback と webhook の両方の URL）と素の `Error` を logger に渡し、書き出された行に token が含まれず、どのエラーでも `message` は残ることを確かめる。同じエラーを `runToolLoop()` の updater の callback から同期的な throw と非同期の reject の両方で投げ、コンソールとログファイルのどちらにも token が出ないことを確かめる。rate limit 情報は許可した項目だけが出ることを別に確かめる。
- defer の失敗は、Discord が無効と返した場合と通信の失敗の場合の両方で、LLM が呼ばれないことを確かめる。
- 返信先の取得の失敗は、`CONNECT` の不足を含めて、返信先なしで解説が続き注記が付くことを確かめる。返信先がキャッシュにあっても REST が権限不足や削除済みを返す場合に、キャッシュの本文を使わないことを確かめる。
- interaction 版の送信先は、ストリーミング中の追加送信、停止、最終描画、余剰の削除要求、中立化、finalize 後の送信の後始末のそれぞれで、webhook の操作だけが呼ばれ（チャンネル API が呼ばれない）、followup に `Ephemeral` と `IsComponentsV2` が付き、正しいメッセージ ID を編集することを確かめる。
- `systemPrompt` が `system` メッセージとして先頭に入ることを確かめる。
- チャンネル版の送信先に置き換えた後も、既存の `messageCreate` と `streamingUpdater` のテストがそのまま通ることを確かめる。

## Tasks

- [ ] `ChatUserInput.systemPrompt` を追加し、`buildChatMessages()` で `system` メッセージにする
- [ ] 送信先の差し替え口を定義し、`streamingUpdater.ts` と `messageCreate.ts` の描画をチャンネル版の送信先経由にする（挙動は変えない）
- [ ] interaction 版の送信先を実装する
- [ ] 材料の取り出し（V2、embed、snapshot、返信先）を実装する
- [ ] `src/bot/commands/explain.ts` と `src/bot/events/explainCommand.ts` を実装し、`interactionCreate.ts` から分岐させる
- [ ] 締め切りとエラー処理を実装する
- [ ] logger で interaction と webhook の URL の token を伏せ、`toolLoop.ts` の `console` 出力を logger 経由にする
- [ ] `generate-readme.ts` で chat input 以外を除き、README と `/help` に解説コマンドを足す
- [ ] 単体テストを追加する
- [ ] `bun run e2e` で既存のチャット経路が壊れていないことを確かめる
- [ ] 手動確認: 開発サーバーでメッセージを右クリック → アプリ → 解説する を実行し、本人にだけ見える解説がストリーミング表示され、長文なら分割され、`/config llm-details` が有効なら footer が出ることを確かめる
- [ ] 手動確認: 2 通以上に分かれる解説の生成中に、2 通目以降に付いた停止ボタンを押し、停止表示に切り替わることを確かめる
- [ ] 手動確認: 画像付き、PDF 付き、bot 自身の返信（Components V2）、返信の付いたメッセージ、転送メッセージに対して実行し、それぞれの内容が解説に反映されることを確かめる
- [ ] 手動確認: 上の確認の間、Discord の REST の `rateLimited` イベントを「ログに interaction token を残さない」の項目だけ一時的にログへ出し、ストリーミングの表示の遅れが通常のチャット返信と同程度であることを確かめる
- [ ] `docs/changes/message-explain/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- 締め切り時の停止表示は、削除と同じ REST の bucket に入る場合に届かないことがある（「締め切りとエラー処理」）。届かなくても、token の失効後に残るのは本人にだけ見える生成途中の表示である。
- interaction token 経由の編集のレート制限は確かめていない。discord.js は 429 を内部で待って再試行し、アプリのログには出ないので、手動確認で `rateLimited` イベントと表示の遅れを見て判断する。遅れが大きければ、解説経路だけ編集の間隔を広げる。
- 対象メッセージの投稿者ではない利用者が、そのメッセージを OpenRouter へ送れる。これはメンションで本文を貼り付けた場合と同じだが、右クリック一つでできるようになる。
- 利用制限が無いので、利用の多いサーバーでは OpenRouter の消費が増える。permissions change が入るまでは `/model set` で安いモデルを選ぶことで抑える。

## 参照

- Discord Developer Documentation: [Message Commands](https://discord.com/developers/docs/interactions/application-commands#message-commands)
- Discord Developer Documentation: [Receiving and Responding](https://discord.com/developers/docs/interactions/receiving-and-responding)
- Discord Developer Documentation: [Message Content Intent](https://discord.com/developers/docs/events/gateway#message-content-intent)
