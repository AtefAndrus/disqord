---
title: "対話UX改善（会話履歴）"
status: in-progress
priority: high
summary: "直近の会話を Discord から読んで渡し、それより前と過去の添付はモデルが tool で取りに行く"
---

# 対話UX改善（会話履歴）

## Why

Bot への発言ごとに文脈を説明し直さずに済むよう、同じチャンネルの直前の会話をモデルに渡す。
「↑」や「上の話」のように、Bot をメンションしていない直前の発言を指すことも多いので、応答対象になった発言だけでなく、チャンネルの会話そのものを渡す。
一方、会話を毎回まるごと送ると、長い会話や大きな添付のたびに入力が膨らむ。
既定では直近の会話だけを渡し、それより前の発言と過去の添付は、必要なときにモデルが tool で取りに行く。

会話の本文は Discord から毎回読み、Bot の DB には持たない。
Discord が今残っている会話をそのまま返すので、本文の複製とその同期を Bot が持たずに済む。
利用者が消した発言は、次に読むときには Discord から返らない。
DB に残すのは、分割した Bot の返答をまとめるための、本文を持たない管理記録だけである。

OpenRouter の Responses API は会話状態をサーバ側へ保存せず（`store` は `false` 固定）、`previous_response_id` に値を入れたリクエストは HTTP 400 で拒否される（OpenAPI 定義の `ResponsesRequest`）。
そのため会話は毎回の `input` に載せる。

## 依存 / 関連 change

- 前提（リリース済み）: [Responses API への移行](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/responses-api-migration/design.md) — `runToolLoop()`（`src/llm/toolLoop.ts`）と `ToolRegistry`（`src/llm/tools/registry.ts`）。client tool は 1 つも登録されていない
- 連携: [Web 検索](../web-search/design.md) — Web 検索 ON 時の system メッセージは、変わらない指示を先頭に、現在日時を今回の発言の直前に置く（prompt cache の先頭を毎分変えないため）
- 連携: [discord-tool](../discord-tool/design.md) — 同 change の `fetch_recent_messages` / `fetch_more_context` の役割は本 change の `read_earlier_messages` が担う
- 連携: [view-image-rehydration](../view-image-rehydration/design.md) — 過去の画像を見直す役割は本 change の `view_attachment` が担う
- 後続: [conversation-regeneration](../conversation-regeneration/design.md) / [fork](../fork/design.md) — DB の会話ストアを前提にしない形で、本 change の後に設計し直す
- 連携: [使用統計](../usage-stats/design.md) — cache の読み取り・書き込み token の永続化

## Goals / Non-Goals

**Goals:**

- 今回の発言の直前の会話（Bot をメンションしていない発言を含む）を Discord から読んでモデルに渡す
- それより前の発言と過去の添付を、モデルが tool で取りに行けるようにする
- 分割した Bot の返答をまとめ、完了し、トリガーの発言と全ページが Discord に残っている返答だけを渡す
- Gemini などの暗黙の prompt cache が効くよう、同じ会話の中では送る内容の先頭を変えない
- ギルド単位の 1 つのスイッチ（既定 OFF）で有効にする
- tool に対応しないモデルでも、窓だけで答えられる

**Non-Goals:**

