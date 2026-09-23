---
title: "カスタム絵文字・スタンプ・GIF への対応"
status: planned
priority: medium
summary: "カスタム絵文字、スタンプ、GIF の埋め込みをモデルが読めるようにし、返信でサーバーのカスタム絵文字を使えるようにする"
---

# カスタム絵文字・スタンプ・GIF への対応

## Why

Discord の会話では、文字の代わりにカスタム絵文字、スタンプ、GIF で反応することが多い。
いまの bot はこれらをほとんど読めない。
本文中のカスタム絵文字は `<:name:id>` という生の表記のままモデルへ渡り、スタンプ（`sticker_items`）と、Tenor などのリンクから Discord が作る GIF の埋め込み（`embeds` の `type: "gifv"`）は捨てている。
そのため、スタンプだけのメッセージで bot を呼ぶと、本文が空とみなされて「メッセージを入力してください」のエラーになる。
また、モデルはサーバーにどのカスタム絵文字があるかを知らず、絵文字を書くには `<:name:id>` の ID まで要るので、返信でサーバーの絵文字を使えない。

## 依存 / 関連 change

- 前提（実装済み）: [conversation-context](../conversation-context/design.md) — 会話の窓は Discord のメッセージを正規化してモデルへ渡し、過去の添付は `view_attachment` で開く。本 change はその正規化と `view_attachment` の対象を広げる
- 連携: [discord-tool](../discord-tool/design.md) — 同 change の `add_reaction` もカスタム絵文字を名前で引く。どちらも guild の絵文字を名前で引くので、実装が後になる方が先の方の関数を使う

## Goals / Non-Goals

**Goals:**

- 本文中のカスタム絵文字を、モデルが読める `:name:` の形で渡し、bot を呼んだメッセージの絵文字は画像でも渡す
- スタンプを、名前の表記で渡し、画像として見られる形式のスタンプは画像としても渡す
- GIF の埋め込みを、表記と静止画のサムネイルで渡す
- 過去のメッセージのカスタム絵文字、スタンプ、GIF を `view_attachment` で開けるようにする
- 返信の中でモデルが書いた `:name:` を、そのサーバーのカスタム絵文字に置き換える

**Non-Goals:**

