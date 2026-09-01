---
title: "出力マルチモーダル対応"
status: investigating
priority: medium
summary: "検証済みの生成画像と生成ファイルを Discord の MediaGallery / File で表示"
---

# 出力マルチモーダル対応

## Why

現在のチャット応答フローは、OpenRouter の応答をテキストと利用量メタデータへ正規化し、Discord の `TextDisplay` として表示する。
そのため、画像生成 server tool が生成物を返しても、検証済みデータを Discord 添付へ変換して本文と一緒に表示する契約がない。

Discord Components V2 は、アップロードした画像を `MediaGallery`、その他のファイルを `File` としてメッセージ内に表示できる。
API 固有の取得処理と Discord 固有の描画処理を分離し、検証済み成果物からメッセージを構築する基盤を独立した release 単位として設計する。

## 依存 / 関連 change

- 先行：[LLM チャット返信の Components V2 化](../chat-response-v2/design.md) は、テキスト応答の分割、ストリーミング更新、metadata 表示を担う描画基盤を提供する
- 関連：[OpenRouter サーバツール群](../server-tools/design.md) は、`openrouter:image_generation` の呼び出し方、実レスポンス、コスト制御を調査し、採用時に producer adapter を実装する画像生成 change を切り出す

## Goals / Non-Goals

**Goals:**

- 検証済みの画像とファイルを provider 固有フィールドを含まない内部成果物へ正規化する境界を定義する
- 成果物ごとの失敗理由と警告を、成功したテキストおよび成果物と一緒に最終結果へ保持する
- 生成画像を Discord の `MediaGallery`、生成ファイルを `File` として Components V2 メッセージへ組み込む
- component 数、添付数、ファイル名、編集時の既存添付を一体で扱うメッセージレイアウトを定義する
- ストリーミング中は完成した成果物だけを表示し、本文、成果物、metadata の最終状態を一貫して更新する

**Non-Goals:**

- OpenRouter API の呼び出し、外部 URL の取得、data URL と base64 の decode（producer を所有する画像生成 change で扱う）
- 画像生成 server tool を有効化する条件、パラメータ、費用警告の決定（[OpenRouter サーバツール群](../server-tools/design.md) から分割する画像生成 change で扱う）
- `/api/v1/images` と `/image` コマンドを使う独立した画像生成フロー
- client tool が生成したファイルの表示（各 tool change が自身の `ToolRenderPayload` と描画を所有する）
- 入力画像と入力 PDF の解析（[マルチモーダル対応](../multimodal/design.md)）
- 生成物の永続保存、再ホスト、履歴からの再取得
- 画像の加工、動画と音声の出力

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| release 単位 | Components V2 移行と分離した描画基盤 change とする | テキスト応答の V2 移行は完了しており、出力成果物には producer の採用、データ検証、添付レイアウトという別の完了条件がある |
| status | `investigating` | 最初の integration となる `openrouter:image_generation` の実 wire 形式と Discord 編集時の添付 reconciliation を確定する必要がある |
| producer 境界 | producer adapter が API 固有レスポンスを検証済み bytes へ変換し、本 change は外部 URL や未検証 data URL を受け取らない | URL の出所を失った共通層では SSRF 対策と producer ごとの許可 origin を適用できないため |
| 内部結果 | `artifacts` と `warnings` を持つ結果型を使い、利用量と費用は Discord upload の成否にかかわらず保持する | 一つの成果物の失敗を回答全体の失敗へ拡大せず、画像が表示されない理由をユーザとログへ残すため |
| 成功判定 | テキストまたは成果物が一つでも成功すれば警告付き成功とし、両方が空ならエラーとする | テキストを返さない producer の全成果物失敗を「応答なし」の正常終了として扱わないため |
| Discord 表示 | 実機確認済みの raster 画像は `MediaGallery`、その他のファイルは `File` を使い、`files` payload の添付を `attachment://<filename>` で明示参照する | `File` は `attachment://` 参照を必要とし、Components V2 の添付は表示 component から明示的に参照する必要がある |
| SVG | `image/svg+xml` を `MediaGallery` へ入れず、`File` として扱うか拒否する | Discord client のインライン表示可否を MIME の `image/*` だけから判断できないため |
| 代替テキスト | Unicode code point 単位で最大 1024 文字へ切り詰め、切り詰め時は末尾に省略記号を置く | `MediaGallery` item の description 上限超過で message edit 全体が失敗することを防ぐ |
| ストリーミング | partial image は Discord へ送らず、producer が完成品を検証した後に最終メッセージへ追加する | partial image ごとの再アップロードと message edit は通信量と rate limit 消費を増やす |
| ファイル名 | 応答 ID と成果物 index から一意で安定した ASCII 名を生成する | 同名添付による `attachment://<filename>` の参照衝突を防ぎ、edit の再試行で同じ成果物を識別するため |
| warning 表示 | 最終メッセージの metadata より前に専用 `TextDisplay` を置き、Markdown を escape した warning を最大 5 件、各 200 code points まで表示する。超過分は件数だけを表示する | 部分失敗をユーザへ伝えながら TextDisplay 予算と表示量を制限するため |
| upload 失敗 | message を再取得して反映済み添付を照合し、未反映成果物を一件ずつ一度だけ再試行する。失敗した成果物を除外して warning に変換し、成功分とテキストだけで再計画する | multipart request 全体の失敗と timeout 後の結果不明を成果物単位へ切り分け、無限再試行を防ぐため |
| 成果物だけの応答 | テキストが空で成果物が一つ以上ある場合は body `TextDisplay` を省略する | 成功した成果物に対して「（応答なし）」と表示しないため |

