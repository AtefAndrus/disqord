---
title: "会話履歴の時間制限の撤廃と tool 結果の予算化"
status: planned  # investigating | planned | in-progress | implemented
priority: medium       # high | medium | low
summary: "会話履歴を 24 時間より前まで読めるようにし、tool の結果の大きさを固定バイト数ではなくモデルの context 長から決める予算で抑える"
---

# 会話履歴の時間制限の撤廃と tool 結果の予算化

## Why

会話履歴が有効な guild でも、窓、reply 先、`read_earlier_messages` はどれも今回の発言から 24 時間より前の発言を読まないので、前日以前の会話を文脈に使えない。
あわせて、`read_earlier_messages` の 1 回 12 KiB、1 応答 3 回、計 60 件という上限と、dispatcher が tool の文字列の結果を 16 KiB で切る処理は、どれもモデルの context 長と無関係の固定値で、context 長の大きいモデルでも少ししか読めず、小さいモデルではリクエストが context 超過で失敗しうる。

## 依存 / 関連 change

- 連携: [fork](../fork/design.md) — 系譜の寿命と遡りの範囲を 24 時間の制限と記録の TTL を前提に決めている。この change の後に書き直す
- 連携: [conversation-regeneration](../conversation-regeneration/design.md) — 記録が 24 時間で消える前提の判定を持つ。この change の後に書き直す

## Goals / Non-Goals

**Goals:**

- 窓、reply 先、`read_earlier_messages` から 24 時間の制限をなくし、返答の記録（`reply_records` / `reply_pages`）を無期限に持つ
- `read_earlier_messages` の `count` を 1〜100 に広げ、呼び出し回数と総件数の上限を外す
- tool の結果の大きさを、tool loop が持つリクエスト全体の context 予算で事前に抑える
- tool 側の Discord REST に窓とは別の応答全体の予算を持たせ、`read_earlier_messages` に呼び出しごとの内部の期限を持たせる
- OpenRouter が context 超過で拒否したときに、tool 無しの最終回答で 1 回だけ回復する

**Non-Goals:**

