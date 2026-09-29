---
title: "定期実行"
status: in-progress      # investigating | planned | in-progress | implemented
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
| スケジュールの形式 | 5 フィールドの cron 式、`30m` `2h` `1d` の固定間隔、オフセット付きの ISO 8601 日時。自然言語の入力は 1 回だけ LLM に変換させ、同じ検証を通す | 自然言語の日付パーサを自作しない。秒付きの 6 フィールドは 60 秒のティッカーと合わないので、LLM に変換させずに拒否する |
| タイムゾーン | cron 式は `Asia/Tokyo` で解釈する | モデルに渡す現在日時が JST である（`buildDateTimeSystemMessage`）。日時指定はオフセットを必須にするので、タイムゾーンに依存しない |
| スケジュール計算 | croner 10 を、callback を渡さない計算専用のオブジェクトとして使い、`nextRun(from)` だけを呼ぶ | MIT で依存が無い。IANA タイムゾーンと夏時間を扱える。croner 自身のタイマーは使わず、実行時刻は DB に持つ |
| 実行時刻の管理 | `next_run_at` を DB に持ち、60 秒ごとのティッカーが時刻の来たジョブを直列に処理する | プロセス内のタイマーにジョブを載せないので、再起動で予定が消えない |
| 2 回実行しない仕組み | 実行を始める前に `next_run_at` を次の時刻へ進めて保存し、それから LLM を呼ぶ。実行は開始時のジョブの `version` を持ち、投稿と結果の保存は `version` が変わっていないときだけ行う | 実行中に落ちても、その時刻は消費済みとして扱われ、再起動後に同じ時刻をもう一度実行しない。「実行中」の状態を DB に持たないので、落ちた後の復旧処理が要らない。停止、再開、編集は `version` を上げるので、実行中にそれらが行われると、古い実行の投稿と結果が新しい状態に混ざらない |
| 停止中に過ぎた時刻 | 起動時に `next_run_at` が 10 分より前に過ぎていたら、実行せずに次の未来の時刻へ進める。10 分以内なら通常どおり 1 回実行する | 停止中の分をまとめて投稿しない。デプロイの再起動で、ちょうどその時刻の 1 回が消えるのは避けたい |
| 実行に使うモデル | 実行時点のギルドの既定モデル。ギルドが無料モデル限定なら、ジョブの実行とスケジュールの変換の前に既定モデルが無料かを確かめ、無料でない、または確かめられないときは LLM を呼ばずに失敗とする | ジョブにモデルを持たせなければ、無料モデル限定の設定を登録時のモデルで迂回されない。無料かどうかはモデルの変更時と無料モデル限定の有効化時（`settingsService.ts` の `setGuildModel` と `setFreeModelsOnly`）に確かめられるが、通常の生成の前には確かめられていない。保存後に有料になったモデルを無人の定期実行で使い続けないよう、呼び出しの前にも確かめる |
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
- 「今すぐ実行」は、どの状態のジョブでも、スケジュールを変えずに 1 回実行する。`next_run_at`、`last_run_at`、`fail_count`、`last_error`、状態は書き換えない。投稿は通常の配信と同じで、押した時点の `version` が変わったら（実行中に停止、編集、削除された）残りを投稿しない。失敗したら押した人に ephemeral で理由を返す。
- 「停止」は `active` のジョブにだけ出し、`paused` にして `next_run_at` を NULL にする。「再開」は `paused` のジョブにだけ出し、 `next_run_at` を今より後の最初の時刻にして `active` へ戻し、`fail_count` を 0 にする。次の時刻が無い（日時指定が過ぎている、cron 式に今後一致する時刻が無い）ときは再開せず、その旨を返す。どちらも `version` を 1 上げる。
- 「編集」は `active` と `paused` のジョブにだけ出し、状態を保ったまま内容を差し替える。
- `done` のジョブに出すのは「今すぐ実行」「削除」「一覧へ戻る」だけで、`active` にも `paused` にも戻らない。同じ内容で使うなら「追加」で登録し直す。1 回限りのジョブは実行を始めた時点で `done` になるので、その実行中の投稿を止めたいときは削除する（削除でも実行の手順 7 の確認に掛かる）。
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
- 窓口の `propose()` は、まずギルドの設定を読み直して `cron_enabled` を確かめる。応答の途中で無効にされたら、提案もスケジュールの変換もしない。
- 続いて依頼者を `guild.members.fetch({ user, force: true, cache: false })` で取り直し、そのメンバーの権限とロールで `canManageGuildSettings` を評価する。応答は tool のターンを重ねて数分続きうるので、応答の開始時の `message.member` では途中の権限の変化を反映できない。
- 通れば、スケジュールを解釈して検証し、提案を保存し、bot を呼んだメッセージへの返信として確認カードを送る。モデルには `{"ok":true,"status":"awaiting_approval"}` のような短い JSON を `terminal` で返し、登録が済んだと誤って伝えないようにする。検証に失敗したら理由を返し、モデルに書き直させる。
- 1 応答あたり 1 回までとする。回数は提案を保存する直前に数え、以後に中断されても戻さない。中断後の再試行で確認カードが 2 枚出るのを防ぐ。認可やスケジュールの検証で断った呼び出しは数えないので、モデルは同じ応答の中で書き直して呼び直せる。
- 窓口は Discord 操作の tool と同じく包んで `clientToolInvoked` を立て、`generateChatResponse` のやり直しで提案が繰り返されないようにする。
- `generateChatResponse` には、モデルの詳細を取る条件（会話履歴、Discord 操作、推論表示のいずれかが有効）と、取った詳細から `supportsTools` を決める条件（会話履歴か Discord 操作が有効）の 2 つがある（`chatService.ts` の `supportsTools` の初期化と判定）。`cron_enabled` を両方に加える。

