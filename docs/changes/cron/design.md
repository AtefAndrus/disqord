---
title: "定期実行"
status: planned      # investigating | planned | in-progress | implemented
priority: medium     # high | medium | low
summary: "登録したプロンプトを決まった時刻に LLM で実行し、指定チャンネルへ投稿する。登録は /cron パネルの modal と会話中の tool の 2 経路で、どちらも確認カードの承認を経る"
---

# 定期実行

## Why

DisQord は呼ばれたときに答えるだけで、誰も呼んでいないときに何かを届ける手段がない。
「平日の朝 9 時に英単語を 1 つ例文付きで投稿する」「毎週金曜 17 時に週報の書き方を 3 行で投稿する」のような定期的な LLM タスクを登録し、決まった時刻にチャンネルへ投稿させたい。
ジョブの中では tool を使わないので（Non-Goals）、題材は外部の最新情報を要らないものに限られる。

## 依存 / 関連 change

- 前提（実装済み）: [ギルド設定変更の共通認可](https://github.com/AtefAndrus/disqord/blob/72517eb35f9d3e8928a954f83e12da2f445d9424/docs/changes/permissions/design.md) — 登録、承認、編集、今すぐ実行、再開は `canManageGuildSettings`（`src/services/settingsAuthorization.ts`）を満たすメンバーに限る
- 前提（実装済み）: [設定パネル](https://github.com/AtefAndrus/disqord/blob/67291dde3d1ca40f9243d10430e98c3600341dbf/docs/changes/config-panel/design.md) — 有効化の切り替えを「機能」ページの項目として足す。`/cron` パネルの custom_id と再描画の作りもこのパネルに合わせる
- 前提（実装済み）: [Discord 操作ツール](../discord-tool/design.md) — 会話中の tool が Discord に書き込むときの形（応答ごとに作る窓口を `IToolContext` に載せる、実行の直前に依頼者を REST で取り直す、1 応答あたりの上限、`terminal` の結果、`clientToolInvoked` による再試行の抑止）をそのまま使う
- 連携: [使用統計](../usage-stats/design.md) — ジョブの実行ごとに `usage_logs` へ `source='cron'`、`user_id` = 登録者で記録する。どちらが先に入っても、後から入る側が記録を足す
- 連携: [終了時の後始末](../graceful-shutdown/design.md) — ティッカーの停止と実行中ジョブの中断を、同 change の終了手順の中で `db.close()` より前に行う
- 連携: [設定の階層化](../settings-hierarchy/design.md) — 成立したら、ジョブの実行にもチャンネル単位のモデルとシステムプロンプトを適用する。それまではギルドの設定だけを使う

## Goals / Non-Goals

**Goals:**

- `/cron` で開くパネルから、ジョブの一覧、詳細、追加、編集、停止、再開、今すぐ実行、削除ができる
- 追加と編集は modal で入力する
- 会話の中でモデルが `propose_cron_job` tool を呼び、登録を提案できる
- どちらの経路でも、解釈したスケジュールと次回以降の実行時刻を確認カードで示し、承認されたときだけ登録する
- スケジュールは cron 式、固定間隔、日時指定の 1 回限りの 3 種類で、自然言語で書かれたものは LLM でこのどれかに変換する
- 再起動をまたいでも 1 つの実行時刻で 2 回実行しない
- ギルドごとに有効、無効を切り替えられ、既定は無効にする

**Non-Goals:**

- ジョブの中での tool の利用（Web 検索、コード実行など）。1 回の実行費用を登録時に見積もれなくなり、無人の定期実行で課金が膨らみうる
- 分より細かい精度の実行。ティッカーは 60 秒ごとに動く
- 実行結果の履歴の保存。直近の実行時刻と直近のエラーだけを持つ
- 複数プロセスでの実行。bot は 1 プロセスで動く前提とする
- DM での登録と配信。bot は `DirectMessages` の intent を持たない
- ジョブごとのモデルの指定とタイムゾーンの指定

**将来別 change 候補:**

- ジョブの中での Web 検索 → Web 検索の費用を承認時に示す方法が決まってから
- ギルドごとのタイムゾーン → 日本以外のギルドから要望が出たら

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 有効化の単位 | ギルド設定の列 `cron_enabled`（既定 0）を設定パネルの「機能」ページで切り替える | 副作用のある機能は他と同じく管理者の明示で始める。上限や timeout は運用者が変える需要が無いので、環境変数にせずコードの定数にする |
| 操作の入口 | スラッシュコマンドは `/cron` 1 つにし、操作はすべてパネルのボタンと modal で行う | `/config` と同じく、サブコマンドを覚えなくても一覧から選んで操作できる。ジョブの ID を手で打たせない |
| 登録の経路 | パネルの modal と、会話中の `propose_cron_job` tool の 2 つ | modal は形の決まった入力に向き、tool は会話の流れで「これ毎朝やって」と頼む場合に向く |
| 登録前の確認 | 両経路とも、提案を `cron_proposals` に保存して確認カードを出し、承認で `cron_jobs` に移す | 登録すると、承認後は誰も呼ばなくても課金が続く。解釈したスケジュールと次回の実行時刻を登録前に目で確かめる機会が要る |
| 確認カードの状態 | DB の提案行と custom_id の提案 ID だけで表し、メモリには持たない。期限は 24 時間 | 設定パネルと同じく、押されるたびに DB を読み直せば再起動後もボタンが働く。期限切れはその時点の時刻との比較で判定する |
| プロンプトを書く主体 | modal では入力者、tool では会話中のモデルが、会話の文脈なしで実行できる文を書く。書き直すための LLM 呼び出しは足さない | 会話中のモデルは文脈を持っているので、自己完結した文をその場で書ける。確認カードに全文を出すので、意図とずれていれば承認前に気付ける |
| スケジュールの形式 | 5 フィールドの cron 式、`30m` `2h` `1d` の固定間隔、オフセット付きの ISO 8601 日時。これ以外の入力は 1 回だけ LLM に変換させ、同じ検証を通す | 自然言語の日付パーサを自作しない。秒付きの 6 フィールドは 60 秒のティッカーと合わないので受け付けない |
| タイムゾーン | cron 式は `Asia/Tokyo` で解釈する | モデルに渡す現在日時が JST である（`buildDateTimeSystemMessage`）。日時指定はオフセットを必須にするので、タイムゾーンに依存しない |
| スケジュール計算 | croner 10 を、callback を渡さない計算専用のオブジェクトとして使い、`nextRun(from)` だけを呼ぶ | MIT で依存が無い。IANA タイムゾーンと夏時間を扱える。croner 自身のタイマーは使わず、実行時刻は DB に持つ |
| 実行時刻の管理 | `next_run_at` を DB に持ち、60 秒ごとのティッカーが時刻の来たジョブを直列に処理する | プロセス内のタイマーにジョブを載せないので、再起動で予定が消えない |
| 2 回実行しない仕組み | 実行を始める前に `next_run_at` を次の時刻へ進めて保存し、それから LLM を呼ぶ | 実行中に落ちても、その時刻は消費済みとして扱われ、再起動後に同じ時刻をもう一度実行しない。「実行中」の状態を DB に持たないので、落ちた後の復旧処理が要らない |
| 停止中に過ぎた時刻 | 起動時に `next_run_at` が 10 分より前に過ぎていたら、実行せずに次の未来の時刻へ進める。10 分以内なら通常どおり 1 回実行する | 停止中の分をまとめて投稿しない。デプロイの再起動で、ちょうどその時刻の 1 回が消えるのは避けたい |
| 実行に使うモデル | 実行時点のギルドの既定モデル | 無料モデル限定の設定は既定モデルの変更時に確かめられている（`settingsService.ts` の `setGuildModel`）ので、ジョブにモデルを持たせなければその制約を迂回できない |
| LLM の呼び出し | `chatService.generateScheduledResponse(job, signal)` を足し、非ストリームの `OpenRouterClient.chat()` を使う。`chat()` に `signal` を足す | チャットの経路は Discord の返答ページの更新と tool ループを前提にしている。書式の system message と現在日時の system message は同じものを使う |
| 配信の見た目 | チャットの最終ページと同じ組み立て（`splitTextIntoMessages` とフッタ）に、ジョブ名の見出しを足す。最大 5 ページ | 定期投稿であることが見出しで分かり、Separator や表の扱いが通常の返答と揃う |
| 認可 | 追加、編集、承認、今すぐ実行、再開は `canManageGuildSettings` を満たすメンバー。停止と削除は登録者本人も可。一覧は、満たせばギルド全体、満たさなければ自分のジョブだけを出す | 登録と実行は bot の運営者の費用を継続して使う。止める操作は費用を増やさないので、権限を失った登録者にも自分のジョブを止める手段を残す |
| 連続失敗 | 繰り返しのジョブは 3 回続けて失敗したら停止し、配信先に登録者へのメンション付きで知らせる。知らせられなければパネルの表示に任せる | 削除されたチャンネルや壊れたプロンプトで課金が続くのを止める。DM は相手が閉じていると届かないので使わない |

## Design

### 全体の流れ

```text
登録: パネルの modal ─┐
                      ├─► スケジュールの解釈と検証 ─► cron_proposals ─► 確認カード ─► 承認で cron_jobs
      propose_cron_job ┘

実行: 60 秒ごとのティッカー ─► 時刻の来たジョブ ─► next_run_at を先に進める ─► LLM ─► 配信
```

### /cron パネル

`/cron` は、自分にだけ見える（ephemeral）パネルで返す。
見えるジョブが権限によって変わるので、`/config` のような公開のパネルにはしない。

- 一覧: ジョブを選択欄（1 ページ 25 件、ページ送りのボタン付き）で並べ、各項目に名前、状態、次回の実行時刻を出す。下に「追加」ボタンを置く。
- 詳細: 選んだジョブのプロンプト全文、スケジュール、次回と直近の実行時刻、状態、直近のエラーを出し、「編集」「今すぐ実行」「停止」または「再開」「削除」「一覧へ戻る」のボタンを置く。削除は、押すと「削除を確定」に変わる 2 段階にする。
- custom_id は `cron:<action>:<引数>` の形にし、設定パネルと同じく状態をすべて custom_id に入れる。ジョブを変える操作の custom_id にはジョブの `version` を入れ、押されたときに DB の値と違えば実行せずに再描画し、「表示の後にジョブが変わった」ことを ephemeral で伝える。
- 押されるたびに DB を読み直し、`settingsActorFromInteraction` で認可を確かめ直す。存在しないジョブや解釈できない custom_id には「この操作は無効です。`/cron` から開き直してください。」と ephemeral で返す。
- 「今すぐ実行」はスケジュールを変えずに 1 回実行する。`next_run_at`、`fail_count`、状態は書き換えない。結果の投稿は通常の配信と同じで、失敗したら押した人に ephemeral で理由を返す。
- 「再開」は `next_run_at` を今より後の最初の時刻にして `active` へ戻し、`fail_count` を 0 にする。次の時刻が無い（日時指定が過ぎている、cron 式に今後一致する時刻が無い）ときは再開せず、その旨を返す。
- 機能が無効なギルドでも、一覧、詳細、停止、削除は使える。追加、編集、承認、今すぐ実行、再開は断る。

### 追加と編集の modal

「追加」と「編集」は modal を開く。
編集では現在の値を入れた状態で開く。
modal の部品は次の 5 つで、Discord の modal に置ける上限の 5 に収まる。

| 項目 | 部品 | 制約 |
| ---- | ---- | ---- |
| 名前 | 1 行のテキスト入力 | 50 字まで |
| スケジュール | 1 行のテキスト入力 | cron 式、固定間隔、日時、または自然言語 |
| プロンプト | 複数行のテキスト入力 | 2000 字まで |
| 配信先 | チャンネルの選択欄（テキストチャンネル、アナウンスチャンネル、公開スレッド） | 追加では modal を開いたチャンネルを既定値にする |
| 投稿の条件 | 文字列の選択欄 | 「毎回投稿する」か「伝えることがあるときだけ投稿する」 |

選択欄は `LabelBuilder` で包んで modal に置く（discord.js 14.27.0 の `ModalBuilder.addLabelComponents`）。
modal の custom_id は、追加が `cron:modal:new`、編集が `cron:modal:edit:<jobId>:<version>` である。
送信を受けたら先に `deferReply({ ephemeral })` し（スケジュールの変換に LLM を呼ぶと 3 秒を超えうる）、検証の結果に応じて確認カードかエラーを返す。

「伝えることがあるときだけ投稿する」を選んだジョブは、実行時の system message で「特に伝えることが無ければ本文を `[SILENT]` だけにする」と指示し、応答が `[SILENT]` だけなら投稿しない。

### propose_cron_job tool

既存の `IClientTool` として登録する。
DB への登録はせず、提案を保存して確認カードを投稿するところまでを行う。

- 引数: `name`、`schedule`、`prompt`、`post_only_when_notable`（既定 false）。description で、`prompt` は会話の文脈なしで実行される自己完結した文にすること、`schedule` はできるだけ cron 式、固定間隔、オフセット付きの日時のどれかで書くこと、登録にはユーザの承認が要ることを伝える。
- 配信先は tool を呼んだチャンネルに固定する。別のチャンネルに送りたいときは、パネルの編集で変える。
- `isEnabled(ctx)` は、`toolsAllowed` が false でなく、`ctx.cron` があり、チャンネルがテキストチャンネル、アナウンスチャンネル、公開スレッドのどれかのときに true を返す。`ctx.cron`（応答ごとに作る窓口、`CronToolContext`）は `cron_enabled` のギルドでだけ作る。
- 窓口の `propose()` は、実行の直前に依頼者を `guild.members.fetch({ user, force: true, cache: false })` で取り直し、そのメンバーの権限とロールで `canManageGuildSettings` を評価する。応答は tool のターンを重ねて数分続きうるので、応答の開始時の `message.member` では途中の権限の変化を反映できない。
- 通れば、スケジュールを解釈して検証し、提案を保存し、bot を呼んだメッセージへの返信として確認カードを送る。モデルには `{"ok":true,"status":"awaiting_approval"}` のような短い JSON を `terminal` で返し、登録が済んだと誤って伝えないようにする。検証に失敗したら理由を返し、モデルに書き直させる。
- 1 応答あたり 1 回までとし、中断した呼び出しも数える。中断後の再試行で確認カードが 2 枚出るのを防ぐ。
- 窓口は Discord 操作の tool と同じく包んで `clientToolInvoked` を立て、`generateChatResponse` のやり直しで提案が繰り返されないようにする。
- `generateChatResponse` がモデルの詳細を取って `supportsTools` を判定する条件（`chatService.ts` の、会話履歴、Discord 操作、推論表示のいずれかが有効なとき）に `cron_enabled` を加える。

### 確認カード

確認カードは Components V2 のコンテナで、名前、プロンプト全文、解釈したスケジュール（「毎週平日 9:00」のような読み下しと元の式）、次回から 3 回分の実行時刻、配信先、投稿の条件を出し、「登録する」「取り消す」のボタンを置く。
modal から来た提案は ephemeral で、tool から来た提案はチャンネルに公開で出す。

- ボタンの custom_id は `cron:proposal:<approve|reject>:<proposalId>` である。
- 押した人が提案者本人であり、その時点で `canManageGuildSettings` を満たすときだけ受け付ける。
- 承認では、1 つのトランザクション（`BEGIN IMMEDIATE`）の中で、提案がまだあり期限内であること、ギルドとユーザのジョブ数の上限、編集なら対象ジョブの `version` が提案時と同じことを確かめ、ジョブの追加または更新と提案の削除を行う。二重押しでは 2 回目が提案を見つけられず、無効な操作として返る。
- トランザクションの前に、配信先に bot が投稿でき、提案者がそのチャンネルを見られることを取り直して確かめる。提案から承認までに権限が変わりうる。
- 承認したら、カードを「登録しました」の表示に書き換え、ボタンを外す。取り消しと期限切れも同様に書き換える。

### スケジュールの解釈と検証

入力は次の順に解釈する。

1. 5 フィールドの cron 式として croner で組み立てられれば `cron`。
2. `30m`、`2h`、`1d`（`every` を前置してもよい）の形なら `interval`。値はミリ秒で保存する。
3. オフセット（`Z` または `+09:00` など）付きの ISO 8601 日時なら `once`。UTC の時刻として保存する。
4. どれでもなければ、ギルドの既定モデルを tool なし、会話の文脈なしで 1 回呼び、上の 3 つのどれかを JSON で返させる。system message には現在日時を入れ、「明日の朝」のような相対的な表現を解決させる。

解釈した結果は、経路によらず同じ検証を通す。

- `interval` は 5 分以上で、1 分の倍数であること。
- `cron` は、今から次の 20 回の実行時刻を列挙し、隣り合う間隔がすべて 5 分以上であること。間隔は壁時計ではなく実際の経過時間で測るので、夏時間の切り替えも正しく扱える。
- `once` は、日付の各部分が暦の上で実在し（`2026-02-30` は拒否）、未来の時刻であること。`Date.parse` は存在しない日付を繰り上げて受け付けることがあるので、年月日と時分秒を取り出して範囲を確かめ、組み立て直した時刻が入力と一致することを確かめる。
- 最初の実行時刻が存在すること。cron 式でも `0 0 30 2 *` のように今後一致しないものは拒否する。

列挙で見るのは次の 20 回だけなので、年に 1 回だけ密集する式のようにすり抜けるものがありうる。
そこで実行時にも、次の時刻を「実行開始から 5 分後より後の最初の時刻」として計算する。
間隔がすべて 5 分以上の式では、この計算は単に次の時刻を返すのと同じ結果になる。

### 実行

ティッカーは 60 秒ごとに動き、前回の処理が終わっていなければその回を飛ばす。
タイマーには `.unref()` を付け、プロセスの終了を妨げないようにする（`conversationWindow` の掃除と同じ）。
1 回の処理では、時刻の来た `active` のジョブを `next_run_at` の順に直列に処理する。

1. ジョブのギルドで機能が無効なら、実行せずに `next_run_at` を次の未来の時刻へ進める（`once` は `done` にする）。
2. プロセス内の実行中の集合にジョブがあれば（「今すぐ実行」と重なった場合）、今回は飛ばす。
3. `next_run_at` を次の時刻へ進め、`last_run_at` を今にして保存する。`once` は `done` にする。この書き込みは `WHERE id = ? AND status = 'active' AND next_run_at = ?` の条件付きで行い、変わった行が無ければ（その間に停止、削除、編集された）実行しない。
4. 配信先を解決する。見つからない、投稿できない、許可チャンネルに入っていない（`allowedChannels` が null でなく、そのチャンネルもその親も含まない）ときは、LLM を呼ばずに失敗とする。
5. `generateScheduledResponse` を 120 秒の timeout で呼ぶ。timeout したら `AbortSignal` で OpenRouter への要求を中断する。
6. 各ページを投稿する直前に、ジョブがまだあり停止されていないことを DB で確かめる。実行中に削除や停止をされたら、残りを投稿しない。
7. 1 ページ目の投稿に成功したら成功とし、`fail_count` を 0、`last_error` を NULL にする。2 ページ目以降の失敗は記録するだけで失敗に数えず、残りのページの投稿をやめる。
8. 失敗したら `fail_count` を 1 増やし、`last_error` に理由を短く保存する。繰り返しのジョブで 3 に達したら `paused` にして `next_run_at` を NULL にし、配信先に登録者へのメンション付きで知らせる（`allowedMentions` はその 1 人だけに絞る）。

`generateScheduledResponse` は、ギルドの既定モデルに、書式の system message（`DISCORD_FORMAT_SYSTEM_MESSAGE`）、現在日時の system message（Web 検索なしの文面）、必要なら `[SILENT]` の指示を前置し、保存したプロンプトを user message として送る。
tool も Web 検索も付けない。
返り値は本文と usage で、usage はフッタの表示と、使用統計が入っていればその記録に使う。

Discord への投稿は取り消せないので、投稿の要求が timeout した後に遅れて届くことがある。
ページごとの timeout は 15 秒と長めにとり、遅れて届いた場合も失敗として数えたまま許容する。

### 配信

配信先の解決は、`releaseAnnouncer.ts` の `resolveReleaseChannel` を公開スレッドにも使えるように一般化して共有する。
同じギルドのチャンネルであること、bot の `ViewChannel` と、スレッドなら `SendMessagesInThreads`、それ以外なら `SendMessages` を REST で取り直して確かめる。

本文は `splitTextIntoMessages` で分け、チャットの最終ページと同じコンテナで組み、1 ページ目の先頭に `-# 定期実行「<名前>」` の見出しを置く。
フッタのモデル名と費用は、ギルドの「LLM 詳細表示」の設定に従う。
5 ページを超える分は切り捨て、最後のページの末尾にその旨を出す。
送信は `toComponentsV2Payload` を使うので、`allowedMentions` は `{ parse: [] }` に固定される。

### 起動と終了

起動時、`active` のジョブのうち `next_run_at` が 10 分より前に過ぎたものを、次の未来の時刻へ進める。
`once` は実行せずに `done` にし、`last_run_at` を NULL のままにして、実行されずに終わったことをパネルで分かるようにする。
その後、ティッカーを始める。

終了時は、ティッカーを止め、実行中のジョブの `AbortController` を中断する。
時刻は実行前に消費済みなので、中断したジョブに後始末は要らない。
終了による中断は失敗に数えない。
この 2 つは [終了時の後始末](../graceful-shutdown/design.md) の手順の中で `db.close()` より前に行う。

### 削除の連動と上限

- bot がギルドから外れたら（`GuildDelete`）そのギルドのジョブと提案を、チャンネルやスレッドが消えたら（`ChannelDelete`、`ThreadDelete`）そこを配信先とするジョブと提案を削除する。起動時の `reconcileGuilds` でも、所属していないギルドの分を消す。処理は `replyRecordCleanup.ts` の各ハンドラに足す。
- 期限の過ぎた提案は、ティッカーの各回で削除する。
- 上限は、ユーザあたり 10 件、ギルドあたり 50 件とする。数えるのは `active` と `paused` のジョブで、`done` と提案は数えない。上限は承認のトランザクションの中で確かめる。再開は数を変えないので確かめない。

### 変更対象ファイル

- 新規: `src/services/cronService.ts` — スケジュールの解釈と検証、次の時刻の計算、ティッカー、実行、配信、起動時の繰り越し
- 新規: `src/db/repositories/cronRepository.ts` — `cron_jobs` と `cron_proposals` の読み書き、条件付きの更新、承認のトランザクション
- 新規: `src/bot/commands/cron.ts` — `/cron` の定義
- 新規: `src/bot/events/cronPanelHandler.ts` — `cron:` のボタン、選択欄、modal の送信の処理
- 新規: `src/utils/cronPanel.ts` — パネル、詳細、modal、確認カードの組み立てと custom_id の解釈
- 新規: `src/llm/tools/proposeCronJob.ts` — `propose_cron_job`
- 修正: `src/llm/tools/registry.ts` — `IToolContext` に `cron?: CronToolContext` を足す
- 修正: `src/bot/events/messageCreate.ts` / `src/services/chatService.ts` — `cron_enabled` のギルドで `CronToolContext` を作って ctx に載せ、`clientToolInvoked` を立てる包みを通す。`supportsTools` の判定条件に加える。`generateScheduledResponse` を足す
- 修正: `src/llm/openrouter.ts` — `chat()` に `signal?: AbortSignal` を足し、内部の要求に渡す
- 修正: `src/bot/events/interactionCreate.ts` — `cron:` で始まるボタン、選択欄、modal の送信を `cronPanelHandler` に回す。`/cron` を回す
- 修正: `src/services/releaseAnnouncer.ts` — 配信先の解決を公開スレッドにも使えるように一般化する
- 修正: `src/bot/events/replyRecordCleanup.ts` — ギルド、チャンネル、スレッドの削除でジョブと提案を消す
- 修正: `src/db/schema.ts` / `src/db/repositories/guildSettings.ts` / `src/services/settingsService.ts` / `src/utils/configPanel.ts` / `src/bot/events/configPanelHandler.ts` / `src/utils/statusMessage.ts` — `cron_enabled` の列、setter、「機能」ページの項目、`/status` の表示（有効か、登録数）
- 修正: `src/index.ts` — 配線、tool の登録、起動時の繰り越し、ティッカーの開始と停止
- 修正: `scripts/preview/fixtures.ts` — パネル、詳細、確認カード、配信の fixture
- 修正: `scripts/e2e/scenarios.ts` — 名前を指定して走るシナリオ
- 修正: `package.json` — `croner` を足す

### DBスキーマ変更

```sql
CREATE TABLE IF NOT EXISTS cron_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,      -- 登録者
  name        TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('cron', 'interval', 'once')),
  expr        TEXT NOT NULL,      -- cron 式 / 間隔のミリ秒 / UTC の ISO 8601
  silent      INTEGER NOT NULL DEFAULT 0 CHECK (silent IN (0, 1)),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
  next_run_at INTEGER,            -- epoch ms
  last_run_at INTEGER,
  fail_count  INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  CHECK (status != 'active' OR next_run_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_due ON cron_jobs (status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_guild ON cron_jobs (guild_id);

CREATE TABLE IF NOT EXISTS cron_proposals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id       TEXT NOT NULL,
  channel_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,   -- 提案者。承認できるのはこの人だけ
  target_job_id  INTEGER,         -- 編集なら対象のジョブ
  target_version INTEGER,
  name           TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('cron', 'interval', 'once')),
  expr           TEXT NOT NULL,
  silent         INTEGER NOT NULL CHECK (silent IN (0, 1)),
  expires_at     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
```

`guild_settings` に `cron_enabled INTEGER NOT NULL DEFAULT 0` を足す。
追加の仕方は `discord_tools_enabled` と同じく、`src/db/schema.ts` で列の有無を見て `ALTER TABLE` する。
時刻の列は `reply_records` と同じく epoch ms の INTEGER にする。

`done` は「今後は実行しない」を表し、1 回限りのジョブが実行された場合と、停止中に時刻を過ぎて実行されなかった場合の両方を含む。
パネルは `last_run_at` の有無で両者を分けて表示する。

### e2e

`bun run e2e cron` を名前を指定したときだけ走らせ、テスト対象のギルドで `cron_enabled` が有効であることを要件にする（設定パネル、または `guild_settings` の列の直接更新で切り替える）。
テスト bot はボタンを押せないので、承認の操作は e2e の対象にしない。

1. テスト bot が bot に定期投稿を頼み、確認カード（「登録する」ボタンを持つ bot のメッセージ）が返信として届くことを確かめる。
2. スクリプトが bot の DB に、1 分後に実行する `once` のジョブを直接挿入し、見出し `定期実行「<名前>」` を持つ投稿が届くことを確かめる。
3. 挿入したジョブと、1 で作られた提案を削除する。

## Tasks

- [ ] `croner` を足す（実装時点の最新の安定版を確かめる）
- [ ] `cron_enabled` の列と、「機能」ページの項目、`/status` の表示を足す
- [ ] `cron_jobs`、`cron_proposals` と `cronRepository` を足す
- [ ] スケジュールの解釈と検証、次の時刻の計算を実装する
- [ ] `chat()` に `signal` を足し、`generateScheduledResponse` を実装する
- [ ] ティッカー、実行、配信、起動時の繰り越し、終了時の停止を実装する
- [ ] `/cron` パネル、modal、確認カードと `interactionCreate` の振り分けを実装する
- [ ] `CronToolContext` と `propose_cron_job` を実装して登録する
- [ ] ギルド、チャンネル、スレッドの削除に連動した削除を足す
- [ ] preview の fixture を足す
- [ ] テスト: 各形式の解釈と拒否（6 フィールド、5 分未満、存在しない日付、過去の日時、今後一致しない cron 式）、`nextRun` が境界の時刻（`0 9 * * *` に 09:00:00 を渡す）で次の日を返すこと、密集する式の実行時の繰り越し、実行前の時刻の消費と条件付き更新、停止中に過ぎた時刻の繰り越しと 10 分の猶予、実行中の停止と削除での投稿の中止、分割投稿の成否の数え方、連続失敗での停止、`[SILENT]`、承認の二重押しと上限と `version` の食い違い、提案者以外と権限の無い人の承認の拒否、無効なギルドでの操作の拒否、tool の 1 応答 1 回
- [ ] e2e シナリオ `cron` を足し、AGENTS.md の End-to-end 節に実行条件を書く
- [ ] `bun run e2e` と `bun run e2e cron` を実行し、結果を PR に書く
- [ ] 手動確認: `/cron` から追加の modal を開き、選択欄を含む 5 項目が表示されて送信でき、確認カードの「登録する」で一覧に載ることを確かめる
- [ ] 手動確認: 会話で定期投稿を頼み、公開の確認カードを提案者以外が押すと断られ、提案者が押すと登録されることを確かめる
- [ ] 手動確認: 詳細画面の編集、今すぐ実行、停止、再開、削除の 2 段階を一通り操作する
- [ ] `docs/changes/cron/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **croner の境界の扱い（未検証）**: `nextRun(from)` が `from` より厳密に後の時刻を返すこと、Bun 上で IANA タイムゾーンを正しく扱うことは、README の記載だけで確かめていない。テストで確かめる。
- **modal の選択欄の表示（未検証）**: discord.js 14.27.0 の型定義には `LabelBuilder` と、選択欄を含める `setChannelSelectMenuComponent` / `setStringSelectMenuComponent` がある。実際のクライアントでの表示と送信の値は手動確認で確かめる。
- **起動時の 10 分の猶予**: 本番のデプロイで bot が止まっている時間を計っていない。デプロイがこれより長くかかるなら、その時刻の実行が 1 回飛ぶ。
- **スケジュールの変換の質**: 既定モデルが無料モデルのギルドでは、自然言語のスケジュールを誤って変換することがありうる。確認カードで読み下しと実行時刻を示すので、承認前に気付ける前提である。
- **遅れて届く投稿**: 投稿の要求が timeout した後に届くと、投稿されたのに失敗として数えられる。ページごとの timeout を長めにとって頻度を下げる以上の対策はしない。

## 参照

- [croner](https://github.com/hexagon/croner) — MIT、依存なし。2026-09-29 時点の npm の最新の安定版は 10.0.1（dev タグは 11.0.0-dev.1）
- [Discord の modal と Label コンポーネント](https://discord.com/developers/docs/components/reference#label) — modal に置ける部品と上限
- [OpenRouter Responses API](https://openrouter.ai/docs/api_reference/responses/overview) — `OpenRouterClient.chat()` が内部で使う非ストリームの呼び出し