- 保持期間を設定で変えること。記録は無期限だけとし、環境変数は足さない
- 記録の件数や容量による上限
- 窓そのものの時間の規則（一番古い発言が 60 分以内、縮小後 30 分以内）の変更。古い発言は tool か reply 先で渡す
- 返答を `message.reply` で送り、Discord 側に返答とトリガーの紐付けを持たせること
- TTL で既に消えた記録の復元

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 記録の保持期間 | 期限による削除（起動時と 1 時間ごとの `deleteExpired`）をやめ、無期限に持つ | 読み取りだけを延ばすと、記録の消えた範囲で人の発言だけが見え、Bot の返答が抜ける。記録は ID と状態だけで、1 返答あたり 1 行とページ数ぶんの行なので容量は小さい |
| 記録を消す契機 | guild からの退出（`guildDelete` と起動時の突き合わせ）と、チャンネルやスレッドの削除（`channelDelete`、`threadDelete`）だけ | 返答のページやトリガーが消えたと分かったときに記録を消すと、次の応答でそのトリガーが記録の無い人の発言として再び適格になり、「返答の一部が消えたら会話ごと外す」規則が崩れる。今どおり読むたびの確認が外す |
| 拾えない削除 | キャッシュ外のスレッドの削除、停止中の削除、親チャンネルの削除に伴う配下のスレッドの削除では、記録が残るのを許す | discord.js は、キャッシュ外のスレッドにも、親の削除に伴う子にも `threadDelete` を emit しない。そのチャンネルは読まれないので、残った行は容量を使うだけである |
| 履歴を無効にしたとき | 記録を消さない。再び有効にすると、無効にする前の返答も読める | 記録は本文を持たず、読み取りは設定で止まる |
| 保持期間の設定 | 設けない | 設定できるようにすると、記録の TTL（壁時計）と読み取りの打ち切り（今回の発言の時刻）を 1 つの値で揃える規則まで要る。無期限の運用ではどれも要らない |
| 容量の上限 | 設けない。DB の大きさは監視で追う | 容量で古い記録から消すと、古い Bot の返答だけが読めなくなり、人の発言だけが残る |
| `count` の範囲 | 1〜100、既定 5 | 100 は Discord の 1 回の取得量（`limit` は 1〜100）に揃えた、1 回の応答の粒度としての判断である。`count` は適格な発言の数なので、100 件を返すのに REST が複数回要ることもある |
| 呼び出し回数と総件数 | `READ_EARLIER_MAX_CALLS`（3 回）と `READ_EARLIER_MAX_MESSAGES`（60 件）を削除する | 呼び出しの暴走は tool loop の 5 ターンと 1 ターン 8 回の上限が止める。件数は発言の大きさと対応しないので、context の量を抑える単位にならない |
| tool の結果の大きさ | tool loop が応答の開始時に context 予算を決め、残りを tool に渡し、tool が収めてから状態を確定する | 固定バイト数では、context 長の大きいモデルで読める量が少なく、小さいモデルではリクエストが失敗する。どう縮めるべきかを知っているのは結果を作る tool である |
| 出力用の予約 | アプリの既定の上限と `top_provider.max_completion_tokens` の小さい方を `max_output_tokens` として送り、同じ値を予約する | provider の最大出力をそのまま予約すると、`qwen/qwen-2.5-7b-instruct`（context 32,768、最大出力 29,491）では予約だけで context の 9 割を使う |
| dispatcher の切り詰め | 文字列の結果の 16 KiB の head+tail clip をやめ、予算を超えた結果を `result_too_large` で断る | 中間に `[truncated N bytes]` を入れても、JSON の構造と発言という意味の単位は保てない |
| tool 側の REST 予算 | 窓（12 回と 5 秒のまま）とは別に、応答全体で 1 つの予算を持ち、今の 12 回より大きくする | tool の呼び出しは 1 応答で最大 32 回、逐次に実行される。呼び出しごとに予算を与え直すと、24 時間の打ち切りが無い状態で REST と待ち時間が膨らみ、他の応答のレート制限も圧迫する |
| ページングの単位 | 1 ページ（100 件）の適格性をすべて確かめてからカーソルを進める。途中で予算か期限が尽きたらページごと取り直す | ページの途中で返すと、確認済みの古い側と未処理の新しい側が混ざり、「新しい方から count 件」と、分割した返答を先頭ページの位置まで保留する規則を守る境界を別に持つ必要が出る |
| context 超過の識別 | Responses API の失敗応答の `error_type: "context_length_exceeded"` だけで識別する | `error.code: "invalid_prompt"` は他の原因にも使われる。`error_type` を持たない HTTP 400 は区別できない |
| context 超過からの回復 | 直前に積んだ tool の結果をエラーに置き換え、`tool_choice: "none"` で最終回答を 1 回だけ求める | tool を続行すると、捨てた結果に対応する tool の状態（返した発言の記録、添付の読み込み済みの印）との矛盾を巻き戻す必要が出る |

## Design

### 変更対象ファイル