### 確認カード

確認カードは Components V2 のコンテナで、名前、プロンプト全文、解釈したスケジュール（「毎週平日 9:00」のような読み下しと元の式）、次回から 3 回分の実行時刻、配信先、投稿の条件を出し、「登録する」「取り消す」のボタンを置く。
modal から来た提案は ephemeral で、tool から来た提案はチャンネルに公開で出す。

- ボタンの custom_id は `cron:proposal:<approve|reject>:<proposalId>` である。
- 押した人が提案者本人のときだけ受け付ける。
- 承認では、まず配信先に bot が投稿でき、提案者がそのチャンネルを見られることを REST で取り直して確かめる。提案から承認までに権限が変わりうる。
- その後、1 つのトランザクション（`BEGIN IMMEDIATE`）の中で次を確かめ、すべて満たせばジョブの追加または更新と提案の削除を行う。二重押しでは 2 回目が提案を見つけられず、無効な操作として返る。
  - 提案がまだあり、期限内であること
  - ギルドの設定を読み直し、`cron_enabled` が有効で、押した人が `canManageGuildSettings` を満たすこと
  - 承認の時刻を基準にスケジュールを検証し直し、最初の実行時刻があること。提案の後に日時指定が過ぎていたら登録せず、提案し直すよう返す
  - 追加なら、ギルドとユーザのジョブ数の上限を超えないこと。編集は数を変えないので確かめない
  - 編集なら、対象ジョブの `version` が提案時と同じで、状態が `active` か `paused` であること
- 登録するジョブの `next_run_at` は承認の時刻から計算する。編集で `paused` のジョブは `paused` のまま `next_run_at` を NULL に保ち、`active` のジョブは計算し直す。編集は `version` を 1 上げる。
- 編集でスケジュールが変わったら `last_run_at` を NULL に戻す。`last_run_at` は、いま承認されているスケジュールでの直近の実行を表し、前のスケジュールでの実行時刻は残さない。
- 承認したら、カードを「登録しました」の表示に書き換え、ボタンを外す。取り消しと期限切れも同様に書き換える。

### スケジュールの解釈と検証

入力は次の順に解釈する。