- bot の返信でスタンプを送ること（Components V2 のメッセージには `sticker_ids` を付けられない）
- bot が GIF を探して貼ること（GIF の検索サービスの API キーと利用規約の扱いが要る）
- Lottie 形式のスタンプを画像にすること（描画ライブラリが要る）
- アニメーションの内容をモデルに見せること（GIF とアニメーション絵文字は静止画 1 枚として渡る）
- 絵文字の画像の枚数を設定で変えること
- 他のサーバーのカスタム絵文字を返信で使うこと

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 本文中のカスタム絵文字 | `<:name:id>` と `<a:name:id>` を `:name:` に置き換えて渡す。bot を呼んだメッセージでは、加えて絵文字の静止画（`emojis/<id>.webp`、アニメーションも静止画で取る）を、重複を除いて最大 5 個まで画像として渡す。窓の過去のメッセージでは名前だけを渡し、`view_attachment` で開けるようにする | カスタム絵文字の名前は `:a1:` や `:kusa2:` のように見た目を表さないことが多く、絵文字だけのメッセージでは画像が唯一の内容になる。一方で窓の全メッセージの絵文字を画像にすると token が大きく増えるので、画像は呼ばれたメッセージに限る。ID はモデルに不要である |
| スタンプの表記 | `[スタンプ "name"]` の形で本文の後に置く。説明は添えない | 添付の表記（`[添付 m7/1: 画像 ...]`）と同じく、本文と区別できる形にする。メッセージの `sticker_items` は ID、名前、形式しか持たず、説明を得るにはスタンプごとに追加の取得が要る。名前と画像で足りる |
| スタンプの画像 | bot を呼んだメッセージのスタンプは、PNG・APNG・GIF 形式なら CDN の画像をモデルへ渡す。Lottie は表記だけにする | スタンプだけのメッセージでは、画像が唯一の内容である。Lottie は画像ファイルではない |
| GIF の埋め込み | `type: "gifv"` の埋め込みは `[GIF "provider"]` の表記にし、bot を呼んだメッセージではサムネイルを画像として渡す（取得先は下の「画像の取得先」のとおり `proxy_url` に限る） | 動画としての本体はモデルが読めない。サムネイルは静止画で、多くのモデルが読める |
| 過去のカスタム絵文字・スタンプ・GIF | 窓に入った過去のメッセージでは表記だけを渡し、`view_attachment` の対象に含めて番号で開けるようにする | 過去の添付と同じく、必要なときだけモデルが取りに行く。添付の番号の後ろに続けて番号を振る |
| 画像の取得先 | カスタム絵文字は Discord CDN の `emojis/<id>.webp`、スタンプは `stickers/<id>.png`（GIF 形式は `media.discordapp.net/stickers/<id>.gif`）、GIF は埋め込みのサムネイルの `proxy_url` だけを取得する。取得してよいホストは `cdn.discordapp.com`、`media.discordapp.net`、Discord のメディアプロキシ（`images-ext-<n>.discordapp.net`）に限り、redirect のたびに宛先のホストを確かめる。`proxy_url` が無い、または許可したホストでないときは、`thumbnail.url` に切り替えず表記だけにする | `thumbnail.url` は埋め込み元のサイトの URL で、任意のホストを指しうる。既存の `view_attachment` も取得先を Discord の CDN に限っている（`src/services/conversationWindow.ts` の `isDiscordCdnHost`）。絵文字は WebP で上げられたものが PNG では取れず、WebP はどの絵文字でも取れる |
| 返信での絵文字 | 返信の本文をページに分ける前に、単独で書かれた `:name:` のうち guild のカスタム絵文字の名前に一致するものを `<:name:id>`（アニメーションは `<a:name:id>`）に置き換える。コードブロック、インラインコード、既にある `<...>` の Discord の表記（メンション、絵文字、タイムスタンプ）、URL（自動リンクと Markdown のリンク先）の中は置き換えない。`:name:` の前後が英数字や `_` のときも置き換えない | モデルに ID を書かせない。一致しない `:name:` はそのまま残るので、誤った絵文字にはならない。既存の表記や URL の中を置き換えると、`<<:ok:id>id>` のような壊れた表記やリンク切れになる |
| モデルへの絵文字一覧 | guild のカスタム絵文字の名前を、system メッセージに最大 50 個まで並べる。置き換えにも同じ一覧を使う。bot が使えない絵文字（利用ロールの制限があり bot がそのロールを持たないもの、`available: false` のもの）は除く | 名前を知らないとモデルは使えない。数百個あるサーバーでも token を抑える |
| 絵文字一覧の鮮度 | 一覧は `guild.emojis.fetch()` で REST から取り、guild ごとに 5 分だけ手元に持つ。gateway のキャッシュは使わない | bot は `GuildExpressions` intent を持たないので、起動後の絵文字の追加、変更、削除はキャッシュに届かない。intent を足しても、discord.js 14.26.5 は `available` だけが変わった更新をキャッシュに反映しない（`GuildEmoji#equals` が `available` を比べない）。REST の一覧は 1 回の取得で全部が新しくなり、5 分の保持で応答ごとの取得を避ける |

## Design

### 変更対象ファイル

- 修正: `src/utils/discordMessageNormalizer.ts` — カスタム絵文字の置き換え、`sticker_items` と `gifv` の埋め込みの表記、`view_attachment` で開ける項目への追加
- 修正: `src/services/conversationWindow.ts` — 過去のカスタム絵文字、スタンプ、GIF を `view_attachment` で開く
- 修正: `src/services/attachmentParser.ts` / `src/bot/events/messageCreate.ts` — bot を呼んだメッセージのカスタム絵文字、スタンプ、GIF のサムネイルを画像としてモデルへ渡す
- 新規: `src/utils/customEmoji.ts` — guild の絵文字一覧の作成と、返信の `:name:` の置き換え
- 修正: `src/services/chatService.ts` — 絵文字一覧を system メッセージに入れる
- 修正: `src/bot/events/messageCreate.ts` — 返信の本文をページに分ける前に置き換えを掛ける
- テスト: 正規化、置き換え、一覧、画像の取得先の制限
- 修正: `scripts/e2e/scenarios.ts` — スタンプとカスタム絵文字のシナリオ

### 実装内容