- 修正: `src/services/conversationWindow.ts` — 24 時間の打ち切りの削除、`read_earlier_messages` の予算による収め方、ページ単位の確定、tool 側の REST 予算と内部の期限
- 修正: `src/services/messageEligibility.ts` — `maxAgeMs` と `too-old` の削除
- 修正: `src/llm/tools/readEarlierMessages.ts` — `count` の範囲、`stop_reason` の値、tool の説明
- 修正: `src/llm/tools/viewAttachment.ts` — 予算による受け入れ判定
- 修正: `src/llm/tools/registry.ts` — `IToolContext` に残りの予算を載せる
- 修正: `src/llm/tools/toolHandler.ts` — 文字列の結果の clip をやめ、予算を超えた結果を断る。応答内で実行を止めた tool の管理
- 修正: `src/llm/toolLoop.ts` — context 予算の算出と差し引き、締めくくりの予約、`tool_choice: "none"` への切り替え、context 超過からの回復
- 修正: `src/llm/openrouter.ts` — 失敗応答の `error_type` の保持、`max_output_tokens` の送信、`top_provider.max_completion_tokens` の取得
- 修正: `src/services/chatService.ts` — `max_output_tokens` と予算の受け渡し
- 修正: `src/db/repositories/replyRecord.ts`、`src/services/replyRecordService.ts` — `deleteExpired` の削除、guild とチャンネル単位の削除
- 修正: `src/index.ts` — 起動時の期限切れ削除の削除、1 時間ごとの runner を `sweepStaleChannels` だけに、起動時の guild の突き合わせ
- 新規: guild とチャンネルの削除イベントの handler（`guildDelete`、`channelDelete`、`threadDelete`）
- 修正: `src/utils/discordMessageNormalizer.ts` — トークンの見積もりを tool loop と共有する関数へ移す
- 修正: `README.md` — 24 時間の記述と、保持するもの（ID と状態）とモデルに送る範囲（Discord に残っている過去の発言）の説明

### 24 時間の制限と記録

- 窓、reply 先、`read_earlier_messages`、`messageEligibility` から `CONVERSATION_MAX_AGE_MS` による打ち切りを外し、`stop_reason` の `24h_cutoff` を削除する。
- `finalized-after-current`（今回の発言の時刻以降に確定した返答を外す）の規則は変えない。
- デプロイ時点に残っている記録はそのまま無期限に持つ。
- Bot 自身が不要なページを消すときに、先に `reply_pages` からそのページの登録を外す経路（`removePage`）は今どおり残す。自分で消したページを外部の削除と誤判定しないための経路で、返答単位の記録は消さない。
- 記録を消すのは Decisions の「記録を消す契機」だけとする。停止中に退出した guild は、起動時に参加中の guild の一覧と突き合わせて消す。

### context 予算

- tool loop は応答の開始時に、以後のターンで履歴に足してよい量をトークンで決める。
  - 予算 = (モデルの `contextLength` − 出力用の予約 − 最初のリクエストの見積もり) × 安全係数。
  - 最初のリクエストの見積もりは、system、tool の定義、窓、reply 先（複数ページを連結した全文）、今回の発言と添付を含む。
  - `max_completion_tokens` が省略か null のときは、アプリの既定の上限を出力用の予約にする。`contextLength` が取れないときは固定の既定予算を使う。予算が 0 以下なら、その応答では tool を提示しない。
