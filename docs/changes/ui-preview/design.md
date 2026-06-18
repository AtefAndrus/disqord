---
title: "Bot UI プレビュー（visual refine）"
status: implemented
priority: low
summary: "プレビュー描画基盤（残タスクは任意項目のみ）"
---

# Bot UI プレビュー（visual refine）

## Why

Discord Bot の応答 UI（Embed・ボタン・整形テキスト）は、コードからは最終的な見た目が分からず、デザイン変更のたびに人間が Discord 上で目視確認していた。これを Claude Code から「Claude がどう描画されるかを画像で確認 → UI 生成関数を refine」できるようにし、目視チェックの手戻りを減らす。

## Goals / Non-Goals

**Goals:**

- 実際の UI 生成関数（`embedBuilder` / `statusMessage` / `buttonBuilder`）の出力を Discord 風に描画して PNG 化し、Claude が `Read` で視認できる状態にする
- 代表的な UI 状態を fixture 化し、`bun run preview` で一括生成する
- UI 関数を変更すれば出力に即反映されるループ（編集 → 描画 → 視認 → 再修正）を成立させる

**Non-Goals:**

- ピクセル等価の再現（後述のとおり近似に留める）
- CI 回帰ゲートへの組み込み（今回は見送り。ローカルの refine ループに集中）
- Discord 実機への自動送信・自動キャプチャ（ToS 上不可能なため、後述）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 描画方式 | discord-components + Playwright(Chromium) | 公式の描画ツールは存在せず、selfbot は ToS 違反。実ブラウザ + コミュニティ標準コンポーネントが selfbot 抜きで最も忠実 |
| 描画ライブラリ | `@skyra/discord-components-core` v4 | Embed/ボタン/フィールド3列/メンション等を網羅。discord.js 公式ガイドも採用。Lit 製で import 副作用で登録される。**legacy components 専用で Components V2 は非対応**（V2 化する UI のプレビューは別途要検討、下記） |
| バンドル | `Bun.build`（target=browser）で 1 回バンドル → ページ注入 | Stencil/Lit の bare import を file:// で解決する問題を回避。ネットワーク非依存 |
| CJK フォント | Noto Sans JP woff を `@font-face` で `gg sans` 名に割当 | コンポーネントのフォントスタック先頭が `'gg sans'`。同名で登録すれば OS フォント導入や Shadow DOM 貫通なしで豆腐回避 |
| 絵文字 | unicode → Twemoji 画像 URL | Noto Sans JP に絵文字グリフが無く豆腐化するため。Discord も Twemoji 系画像 |
| fixture の素材 | 実 UI 関数を直接呼ぶ | プレビューが本物のコードを反映し、改修が即反映されるようにするため |
| Satori + resvg | 不採用 | ブラウザ非依存だが Discord CSS の自前再現で忠実度が落ちる。探索後に devDeps から除去 |
| 実 Discord 自動キャプチャ | 不採用 | Bot はクライアント UI にログインできず、ピクセル取得には selfbot が必要＝ToS 違反・BAN リスク |

## Design

### 構成（`scripts/preview/`）

| ファイル | 役割 |
| -------- | ---- |
| `fixtures.ts` | 実 UI 関数を呼ぶ代表 11 状態。`.toJSON()` でペイロード化 |
| `payloadToMarkup.ts` | ペイロード → discord-components マークアップ（markdown/メンション/タイムスタンプ/絵文字変換を内包） |
| `render.ts` | コンポーネントを `Bun.build` でバンドル → Playwright で描画 → 要素スクショ |
| `index.ts` | エントリ。フォント自動 DL・PNG/JSON 出力・`index.md` ギャラリー生成 |
| `glue.ts` | バンドルエントリ（`import "@skyra/discord-components-core"`） |
| `fonts/` | Noto Sans JP woff（gitignore・初回自動 DL） |

実行: `bun run preview` → `.preview/<id>.png` / `<id>.payload.json` / `index.md`（すべて gitignore）。

### 描画フロー

1. `fixtures.ts` が UI 関数を呼びペイロード取得
2. `payloadToMarkup.ts` がマークアップへ変換
3. `render.ts` が Chromium ページにマークアップ設定 → バンドル注入 → カスタム要素定義待ち → フォント/ネットワーク待ち → `<discord-messages>` をスクショ