- 会話の本文や添付を Bot の DB に保存すること
- 応答の生成中に消された発言を、その応答から取り除くこと（次の応答からは読まれない）
- 回答の再生成、編集への追従、undo、会話の要約（compaction）、fork（それぞれ後続 change で設計する）
- DM（`DirectMessages` intent を持たない）、ボイスチャンネルのテキスト
- チャンネル単位の ON/OFF（[settings-hierarchy](../settings-hierarchy/design.md) の範囲）
- 他の bot、webhook、システムメッセージの取り込み（開発時の e2e 用 tester bot だけは例外、下記）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 会話の情報源 | 応答のたびに Discord の REST（`GET /channels/{id}/messages`）から読む。本文と添付を DB に保存しない | Discord が今残っている会話をそのまま返すので、本文の複製と、その削除や編集への同期を Bot が持たずに済む。Bot をメンションしていない発言も同じ経路で読める。本文を DB に複製する方式は、削除への追従（削除イベントの取りこぼし、写像の管理、再試行）が実装の大半を占めるうえ、未メンションの発言を扱うには別の保存が要るので採らない |
| 削除の扱い | 削除イベントは追わない。Bot の返答は、読むたびにトリガーの発言と全ページが Discord に残っていることを確かめ、どれかが欠けていれば返答ごと渡さない | 利用者が自分の発言を消したとき、それに答えた Bot の返答が元の発言を引用していても渡らないようにする。読む時点で確かめるので、Bot の停止中の削除も同じ規則で扱える |
| 応答の途中の削除と OFF | 応答の開始時に読んだ内容は、その応答の中では使い切る。応答の途中の削除やスイッチの OFF は、進行中の応答には反映せず、次の応答から反映する | 既に送った内容は取り消せない。進行中の応答（`runToolLoop()` の最大 5 ターン）を途中で止めるための監視（読み込んだメッセージの集合、削除イベントとの照合、ストリーミングの中断）は実装と検証の負担が大きく、得られるのは進行中の 1 応答の残りのリクエストに載せないことだけである |
| 窓の決め方 | チャンネルごとに窓の開始位置をメモリに持ち、同じ会話の間は開始位置を動かさずに新しい発言を後ろに足す。窓が上限を超えたときだけ開始位置を進める（下記） | Gemini の暗黙の prompt cache は先頭からの一致でしか効かず、キャッシュから読んだ入力は通常の 1/10 の料金になる（`gemini-3.8-flash` で $0.75 → $0.075 / 100 万トークン、2026-09-22 の OpenRouter のモデル一覧）。直近 N 件で切る方式は発言のたびに先頭が押し出されて、会話の部分が毎回キャッシュから外れる |
| 窓の上限 | 概算 8,000 トークン、40 件、一番古い発言が 60 分以内。どれかを超えたら、開始位置を一気に進め、概算 4,000 トークン以下、20 件以下、一番古い発言が 30 分以内の 3 つをすべて満たす所まで縮める。60 分発言が無いチャンネルは、次の発言で窓を作り直す | 開始位置を進めるたびにキャッシュが外れるので、上限に触れるたびに少しずつ進めるのではなく、次に上限に触れるまで余裕ができる所までまとめて進める |
| reply 先 | 今回の発言が Discord の reply で、返信先が窓に入っていなければ、同じチャンネルの返信先を 1 件だけ窓の後ろ（変動する部分）に足す（24 時間以内） | 利用者が明示的に指した発言は、窓の外でも渡す価値がある。窓の先頭を変えないよう後ろに置く |
| 過去の添付 | 窓や tool の結果では `[添付 m7/1: PDF "hanrei.pdf" 123 KB]` のような表記だけを渡す。今回の発言の添付は中身を渡す | 添付の中身を毎回送ると入力が膨らむ。今回の添付への質問に余計な往復を要求しない |
| tool | `read_earlier_messages` と `view_attachment` の 2 つだけ | モデルの判断を要する選択肢を増やさない。どちらも「窓の外を取りに行く」という 1 つの役割に絞る |
| tool の提示 | モデルが `supported_parameters` に `tools` を持ち、スイッチが ON なら、応答の開始時から 2 つとも提示する | tool の一覧は `runToolLoop()` の開始時に固定される。添付の有無で出し分けると、後から読んだ発言の添付を開けない |
| tool に対応しないモデル | tool を出さず、窓と reply 先だけで答える。窓の上限は tool 対応モデルと同じ | 窓を別の規則にすると、同じチャンネルでモデルを切り替えたときに開始位置の扱いが分かれる |
| 返答の管理記録 | 本文を持たない記録を DB に置く: トリガーの message ID、返答ページの message ID と順序、総ページ数、状態（pending / completed / stopped / failed）、確定時刻。スイッチが ON の間だけ作る。確定時刻から 24 時間で消す | Bot の返答は複数の Discord メッセージに分かれ、Discord のメッセージだけでは、どのページが同じ返答か、どの発言への返答か、完了したかが分からない |
| 渡す Bot の返答 | 記録があり、状態が completed か stopped で、確定時刻が今回の発言より前で、登録されたページ数が総ページ数と一致し、トリガーの発言と全ページが Discord に残っているものだけ | 記録の書き込みが一部だけ失敗した返答や、完了しなかった返答、削除された発言への返答を渡さない。どの条件でも迷ったら渡さない側に倒す |
| Bot 自身の削除 | 最終描画で余ったページや、失敗した応答の後始末のページは、Discord の削除を呼ぶ前に記録から外し、総ページ数に数えない | 自分で消したページを「欠けたページ」と数えて、正常な返答を渡さなくなることを防ぐ |
| 同意 | ギルド単位の 1 つのスイッチ `history_enabled`（既定 0）。意味は「Bot をメンションしていない発言を含む直近の会話を LLM に送る」 | 身内向けの bot で、管理者 1 人の判断で足りる。チャンネル単位の同意は設けない。Discord 上の設定の応答には注意書きを出さず、送る範囲は運用者向けに README に書く |
| 認可 | 窓と tool の読み取りの前に、Bot と呼び出した利用者の両方が、そのチャンネルで `ViewChannel` と `ReadMessageHistory` を持つことを確かめる。private thread では、さらに呼び出した利用者がそのスレッドの参加者であるか `ManageThreads` を持つことを確かめる | Bot の権限で読むので、呼び出した利用者が読めない履歴を Bot 経由で読ませない |
| 認可に使う所属ロール | 今回の発言に付いてきた所属ロールを、その応答の間は使う。応答の途中で利用者のロール所属が変わっても、反映は次の応答からになる | ロールの権限変更とチャンネルの上書き変更は gateway のイベントで反映されるので、tool の呼び出しごとの判定に効く。反映されないのは利用者のロール所属の変更だけで、これを追うには `GuildMembers` intent か、tool の呼び出しごとのメンバーの強制取得が要る。後者は 1 応答 12 回の REST 予算を最大 5 回消費する。露出は 1 応答の間に限られ、応答の途中の削除やスイッチの OFF と同じ扱いにする |
| 非信頼データ | 過去の発言、表示名、添付の中身、Bot 自身の過去の返答を、引用資料として渡す。system の指示には昇格させず、過去の発言を今回の依頼として扱わせない | 他人の発言や添付にはプロンプトインジェクションが含まれうる |
| session_id | 窓と同じくチャンネルごとにメモリで UUID を持ち、窓を作り直すときに作り直す。Responses API の top-level `session_id` として送る。永続化しない | OpenRouter はキャッシュが効いたプロバイダに後続のリクエストを寄せる（sticky routing、10 分使われなければ解除）。窓と同じ区切りにすることで、同じ窓の間は同じプロバイダに寄る |
| 明示的なキャッシュ | `cache_control` などは送らず、暗黙のキャッシュだけを使う | Gemini の明示的なキャッシュは書き込みと 5 分間の保存に料金が掛かる。窓の先頭を固定すれば、暗黙のキャッシュで足りるかを先に測る |
| 運用上の上限 | 1 応答あたり、Discord の REST（履歴の取得、個別のメッセージの取得、添付を得るためのメッセージの取り直し）は 12 回まで。CDN からの添付のダウンロードはこれに数えず、下記のバイト数の上限で抑える。窓の取得は 5 秒で打ち切り、取れなければ今回の発言だけで答える。discord.js の REST キューに任せ、`retry_after` に従う | ユーザごと・ギルドごとの追加の制限は、今の規模では設けない。1 応答の上限は同時に走る応答の総量までは抑えないので、待ち時間や 429 が問題になった時点で改めて検討する |