- ターンごとに履歴へ積むもの（assistant の本文、reasoning、tool 呼び出しの引数、tool の結果、dispatcher が生成するエラーの結果）はすべて、積んだ時点で見積もって予算から引く。各結果は 1 回だけ数える。
- 予算の中に締めくくりの予約を置く。予約は、1 ターンに受け付ける呼び出しの上限（`MAX_DISTINCT_TOOL_CALLS_HARD_CAP`、32 件）ぶんの固定長の結果と、最終回答のターンの入力増分を賄う量とする。実行の上限は 8 件だが、9 件目以降の呼び出しにもエラーの結果が作られるので、8 件ぶんでは足りない。
- **固定長の結果**は、dispatcher が生成するエラーと、tool が予算不足や停止を伝える終了結果（`read_earlier_messages` の発言 0 件の JSON、`view_attachment` の `{"error":"result_budget_exhausted"}` など）である。どれも上限の決まった定数か、発言 0 件の決まった形である。tool は残りの予算がこの終了結果にも満たないときも終了結果を返してよく、dispatcher は固定長の結果を予約から引いて受け入れ、`result_too_large` にしない。`result_too_large` にするのは、固定長の結果でない結果が渡された予算を超えたときだけである。同じターンの先に実行した呼び出しが残りを使い切った場合も、後の呼び出しはこの規則で終了結果を返せる。
- 残りの予算が予約を下回ったら、次のターンを `tool_choice: "none"` にして最終回答させる。`tool_choice: "none"` で送ったターンは、何ターン目であっても今の最終ターンと同じに扱う。モデルが従わずに tool を呼んだら、その呼び出しは実行せず、本文があれば回答として確定し、本文が無ければ失敗の経路へ渡す（今は `turn === MAX_TURNS` のときだけこの扱いになる：`toolLoop.ts:1235-1277`）。context 超過からの回復のターンも同じである。
- tool は呼び出しのたびに、残りの予算（締めくくりの予約を除いた分）を `IToolContext` で受け取り、結果が予算に収まることを確かめてから内部の状態（カーソル、バッファ、`shown`、添付の読み込み済みの印）を確定する。
- トークンの見積もりは、今の `estimateNormalizedMessageTokens` と同じ規則（ASCII は 4 文字で 1、それ以外は 1 文字で 1）を共通の関数にして使う。日本語の実測（約 0.49 トークン / 文字）に対して約 2 倍の安全側に倒れる。
- context の予算と費用は別に扱う。同じ応答の以後のターンは、それまでの履歴を毎回送るので、入力トークンの課金は積まれた量 × 残りのターン数に近づく。同じ応答の中では履歴が追記だけなので、`session_id` を送る現状で、対応する provider では prompt cache が効くと見込む（未計測）。

### `read_earlier_messages`

- 最終的な JSON 全体（外枠、`has_more`、`stop_reason`、各発言の ref、表示名、時刻、添付一覧、本文）を見積もる。本文だけで数えない。
- 終了を伝える最小の JSON（発言 0 件と `stop_reason`）の分を先に確保し、新しい方から発言を足す。収まらない発言は返さずバッファに残し、`shown` に入れない。1 件目でも収まらない発言は、本文を切り詰めて `truncated: true` を付ける。本文を空にしても収まらなければ、その発言を返さない。
- ページングはページ単位で確定する（Decisions の「ページングの単位」）。取り直しでは、応答ごとの確認キャッシュ（`verificationCache`）に残った確認の結果を使う。
- 予算や期限による中断は、その発言の確認失敗としては扱わず、ページごと未処理に戻す。適格性の判定そのもの（確認に失敗した人のトリガーは適格、Bot の返答は不適格）は変えない。
- `stop_reason` と次の呼び出しでの扱い:
  - `fetch_deadline`: dispatcher のタイムアウト（30 秒）より短い内部の期限に達した。バッファのうち返してよい発言（確定済みのカーソル以降にあり、分割した返答なら先頭ページまで走査が済んだもの：`conversationWindow.ts:910-916`）を返す。次の呼び出しは続きから再開できる。
  - `rest_budget_exhausted`: tool 側の REST 予算が尽きた。その呼び出しでは、`fetch_deadline` と同じ条件で返してよいバッファの発言を返す。以後の呼び出しは REST を呼ばずに同じ理由を返し、バッファも返さない。private thread の認可に REST が要り、認可を通さずに返せないためである。
  - `result_budget_exhausted`: 1 件も返せないほど context 予算が残っていない。予算は応答の中で増えないので、以後の呼び出しも REST を呼ばずに同じ理由を返す。
  - 利用者の停止（request の abort）では何も返さない。
- `has_more` は「まだ返していない履歴があるか、終端をまだ確かめていない」ことを表す。この応答で取れるかどうかは `stop_reason` で表す。

### tool 側の REST 予算

