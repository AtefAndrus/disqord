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

- 要見直し: [conversation-context](../conversation-context/design.md) は、会話の本文を DB に保存せず、応答のたびに Discord から読み、それより前と過去の添付はモデルが `read_earlier_messages` / `view_attachment` で取りに行く。DB に残るのは本文を持たない返答の管理記録（`reply_records` / `reply_pages`）だけである。本 design のうち `sessions` / `turns` / `turn_messages`、`PersistedContentPart`、`stripHistoricalMedia()`、DB の削除同期を前提にした記述は、同 change の実装後に前提から設計し直す
- 連携: [chat-response-v2](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/chat-response-v2/design.md) — 停止表示（`buildStoppedContainer`）と、updater の確定処理を使う
- 連携: [対話UX改善（会話履歴）](../conversation-context/design.md) — 同 change は `pending` の exchange を永続化する。終了時に中断した exchange をどの状態で残すかを合わせる必要がある

## Goals / Non-Goals

**Goals:**

- SIGTERM / SIGINT を受けたとき、進行中の返信を停止表示に書き換えてからプロセスを終える
- 後始末には期限を置き、Discord への書き込みが詰まっても終了を妨げない

**Non-Goals:**

- 中断した生成の再開
- クラッシュ（SIGKILL、OOM）で残ったメッセージの、次回起動時の掃除。必要になったら別に検討する

## Design

### 現状

`src/index.ts` の `shutdown()` は、HTTP サーバの停止、`client.destroy()`、DB のクローズ、ログの flush を順に行って `process.exit(0)` する。
進行中のリクエストには触れない。

`ChatService` は進行中のリクエストを `activeRequests`（message ID → `AbortController`）で持っており、停止ボタンは `cancelRequest(messageId)` でこれを中断する。
中断された生成は `messageCreate` 側が `cancelled` として受け取り、停止表示に書き換える。

### 方針の候補

終了時に `activeRequests` の全件を中断し、各ハンドラが停止表示を書き終えるのを期限つきで待ってから、`client.destroy()` へ進む。
停止ボタンと同じ経路を通るので、表示の組み立てを新しく作る必要が無い。

決める必要があるのは次の点である。

- `ChatService` に「全件を中断し、完了を待てる」入口をどう持たせるか（現状の `cancelRequest` は 1 件ずつで、完了を待つ手段が無い）
- 待つ時間の上限（コンテナの停止猶予より短くする必要がある。Docker の既定は 10 秒）
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

- `client.destroy()` より前に Discord への編集を終える必要がある。期限内に終わらなかった分は、現状と同じく「生成中...」のまま残る