## Design

### 1. 窓

チャンネルごとにメモリに次を持つ: 窓の開始位置（message ID）、`session_id`、最後に使った時刻。

1. `history_enabled` が 0 なら何もしない。リクエストは今回の発言だけになる。
2. 認可を確かめる（Decisions「認可」）。満たさなければ今回の発言だけで答える。
3. 今回の message ID を上限として固定する。応答の途中で投稿された発言は取り込まない。
4. チャンネルの状態が無いか、最後に使ってから 60 分を過ぎていれば、今回の発言の直前から遡って、縮めた後の上限（概算 4,000 トークン、20 件、30 分）に収まる所を新しい開始位置にし、`session_id` を作り直す。
5. 開始位置から今回の発言の直前までを、`after = 開始位置の 1 つ前` から古い順に取得する（1 回 100 件まで、ページが続く限り、REST の上限まで）。
6. 適格性の判定（下記 3）を通った発言だけを残す。
7. 残した発言が上限（Decisions「窓の上限」）のどれかを超えていたら、開始位置を、縮めた後の 3 つの条件をすべて満たす所まで進める。候補の開始位置は発言の位置（分割した返答は 1 ページ目）で、古い方から順に試す。
   窓の中身は開始位置だけで決まる: 開始位置以降の人の発言と、全ページが開始位置以降にある Bot の返答である。トリガーが開始位置より前にある返答も、全ページが開始位置以降にあれば含める。縮めるときと、次の応答で同じ窓を延長するときで同じ規則を使うので、縮めて外した発言が次の応答で窓の途中に戻ることはない。
