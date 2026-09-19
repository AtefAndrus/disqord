# Bot UI プレビュー（visual refine 用）

Bot の応答 UI（スラッシュコマンドの Embed・ボタン、チャット返信の Components V2 Container・整形テキスト）を **Discord 風に描画して PNG 化**するツール。人間が Discord で目視確認していたデザインチェックを、Claude（や開発者）が画像として確認・refine できるようにする。

## 使い方

```bash
bun run preview
```

- 出力先: `.preview/`（gitignore 済み）
  - `<id>.png` — 各 UI 状態のスクリーンショット
  - `<id>.payload.json` — その状態の Discord ペイロード（builder の `.toJSON()`）。構造の差分レビュー・回帰用
  - `index.md` — 全 PNG を並べたギャラリー

Claude は生成された PNG を読んでデザインを視認し、`src/utils/` の UI 生成関数を直接 refine → `bun run preview` で再描画、というループを回せる。

## 初回セットアップ

```bash
bunx playwright install chromium   # ブラウザ本体（リポジトリには含めない）
```

CJK フォント（Noto Sans JP woff）は初回実行時に `scripts/preview/fonts/` へ自動ダウンロードされる。

## 仕組み

1. `fixtures.ts` が **実際の Bot UI 生成関数**（`buildStatusMessage` / `createEmbed` / `buildStreamingContainer` / `buildFinalContainer` / `splitTextIntoMessages` …）を呼び、`.toJSON()` でペイロードを得る
2. `payloadToMarkup.ts` がペイロードを [@skyra/discord-components-core] のマークアップへ変換
3. `render.ts` が Bun でコンポーネントをバンドルし、Playwright(Chromium) で描画してスクショ

UI 関数を改修すれば fixture の出力が変わり、プレビューに即反映される。

## 回帰テスト

`tests/unit/scripts/previewMarkup.test.ts` と `tests/unit/scripts/previewFixtures.test.ts` が、ブラウザを起動せずに次を検証する。

- マークダウン変換: 連続する見出し、見出し直後の箇条書き、見出し直後の余分な改行、見出し内の絵文字（退避の入れ子）、入力に退避用の私用領域文字が混ざった場合
- Components V2 変換: Container のアクセントカラー、Separator の `divider` 既定値、Section accessory の ActionRow ラッパ
- fixture: すべての fixture が描画でき退避プレースホルダを残さないこと、`chat-final-long` が複数 message へ分割されページ番号フッターを持つこと

描画の見え方そのもの（余白・折り返し・フォント）は PNG の目視でしか確認できない。テストが見ているのは構造だけである。

## fixture の追加

`fixtures.ts` の `buildFixtures()` に 1 件追加するだけ。実際の UI 関数を呼び、Embed なら `pack(embeds, components)`、Components V2 の Container なら `packContainers(containers)` で包む。Container は 1 個が message 1 通に対応する（`toComponentsV2Payload` と同じ構造）。

## 忠実度の注意（近似であること）

これは Discord 本体の描画ではなく **近似**。以下は実機と差が出る可能性がある。

- inline フィールドは Discord 同様 3 列グリッドだが、1〜2 個時の引き伸ばしは未再現（常に 1/3 幅）
- Components V2（Container / TextDisplay / Separator / Section）は @skyra/discord-components-core に該当要素が無く、`render.ts` の CSS で Embed と同系のボックスとして近似している。角丸・余白・アクセントバーの太さは実機と一致しない
- Section の accessory は Button のみ対応（Thumbnail は Bot が未使用のため描画しない）
- Premium(SKU) ボタンはラベルの無い secondary ボタンとして描画される（SKU 名や価格は再現しない）。Bot が未使用のため未対応のままにしている
- フォントは Noto Sans JP 単一ウェイト。実機の gg sans とは字形が異なり、`@font-face` が `font-weight: 100 900` を宣言しているため Chromium は合成ボールドを作らず、**太字は太く描画されない**
- 順序付きリスト（`1.`）は素のテキスト表示（`-` 箇条書きのみ中黒に変換）
- カスタム絵文字（`<:name:id>`）・アニメーション絵文字は未対応（unicode 絵文字のみ Twemoji 化）
- モバイル表示・実ユーザーアバター・添付ファイル/画像プレビューは対象外
- テーブル記法は Discord 自体が未対応のため、本ツールも実機同様に生表示

対応済みの整形: Embed/ボタン/フィールド3列グリッド・Components V2 の Container/TextDisplay/Separator/Section・見出し（H1-H3、Embed の description と TextDisplay のみ。Discord は field では未対応）・太字/斜体・インラインコード/コードブロック・チャンネル/ユーザー/ロールメンション・`<t:unix:style>` タイムスタンプ（style 省略時は実機同様に絶対日時）・footer タイムスタンプ・`<url>` 抑制リンク・素の URL 自動リンク・`-` 箇条書き・unicode 絵文字（本文/ボタン、国旗・肌色・キーキャップ・ZWJ 連結を含む）。属性値は全て `"` までエスケープ済み。

ピクセル等価が必要な最終確認は、テストサーバへ実送信して目視するのが確実（ユーザーアカウントの自動操作＝selfbot は Discord ToS 違反のため不可）。

[@skyra/discord-components-core]: https://github.com/skyra-project/discord-components
