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
- 対象メッセージの本文に加え、添付の画像と PDF、Components V2 や embed のテキスト、転送メッセージの本文、返信先メッセージの本文を解説の材料にする。

**Non-Goals:**

- 対象メッセージより前の会話履歴を材料にすること。どこまでが同じ話題かを決める基準が無く、無関係な発言を混ぜると解説がずれるためである。会話の境界は [conversation-context](../conversation-context/design.md) が扱う。
- 解説への追加質問（対話の継続）。ephemeral メッセージにはメンションで返信できないため、続きを聞く手段は別途設計が要る。
- DM とユーザーインストール（サーバー外）での利用。モデルや設定がサーバー単位で保存されているため、サーバーの外では使うモデルが決まらない。

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| コマンドの種類 | message command（`type: 3`）、`contexts` は Guild のみ、`integration_types` は Guild Install のみ | 右クリックメニューに出る唯一の種類である。設定がサーバー単位なので DM とユーザーインストールは除く |
| コマンド名 | `解説する`（ローカライズなし） | bot の UI は日本語だけで提供している。message command の名前は大文字小文字と空白を含められ、`ContextMenuCommandBuilder` が日本語名を受け付けることを確認した |
| 返信の公開範囲 | ephemeral | 質問したこと自体を他の参加者に見せず、チャンネルにも残さない。解説を共有したい場合は通常のメンションで聞ける |
| 解説の材料 | 対象メッセージ（本文、V2 の TextDisplay、embed の title と description、転送元の本文、添付）と返信先 1 件の本文 | 返信先は「何への発言か」という背景そのものである。それより前の履歴は Non-Goals のとおり含めない |
| 指示の渡し方 | `ChatUserInput` に任意の `systemPrompt` を足し、`system` メッセージとして先頭に置く | Responses API への変換は `system` を扱える（`src/llm/openrouter.ts:425`）。専用の service を作ると model 解決と tool loop の呼び出しが二重になる |
| モデル | サーバーの既定モデル（`/model set`） | `/config free-only` を含む既存の設定がそのまま効く。解説専用のモデル設定は、必要になった時点で settings-hierarchy に載せる |
| 返信の描画 | 既存のストリーミング描画を、送信先を差し替えられる形にして再利用する | 分割、停止表示、エラー時の後始末は既に `messageCreate.ts` と `streamingUpdater.ts` にある。interaction 用に書き直すと同じ論理が二重になる |
| 停止ボタンの ID | `interaction.id` を requestId にする | `stop_response_<id>` の処理は ID の出どころを問わないので、ボタン側は変更不要である |
| 15 分の期限への備え | 実行開始から 14 分で `chatService.cancelRequest()` を呼ぶ | interaction token は 15 分で失効し、以後は返信を編集できない。今は tool が未登録で 1 turn（最大 10 分）で終わるが、tool が載ると最大 5 turn になり期限を超えうる |
| 利用制限 | `default_member_permissions` を設定しない | 権限の設計は permissions change が持つ。先にこの change で独自の制限を入れると、後で共通契約へ移すときに二重になる |
| README のコマンド一覧 | 生成スクリプトは chat input コマンドだけを表にし、解説コマンドは README に手書きで 1 行足す | message command は API が `description` を受け付けないため、生成の元になる説明文が無い。1 件のために説明文の置き場を新設するほどではない |

## Design

### 変更対象ファイル