- tool 側の Discord REST（`read_earlier_messages` のページングと Bot の返答の確認、`view_attachment` のメッセージの取り直し、認可）は、窓とは別の、応答全体で 1 つの予算を使う。認可はこの予算から先に取る。窓の予算が尽きていても、tool の呼び出しが `no_permission` にならない。
- レート制限（`GET /channels/{id}/messages` は 1 秒 5 回のバケットだった）や再試行の待ちは予測できないので、回数から完了時間を保証することはせず、`read_earlier_messages` は内部の期限で打ち切る。
- `view_attachment` には内部の期限を設けない。REST は認可とメッセージ 1 件の取り直しだけで、ページングのように回数が積み上がらないので、dispatcher のタイムアウトで足りる。取り直しに失敗したときに `attachment_unavailable` を記録する今の扱い（`conversationWindow.ts:1096` 以降）は変えない。

### dispatcher と `view_attachment`

- dispatcher は、予算を超えた文字列の結果を中間で切らず、`{"error":"result_too_large","estimated_tokens":…,"budget":…}` を tool の結果として返す。tool が状態を先に確定していた可能性があり、`read_earlier_messages` と `view_attachment` は状態（`shown` など：`conversationWindow.ts:1068-1070`）を共有するので、その応答の残りではすべての client tool を実行しない。同じターンで既に受け付けた未実行の呼び出しにも同じ固定エラーを返し、次のターンは `tool_choice: "none"` にする。
- dispatcher 自身が生成するエラー文には、固定の上限を残す。
- multimodal の parts の経路は、32 MiB の上限と形式ごとの上限に加えて予算による受け入れ判定を行う。`view_attachment` は、画像や PDF 1 件あたりの見積もり（固定値）が残りの予算を超えるなら、読み込まずに `{"error":"result_budget_exhausted"}` を返し、読み込み済みの印を付けない。
- 長いテキストを返す client tool（ログ、取得したページなど）を足すときは、その tool が予算を受け取り、自分で縮める。先頭と末尾を残す縮め方が適する tool は、`clipToolResultBytes` を共通の helper として使い、予算から換算したバイト数を渡し、縮めた結果が共通の見積もりで予算に収まることを確かめる。dispatcher に tool ごとの縮め方を宣言させる仕組みは、該当する tool ができるまで作らない。

### context 超過からの回復

- 失敗応答の `error_type` を保持する。現在のクライアントはこれを捨てている。
- 回復するのは、`error_type: "context_length_exceeded"` と識別でき、かつ tool の結果を積んだ後のターンで、そのターンの出力がまだ利用者に確定していないときだけとする。直前のターンで積んだ tool の結果を `{"error":"result_dropped","reason":"context_overflow"}` に置き換え、`tool_choice: "none"` で最終回答を 1 回だけ求め、以後 tool を使わない。置き換えた結果に対応する tool の状態は戻さないが、以後 tool を呼ばないので矛盾は表に出ない。
- 最初のリクエストでの拒否、回復でも拒否されたとき、`error_type` を持たない HTTP 400 は、今の失敗の経路（`toolLoop.ts` の `abortToErrorOrCancelled`）へ渡す。既に確定した表示と usage の扱いもその経路に従う。
- 出力上限による `length` の終了は context 超過として扱わず、今の処理のままにする。tool 呼び出しの断片が無く本文があれば回答として確定し、断片があれば失敗の経路へ渡す（`toolLoop.ts:1369-1396`）。`max_output_tokens` を送るようになると、上限に達した通常の回答もこの経路で確定する。
- この「回復しない」は context 超過の回復についてだけである。`chatService` が、未表示で client tool を実行していない `BadRequestError` のときに tweet の画像を外して再試行する既存の処理は変えない。

### 設計メモ

2026-09-27 に計測した値は次のとおりである。