8. reply 先を足す（Decisions「reply 先」）。

並びは「不変の system メッセージ → tool の定義 → 窓の引用（古い順）→ reply 先 → 変動する system 情報（現在日時など）→ 今回の発言」とする。
同じ窓の間は、既に引用した発言の内容と適格性が変わらない限り、窓の引用の部分が前回の送信の先頭と一致し、後ろに発言が足されるだけになる。毎回 Discord から読むので、発言の削除や編集、表示名の変更、前回は未完了だった返答が完了したことなどで、先頭が変わることはある。

#### 上限の数え方

- 件数は、適格性の判定を通った発言の件数で数える。分割した Bot の返答は 1 件と数える。窓、reply 先、tool の結果のすべてで同じ数え方をする。
- tool のページングで既に見せた reply 先に再び達したときは、参照だけを返し、件数に重ねて数えない。
- 概算トークンは、発話者ラベル、参照 ID、添付の表記を含めた、実際に渡す文字列で数える（ASCII は 4 文字 1 トークン、それ以外は 1 文字 1 トークン）。
- REST の回数は、アプリから discord.js の REST を呼んだ回数で数える。discord.js が内部で行う再試行は数えない。

### 2. Discord のメッセージの正規化

- 人の発言: `content` を本文とし、表示名（サーバーのニックネーム、無ければユーザ名）を発話者ラベルにする。ラベルは改行と制御文字を除き 32 字で切る。
- Bot の返答: Components V2 で送っているので `content` は空である。各ページの Container の中の TextDisplay から回答本文を取り出し、Separator の後ろのフッター（トークン数、費用、ページ番号など）を除く。先頭のモデル名の表示は、記録で 1 ページ目と分かるページからだけ除く。フッターの判定は `scripts/e2e/scenarios.ts` の `footerOf()` と同じ構造の判断で、本体のコードに共通の関数として置き、e2e からも使う。
- 分割した返答は、記録のページ順でつなげて 1 つの返答として渡す。
- 添付は、1 始まりの番号、種別（画像、PDF、その他）、ファイル名、サイズだけを表記する。元の CDN URL はモデルに見せない。
- 各発言には、この応答の中だけで通じる参照 ID（`m1`、`m2` …）を振る。

### 3. 適格性の判定

窓、reply 先、`read_earlier_messages` のすべての経路で、同じ関数で判定する。

- 人の発言: 対象（他の bot、webhook、システムメッセージは除く）。
- 開発時の e2e: `E2E_TESTER_BOT_ID` の bot の発言は人の発言として扱う。`NODE_ENV=production` ではこの設定を読まない（`messageCreate` の既存の扱いと同じ）。
- Bot の返答: Decisions「渡す Bot の返答」の条件をすべて満たすときだけ対象。トリガーの発言が取得した範囲に無ければ `GET /channels/{id}/messages/{id}` で確かめ、404 なら渡さない。ページも同じ。確かめられない（REST の上限、5xx、timeout）ときも渡さない。
- 人の発言ごとに、それをトリガーとする管理記録を引く。記録があり、その返答ページのどれかが Discord に無い（404）ときは、外部から消されたとみなし、トリガーの発言と返答を、窓・reply 先・tool のすべての経路から外す。ページが全部消された場合も、記録から引いたページが 1 つも取得できないので同じ扱いになる。記録上のページのうち Bot 自身が消したものは、Decisions「Bot 自身の削除」により記録に残っていないので数えない。
- 返答を渡さない理由が外部削除以外（未完了、失敗、記録の欠け、確定時刻が今回の発言より後、窓の境界、確かめられない）のときは、トリガーの発言そのものは渡す。
- 返答が窓の境界で一部のページしか入らない場合は、返答ごと窓から外す（半端に渡さない）。

