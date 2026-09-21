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
- ユーザーインストールでの利用。ユーザーインストールのコマンドは bot が参加していないサーバーでも実行できるが、そのサーバーには設定が無く、bot として返信先メッセージを取得することもできない。

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
| 15 分の期限への備え | `interaction.createdTimestamp` から 13 分を締め切りとし、準備、生成、描画の全体に掛ける | interaction token は 15 分で失効し、以後は返信を編集できない。今は tool が未登録で 1 turn（最大 10 分）で終わるが、tool が載ると最大 5 turn になり期限を超えうる。`cancelRequest()` は生成中しか効かないため、生成の前後の段階は締め切りを別に確かめる必要がある。2 分の余裕は停止表示の描画に充てる |
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
- 修正: `scripts/generate-readme.ts` — `generateCommandTable()` に渡す前に chat input 以外を除く。
- 修正: `src/bot/commands/handlers.ts` — `/help` の手書きのコマンド一覧に解説コマンドを 1 行足す。
- 修正: `README.md` — コマンド一覧の AUTO ブロックの外に解説コマンドの使い方を 1 行足す。

### 実装内容

1. interaction を受けたら、3 秒以内に `deferReply({ flags: Ephemeral })` を返す。defer に失敗したら（期限切れなど）、token で返信できないのでログだけ残して終え、LLM は呼ばない。
2. 材料を集める（範囲は次の小節「解説の材料」）。添付は既存の `parseAttachments()` に通し、画像があれば既存の `isMultimodalCapable()` でモデルの対応を確かめる。
3. テキストも添付も無ければ、「解説できる内容がありません」を返して終える。添付の拒否やモデル非対応も、通常のチャット経路と同じ文言で返す。
4. 締め切りを過ぎていなければ、解説用のシステムプロンプトと材料を `generateChatResponse()` に渡す。requestId は `interaction.id` である。
5. 描画は interaction 用の送信先を使う。1 通目は `editReply()` で Components V2 にし、2 通目以降は `followUp({ flags: Ephemeral | IsComponentsV2 })` で足し、編集と削除は interaction token の webhook 経由で行う。

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
取得は上限時間つきの 1 回だけにし、失敗（削除済み、`VIEW_CHANNEL` や `READ_MESSAGE_HISTORY` の不足、タイムアウト）したら返信先なしで続け、解説の末尾にその旨を注記する。
返信先から使うのはテキストだけで、添付は含めない。

### 締め切りとエラー処理

締め切りは `interaction.createdTimestamp` から 13 分とする。
締め切りの状態は `chatService` の `activeRequests` とは別に、解説 1 件ごとの締め切りオブジェクトが持つ。
`activeRequests` は生成が終わると外れる（`src/services/chatService.ts:231-233`）ので、生成後の描画中に来た締め切りを `cancelRequest()` では止められないためである。

- 準備の待ち（返信先の取得、添付の取得）は、固定の上限と締め切りまでの残り時間の短い方で打ち切る。
- 生成を始める前に締め切りを過ぎていたら、生成せずに期限切れを返して終える。
- 生成中に締め切りが来たら `cancelRequest(interaction.id)` を呼び、停止表示にする。
- 描画中に締め切りが来たら、interaction 版の送信先が以後の通常の描画（ストリーミングの更新と最終描画の続き）を受け付けなくなる。その時点で描画を止め、表示中の最後のメッセージを停止表示に置き換える書き込みだけを 1 回行う。締め切りの後に通常の描画が再開することはない。
- 締め切り後の停止表示とエラー表示の書き込みは best effort とし、token の失効による失敗はログだけ残して諦める。1 通ずつの書き込みは待ち行列に入りうるので、2 分の余裕でも完了は保証できない。
- タイマーは `finally` で必ず解除する。

締め切りの判定を送信先に置くのは、描画の書き込みがすべてそこを通るからである。
描画の各所に締め切りの確認を足すと、確認の漏れた書き込みが期限後に走りうる。

エラー表示は常に ephemeral で、Components V2 の `buildErrorContainer()` を V2 の編集または送信として出す。
元応答はストリーミングの表示を出した時点で V2 になっており、`IS_COMPONENTS_V2` は外せないので、通常の `content` や embed には戻せない。

