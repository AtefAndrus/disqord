---
title: "終了時の進行中返信の後始末"
status: in-progress
priority: medium
summary: "bot の終了時に、生成途中の返信を停止表示へ書き換えてから落とす"
---

# 終了時の進行中返信の後始末

## Why

bot のプロセスが生成の途中で終了すると、「生成中...」と停止ボタンの付いたメッセージがチャンネルに残る。
ボタンを押しても、対応するリクエストはもう存在しないので「該当するリクエストが見つかりません」と返るだけで、表示は変わらない。
デプロイや再起動は生成中にも起こるので、本番でも同じ状態になりうる。

2026-09-20 に開発用 bot で確認した。
長い生成の途中で bot へ SIGTERM を送ると、返信は「生成中...」と停止ボタンが付いたまま残った。
本番で実際に起きたことがあるかは確認していない。

## 依存 / 関連 change

- 前提（実装済み）: [chat-response-v2](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/chat-response-v2/design.md) — 停止表示（`buildStoppedContainer`）と、updater の確定処理を使う
- 前提（実装済み）: [conversation-context](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/conversation-context/design.md) — 返答ごとの管理記録（`reply_records` / `reply_pages`）を DB に持つ。終了時の後始末は、この記録の状態も確定させる（下の「現状」）

## Goals / Non-Goals

**Goals:**

- SIGTERM / SIGINT を受けたとき、進行中の返信を停止表示に書き換えてからプロセスを終える
- 停止表示で、ユーザが止めた場合と再起動で止まった場合を見分けられるようにする
- 後始末には期限を置き、Discord への書き込みが詰まっても終了を妨げない

**Non-Goals:**

- 中断した生成の再開
- クラッシュ（SIGKILL、OOM）で残ったメッセージの、次回起動時の掃除。必要になったら別に検討する
- 定期実行の後始末。`cronService.stop()` が実行中のジョブを中断して 5 秒まで待つ処理を既に持ち、ジョブは生成が終わってから 1 回だけ投稿するので（`src/services/cronService.ts`）、途中のメッセージは残らない
- rolling update 中に新旧 2 つの bot が並んで動くことへの対処（Open Questions / Risks）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 完了を待つ単位 | `messageCreate` の handler 1 回の実行全体（Promise）を `src/index.ts` で数えて待つ | 停止表示の書き込みと `finalize(..., "stopped")` は、`generateChatResponse` が `cancelled` を返した後に handler 側で行われる。`ChatService` の `activeRequests` は生成が終わった時点で消えるので、それを見ても書き込みの完了は待てない |
| 中断の入口 | `ChatService` に `cancelAll()` を足し、全件を abort したうえで、以後の `generateChatResponse` を開始直後に `cancelled` で返す | 終了処理の開始と生成の開始が競合しても、中断を漏らさない。停止ボタンと同じ経路を通るので、表示の組み立てを新しく作らない |
| 終了開始後に届いた発言 | 返答しない（handler を呼ばない） | Coolify が rolling update で動かしている場合は、新しい bot が答える。古い bot を先に止める場合は、その時点ではどちらの bot も答えられないので、無視しても現状より悪くならない |
| 待つ時間の上限 | 8 秒。定期実行の停止（上限 5 秒）と並行して待つ | Coolify が古いコンテナを止めるときの猶予は既定 30 秒で（下の「本番の停止猶予」）、手元で `docker stop` した場合の既定 10 秒にも収める |
| 停止表示の文言 | footer を `🛑 Stopped by restart` にする（ユーザの停止は従来どおり `🛑 Stopped`） | 本人が押していないのに「停止」とだけ出ると、理由が分からない。再起動が理由と分かれば、ユーザは送り直せばよいと判断できる |
| 返答記録の状態 | `stopped` で確定する（新しい状態は足さない） | 停止ボタンと同じ扱いで、返信はそのまま次の会話の窓に入る。`status` の CHECK 制約を変えるには表の作り直しが要る |

## Design

### 現状

