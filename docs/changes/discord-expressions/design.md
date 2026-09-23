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
そのため、スタンプだけのメッセージに bot を呼ぶと、モデルには本文の無いメッセージに見える。
また、bot の返信はサーバーのカスタム絵文字を使えないので、会話の雰囲気に合わせた返しができない。

## 依存 / 関連 change

- 前提（実装済み）: [conversation-context](../conversation-context/design.md) — 会話の窓は Discord のメッセージを正規化してモデルへ渡し、過去の添付は `view_attachment` で開く。本 change はその正規化と `view_attachment` の対象を広げる
- 連携: [discord-tool](../discord-tool/design.md) — `add_reaction` がカスタム絵文字を名前で引く。本 change の絵文字一覧と同じ一覧を使う

## Goals / Non-Goals

**Goals:**

- 本文中のカスタム絵文字を、モデルが読める `:name:` の形で渡し、bot を呼んだメッセージの絵文字は画像でも渡す
- スタンプを、名前と説明の表記で渡し、画像として見られる形式のスタンプは画像としても渡す
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
| 本文中のカスタム絵文字 | `<:name:id>` と `<a:name:id>` を `:name:` に置き換えて渡す。bot を呼んだメッセージでは、加えて絵文字の画像（`emojis/<id>.png`、アニメーションは静止画）を、重複を除いて最大 5 個まで画像として渡す。窓の過去のメッセージでは名前だけを渡し、`view_attachment` で開けるようにする | カスタム絵文字の名前は `:a1:` や `:kusa2:` のように見た目を表さないことが多く、絵文字だけのメッセージでは画像が唯一の内容になる。一方で窓の全メッセージの絵文字を画像にすると token が大きく増えるので、画像は呼ばれたメッセージに限る。ID はモデルに不要である |
| スタンプの表記 | `[スタンプ "name"]` の形で本文の後に置く。スタンプの説明（`description`）があれば添える | 添付の表記（`[添付 m7/1: 画像 ...]`）と同じく、本文と区別できる形にする。説明は guild のスタンプにしか無いので、取れたときだけ添える |
| スタンプの画像 | bot を呼んだメッセージのスタンプは、PNG・APNG・GIF 形式なら CDN の画像を添付の画像と同じ経路でモデルへ渡す。Lottie は表記だけにする | スタンプだけのメッセージでは、画像が唯一の内容である。Lottie は画像ファイルではない |
| GIF の埋め込み | `type: "gifv"` の埋め込みは `[GIF "provider"]` の表記にし、bot を呼んだメッセージではサムネイル（`thumbnail.url`）を画像として渡す | 動画としての本体はモデルが読めない。サムネイルは静止画で、多くのモデルが読める |
| 過去のカスタム絵文字・スタンプ・GIF | 窓に入った過去のメッセージでは表記だけを渡し、`view_attachment` の対象に含めて番号で開けるようにする | 過去の添付と同じく、必要なときだけモデルが取りに行く。添付の番号の後ろに続けて番号を振る |
| 画像の取得先 | カスタム絵文字は Discord CDN の `emojis/<id>.png`、スタンプは Discord CDN の `stickers/<id>.png`（GIF 形式は `media.discordapp.net/stickers/<id>.gif`）、GIF はサムネイルの URL だけを取得する。それ以外の URL は取得しない | 取得先を Discord の CDN と、Discord が作った埋め込みのサムネイルに限る。サムネイルは Discord のプロキシ（`proxy_url`）を優先する |
| 返信での絵文字 | 返信を描画する直前に、本文中の `:name:` のうち guild のカスタム絵文字の名前に一致するものを `<:name:id>`（アニメーションは `<a:name:id>`）に置き換える。コードブロックとインラインコードの中は置き換えない | モデルに ID を書かせない。一致しない `:name:` はそのまま残るので、誤った絵文字にはならない |
| モデルへの絵文字一覧 | guild のカスタム絵文字の名前を、system メッセージに最大 50 個まで並べる。bot が使えない絵文字（利用ロールの制限があり bot がそのロールを持たないもの、`available: false` のもの）は除く | 名前を知らないとモデルは使えない。数百個あるサーバーでも token を抑える |
| 絵文字一覧の鮮度 | gateway intent に `GuildExpressions` を足し、キャッシュを絵文字の追加・変更・削除に追従させる | 特権 intent ではない。いまの `Guilds` だけでは、起動後の絵文字の変更がキャッシュに届かない |

## Design

### 変更対象ファイル

- 修正: `src/bot/client.ts` — intent に `GatewayIntentBits.GuildExpressions` を足す
- 修正: `src/utils/discordMessageNormalizer.ts` — カスタム絵文字の置き換え、`sticker_items` と `gifv` の埋め込みの表記、`view_attachment` で開ける項目への追加
- 修正: `src/services/conversationWindow.ts` — 過去のスタンプと GIF を `view_attachment` で開く
- 修正: `src/services/attachmentParser.ts` / `src/bot/events/messageCreate.ts` — bot を呼んだメッセージのカスタム絵文字、スタンプ、GIF のサムネイルを画像としてモデルへ渡す
- 新規: `src/utils/customEmoji.ts` — guild の絵文字一覧の作成と、返信の `:name:` の置き換え
- 修正: `src/services/chatService.ts` — 絵文字一覧を system メッセージに入れる
- 修正: 返信の描画（`src/utils/chatContainerBuilder.ts` の呼び出し側） — 確定したページの本文に置き換えを掛ける
- テスト: 正規化、置き換え、一覧、画像の取得先の制限
- 修正: `scripts/e2e/scenarios.ts` — スタンプとカスタム絵文字のシナリオ

### 実装内容

- 置き換えはストリーミング中の表示にも掛ける。途中まで届いた `:name` は一致しないのでそのまま表示され、`:` が閉じた時点で絵文字になる。
- bot 自身の過去の返信を窓に読み戻すときは、`<:name:id>` を `:name:` に戻す。本文の正規化で同じ置き換えが掛かるので、追加の処理は要らない。
- カスタム絵文字、スタンプ、GIF のサムネイルの画像は、既存の画像と同じく、モデルが画像入力に対応しない（`isMultimodalCapable` が false）なら表記だけにする。
- `view_attachment` の番号は、添付を 1 から振った後に、スタンプ、GIF、カスタム絵文字の順で続けて振る。スタンプと GIF は表記に番号を含める（例 `[スタンプ m7/2: "name"]`）。本文中の絵文字は `:name:` のまま置き、本文の後に `[絵文字 m7/3: "name"]` のように番号を並べる。

## Tasks

- [ ] `GuildExpressions` intent を足す
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
- [Discord Gateway Intents](https://discord.com/developers/docs/events/gateway#list-of-intents) — `GUILD_EXPRESSIONS`