1. 空白で区切った 5 つの欄が cron 式の文字（数字、`*`、`,`、`-`、`/`、曜日と月の英略称）だけでできていれば cron 式とみなし、croner で組み立てられれば `cron`、組み立てられなければ拒否する。同じ文字だけでできた欄が 6 つか 7 つなら、秒または年付きの式として拒否する。それ以外の入力は手順 2 へ進む。
2. `30m`、`2h`、`1d`（`every` を前置してもよい）の形なら `interval`。値はミリ秒で保存する。
3. オフセット（`Z` または `+09:00` など）付きの ISO 8601 日時なら `once`。UTC の時刻として保存する。オフセットの無い日時は拒否する。
4. 1 から 3 のどれにも当たらなければ自然言語とみなし、ギルドの既定モデルを tool なし、会話の文脈なしで 1 回呼び、上の 3 つのどれかを JSON で返させる。system message には現在日時を入れ、「明日の朝」のような相対的な表現を解決させる。この呼び出しの usage は、使用統計が入っていれば `source='cron'`、`user_id` = 提案者で記録する。

解釈した結果は、経路によらず同じ検証を通す。

- `interval` は 5 分以上で、1 分の倍数であること。
- `cron` は、今から次の 20 回の実行時刻を列挙し、隣り合う間隔がすべて 5 分以上であること。間隔は壁時計ではなく実際の経過時間で測るので、夏時間の切り替えも正しく扱える。
- `once` は、日付の各部分が暦の上で実在し（`2026-02-30` は拒否）、未来の時刻であること。`Date.parse` は存在しない日付を繰り上げて受け付けることがあるので、年月日と時分秒を取り出して範囲を確かめ、組み立て直した時刻が入力と一致することを確かめる。
- 最初の実行時刻が存在すること。cron 式でも `0 0 30 2 *` のように今後一致しないものは拒否する。

列挙で見るのは次の 20 回だけなので、年に 1 回だけ密集する式のようにすり抜けるものがありうる。
そこで実行のたびに、次の時刻を次の規則で決める。

- `cron`: いま実行する予定の時刻に 5 分を足した時刻と、現在時刻の遅い方をとり、その時刻ちょうどか、それより後で最初に一致する時刻にする。croner の `nextRun(from)` は `from` より後の時刻を返すので、`from` には 1 ミリ秒前を渡す。`*/5 * * * *` を 09:00 の予定で 09:00:20 に実行すると次は 09:05 になり、間隔がすべて 5 分以上の式では予定どおりの時刻が続く。5 分未満で密集する時刻は飛ばされる。
  この規則が保証するのは、予定の時刻どうしの間隔が 5 分以上であることで、実際に LLM を呼ぶ間隔ではない。実行はティッカーの周期と、同じ回の前のジョブの処理（LLM だけで最大 120 秒）の分だけ予定より遅れ、遅れは回ごとに変わるので、実際の間隔は 5 分を切ることがある。起動時の猶予で 09:00 の分を 09:09 に実行すると、次の 09:10 の分との実際の間隔は 1 分になる。実際の間隔まで 5 分を保証すると、実行が遅れるたびに予定の時刻を 1 つ飛ばすことになるので、この短縮は許容する。
- `interval`: 実行を始めた時刻に間隔を足した時刻にする。最初の時刻は承認の時刻に間隔を足した時刻で、確認カードには「承認から 30 分後、以後 30 分ごと」のように示す。

### 実行

ティッカーは 60 秒ごとに動き、前回の処理が終わっていなければその回を飛ばす。
タイマーには `.unref()` を付け、プロセスの終了を妨げないようにする（`conversationWindow` の掃除と同じ）。
1 回の処理では、時刻の来た `active` のジョブを `next_run_at` の順に直列に処理する。