### 4. tool

#### `read_earlier_messages`

- 引数: `count`（整数、既定 5、1〜20）。数えるのは、適格性の判定を通った発言の件数（分割した Bot の返答は 1 件）。
- この応答で見せた範囲（窓と、それまでの tool の結果）より前の発言を、新しい方から `count` 件、古い順に並べて返す。
- 応答の中で、REST で走査した一番古い message ID（カーソル）と、取得したがまだ見せていない適格な発言（バッファ）を持つ。バッファから先に返し、足りなければカーソルより前を `before = カーソル`、`limit = 100` で取得してカーソルを進める。適格でない発言だけのページでも、カーソルは進む。
- reply 先はカーソルに影響させない。後でページングが reply 先に達したら、既に見せた発言として参照 ID だけを返し、本文を重ねない。
- 1 応答の中で呼べるのは 3 回まで。モデルに見せる発言は、窓（最大 40 件）、reply 先、tool の結果を合わせて 60 件まで。過去 24 時間より前は返さない。
- 返り値は古い順の JSON で、12 KiB 以内に収める。収まらない分は、古い方の発言をバッファに戻して `has_more: true` を返す。1 件で 12 KiB を超える発言は、本文を切り詰めて `truncated: true` を付ける。

```json
{
  "messages": [
    {
      "ref": "m7",
      "author": "田中",
      "kind": "user",
      "time": "2026-09-22T10:00:00+09:00",
      "text": "この資料について",
      "attachments": [{ "index": 1, "kind": "pdf", "filename": "hanrei.pdf", "size_bytes": 123456 }],
      "truncated": false
    }
  ],
  "has_more": true,
  "stop_reason": null
}
```

- `stop_reason` は、回数の上限、件数の上限、24 時間、権限が無い、取得に失敗した、のどれかを区別して返す。Discord は `ReadMessageHistory` が無いと空の配列を返すので、空の配列だけを「履歴が無い」とは扱わない。

#### `view_attachment`

- 引数: `message_ref`（この応答で見せた参照 ID）、`attachment_index`（1 始まり）。任意の URL、チャンネル ID、見せていない message ID は受け付けない。
- 参照 ID と番号を、最初に見せた時点の Discord の `attachment.id` に固定して解決する。メッセージを取り直した後に添付の並びが変わっても、別の添付に切り替えない。
- 認可を確かめてからメッセージを取り直し、新しい署名付き URL を得る。添付が消えていたら `unavailable` を返す。
- 対応形式は PNG / JPEG / GIF / WebP と PDF。1 応答で開ける過去の添付は異なる 2 件まで（失敗した呼び出しも数える）、画像 1 件 8 MiB、PDF 1 件 20 MiB まで。取得先のホスト（Discord の CDN）、redirect 先、MIME、実際のバイト数を確かめる。同じ添付を 2 度取得しない（2 度目は取得済みと返す）。
- 画像は、モデルが画像入力に対応すると判定できたとき（`isMultimodalCapable(model, "image") === true`）だけ返す。そうでなければ、文字列の tool エラーを返す。
- 結果は Responses API の `function_call_output` の `output` に、`input_image` / `input_file` の part の配列として返す（OpenAPI の `output` がこの形を許すことは確認済み）。
- 取得した中身は、その応答の中だけで使い、次の発言では表記に戻る。

### 5. tool 基盤の拡張

- `IToolHandlerResult.llmResult`（`src/llm/tools/registry.ts`）を、文字列だけでなくマルチモーダルの part の配列も返せるようにする。
- dispatcher（`src/llm/tools/toolHandler.ts`）の 16 KiB の切り詰めは文字列の結果にだけ適用し、part の配列にはバイト数の上限を別に適用する。
- `toResponsesInput()`（`src/llm/openrouter.ts`）の `function_call_output` の変換を、part の配列に対応させる。
- `file-parser` plugin は、今は最初の入力に file part があるときだけ付く。tool の結果で PDF を返しうる応答（`view_attachment` を提示する応答）では最初から付ける。
- Responses API の `function_call_output` の `output` に `[{ type: "input_file", filename, file_data: "data:application/pdf;base64,..." }]` を入れた PDF は、`plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }]` をリクエストに付けた場合だけモデルに読み取られることを、2026-09-22 に `google/gemini-3.8-flash` で確認した（plugin ありでは正しく回答し、なしでは PDF がモデルに届かなかった）。
- したがって `view_attachment` を提示する応答では、最初のリクエストから `file-parser` plugin を付ける。
- `function_call_output` の `output` に `[{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,..." }]` を入れた画像は、同日同モデルで plugin なしでも正しく読み取られることを確認した。