`src/index.ts` の `shutdown()` は、窓の掃除タイマーの停止、HTTP サーバの停止、`cronService.stop()`、`client.destroy()`、DB のクローズ、ログの flush を順に行って `process.exit(0)` する。
進行中のリクエストには触れない。

`ChatService` は進行中のリクエストを `activeRequests`（message ID → `AbortController`）で持っており、停止ボタンは `cancelRequest(messageId)` でこれを中断する。
中断された生成は `messageCreate` 側が `cancelled` として受け取り、停止表示に書き換えたうえで、返答記録を `finalize(..., "stopped")` で確定させる。

生成の途中で終了すると、返答記録は `pending` のまま DB に残る。
次の起動時に `markPendingFailed()` がこれを `failed` にし（`src/index.ts` の起動処理）、`failed` の記録を持つ bot の返信は会話の窓から外れる（`src/services/messageEligibility.ts` の `recordStatusReason`）。
記録の側は現状でも次の起動で整うが、チャンネルの表示は「生成中...」のまま残る。

本番のコンテナは Dockerfile の exec 形式の `CMD ["bun", "run", "src/index.ts"]` で起動するので、シェルを挟まず bun のプロセスがシグナルを直接受ける。

### 本番の停止猶予

本番へのデプロイは `.github/workflows/deploy.yml` から Coolify に依頼する。
Coolify（`coollabsio/coolify` の v4.4.3、`3b33e8a4ab`）は、古いコンテナを `docker stop --timeout=N` で止め、`N` はアプリケーション設定の Stop grace period（既定 30 秒、1〜3600 秒）である（`app/Jobs/ApplicationDeploymentJob.php` の `graceful_shutdown_container()`、`bootstrap/helpers/constants.php` の `DEFAULT_STOP_GRACE_PERIOD_SECONDS`）。
この設定が無い v4.0.0 以前も 30 秒の固定値なので、実効の既定値はバージョンによらず 30 秒である。

Dockerfile のアプリケーションは、Ports Mappings（ホストへの publish）、consistent container name、PR プレビュー、`--ip` 指定のどれにも当たらなければ rolling update になる（同ファイルの `rolling_update()`）。
rolling update では、新しいコンテナがヘルスチェックを通ってから古いコンテナへ SIGTERM を送るので、その間は 2 つの bot が同じトークンで動く。
本番の disqord がどちらの方式で動いているかは確かめていない（Open Questions / Risks）。
どちらの方式でも、古い bot が SIGTERM を受けた時点で進行中の返信を後始末するという、この change の振る舞いは変わらない。

### 実装内容

`ChatService`:

- `cancelAll(): void` を足す。`closing` を立て、`activeRequests` の全件を abort して空にする。
- `generateChatResponse` は、`closing` が立っていれば `activeRequests` に登録する前に `{ status: "cancelled", history }` を返す。
- 停止の理由を `messageCreate` へ渡すため、`isClosing` を読めるようにする。`cancelled` を受けた handler は、`isClosing` が真なら再起動による停止として表示する。

`messageCreate`:

- `updateStoppedMessages` と `buildStoppedContainer` / `buildStoppedFooterText` に停止の理由（`"user"` / `"shutdown"`）を渡し、`"shutdown"` のとき footer の先頭を `🛑 Stopped by restart` にする。

`src/index.ts`:

- `client.on("messageCreate", ...)` を包み、`shuttingDown` が立っていれば handler を呼ばない。呼んだ handler の Promise は `src/utils/inFlight.ts` の tracker に渡し、終わったら外す。tracker は拒否された Promise も完了として扱うので、handler から漏れた例外は包む側でログに残す。
- `shutdown()` は、窓の掃除タイマーと HTTP サーバを止めた後、`chatService.cancelAll()` を呼ぶ。そのうえで、handler の Promise 全件の `allSettled` と `cronService.stop()` を並行して待ち、8 秒で打ち切ってから `client.destroy()` と `db.close()` へ進む。
- 打ち切りの時点で終わっていない handler があれば、件数をログに残す。その返信は現状と同じく「生成中...」のまま残り、記録は次の起動で `failed` になる。