## Design

### 責任境界

```text
OpenRouter image_generation response
        │ image-generation change の producer adapter
        │ wire fixture 検証、URL 出所検証、上限付き取得、decode、magic-byte 検証
        ▼
ResponseArtifactResult
        ├ artifacts: ResponseArtifact[]
        └ warnings: ArtifactWarning[]
        │
        ▼
ResponseArtifactRenderer / ResponseLayoutPlanner
        │ component 数、添付、安定ファイル名、edit 時の保持 ID を計画
        ▼
DiscordResponseMessagePlan[]
        ├ components
        ├ files
        └ retainedAttachmentIds
```

`ResponseArtifact` は成果物種別、検証済み bytes、MIME、ファイル名、代替テキストを保持する。
外部 URL、data URL、base64 文字列、任意の Markdown URL は成果物境界へ入れない。
具体的な型は、`openrouter:image_generation` の実 wire fixture と Discord の upload 上限を確認してから確定する。

### producer adapter の不変条件

producer adapter は任意の Markdown URL を成果物へ昇格させず、API の構造化フィールドまたは検証済みの所定フィールドだけを扱う。
外部 URL を取得する場合は HTTPS と明示的な origin allowlist を要求し、redirect ごとに宛先を再検証して private、loopback、link-local、metadata endpoint の IPv4 と IPv6 を拒否する。
取得時は `Content-Length` だけに依存せず読み取り中も byte 上限を強制し、data URL と base64 は encoded length と decode 後サイズの両方を制限する。
MIME はレスポンスヘッダや文字列の宣言だけを信用せず、magic byte と許可形式を照合する。
具体的な origin、単体サイズ、合計サイズ、timeout は producer の実 fixture と Discord の upload 上限を確認して決める。

### Discord メッセージ計画

現在の `chatContainerBuilder` は固定構造を組み立て、TextDisplay の文字数と UTF-8 バイト数を管理しているが、可変個数の component は管理していない。
本 change は `ResponseLayoutPlanner` を追加し、Container の直接の子を最大 10、メッセージ全体を最大 40 components、1 `MediaGallery` を最大 10 items に収める。
非画像成果物は一つにつき一つの `File` component を消費するため、本文、Separator、metadata と合わせて上限を超える場合は追加メッセージへ分割する。

各 `DiscordResponseMessagePlan` は、そのメッセージが最終的に保持する添付と warning 表示を components と同時に定義する。
既存メッセージを編集する場合は、安定ファイル名で現在の添付を照合して保持する attachment ID と新規 upload を分け、すべての保持添付を component から参照する。
再試行前は Discord 上の現在の添付を読み直して計画を再構築し、未参照の添付を残さない。

最初の multipart edit が失敗した場合は message を再取得し、安定ファイル名と attachment ID で反映済み成果物を確定する。
未反映成果物は一件ずつ一度だけ再試行し、再び失敗した成果物を `ArtifactWarning` へ変換して除外する。
その後は成功したテキスト、成果物、warning から最終計画を作り直し、同じ成果物をそれ以上再試行しない。