- 生成前の失敗（材料の準備、添付の拒否、モデル非対応）は、deferred の元応答を `editReply()` でエラー表示に置き換える。
- 生成後の失敗で受信済みのテキストがあれば、既存の後始末と同じく部分テキストを残して停止ボタンを外し、`followUp()` でエラーを足す。
- 生成後の失敗でテキストが無ければ、元応答をエラー表示に置き換える。
- エラー表示の書き込み自体が失敗したら、ログだけ残して終える。

元応答は削除しない。ephemeral の元応答を消すと、以後の表示を `editReply()` で出せなくなるためである。

### ログに interaction token を残さない

interaction の返信は URL に token を含む webhook 経路で書き込むので、その経路の情報をそのままログに出すと token が残る。
discord.js の `DiscordAPIError` は `url` を持ち、REST の rate limit 情報は `url` に加えて `majorParameter` にも `<application id>/<token>` を入れる（`node_modules/@discordjs/rest/dist/index.js:1464-1467`）。
既存の描画は Discord のエラーをそのまま logger へ渡している（`src/bot/events/streamingUpdater.ts:147` など）。

interaction 版の送信先は、webhook 経路のエラーを捕まえて `url` を落とした形に直してから投げ直す。
描画側の既存のログ出力を変えずに済み、token を含む値が送信先の外へ出ない。
rate limit の確認で出す項目は、正規化済みの `route`（token は `:token` に置き換わっている）、`method`、`limit`、`retryAfter`、`global` に限る。

### 送信先の差し替え口

`DiscordStreamingUpdater` と `messageCreate.ts` の描画関数は、`Message#edit`、`message.channel.send`、`Message#delete` を直接呼んでいる。
discord.js の `Message#edit` はチャンネルのメッセージ API を呼ぶ（`node_modules/discord.js/src/structures/Message.js:839-842`）ので、interaction の返信を編集するには interaction token の webhook 経路へ切り替える必要がある。
そこで、編集、追加送信、削除の 3 操作と停止ボタンに埋める requestId を持つ送信先を定義し、チャンネル版（既存の挙動）と interaction 版の 2 実装を置く。
ephemeral メッセージをチャンネル API で編集できるかは確かめていないが、この設計は文書化された webhook 経路だけを使うので、その可否に依存しない。

差し替え口を通すのは、ストリーミング中の編集と追加送信、finalize 後に届いた送信の削除、最終描画、停止表示、余ったメッセージの削除と中立化、致命的エラー時の後始末である。
メンション経路のエラー表示（`message.reply()` による別メッセージ）は描画の一部ではないので、差し替え口に入れず `messageCreate.ts` に残す。
interaction 版で元応答の削除を求められたとき（後始末でテキストが空の場合など）は、削除せず中立化の表示に置き換える。

### 設計メモ

2026-09-21 に Discord API ドキュメントのリポジトリ（`discord/discord-api-docs`、同日時点の main）の原文で確認した事項は次のとおりである。

- グローバルの message command は 15 個まで、サーバー単位の message command も各サーバーで 15 個まで登録できる（`developers/interactions/application-commands.mdx` の Registering a Command）。
- message command は `description` を受け付けず、取得時は空文字列が返る（同ファイルの Message Commands）。
- Message Content intent が無いアプリでも、message command の対象メッセージの本文は受け取れる（`developers/events/gateway.mdx` の Message Content Intent）。この bot は intent を持っているので、どちらでも本文は届く。
- deferred 応答で付けられるフラグは `EPHEMERAL` だけで、Components V2 にするには Edit Original Interaction Response で `IS_COMPONENTS_V2` を付ける（`developers/interactions/receiving-and-responding.mdx`）。
- followup は `EPHEMERAL` と `IS_COMPONENTS_V2` を同時に付けて送れ、followup の編集と削除の endpoint もある（同ファイルの Followup Messages）。
- interaction token は 15 分有効で、最初の応答は 3 秒以内に返す必要がある（同ファイル）。
- メッセージの取得には `VIEW_CHANNEL` と `READ_MESSAGE_HISTORY` が要る（`developers/resources/message.mdx` の Get Channel Message）。

コードで確認した事項は次のとおりである。