1. 終了の処理が始まっていれば、以降のジョブを処理しない。
2. ジョブのギルドで機能が無効なら、実行せずに `next_run_at` を次の未来の時刻へ進める（`once` は `done` にする）。
3. プロセス内の実行中の集合にジョブがあれば（「今すぐ実行」と重なった場合）、今回は飛ばす。
4. ジョブの `version` を読み、`next_run_at` を次の時刻へ進め、`last_run_at` を今にして保存する。`once` は `done` にする。この書き込みは `WHERE id = ? AND version = ? AND status = 'active' AND next_run_at = ?` の条件付きで行い、変わった行が無ければ実行しない。この書き込みは `version` を変えない。
5. 配信先を解決する。見つからない、投稿できない、許可チャンネルに入っていない（`allowedChannels` が null でなく、そのチャンネルもその親も含まない）ときは、LLM を呼ばずに失敗とする。
6. `generateScheduledResponse` を 120 秒の timeout で呼ぶ。timeout したら `AbortSignal` で OpenRouter への要求を中断する。
7. 各ページを投稿する直前に、ジョブがまだあり `version` が 4 で読んだ値のままであることを DB で確かめる。実行中に停止、再開、編集、削除をされたら、残りを投稿せず、結果も保存しない。終了の処理が始まっていたときも残りを投稿しない。
8. 1 ページ目の投稿に成功したら成功とし、`fail_count` を 0、`last_error` を NULL にする。応答が `[SILENT]` だけで投稿しなかった場合も成功とする。2 ページ目以降の失敗は記録するだけで失敗に数えず、残りのページの投稿をやめる。
9. 失敗したら `fail_count` を 1 増やし、`last_error` に理由を短く保存する。繰り返しのジョブで 3 に達したら `paused` にして `next_run_at` を NULL にし、`version` を 1 上げ、配信先に登録者へのメンション付きで知らせる（`allowedMentions` はその 1 人だけに絞る）。`once` は既に `done` なので、失敗を `last_error` に残すだけにする。

8 と 9 の書き込みも `WHERE id = ? AND version = ?` の条件付きで行う。

`generateScheduledResponse` は、ギルドの既定モデルに、書式の system message（`DISCORD_FORMAT_SYSTEM_MESSAGE`）、現在日時の system message（Web 検索なしの文面）、必要なら `[SILENT]` の指示を前置し、保存したプロンプトを user message として送る。
tool も Web 検索も付けない。
無料モデル限定のギルドでの無料の確認には、`modelService` のモデル一覧のキャッシュを使ってよいが、期限（1 時間）内の情報に限る。
`getAllModels()` は Models API の取得に失敗すると期限切れのキャッシュを返す（`modelService.ts` の `getAllModels`）ので、期限内の情報で判定できたときだけ結果を返す関数を `modelService` に足し、判定できなければ LLM を呼ばない。
キャッシュの期限内に価格が変わった場合は、次の取得まで気付けない。
返り値は本文と usage で、usage はフッタの表示と、使用統計が入っていればその記録に使う。

Discord への投稿は取り消せないので、投稿の要求が timeout した後に遅れて届くことがある。
ページごとの timeout は 15 秒と長めにとり、遅れて届いた場合も失敗として数えたまま許容する。

### 配信

配信先の解決は、`releaseAnnouncer.ts` の `resolveReleaseChannel` を公開スレッドにも使えるように一般化して共有する。
同じギルドのチャンネルであること、bot の `ViewChannel` と、スレッドなら `SendMessagesInThreads`、それ以外なら `SendMessages` を REST で取り直して確かめる。
スレッドがロックされていれば、bot に `ManageThreads` も求める。ロックされたスレッドへの投稿には `ManageThreads` が要り、スレッドの `permissionsFor()` は親チャンネルの権限を返すだけでロックを反映しない（`discordActionService.ts` の共通の確認と同じ理由）。
この確認は承認のときと実行のときの両方で使い、実行では LLM を呼ぶ前に行う。

本文は `splitTextIntoMessages` で分け、チャットの最終ページと同じコンテナで組み、1 ページ目の先頭に `-# 定期実行「<名前>」` の見出しを置く。
フッタのモデル名と費用は、ギルドの「LLM 詳細表示」の設定に従う。
5 ページを超える分は切り捨て、最後のページの末尾にその旨を出す。
送信は `toComponentsV2Payload` を使うので、`allowedMentions` は `{ parse: [] }` に固定される。

### 起動と終了

起動時、`active` のジョブのうち `next_run_at` が 10 分より前に過ぎたものを、次の未来の時刻へ進める。
`once` は実行せずに `done` にし、`last_run_at` を NULL のままにして、実行されずに終わったことをパネルで分かるようにする。
その後、ティッカーを始める。