### 対応している整形

Embed（color/title/author/description/fields/footer/thumbnail/image）、ボタン（4 スタイル + unicode 絵文字 + リンク + disabled）、string select、見出し（H1-H3、description のみ）、太字/斜体、インラインコード/コードブロック、チャンネル/ユーザー/ロールメンション、`<t:unix:style>`（style 省略時は実機同様に絶対日時）、footer タイムスタンプ、`<url>` 抑制リンク、素の URL 自動リンク、`-` 箇条書き、本文 unicode 絵文字（国旗・肌色・キーキャップ・ZWJ 連結を含む Twemoji）、inline フィールドの 3 列グリッド。

変換は「インライン要素（コード・リンク・メンション・タイムスタンプ・絵文字・見出し）を先に退避してから太字/斜体/箇条書きを適用 → 復元」する方式。後段の装飾正規表現が前段で挿入したタグ（特に URL の href）を壊さない。属性値は全て `"` までエスケープし、タイムスタンプは不正値で NaN を出さない。

### 既知の忠実度ギャップ（近似であること）

- inline フィールド 1〜2 個時の引き伸ばし未再現（常に 1/3 幅）
- フォントは Noto Sans JP 単一ウェイト（太字は合成、字形は gg sans と異なる）
- 順序付きリスト（`1.`）は素表示、テーブルは Discord 自体未対応のため実機同様に生表示
- カスタム/アニメーション絵文字、モバイル表示、実アバター、添付プレビューは対象外
- 見出しは embed description のみ描画（Discord は field value では未対応 [discord-api-docs#7167]）
- **Components V2（Container / TextDisplay / Section / MediaGallery / Separator / File）は未対応**: `@skyra/discord-components-core` v4 は legacy components（Embed / ボタン / select 等）専用で、V2 コンポーネントのブラウザ描画は提供しない（v4 系・upstream に V2 対応の予定も確認できず）。ブラウザ用の V2 Web Component ライブラリは 2026-06 時点で存在が確認できない（`discord-components-v2` 等は JSON ペイロード生成用でブラウザ描画ではない）

ピクセル等価が必要な最終確認は、テストサーバへ実送信して目視するのが確実。

### 環境前提

- 初回 `bunx playwright install chromium` が必要（ブラウザ本体はリポジトリ非同梱）
- WSL/Linux で `sudo` 不要・headless shell + `--no-sandbox` で起動可
- devDeps: `playwright`, `@skyra/discord-components-core`

## Tasks

- [x] 描画方式の調査（公式ツール有無・実 Discord 可否）と方式決定
- [x] 変換器・fixture・レンダラ・オーケストレータの実装
- [x] 代表 11 状態の fixture（status/help/model/config/error/streaming/応答長短）
- [x] 忠実度改善（3 列グリッド・絵文字カバレッジ・見出し・footer 時刻・素URL自動リンク・箇条書き）
- [x] 堅牢性修正（href 等の属性エスケープ・装飾regexのタグ破壊防止・NaN ガード・原子的フォントDL・fixture 単位の失敗隔離・画像デコード待ち・列挙体使用）
- [x] README（使い方・忠実度注意）
- [ ] （任意）inline フィールド 1〜2 個時の引き伸ばし再現
- [ ] （任意）順序付きリスト（`1.`）の番号リスト描画
- [ ] （任意）リリース通知 Embed の fixture 化（`createReleaseEmbed` は private のため要 export 検討）
- [ ] （要検討）Components V2 プレビュー対応: chat-response-v2 / code-execution / conversation-context / model-compare が V2 化するとチャット返信 UI がプレビュー対象外になる。`@skyra/discord-components-core` v4 が未対応のため、(a) V2 専用のブラウザ描画ライブラリ調査、(b) Container/TextDisplay/Section を模した自前 HTML/CSS テンプレート、(c) `payload.json` の構造ダンプ表示、のいずれかを別途設計する
- [ ] （任意・今回見送り）CI 回帰ゲート（`payload.json` スナップショット差分）
- [ ] `docs/changes/ui-preview/` 削除（リリース完了時、git 履歴がアーカイブ）