### 6. 返答の管理記録

```sql
CREATE TABLE reply_records (
  trigger_msg_id  TEXT PRIMARY KEY,         -- 返答した発言の message ID
  channel_id      TEXT NOT NULL,
  guild_id        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('pending','completed','stopped','failed')),
  page_count      INTEGER,                  -- 確定時の総ページ数。pending の間は NULL
  finalized_at    INTEGER,                  -- 確定時刻（ms）。pending の間は NULL
  created_at      INTEGER NOT NULL
);
CREATE TABLE reply_pages (
  page_msg_id     TEXT PRIMARY KEY,
  trigger_msg_id  TEXT NOT NULL REFERENCES reply_records(trigger_msg_id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL CHECK(seq >= 0),
  UNIQUE (trigger_msg_id, seq)
);
CREATE INDEX idx_reply_records_finalized ON reply_records(finalized_at);
```

- スイッチが ON のギルドでだけ、生成の前に `pending` で作る。送信・追加送信のたびにページを足し、最終描画（追加送信と余ったページの削除）を終えてから、状態、総ページ数、確定時刻を書く。
- 送信の経路（初期メッセージ、ストリーミング中の追加送信、最終描画での追加送信、致命的エラー時の部分文、停止表示）と、Bot 自身の削除の経路（余ったページ、致命的エラー時の後始末、finalize 後に届いた送信）は、それぞれ 1 つの関数に集める。
- 起動時に残っている `pending` は `failed` にする（確定時刻は書かない）。`COALESCE(finalized_at, created_at)` から 24 時間を過ぎた記録は、状態によらず、起動時と 1 時間ごとに消す。窓と tool が読めるのは過去 24 時間までなので、それより古い記録は参照されない。
- 記録の書き込みに失敗しても、応答は止めない。失敗した返答は「渡す Bot の返答」の条件（記録があり、ページ数が一致する）を満たさなくなり、渡されない。
- 記録の無い Bot の返答（スイッチが OFF の間の返答、クラッシュで記録が残らなかった返答）は渡さない。

### 7. session_id と prompt cache

- `session_id` は窓と同じ区切りで作り、`runToolLoop()` の `requestFields` で全ターンに載せる。`ChatCompletionRequest` に `session_id?: string` を足す。
- 同じ窓の間は、既に引用した発言の内容と適格性が変わらない限り、送る内容の先頭（system メッセージ、tool の定義、窓の引用）が前回と一致する。窓の開始位置を進めた直後の 1 回と、tool の結果が加わった部分は、キャッシュから外れる。
- 効き具合は LLM 詳細のフッターの `Cached: N` で見る。

### 8. 本文ストアの撤去（未リリースの実装からの移行）

main には、会話の本文を DB に保存する実装がリリース前の状態で入っている。
対象は `sessions` / `turns` / `turn_messages` の各表、`src/db/repositories/conversation.ts`、`src/services/historyRecorder.ts`、`src/bot/events/raw.ts`、`src/services/attachmentParser.ts` の保存用の参照（`storageRefs` と `PersistedAttachmentRef`）、`GuildSettingsRepository.setHistoryEnabled()` の `DELETE FROM sessions`、起動時の `failPendingTurns()` と定期 sweep、`messageCreate` / `DiscordStreamingUpdater` の保存経路、`ChatService` の履歴の組み立てである。

- 本 change の実装は 1 つの PR で、読み取り元の切り替えと本文ストアの撤去を同時に行う。途中の状態（新しい読み取りが有効で、同意がまだ古い意味のまま）を main に作らないため。
- 移行は `applyMigrations()` の中で、`turns` 表が存在するときだけ、1 つの transaction で `turn_messages` / `turns` / `sessions` を DROP し、`guild_settings.history_enabled` を 0 に戻す。`turns` 表の有無で判定するので、2 度目の起動では何もしない。新規の DB では `turns` 表が無いので何もしない。`history_enabled` の意味が変わるので、既存の ON を引き継がず、管理者に選び直してもらう。
- 本文ストアを前提にした e2e の説明（AGENTS.md の `history-set` / `history-recall` の節）と README の「保存する内容」の説明を、新しい挙動に書き換える。
- `/config history off` の応答（`src/bot/commands/handlers.ts`）は、削除するものが無くなるので「会話履歴を **無効** にしました。」にする。

