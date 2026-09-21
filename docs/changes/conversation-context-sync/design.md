---
title: "会話履歴の削除同期の強化"
status: investigating
priority: low
summary: "オフライン中の削除の補足、送信後クラッシュの孤児メッセージの後始末、未応答 turn の再開、reply チェーンの取り込み"
---

# 会話履歴の削除同期の強化

## Why

[対話UX改善（会話履歴ストア）](../conversation-context/design.md) は、Bot がオンラインの間に届いた削除イベントにだけ追従する。
Bot が停止している間に利用者が消したメッセージは DB に残り、次の会話の文脈に入りうる。
また、応答の途中で Bot が落ちると、送信済みの Discord メッセージが残ったまま turn だけが `failed` になり、会話の途中に誰にも対応づかない bot の発言が残る。
本 change はこれらの取りこぼしを埋め、あわせて別 session の発言へのリプライを文脈に取り込む。

## 依存 / 関連 change

- 先行: [対話UX改善（会話履歴ストア）](../conversation-context/design.md) — `sessions` / `turns` / `turn_messages` と、オンライン中の削除追従
- 連携: [graceful-shutdown](../graceful-shutdown/design.md) — 停止時に生成中の exchange をどう残すか
- 後続: [conversation-regeneration](../conversation-regeneration/design.md) — 同 change が前提にする内部削除の lease（`deleting_internal_at`）、起動時の補償削除、文脈に使う直前の REST 再検証、reply seed は本 change が用意する

## Goals / Non-Goals

**Goals:**

- 文脈に入れる直前に、採用した exchange の Discord メッセージが今も存在するかを REST で確かめ、削除（404）やアクセス剥奪（403）が確定したものを purge する
- 起動時に、Bot がアクセスできなくなったチャンネル・スレッド・guild の session を purge する
- 起動時に、送信済みの写像を持つ `failed` の assistant turn（conversation-context が起動時に `pending` から `failed` にしたものと、同 change の運用中に既に残っているものを含む）のメッセージを Discord から削除し、写像を消す
- 応答前に落ちた user turn を、しきい値より新しければ再開し、古ければ応答しないまま文脈にだけ残す
- 別 session の発言へのリプライを、`reply_to_discord_msg_id` から辿って文脈に取り込む

**Non-Goals:**

- 送信成功から写像作成までの間に落ちた場合の孤児メッセージの厳密な回収（durable outbox）。必要になったら別途検討する
- `messageUpdate` への追従（[conversation-regeneration](../conversation-regeneration/design.md) の範囲）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| purge の根拠 | Discord の REST が 404 または 403 を返したときだけ purge する。timeout、5xx、rate limit では purge しない | 一時的な障害で履歴を消さないため |

## Open Questions / Risks

- REST での再検証は応答ごとに Discord API を呼ぶ。exchange 数が多い session では rate limit に当たるので、検証する件数の上限や、最後に検証した時刻を覚えて間引く方法を決める必要がある
- 未応答 user turn を再開するしきい値（直近何分までを再開するか）
- reply チェーンを辿る深さ、循環の検出、purge 済みの発言への reply の表示
- 内部削除の lease を入れるか。conversation-context は「写像を先に消す」順序で内部削除を区別し、内部削除すると決めたメッセージへの外部削除を追わない。conversation-regeneration は lease を前提にしているので、どちらに寄せるかを決める
- 起動時の処理順。failed + 写像の補償削除は、conversation-regeneration のスキーマ移行（failed 行の整理）より前に終える必要がある。先に failed 行を消すと写像も CASCADE で消え、Discord に残ったメッセージを回収できなくなる

## Tasks

- [ ] Design を詰め、`status` を `planned` にする
- [ ] `docs/changes/conversation-context-sync/` 削除（リリース完了時、git 履歴がアーカイブ）