warning は最終メッセージの metadata より前に専用 `TextDisplay` として置き、本文と同じ文字数および UTF-8 バイト数の予算へ含める。
warning のモデル由来部分は Markdown を escape し、最大 5 件、各 200 code points に制限し、残件は「ほか N 件」の形でまとめる。
テキストが空で成果物がある場合は body `TextDisplay` を作らず、テキストと成果物がともにない場合だけエラー表示へ進む。

### 変更対象ファイル

- 修正：`src/types/index.ts` に正規化済み成果物、警告、Discord メッセージ計画の型を追加する
- 新規：`src/services/responseArtifactRenderer.ts` に検証済み bytes から `AttachmentBuilder` を構築する処理を置く
- 新規：`src/utils/responseLayoutPlanner.ts` に本文、成果物、warning、metadata の分割と component 数の計画を置く
- 修正：`src/utils/chatContainerBuilder.ts` がメッセージ計画から `MediaGallery` と `File` を構築できるようにする
- 修正：`src/services/chatService.ts` がテキスト、利用量、成果物、警告を最終結果として返せるようにする
- 修正：`src/bot/events/messageCreate.ts` が components、新規 files、保持 attachment IDs を同じ最終更新へ渡すようにする
- 新規：`tests/unit/services/responseArtifactRenderer.test.ts` に MIME、サイズ、部分失敗、代替テキスト、安定ファイル名のテストを置く
- 新規：`tests/unit/utils/responseLayoutPlanner.test.ts` に component 上限、warning 予算、成果物だけの応答、添付分割、edit reconciliation のテストを置く
- 修正：`tests/unit/utils/chatContainerBuilder.test.ts` に `MediaGallery` と `File` の構築テストを追加する
- 修正：`tests/unit/bot/events/messageCreate.test.ts` にテキスト、成果物、警告を含む最終更新のテストを追加する

## Tasks

- [ ] [OpenRouter サーバツール群](../server-tools/design.md) で `openrouter:image_generation` の実レスポンスを fixture 化する
- [ ] image-generation change が所有する producer adapter と `ResponseArtifactResult` の境界を確定する
- [ ] Discord の添付容量と message edit の attachment 置換および保持挙動を実 API で確認する
- [ ] `ResponseArtifact`、`ArtifactWarning`、`DiscordResponseMessagePlan` の型を確定する
- [ ] raster MIME allowlist、単体および合計 byte 上限、成果物数上限を確定する
- [ ] `responseArtifactRenderer` と `ResponseLayoutPlanner` を実装し、代替テキストと warning の上限を適用する
- [ ] `chatContainerBuilder` に `MediaGallery` と `File` の構築を追加する
- [ ] ChatService と `messageCreate` の最終結果および edit 経路を拡張し、成果物単位の bounded retry と text-only fallback を実装する
- [ ] unit test と実機回帰を行う
- [ ] `docs/changes/multimodal-output/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **OpenRouter の wire 形式**：`openrouter:image_generation` の生成画像が構造化 URL、data URL、別フィールドのどれで返るかは、実レスポンスを fixture 化して確認する。
- **Discord の添付上限**：guild の upload 上限を超える場合の切り捨て順、追加メッセージ分割、警告表示を決める。
- **edit reconciliation**：Discord message edit で既存添付を保持しながら新規 file を追加する payload を実 API で検証し、再試行時に重複 upload が発生しない条件を確認する。
- **成果物の寿命**：永続保存は本 change の対象外なので、期限付き URL から取得した bytes をプロセスが失った後は同じ成果物を再描画できない。

## 参照

- [OpenRouter Image Generation Server Tool](https://openrouter.ai/docs/guides/features/server-tools/image-generation)：chat completion 内で画像生成を呼び出す server tool
- [Discord Display Components](https://discordjs.guide/legacy/popular-topics/display-components)：`MediaGallery`、`File`、`files` payload、`attachment://` 参照
- [Discord Components Reference](https://docs.discord.com/developers/components/reference)：Components V2 の component 制約
- [Discord Editing Message Attachments](https://docs.discord.com/developers/resources/message#edit-message)：message edit における既存添付の保持と新規 upload
