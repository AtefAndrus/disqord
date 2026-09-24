---
title: "終了時の進行中返信の後始末"
status: investigating
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
- 後始末には期限を置き、Discord への書き込みが詰まっても終了を妨げない

**Non-Goals:**

- 中断した生成の再開
- クラッシュ（SIGKILL、OOM）で残ったメッセージの、次回起動時の掃除。必要になったら別に検討する

## Design

### 現状

`src/index.ts` の `shutdown()` は、返答記録の定期掃除（`ttlSweepRunner`）の停止、HTTP サーバの停止、`client.destroy()`、DB のクローズ、ログの flush を順に行って `process.exit(0)` する。
進行中のリクエストには触れない。

`ChatService` は進行中のリクエストを `activeRequests`（message ID → `AbortController`）で持っており、停止ボタンは `cancelRequest(messageId)` でこれを中断する。
中断された生成は `messageCreate` 側が `cancelled` として受け取り、停止表示に書き換えたうえで、返答記録を `finalize(..., "stopped")` で確定させる。

生成の途中で終了すると、返答記録は `pending` のまま DB に残る。
次の起動時に `markPendingFailed()` がこれを `failed` にし（`src/index.ts` の起動処理）、`failed` の記録を持つ bot の返信は会話の窓から外れる（`src/services/messageEligibility.ts` の `recordStatusReason`）。
記録の側は現状でも次の起動で整うが、チャンネルの表示は「生成中...」のまま残る。
終了時に停止ボタンと同じ経路を通せば、記録は `stopped` で確定し、その返信は次の会話の窓にも入る。
このため、後始末は `db.close()` より前に終える必要がある。

本番のコンテナは Dockerfile の exec 形式の `CMD ["bun", "run", "src/index.ts"]` で起動するので、シェルを挟まず bun のプロセスがシグナルを直接受ける。
`docker stop` は SIGTERM を送り、既定では 10 秒後に SIGKILL を送る（Docker の `docker container stop` の文書）。
本番へのデプロイは `.github/workflows/deploy.yml` から Coolify に依頼する形で、Coolify が古いコンテナを止めるときの猶予は確かめていない（Open Questions）。

### 方針の候補

終了時に `activeRequests` の全件を中断し、各ハンドラが停止表示を書き終えるのを期限つきで待ってから、`client.destroy()` へ進む。
停止ボタンと同じ経路を通るので、表示の組み立てを新しく作る必要が無い。

決める必要があるのは次の点である。

- `ChatService` に「全件を中断し、完了を待てる」入口をどう持たせるか（現状の `cancelRequest` は 1 件ずつで、完了を待つ手段が無い）
- 待つ時間の上限（コンテナの停止猶予より短くする必要がある。`docker stop` の既定は 10 秒）
- 停止表示の文言を、ユーザが止めた場合と区別するか（「再起動のため中断しました」など）

### 変更対象ファイル

- 修正: `src/index.ts` — `shutdown()` で進行中の返信の後始末を待つ
- 修正: `src/services/chatService.ts` — 全件の中断と完了待ち

## Tasks

- [ ] 方針を確定する（上の 3 点）
- [ ] 実装とユニットテスト
- [ ] `bun run e2e` に、生成中の bot を SIGTERM で止めて返信が停止表示で終わることを確かめるシナリオを足す
- [ ] `docs/changes/graceful-shutdown/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- `client.destroy()` より前に Discord への編集を、`db.close()` より前に返答記録の確定を終える必要がある。期限内に終わらなかった分は、現状と同じく表示は「生成中...」のまま残り、記録は次の起動で `failed` になる
- **Coolify の停止猶予とローリング更新（未検証）**: Coolify が古いコンテナを止めるときに SIGTERM から SIGKILL までの猶予を何秒とするか、新しいコンテナを起動してから古いコンテナを止めるか（その間は 2 つの bot が同じトークンで動く）を確かめていない。待つ時間の上限を決める前に、本番の設定と Coolify の文書で確かめる

## 参照

- [docker container stop](https://docs.docker.com/reference/cli/docker/container/stop/) — SIGTERM の後、猶予（Linux のコンテナで既定 10 秒）を過ぎると SIGKILL を送る