- 新規: `src/bot/commands/explain.ts` — `ContextMenuCommandBuilder` による定義と、解説用のシステムプロンプト。
- 新規: `src/bot/events/explainCommand.ts` — message command の interaction を受けて材料を組み立て、chat service を呼んで ephemeral 返信へ描画する。
- 修正: `src/bot/commands/index.ts` — `commandDefinitions` に解説コマンドを加える。登録は既存の `rest.put(Routes.applicationCommands(...))` がそのまま行う。
- 修正: `src/bot/events/interactionCreate.ts` — `isChatInputCommand()` の判定より前に `isMessageContextMenuCommand()` の分岐を置く。今は chat input 以外を無言で捨てている（52 行目）。
- 修正: `src/services/chatService.ts` — `ChatUserInput.systemPrompt` を受け、`buildChatMessages()` で `system` メッセージを先頭に置く。
- 修正: `src/bot/events/streamingUpdater.ts`、`src/bot/events/messageCreate.ts` — Discord への書き込み（編集、追加送信、削除）を送信先の差し替え口経由にし、最終描画、停止表示、エラー時の後始末の関数を両経路から使える場所へ移す。
- 修正: `scripts/generate-readme.ts` — `generateCommandTable()` に渡す前に chat input 以外を除く。
- 修正: `src/bot/commands/handlers.ts` — `/help` の手書きのコマンド一覧に解説コマンドを 1 行足す。
- 修正: `README.md` — コマンド一覧の AUTO ブロックの外に解説コマンドの使い方を 1 行足す。

### 実装内容

1. interaction を受けたら、3 秒以内に `deferReply({ flags: Ephemeral })` を返す。
2. `interaction.targetMessage` から材料を集める。テキストは本文、Components V2 の TextDisplay、embed の title と description、転送メッセージ（`messageSnapshots`）の本文の順に連結する。返信先があれば `fetchReference()` で 1 件だけ取り、本文を「返信先」として別に添える。添付は既存の `parseAttachments()` に通し、画像があれば既存の `isMultimodalCapable()` でモデルの対応を確かめる。
3. テキストも添付も無ければ、「解説できる内容がありません」を ephemeral で返して終える。添付の拒否やモデル非対応も、通常のチャット経路と同じ文言で返す。
4. 解説用のシステムプロンプトと材料を `generateChatResponse()` に渡す。requestId は `interaction.id` である。
5. 描画は interaction 用の送信先を使う。1 通目は `editReply()` で Components V2 にし、2 通目以降は `followUp({ flags: Ephemeral | IsComponentsV2 })` で足し、編集と削除は interaction token の webhook 経由で行う。

システムプロンプトには、対象メッセージに出てくる専門用語、略語、固有名詞、前提知識を取り出して短く説明すること、発言の意図の推測は必要な範囲にとどめること、確かでない点は確かでないと書くことを指示する。
文面は実装時に調整する。

### 送信先の差し替え口

`DiscordStreamingUpdater` と `messageCreate.ts` の描画関数は、`Message#edit`、`message.channel.send`、`Message#delete` を直接呼んでいる。
discord.js の `Message#edit` はチャンネルのメッセージ API を呼ぶ（`node_modules/discord.js/src/structures/Message.js:839-842`）ので、interaction の返信を編集するには interaction token の webhook 経路へ切り替える必要がある。
そこで、編集、追加送信、削除の 3 操作と停止ボタンに埋める requestId を持つ送信先を定義し、チャンネル版（既存の挙動）と interaction 版の 2 実装を置く。
ephemeral メッセージをチャンネル API で編集できるかは確かめていないが、この設計は文書化された webhook 経路だけを使うので、その可否に依存しない。

### 設計メモ

2026-09-21 に Discord API ドキュメントのリポジトリ（`discord/discord-api-docs`、同日時点の main）の原文で確認した事項は次のとおりである。

- message command の数の上限はアプリ全体で 15 個（`developers/interactions/application-commands.mdx` の Registering a Command）。
- message command は `description` を受け付けず、取得時は空文字列が返る（同ファイルの Message Commands）。
- Message Content intent が無いアプリでも、message command の対象メッセージの本文は受け取れる（`developers/events/gateway.mdx` の Message Content Intent）。この bot は intent を持っているので、どちらでも本文は届く。
- deferred 応答で付けられるフラグは `EPHEMERAL` だけで、Components V2 にするには Edit Original Interaction Response で `IS_COMPONENTS_V2` を付ける（`developers/interactions/receiving-and-responding.mdx`）。
- followup は `EPHEMERAL` と `IS_COMPONENTS_V2` を同時に付けて送れ、followup の編集と削除の endpoint もある（同ファイルの Followup Messages）。
- interaction token は 15 分有効で、最初の応答は 3 秒以内に返す必要がある（同ファイル）。