- `ContextMenuCommandBuilder` に名前 `解説する`、`type: 3`、`contexts: [Guild]` を与えると `{"name":"解説する","type":3,"contexts":[0]}` を出力し、検証で弾かれない（discord.js 14.26.5 で実行して確認）。
- その JSON を今の `generateCommandTable()` に渡すと、説明欄が `undefined` の行 ``| `/解説する` | undefined |`` ができる（同上）。生成スクリプトで chat input 以外を除く理由である。
- tool registry は空のまま渡されており（`src/index.ts:45-48`）、1 turn のストリームの上限は 10 分である（`src/llm/toolLoop.ts:130`）。
- `chatService` が requestId を登録するのは `generateChatResponse()` の実行中だけで、描画に入る前に外す（`src/services/chatService.ts:193-233`）。締め切りを生成の前後で別に確かめる理由である。
- discord.js の `fetchReference()` はキャッシュ済みのチャンネルから `channel.messages.fetch()` を呼ぶ（`node_modules/discord.js/src/structures/Message.js:798`）。

### テスト

- e2e（`bun run e2e`）では検証できない。テスト bot は REST でメッセージを投稿して返信を読む仕組みで、message command の実行はクライアント上の人の操作から始まるためである。
- 材料の組み立ては、本文、入れ子の V2、embed の field、転送の snapshot（V2 と添付を含む）、返信先の成功と失敗、添付の組み合わせで確かめる。返信先の判定は、reference の `type` が Default、省略、Forward の 3 通りで確かめる。
- 解説経路は、空入力、添付の拒否、モデル非対応、defer の失敗、token 失効時の書き込み失敗で確かめる。
- 締め切りは、準備中、元応答の編集中、生成中、複数通の最終描画の途中のそれぞれで来た場合に、以後の通常の描画が行われず、停止表示の書き込みが 1 回だけ行われることを確かめる。
- 生成後のエラーは、プレースホルダーだけでテキストが無い場合、複数通の部分テキストがある場合、エラー表示の書き込み自体が失敗する場合で確かめ、停止ボタンが外れること、部分テキストが残ること、エラーの followup が ephemeral で V2 であることを確かめる。
- 偽の token を使い、webhook 経路のエラーと rate limit の確認用ログの出力に token が含まれないことを確かめる。
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
- [ ] interaction 版の送信先で webhook 経路のエラーから `url` を落とす
- [ ] `generate-readme.ts` で chat input 以外を除き、README と `/help` に解説コマンドを足す
- [ ] 単体テストを追加する
- [ ] `bun run e2e` で既存のチャット経路が壊れていないことを確かめる
- [ ] 手動確認: 開発サーバーでメッセージを右クリック → アプリ → 解説する を実行し、本人にだけ見える解説がストリーミング表示され、長文なら分割され、`/config llm-details` が有効なら footer が出ることを確かめる
- [ ] 手動確認: 2 通以上に分かれる解説の生成中に、2 通目以降に付いた停止ボタンを押し、停止表示に切り替わることを確かめる
- [ ] 手動確認: 画像付き、PDF 付き、bot 自身の返信（Components V2）、返信の付いたメッセージ、転送メッセージに対して実行し、それぞれの内容が解説に反映されることを確かめる
- [ ] 手動確認: 上の確認の間、Discord の REST の `rateLimited` イベントを「ログに interaction token を残さない」の項目だけ一時的にログへ出し、ストリーミングの表示の遅れが通常のチャット返信と同程度であることを確かめる
- [ ] `docs/changes/message-explain/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- interaction token 経由の編集のレート制限は確かめていない。discord.js は 429 を内部で待って再試行し、アプリのログには出ないので、手動確認で `rateLimited` イベントと表示の遅れを見て判断する。遅れが大きければ、解説経路だけ編集の間隔を広げる。
- 対象メッセージの投稿者ではない利用者が、そのメッセージを OpenRouter へ送れる。これはメンションで本文を貼り付けた場合と同じだが、右クリック一つでできるようになる。
- 利用制限が無いので、利用の多いサーバーでは OpenRouter の消費が増える。permissions change が入るまでは `/model set` で安いモデルを選ぶことで抑える。

## 参照

- Discord Developer Documentation: [Message Commands](https://discord.com/developers/docs/interactions/application-commands#message-commands)
- Discord Developer Documentation: [Receiving and Responding](https://discord.com/developers/docs/interactions/receiving-and-responding)
- Discord Developer Documentation: [Message Content Intent](https://discord.com/developers/docs/events/gateway#message-content-intent)