### 9. e2e

- tester bot の発言を人の発言として扱う（3 の例外）ので、合言葉を tester bot が先に投稿しておけば、窓から読めるかを確かめられる。
- 未メンションの発言を窓から読めるかは、tester bot がメンションなしで資料を投稿し（Bot は応答しない）、続けてメンション付きで尋ねる形で確かめる。runner にメンションなしで投稿する機能を足す。
- `read_earlier_messages` と `view_attachment` は、答えの内容に加えて、LLM 詳細のフッターか bot のログで tool が実際に呼ばれたことを確かめる。

## Tasks

- [x] tool 基盤: マルチモーダルの tool 結果、dispatcher の上限、`function_call_output` の変換、`file-parser` の付与条件
- [x] tool の結果に入れた PDF を `file-parser` が扱えるかの実機確認
- [x] Discord のメッセージの正規化（Bot の返答の本文の取り出しを共通の関数にし、e2e からも使う）
- [x] 返答の管理記録と、送信・Bot 自身の削除の経路の集約
- [x] 窓（開始位置の固定、上限でのまとめ進め、60 分での作り直し）、reply 先、認可、適格性の判定
- [x] `read_earlier_messages`（カーソルとバッファ）と `view_attachment`
- [x] `session_id` と、Web 検索の system メッセージの分割
- [x] 本文ストアの撤去と、1 回だけの移行（DROP と `history_enabled` の 0 化）
- [x] README と AGENTS.md の書き換え
- [x] テスト（窓の開始位置と進め方、reply 先、適格性、Bot の返答の正規化とページの欠け、トリガーの 404、ページング、バッファ、上限の数え方、添付の解決と固定、認可、private thread、非 tool モデル、管理記録、移行を旧 DB・新規 DB・2 度目の起動で）
- [ ] e2e（未メンション発言を含む窓、`read_earlier_messages`、`view_attachment`）と runner のメンションなし投稿
- [ ] prompt cache の効き具合の実測（同じ窓で続けて尋ね、`Cached: N` と費用を記録する）
- [ ] 手動確認: 実クライアントで、未メンションの発言を指す質問、昔の発言を指す質問、過去の PDF を見直す質問、自分の発言を消した後にそれを指す質問を試す
- [ ] `docs/changes/conversation-context/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **モデルが tool を呼ばずに推測で答える**: 「取得した範囲にない過去の内容は、取得するか、分からないと答える」と指示するが、実際に tool を適切に使うかはモデル次第である。実機で評価し、足りなければ窓の上限を広げる。
- **費用と遅延**: 窓の確かめ（トリガーやページの個別取得）と tool の往復で REST と遅延が増える。1 応答あたりの費用と時間を測る。
- **Bot の停止中や、取得に失敗した返答が渡らない**: 迷ったら渡さない規則なので、確かめられない返答は文脈から抜ける。会話が欠けて見えることがある。
- **返信通知を切ったリプライでの応答（要決定）**: 返信通知を切った Bot のメッセージへのリプライ（メンションとして数えられない）にも応答させるか。

## 参照

- [Discord Get Channel Messages](https://docs.discord.com/developers/resources/message#get-channel-messages) — 新しい順、`before` / `after`、`ReadMessageHistory` が無いと空の配列
- [Discord Threads](https://docs.discord.com/developers/topics/threads#permissions) — private thread の閲覧条件
- [Discord Signed Attachment CDN URLs](https://docs.discord.com/developers/reference#signed-attachment-cdn-urls) — 添付の URL は署名付きで失効する
- [Discord Rate Limits](https://docs.discord.com/developers/topics/rate-limits)
- [OpenRouter OpenAPI 定義](https://openrouter.ai/openapi.json) — `ResponsesRequest` の `session_id`、`store`、`previous_response_id`、`function_call_output` の `output`
- [OpenRouter Prompt Caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching) — Gemini の暗黙のキャッシュ、sticky routing