コードで確認した事項は次のとおりである。

- `ContextMenuCommandBuilder` に名前 `解説する`、`type: 3`、`contexts: [Guild]` を与えると `{"name":"解説する","type":3,"contexts":[0]}` を出力し、検証で弾かれない（discord.js 14.26.5 で実行して確認）。
- その JSON を今の `generateCommandTable()` に渡すと、説明欄が `undefined` の行 ``| `/解説する` | undefined |`` ができる（同上）。生成スクリプトで chat input 以外を除く理由である。
- tool registry は空のまま渡されており（`src/index.ts:45-48`）、1 turn のストリームの上限は 10 分である（`src/llm/toolLoop.ts:130`）。

### テスト

- e2e（`bun run e2e`）では検証できない。テスト bot は REST でメッセージを投稿して返信を読む仕組みで、message command の実行はクライアント上の人の操作から始まるためである。
- 単体テストで、材料の組み立て（本文、V2、embed、転送、返信先、添付の組み合わせ）、空入力とモデル非対応の返信、`systemPrompt` が `system` メッセージになること、interaction 版の送信先が 1 通目を `editReply`、2 通目以降を ephemeral の `followUp` で送ることを確かめる。
- チャンネル版の送信先に置き換えた後も、既存の `messageCreate` と `streamingUpdater` のテストがそのまま通ることを確かめる。

## Tasks

- [ ] `ChatUserInput.systemPrompt` を追加し、`buildChatMessages()` で `system` メッセージにする
- [ ] 送信先の差し替え口を定義し、`streamingUpdater.ts` と `messageCreate.ts` の描画をチャンネル版の送信先経由にする（挙動は変えない）
- [ ] interaction 版の送信先を実装する
- [ ] `src/bot/commands/explain.ts` と `src/bot/events/explainCommand.ts` を実装し、`interactionCreate.ts` から分岐させる
- [ ] 14 分での `cancelRequest()` を実装する
- [ ] `generate-readme.ts` で chat input 以外を除き、README と `/help` に解説コマンドを足す
- [ ] 単体テストを追加する
- [ ] `bun run e2e` で既存のチャット経路が壊れていないことを確かめる
- [ ] 手動確認: 開発サーバーでメッセージを右クリック → アプリ → 解説する を実行し、本人にだけ見える解説がストリーミング表示され、長文なら分割され、`/config llm-details` が有効なら footer が出ることを確かめる
- [ ] 手動確認: 解説の生成中に停止ボタンを押し、停止表示に切り替わることを確かめる
- [ ] 手動確認: 画像付きメッセージ、bot 自身の返信（Components V2）、返信の付いたメッセージに対して実行し、それぞれの内容が解説に反映されることを確かめる
- [ ] `docs/changes/message-explain/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- interaction token 経由の編集のレート制限は確かめていない。ストリーミング中の編集頻度がチャンネル経路と同じで足りるかは、手動確認で 429 のログが出ないかを見て判断する。
- 対象メッセージの投稿者ではない利用者が、そのメッセージを OpenRouter へ送れる。これはメンションで本文を貼り付けた場合と同じだが、右クリック一つでできるようになる。
- 利用制限が無いので、利用の多いサーバーでは OpenRouter の消費が増える。permissions change が入るまでは `/model set` で安いモデルを選ぶことで抑える。

## 参照

- Discord Developer Documentation: [Message Commands](https://discord.com/developers/docs/interactions/application-commands#message-commands)
- Discord Developer Documentation: [Receiving and Responding](https://discord.com/developers/docs/interactions/receiving-and-responding)
- Discord Developer Documentation: [Message Content Intent](https://discord.com/developers/docs/events/gateway#message-content-intent)