- ページの分割は、`<:name:id>` と `<a:name:id>` を 1 つの塊として扱い、途中で切らない。いまの splitter はコードブロックだけを守り、普通の文は文字単位で切るので、表記がページの境目にかかると `<:ok:` と `123456789012345678>` に分かれて絵文字として表示されない。
- GIF の埋め込みは、Discord がメッセージの作成より後に `messageUpdate` で付けることがある。bot を呼んだメッセージの本文に `tenor.com` か `giphy.com` の URL があり、`gifv` の埋め込みがまだ無いときに限り、1.5 秒待ってからメッセージを REST で 1 回取り直す。それでも無ければ URL のまま扱う。その他の URL では待たない。
- 置き換えは、ページの分割より前の本文に掛ける。置き換えると `:ok:` が `<:ok:123456789012345678>` になって文字数とバイト数が増えるので、分割した後のページに掛けると 1 メッセージの上限を超えうる。ストリーミング中も、分割のたびに置き換えた本文を使う。途中まで届いた `:name` は一致しないのでそのまま表示され、`:` が閉じた時点で絵文字になる。
- bot 自身の過去の返信を窓に読み戻すときも、`<:name:id>` を `:name:` に戻し、絵文字を `view_attachment` の番号に並べる。bot の返信は `normalizeBotReply()` が人のメッセージとは別に正規化するので、カスタム絵文字の置き換えと番号付けは、人のメッセージと bot の返信の両方から呼ぶ共通の関数にする。
- bot を呼んだメッセージの本文には、カスタム絵文字の `:name:`、スタンプと GIF の表記を、入力の検査より前に入れる。スタンプや GIF だけのメッセージも本文があるものとして扱い、「メッセージを入力してください」で断らない。
- カスタム絵文字、スタンプ、GIF の画像は添付とは別に扱い、モデルが画像入力に対応すると分かっている（`isMultimodalCapable` が true）ときだけ渡す。false と、メタデータが取れず分からない null のときは、画像を落として表記だけで続ける。会話の窓の過去の添付と同じ扱いである。添付の画像を画像非対応のモデルで断る既存の挙動は変えない。添付はユーザが見せたいものそのものだが、絵文字やスタンプの画像は表記で意味の大部分が伝わる。
- `view_attachment` の番号は、添付を 1 から振った後に、スタンプ、GIF、カスタム絵文字の順で続けて振る。スタンプと GIF は表記に番号を含める（例 `[スタンプ m7/2: "name"]`）。本文中の絵文字は `:name:` のまま置き、本文の後に `[絵文字 m7/3: "name"]` のように番号を並べる。

## Tasks

- [ ] guild の絵文字一覧を REST から取り、5 分保持する
- [ ] カスタム絵文字、スタンプ、GIF の正規化と表記を実装する
- [ ] bot を呼んだメッセージのカスタム絵文字、スタンプ、GIF のサムネイルを画像として渡す
- [ ] 過去のカスタム絵文字、スタンプ、GIF を `view_attachment` で開けるようにする
- [ ] 絵文字一覧と、返信の `:name:` の置き換えを実装する
- [ ] テスト: 置き換えがコードの中で起きないこと、一致しない名前が残ること、bot が使えない絵文字が一覧に出ないこと、取得先が CDN とサムネイルに限られること
- [ ] e2e: テスト bot がスタンプを送り、名前か内容を答えられることを確かめる。bot にカスタム絵文字を使うよう頼み、返信に `<:name:id>` が入ることを確かめる
- [ ] 手動確認: 実クライアントで、返信のカスタム絵文字が絵文字として表示されることを確かめる
- [ ] `docs/changes/discord-expressions/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **テスト bot からのスタンプ送信（未検証）**: bot は guild のスタンプを `sticker_ids` で送れるが、テスト用のサーバーにスタンプが無ければ e2e で確かめられない。無ければ e2e を GIF とカスタム絵文字に絞り、スタンプは手動確認にする。
- **絵文字の名前の重複**: 同じ名前のカスタム絵文字が複数あるときは、置き換えに最初のものを使う。一覧にも 1 つだけ出す。

## 参照

- [Discord Sticker Resource](https://discord.com/developers/docs/resources/sticker) — `format_type`（PNG / APNG / LOTTIE / GIF）
- [Discord Image Formatting](https://discord.com/developers/docs/reference#image-formatting) — `emojis/<id>.png`、`stickers/<id>.png`、GIF 形式のスタンプの URL
- [Discord Message Resource](https://discord.com/developers/docs/resources/message) — `sticker_items`、埋め込みの `type: "gifv"`、`IS_COMPONENTS_V2` のメッセージに `sticker_ids` を付けられないこと