- Discord `GET /channels/{id}/messages` に `limit=101` を送ると HTTP 400（`code 50035`、`NUMBER_TYPE_MAX`）が返る。
- 開発用チャンネルの直近 100 件を `formatMessageForTool` 相当の JSON にすると 59,696 bytes で、1 件の中央値は 154 bytes、p90 は 2,413 bytes、最大は 4,099 bytes だった。今の 12 KiB と 16 KiB のどちらにも収まらない。
- 合成した日本語 2,000 文字 × 100 件の tool 結果 JSON（613,891 bytes）は、`google/gemini-3.5-flash-lite` で 104,408 トークン（$0.031）、`google/gemma-4-26b-a4b-it` で 104,421 トークンだった。200 文字 × 100 件では 15,808 と 15,821 だった。複数ページを連結した Bot の返答は 1 件で 2,000 文字を超えうるので、これは 100 件の最悪値ではない。
- context 長 32,768 の `qwen/qwen-2.5-7b-instruct` に 2,000 文字 × 100 件を送ると、OpenRouter は context 長の超過で拒否し、応答は生成されなかった。
- OpenRouter で `tools` に対応する 390 モデルのうち、context 長が 128k 以下のものは 72、最小は 4,095 だった。

## Tasks

- [ ] 24 時間の打ち切りと `too-old` を削除し、`stop_reason` から `24h_cutoff` を外す
- [ ] `deleteExpired` と起動時の期限切れ削除をやめ、1 時間ごとの runner を `sweepStaleChannels` だけにする
- [ ] `guildDelete`、`channelDelete`、`threadDelete` と起動時の guild の突き合わせで記録を消す
- [ ] 失敗応答の `error_type` を保持し、`max_output_tokens` を送り、`top_provider.max_completion_tokens` を取得する
- [ ] tool loop に context 予算、締めくくりの予約、`tool_choice: "none"` への切り替えを入れ、`IToolContext` で残りの予算を渡す
- [ ] dispatcher の文字列の clip をやめ、`result_too_large` と応答内の実行停止を入れる
- [ ] `read_earlier_messages` を予算による収め方、ページ単位の確定、tool 側の REST 予算、内部の期限、新しい `stop_reason` に変え、`count` を 1〜100 にする
- [ ] `view_attachment` に予算による受け入れ判定を入れる
- [ ] context 超過からの回復を入れる
- [ ] Open Questions の 3 点を決め、この文書に反映する
- [ ] 単体テスト: 24 時間より古い人の発言、Bot の返答、reply 先が tool と reply 先で読める（時刻を固定する。e2e は投稿直後の発言しか扱えない）
- [ ] 単体テスト: デプロイ前から残っている記録が起動後に消えない。返答のページを消した後の次の応答で、そのトリガーと返答が外れたままである
- [ ] 単体テスト: `guildDelete`、`channelDelete`、`threadDelete` で、その範囲の記録だけが消える
- [ ] 単体テスト: `fetch_deadline` の後の次の呼び出しが重複も欠落もなく続き、ページの途中で止まったときはカーソルが進まない。`rest_budget_exhausted` と `result_budget_exhausted` の後は REST を呼ばずに同じ理由を返す。返した発言だけが `shown` に入る
- [ ] 単体テスト: 最終ターンより前に `tool_choice: "none"` で送ったターンでモデルが tool を呼んだとき、tool を実行せず、本文があれば回答として確定する。`result_too_large` の後は、同じターンの未実行の呼び出しを含めてすべての client tool が実行されない
- [ ] 単体テスト: 残りの予算が締めくくりの予約を下回ると次のターンが `tool_choice: "none"` になる。`view_attachment` は予算を超える画像や PDF を読み込まない。16 KiB を超える `read_earlier_messages` の結果が有効な JSON のまま届く。残りの予算が外枠と 1 件の発言の間にあるときの境界。同じターンの先の呼び出しが残りを使い切った後の呼び出しが、`result_too_large` ではなく終了結果を返し、以後も同じ理由を返す
- [ ] 単体テスト: `context_length_exceeded` で 1 回だけ tool 無しで回復し、`error_type` の無い HTTP 400 と最初のリクエストでの拒否では回復しない。`length` の終了は、本文があれば回答として確定し、tool 呼び出しの断片があれば失敗になる（今と同じ）
- [ ] 単体テスト: 既存の規則が変わらない（`finalized-after-current`、pending / failed の記録を持つ人の発言と Bot の返答の扱いの違い、分割した返答を先頭ページの位置まで保留する順序、既に見せた reply 先を ref で返す契約）
- [ ] 1 応答あたりのターンごとの入力トークン、cached tokens、費用、待ち時間、REST 回数を、変更の前後で計測する
- [ ] 既定の e2e と `history-set history-recall history-window read-earlier view-attachment view-image` を実行する
- [ ] `search` と `reasoning` の e2e を実行する。`tool_choice: "none"` への切り替えは server tool（Web 検索）を載せたリクエストにもかかり、reasoning は context 予算の差し引きの対象になり、`max_output_tokens` が reasoning の量にも効く可能性があるため（OpenRouter の OpenAPI 定義には記述が無く未確認）
- [ ] README の履歴の説明を書き直し、[fork](../fork/design.md) と [conversation-regeneration](../conversation-regeneration/design.md) の 24 時間を前提にした記述を書き直す
- [ ] `docs/changes/unbounded-conversation-history/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

次の 3 点は、状態の持ち方（確認キャッシュの粒度、認可関数のシグネチャ）に依存するので、実装時にテストとともに決める。

- **最終回答を送れる条件**: assistant の出力（本文、引数、reasoning）が締めくくりの予約に食い込んだ後で、最終回答のリクエストが context に収まる保証。tool を許すターンの開始条件に「次の assistant の入力増分と、そのターンで生じうるエラーの結果を吸収できること」を加えるか、足りないときに履歴を縮めるか失敗させるかを決める。
- **確認の途中の進捗**: `verificationCache` は返答単位で、トリガーかページのどれか 1 つの取得に失敗すると返答全体のエントリを消す（`messageEligibility.ts:308`）。複数ページの返答の確認が毎回期限を超えると、同じページを取り直し続けて REST 予算だけを使う。個別の message の取得結果を残すか、返答の中の確認の進捗を残すかを決め、1 つの返答の確認の途中で中断するテストを加える。
- **期限と認可**: private thread の認可は REST を待つが、認可関数は中断を受け付けず、予算不足も通信失敗も `false` にまとめる（`messageAuthorization.ts:33`）。内部の期限に認可の待ちを含め、認可が済んでいなければ履歴を返さないこと、権限の拒否、期限切れ、予算不足を区別することを契約にする。認可を期限の対象外にしても、呼び出し全体は dispatcher のタイムアウト（30 秒）で打ち切られるが、内部の期限までに `fetch_deadline` を返せずに dispatcher の timeout エラーになり、走査済みの分を返せない。打ち切られた後も認可の REST が裏で残る。

実装時の計測で決める値は、context 予算の安全係数、アプリの既定の出力上限、`contextLength` が取れないときの既定予算、画像や PDF 1 件の見積もり、締めくくりの予約の大きさ、tool 側の REST 予算の回数、`read_earlier_messages` の内部の期限である。

モデルに送る範囲は、Discord に残っている過去の人の発言と Bot の返答へ広がる。1 応答の費用と待ち時間の増え方は未計測である。

## 参照

- [Discord API: Get Channel Messages](https://docs.discord.com/developers/resources/message#get-channel-messages) — `limit` は 1〜100
- [OpenRouter OpenAPI](https://openrouter.ai/openapi.json) — `ApiErrorType` の `context_length_exceeded`、`OpenResponsesResult` の `error_type`、`TopProviderInfo` の `max_completion_tokens`
- [OpenRouter: Errors and debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging)
- [tool-calling-foundation の設計書](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/tool-calling-foundation/design.md) — dispatcher の結果の serialize と 16 KiB の clip
