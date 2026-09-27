---
title: "数式を画像で表示する"
status: investigating  # investigating | planned | in-progress | implemented
priority: medium       # high | medium | low
summary: "返答の別行立ての数式を PNG にして本文の該当位置に差し込み、文中の数式はコードの表記にする"
---

# 数式を画像で表示する

## Why

Discord は TeX の数式を描画しない。
数学の話題では、モデルが `\[ … \]` の別行立ての数式と `\( … \)` の文中の数式を多用し、返答は記号の並んだ読みにくいテキストになる。
別行立ての数式を画像にして本文の該当位置に差し込み、文中の数式は読めるコードの表記にする。

## 依存 / 関連 change

- 連携: [画像生成](../image-generation/design.md) — 同 change は生成物を返答のページに `MediaGallery` として組み込む planner（`ResponseLayoutPlanner`）を設計している。同 change は生成物を最後のページの本文の後に置くが、本 change は数式を本文の途中に置くので、planner に「本文の位置に紐づく画像」を足す。先に実装する側が planner を作り、後の側がそれに合わせる

## Goals / Non-Goals

**Goals:**

- 返答の本文の別行立ての数式（`$$ … $$` と `\[ … \]`）を PNG にし、最終描画のときに本文の該当位置へ `MediaGallery` で差し込む
- 文中の数式（`$ … $` と `\( … \)`）は、区切りの記号を外してコードの表記（`` `…` ``）にする
- 画像の説明（alt）に元の TeX を入れ、会話の窓が bot の過去の返答を読み戻すときに数式を失わない
- 描画できない数式は、TeX のコードブロックで表示する

**Non-Goals:**

- 文中の数式の画像化。Discord は文の途中に画像を置けない
- 生成中（ストリーミング中）の数式の描画。画像は最終描画のときに作る
- 数式を Unicode の記号（x²、√ など）へ変換すること。変換できる範囲が狭く、複雑な式では誤った表示になりうる

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 構文の判定 | ox-content（`@ox-content/napi`）の構文解析で、`math: true` として数式とコードを見分ける。`\[ … \]` と `\( … \)` は、解析の前に、コードブロックとインラインコードの外にあるものだけを `$$ … $$` と `$ … $` に置き換える | ox-content は `$$ … $$` を `math`、`$ … $` を `inlineMath` として取り出し、コードの中の `$$` や `` `$y$` `` は数式にしなかった。`$5 と $10` のような金額も数式にしなかった（2026-09-27 の試行）。一方、CommonMark の規則では `\(` はエスケープとして扱われ、`\( … \)` を数式として取り出せない |
| 描画 | MathJax 4（npm の `mathjax`）で TeX を SVG にし、resvg（`@resvg/resvg-js`）で PNG にする。SVG の `data-latex` 属性は PNG にする前に取り除く | MathJax の SVG 出力は字形をパスで描くので、フォントのファイルが要らない。2026-09-27 の試行で、分数、`\pmod`、`\tag`、`\boxed`、`cases` を 1 式あたり約 20ms で描けた。MathJax 4 は `data-latex` に元の TeX を `<` をエスケープせずに入れ、resvg が SVG として読めずに失敗した（`cases` の `x<0`）。属性を取り除くと描けた |
| 色と背景 | 白地に黒の文字で、周りに余白を付ける | 利用者のテーマ（ライトかダーク）を bot は知らない。透明の背景に明るい文字にすると、ライトテーマで読めない |
| 配置 | ページの本文を数式の位置で区切り、`TextDisplay` と、数式 1 つにつき 1 つの `MediaGallery` を交互に並べる | `MediaGallery` に複数の画像を入れると横に並ぶ格子になり、式の順が読みにくい |
| 上限 | 1 メッセージの component 40 個と添付の件数の上限（10 件）に収まる数だけ画像にし、残りの数式は TeX のコードブロックで表示する。ページの分割では、数式は TeX の文字数を本文として数える | 上限は [画像生成](../image-generation/design.md) の planner が確かめたものと同じである。数式の多い証明は 10 式を超えうる |
| 画像の説明 | `MediaGallery` の項目の説明（1024 字まで）に元の TeX を入れる。会話の窓は bot の過去の返答を読み戻すとき、説明から `$$ … $$` を復元して本文に戻す | 窓は今、bot の返答の `TextDisplay` だけを読むので、画像にした数式は窓から消え、次の応答のモデルが前の式を参照できなくなる |
| 描画できない数式 | 描画の失敗（MathJax のエラー、PNG への変換の失敗）と、数式の中の日本語などの ASCII 以外の文字を含む数式は、画像にせず ```` ```tex ```` のコードブロックで表示する | 数式の中の日本語は、MathJax 3 でも 4 でも字形でなく文字コードを 16 進数で書いた箱として描かれた（2026-09-27 の試行）。サーバー側の MathJax が文字の幅を測れないためと推測する（未確認） |
| モデルへの指示 | 書式の system メッセージ（`DISCORD_FORMAT_SYSTEM_MESSAGE`）に、別行立ての数式は `$$ … $$` か `\[ … \]` で書き、数式の中に日本語を入れず説明は式の外に書くよう足す | 日本語を含む数式は画像にできないので、モデル側で避けさせる |
| 設定 | 設定の切り替えは作らず、常に有効にする | 費用が掛からず、数式が無い返答には何も起きない |

## Design

### 流れ

1. 最終描画の前に、本文の `\[ … \]` と `\( … \)` をコードの外だけ `$$ … $$` と `$ … $` に置き換える
2. ox-content で解析し、`math`（別行立て）と `inlineMath`（文中）を見つける
3. 文中の数式を、区切りを外したインラインコードに置き換える
4. 別行立ての数式を、ページの分割の後、ページごとに上限の中で PNG にする
5. ページの `Container` を、本文の区切りと画像の順に組み立てる。画像は `attachment://math_<requestId>_<連番>.png` で参照する