終了時は、`cronService.stop()` を `client.destroy()` と `db.close()` より前に呼ぶ。
`stop()` は、終了中の印を立ててティッカーを止め、以後のジョブと「今すぐ実行」を始めさせない。
次に実行中のジョブの `AbortController` を中断し、実行中の処理が終わるのを最大 5 秒待つ。
中断された処理は、残りのページを投稿せず（実行の手順 7）、失敗にも数えない。
時刻は実行前に消費済みなので、中断したジョブに後始末は要らない。
5 秒を過ぎても終わらない処理が閉じた DB に書こうとしたら、その例外は記録して捨てる。
[終了時の後始末](../graceful-shutdown/design.md) が入ったら、その待ち時間の上限の中で `stop()` を待つ。

### 削除の連動と上限

- bot がギルドから外れたら（`GuildDelete`）そのギルドのジョブと提案を、チャンネルやスレッドが消えたら（`ChannelDelete`、`ThreadDelete`）そこを配信先とするジョブと提案を削除する。起動時の `reconcileGuilds` でも、所属していないギルドの分を消す。処理は `replyRecordCleanup.ts` の各ハンドラに足す。
- discord.js はキャッシュに無いスレッドの `ThreadDelete` を発火せず、親チャンネルの削除でも子スレッドのイベントを出さない（`replyRecordCleanup.ts` のコメント）。そのため、実行時の配信先の解決で Discord が Unknown Channel（`10003`）を返したら、そのチャンネルを配信先とするジョブと提案を削除する。権限不足や一時的な取得の失敗は通常の失敗として数え、削除しない。停止中のジョブは実行されないので、消えたスレッドを配信先とするものは、登録者か管理者がパネルで削除するまで残る。
- 期限の過ぎた提案は、ティッカーの各回で削除する。
- 上限は、同じギルドの中で登録者 1 人あたり 10 件、ギルドあたり 50 件とする。他のギルドのジョブは数えない（パネルには今のギルドのジョブしか出ないので、見えないジョブで断られることがないようにする）。数えるのは `active` と `paused` のジョブで、`done` と提案は数えない。上限は追加の承認のトランザクションの中で確かめる。編集、停止、再開は数を変えないので確かめない。`done` のジョブは `active` に戻れないので、数が後から増えることはない。

### 変更対象ファイル

- 新規: `src/services/cronService.ts` — スケジュールの解釈と検証、次の時刻の計算、ティッカー、実行、配信、起動時の繰り越し
- 新規: `src/db/repositories/cronRepository.ts` — `cron_jobs` と `cron_proposals` の読み書き、条件付きの更新、承認のトランザクション
- 新規: `src/bot/commands/cron.ts` — `/cron` の定義
- 新規: `src/bot/events/cronPanelHandler.ts` — `cron:` のボタン、選択欄、modal の送信の処理
- 新規: `src/utils/cronPanel.ts` — パネル、詳細、modal、確認カードの組み立てと custom_id の解釈
- 新規: `src/llm/tools/proposeCronJob.ts` — `propose_cron_job`
- 修正: `src/llm/tools/registry.ts` — `IToolContext` に `cron?: CronToolContext` を足す
- 修正: `src/bot/events/messageCreate.ts` / `src/services/chatService.ts` — `cron_enabled` のギルドで `CronToolContext` を作って ctx に載せ、`clientToolInvoked` を立てる包みを通す。`supportsTools` の判定条件に加える。`generateScheduledResponse` を足す
- 修正: `src/services/modelService.ts` — 期限内のモデル情報で無料かを判定し、判定できなければそのことを返す関数を足す
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
提案には依頼者が `canManageGuildSettings` を満たす必要があるので、テスト bot に `ManageGuild` か、設定パネルで指定した管理ロールを持たせることも要件にする。シナリオは始める前にこの 2 つを確かめ、満たさなければ理由を出して止まる。`cron_enabled` と管理ロールの ID はテスト対象の bot の DB（`guild_settings`）から読み、テスト bot のメンバーとロールの権限は Discord の REST から取り、`canManageGuildSettings` で判定する。
テスト bot はボタンを押せないので、承認の操作は e2e の対象にしない。

1. テスト bot が bot に定期投稿を頼み、確認カード（「登録する」ボタンを持つ bot のメッセージ）が返信として届くことを確かめる。
2. スクリプトが bot の DB に、1 分後に実行する `once` のジョブを直接挿入し、見出し `定期実行「<名前>」` を持つ投稿が届くことを確かめる。
3. 挿入したジョブと、1 で作られた提案を削除する。