### 変更対象ファイル

- 修正: `src/services/chatService.ts` — `cancelAll()`、`isClosing`、終了開始後の即時 `cancelled`
- 修正: `src/bot/events/messageCreate.ts` — 停止の理由を停止表示に渡す
- 修正: `src/utils/chatContainerBuilder.ts` — 再起動による停止の footer
- 新規: `src/utils/inFlight.ts` — 実行中の Promise を数え、期限つきで完了を待つ
- 修正: `src/index.ts` — handler の実行中の Promise の管理、`shutdown()` での中断と期限つきの待機
- 修正: `scripts/e2e/` — 下の e2e シナリオ

### e2e

`bun run e2e shutdown` を、名前を指定したときだけ走るシナリオとして足す。
長い返答を頼み、最初のストリーミング更新が届いたら、spawn した子プロセスへ SIGTERM を送り、終了を待ってから返信を REST で読み戻して、最後のページの footer が `🛑 Stopped by restart` であることを確かめる。
子プロセスが終わるので、このシナリオは他のシナリオと同じ実行には入れず、`--no-spawn` では走らせない。

## Tasks

- [x] `ChatService` の `cancelAll()` と終了開始後の即時中断、ユニットテスト
- [x] 再起動による停止の footer（`chatContainerBuilder` と `messageCreate`）、ユニットテストと `bun run preview` の fixture
- [x] `src/index.ts` の `shutdown()` での中断と 8 秒の待機、終了開始後の発言を無視する処理
- [x] `bun run e2e shutdown` シナリオと、AGENTS.md の e2e 節への記載
- [x] `bun run e2e`（既定シナリオ）と `bun run e2e shutdown` の結果を PR 本文に載せる
- [ ] 手動確認: Coolify の disqord のアプリケーション設定で Ports Mappings と consistent container name の有無、Stop grace period の値、デプロイログの `Rolling update started.` の有無を見る
- [ ] `docs/changes/graceful-shutdown/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- `client.destroy()` より前に Discord への編集を、`db.close()` より前に返答記録の確定を終える必要がある。8 秒で終わらなかった分は、現状と同じく表示は「生成中...」のまま残り、記録は次の起動で `failed` になる
- **本番の方式（未検証）**: disqord に Ports Mappings があるか、consistent container name が有効かを確かめていない。どちらも無ければ rolling update で、Dockerfile の `HEALTHCHECK`（interval 30 秒、start-period 10 秒）が Coolify に取り込まれている場合、新旧の bot が並んで動く時間は約 40〜70 秒になる見込みである（Coolify のヘルスチェック待ちの手順からの推定で、デプロイログでは確かめていない）
- **rolling update 中の既存の問題（この change では直さない）**: 新旧の bot が並んで動く間は、両方がゲートウェイから同じ発言を受け取るので、両方が返答する見込みである（推定、未検証）。また、新しい bot は起動時の `markPendingFailed()` で古い bot が生成中の記録まで `failed` にし、`finalize` は `status = 'pending'` の行しか更新しないので（`src/db/repositories/replyRecord.ts` の `finalize`）、その返信は後から完了しても会話の窓から外れる。本番が rolling update だと分かったら、別 change で扱う

## 参照

- [docker container stop](https://docs.docker.com/reference/cli/docker/container/stop/) — SIGTERM の後、猶予を過ぎると SIGKILL を送る
- [Coolify の ApplicationDeploymentJob.php（v4.4.3）](https://github.com/coollabsio/coolify/blob/3b33e8a4ab753308dde26282ebe057e578d561d2/app/Jobs/ApplicationDeploymentJob.php) — `rolling_update()`、`health_check()`、`graceful_shutdown_container()`
- [Coolify の Rolling Updates の文書](https://coolify.io/docs/knowledge-base/rolling-updates) — rolling update にならない条件と Stop grace period