### 変更対象ファイル

- 新規: `src/utils/mathRenderer.ts` — TeX から PNG への描画（MathJax、`data-latex` の除去、resvg）
- 新規: `src/utils/mathSegments.ts` — 区切りの置き換え、ox-content での解析、本文の数式の位置での区切り
- 修正: `src/utils/chatContainerBuilder.ts` — 最終描画の `Container` に、本文の区切りと `MediaGallery` を交互に並べる
- 修正: `src/bot/events/messageCreate.ts` — 最終描画で数式の画像を作り、添付として送る
- 修正: `src/utils/discordMessageNormalizer.ts` — bot の返答を読み戻すとき、`MediaGallery` の説明から数式を本文に戻す
- 修正: `src/services/chatService.ts` — 書式の system メッセージに数式の書き方を足す
- 修正: `package.json` / `Dockerfile` — `mathjax`、`@resvg/resvg-js`、`@ox-content/napi` を足す。resvg と ox-content はネイティブのバイナリを使う
- 修正: `scripts/preview/fixtures.ts` — 数式を含む返答の見本（`bun run preview` で見た目を確かめる）

## Tasks

- [ ] ox-content の構文木から数式の位置を本文に対応させる方法を決める（下の Open Questions）
- [ ] 区切りの置き換えと解析、本文の区切りを実装する
- [ ] 描画（MathJax、`data-latex` の除去、resvg）を実装する
- [ ] 最終描画への組み込み（上限、添付、コードブロックへの切り替え）を実装する
- [ ] 窓で bot の返答を読み戻すときに数式を戻す
- [ ] 書式の system メッセージに数式の書き方を足す
- [ ] テスト: コードの中の `\[` と `$$` を数式にしないこと、金額の `$` を数式にしないこと、上限を超えた数式がコードブロックになること、日本語を含む数式がコードブロックになること、描画の失敗がコードブロックになること、読み戻しで数式が戻ること
- [ ] Docker イメージでネイティブのバイナリが動くことを確かめる
- [ ] 手動確認: 実クライアントで、ライトテーマとダークテーマの両方で数式の画像が読めることを確かめる
- [ ] `docs/changes/math-rendering/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **数式の位置の取り方（未解決）**: ox-content の `parse` が返す構文木には、元の文章での位置が無かった。数式を本文の該当位置で区切るには、位置を含む出力（`parseMdastRaw` など、未確認）を使うか、構文木の順に元の文章から `$$` を探して対応させる必要がある。
- **数式の中の日本語（未解決）**: 画像にできないのでコードブロックにする。MathJax の文字の幅の扱いを調べ、描ける方法が見つかれば画像にする。
- **添付の件数の上限**: 1 メッセージ 10 件は [画像生成](../image-generation/design.md) の planner の記述に拠る。本 change の実装で改めて確かめる。
- **編集での添付の重複**: 最終描画は既存のメッセージを編集して添付を付ける。[画像生成](../image-generation/design.md) の Open Questions と同じく、編集で添付が重複しないかを確かめていない。

## 参照

- [ox-content](https://github.com/ubugeeei-prod/ox-content) — `@ox-content/napi` の `parse`、`math` の設定
- [MathJax](https://www.mathjax.org/) と npm の `mathjax`（4.x）
- [resvg-js](https://github.com/thx/resvg-js)
- Discord Component Reference（`developers/components/reference.mdx`）— 1 メッセージ 40 component、Media Gallery の 1〜10 項目、項目の説明は 1024 字まで