## Tasks

- [x] `croner` を足す（実装時点の最新の安定版を確かめる）
- [x] `cron_enabled` の列と、「機能」ページの項目、`/status` の表示を足す
- [x] `cron_jobs`、`cron_proposals` と `cronRepository` を足す
- [x] スケジュールの解釈と検証、次の時刻の計算を実装する
- [x] `chat()` に `signal` を足し、`generateScheduledResponse` を実装する
- [x] ティッカー、実行、配信、起動時の繰り越し、終了時の停止を実装する
- [x] `/cron` パネル、modal、確認カードと `interactionCreate` の振り分けを実装する
- [x] `CronToolContext` と `propose_cron_job` を実装して登録する
- [x] ギルド、チャンネル、スレッドの削除に連動した削除を足す
- [x] preview の fixture を足す
- [x] テスト: 各形式の解釈と拒否（6 フィールドが LLM に回らず拒否されること、5 分未満、存在しない日付、オフセットの無い日時、過去の日時、今後一致しない cron 式）、`nextRun` が境界の時刻（`0 9 * * *` に 09:00:00 を渡す）で次の日を返すこと、`*/5 * * * *` が遅れて実行されても 5 分ごとに続くことと密集する式の時刻が飛ばされること、実行前の時刻の消費と条件付き更新、停止中に過ぎた時刻の繰り越しと 10 分の猶予、実行中の停止、停止してからの再開、編集、削除での投稿と結果の保存の中止、分割投稿の成否の数え方、`[SILENT]` が成功に数えられること、連続失敗での停止、承認の二重押しと上限と `version` の食い違い、承認時に過ぎた日時指定の拒否、提案者以外と権限の無い人の承認の拒否、無効なギルドでの操作と tool の提案の拒否、無料モデル限定のギルドで有料になった既定モデルを呼ばないこと、Unknown Channel での削除、終了中に新しい実行が始まらないこと、tool の 1 応答 1 回
- [x] e2e シナリオ `cron` を足し、AGENTS.md の End-to-end 節に実行条件を書く
- [x] `bun run e2e` と `bun run e2e cron` を実行し、結果を PR に書く
- [x] 手動確認: `/cron` から追加の modal を開き、選択欄を含む 5 項目が表示されて送信でき、確認カードの「登録する」で一覧に載ることを確かめる
- [x] 手動確認: 会話で定期投稿を頼み、公開の確認カードを提案者以外が押すと断られ、提案者が押すと登録されることを確かめる
- [x] 手動確認: 詳細画面の編集、今すぐ実行、停止、再開、削除の 2 段階を一通り操作する
- [ ] `docs/changes/cron/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **croner の境界の扱い**: `nextRun(from)` が `from` より厳密に後の時刻を返すことと、Bun 上で `Asia/Tokyo` の式を正しく UTC の時刻にすることは、`tests/unit/services/cronSchedule.test.ts` で確かめている（JST 09:00:00 に `0 9 * * *` を渡すと翌日の JST 09:00 を返す）。croner を更新したときは、このテストが境界の挙動の変化を検出する。
- **起動時の 10 分の猶予**: 本番のデプロイで bot が止まっている時間を計っていない。デプロイがこれより長くかかるなら、その時刻の実行が 1 回飛ぶ。
- **スケジュールの変換の質**: 既定モデルが無料モデルのギルドでは、自然言語のスケジュールを誤って変換することがありうる。確認カードで読み下しと実行時刻を示すので、承認前に気付ける前提である。
- **遅れて届く投稿**: 投稿の要求が timeout した後に届くと、投稿されたのに失敗として数えられる。ページごとの timeout を長めにとって頻度を下げる以上の対策はしない。

## 参照

- [croner](https://github.com/hexagon/croner) — MIT、依存なし。2026-09-29 時点の npm の最新の安定版は 10.0.1（dev タグは 11.0.0-dev.1）
- [Discord の modal と Label コンポーネント](https://discord.com/developers/docs/components/reference#label) — modal に置ける部品と上限
- [OpenRouter Responses API](https://openrouter.ai/docs/api_reference/responses/overview) — `OpenRouterClient.chat()` が内部で使う非ストリームの呼び出し
