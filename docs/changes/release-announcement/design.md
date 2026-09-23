---
title: "リリース通知と /release-note"
status: investigating
priority: medium
summary: "起動時に動いている版を記録と比べ、新しい版なら CHANGELOG の該当する節を設定したチャンネルへ通知する。/release-note で任意の版の変更点を表示する"
---

# リリース通知と /release-note

## Why

bot が新しい版で動き出しても、サーバーの利用者は何が変わったかを知る手段が無い。
GitHub のリリースノートを見に行く人はほとんどいない。
リリースノートは CHANGELOG.md の該当する版の節と同じ内容で（AGENTS.md の Release 節）、bot はそれを配るだけでよい。
通知の起点は、GitHub から bot へ届く webhook ではなく、bot が新しい版で起動したことにする。
webhook を受ける公開の受け口と署名の秘密鍵が要らず、「実際に新しい版が動き出した」時点で通知できる。

## Goals / Non-Goals

**Goals:**

- bot の起動時に、動いている版が前回通知した版より新しければ、その間の版の変更点を、設定したチャンネルへ通知する
- サーバーごとに通知先のチャンネルを設定でき、設定しなければ通知しない
- `/release-note [version]` で、任意の版（省略時は動いている版）の変更点を表示する

**Non-Goals:**

- GitHub の API やリリースページからノートを取ること
- 同じ版での再起動や再デプロイで通知し直すこと
- ロールバックした版を通知すること
- 通知先を設定する前の版を、後から遡って通知すること

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 通知の起点 | `ready` の後に、動いている版（`package.json` の `version`）と、DB に記録した最後に通知した版を比べる | 起動は新しい版が実際に動き出したことを表す。GitHub からの受け口が要らない |
| ノートの出どころ | イメージに同梱した `CHANGELOG.md` から、版ごとの節（`## [x.y.z] - YYYY-MM-DD` から次の `## [` の前まで）を読む。`[Unreleased]` は読まない | リリースノートは CHANGELOG の節と同じ内容である。ネットワークや rate limit に依存しない。`.dockerignore` が `*.md` を除外しているので、`!CHANGELOG.md` を足して Dockerfile で `COPY` する |
| 記録の場所 | 新しいテーブル `bot_state(key TEXT PRIMARY KEY, value TEXT NOT NULL)` の `last_announced_version` | サーバーごとではなく bot 全体で 1 つの値である。guild 設定の表に置くと意味が合わない |
| 初回の起動 | 記録が無ければ、動いている版を記録するだけで通知しない | この機能を入れた版で、過去の全版の変更点を一度に流さない |
| 版の比較 | semver として比べる（`x.y.z` の数値の組）。動いている版の方が新しければ、記録より新しく動いている版以下の節をすべて、新しい順に通知する。古いか同じなら、記録を動いている版に合わせるだけで通知しない | 複数の版を飛ばして起動した場合も抜けなく伝える。ロールバックでは通知しない |
| 記録の更新と送信の順 | 送信の前に記録を更新する（通知は多くても 1 回） | 送信の途中で落ちて再起動を繰り返したときに、同じ通知が何度も流れるより、一部のサーバーに届かない方が害が小さい |
| 通知先の設定 | `/config release-channel <channel>` で設定し、`/config release-channel off` で外す。「サーバーの管理」権限を要る。列は `release_announce_channel_id` とする | 通知は既定で送らない。既存の DB には以前の機能の未使用の列 `release_channel_id` が値を持ったまま残っており（削除せずに参照だけ止めた）、同じ列を使うと古い設定が黙って蘇る |
| 送信の条件 | 送信の直前に、bot がそのチャンネルで `ViewChannel` と `SendMessages` を持つことを確かめ、無ければ送らずにログに残す。チャンネルが消えていれば設定はそのままにしてログに残す | 権限の無いチャンネルへ送って失敗を繰り返さない |
| 表示 | Components V2 の Container に `## DisQord v1.6.0 をリリースしました` と節の本文を入れ、4000 字を超えるときは既存の splitter でページに分ける。複数の版は版ごとに別のメッセージにする | 他の返信と同じ部品と分割を使う |
| `/release-note` | 引数 `version` は任意で、CHANGELOG にある版を autocomplete で出す（新しい順に 25 個まで）。省略時は動いている版。節が無ければエラーの notice を返す。返信は ephemeral にしない | 他の人にも見せたい情報である |

## Design

### 変更対象ファイル

- 新規: `src/services/releaseNotes.ts` — CHANGELOG の読み込みと節の切り出し、版の比較
- 新規: `src/services/releaseAnnouncer.ts` — 起動時の比較、記録の更新、各サーバーへの送信
- 修正: `src/db/schema.ts` — `bot_state` テーブルと `release_announce_channel_id` 列
- 新規: `src/db/repositories/botState.ts` — `bot_state` の読み書き
- 修正: `src/db/repositories/guildSettings.ts` / `src/services/settingsService.ts` / `src/types/index.ts` — 通知先の設定
- 修正: `src/bot/commands/config.ts` / `src/bot/commands/handlers.ts` / `src/bot/events/interactionCreate.ts` — `/config release-channel` と `/release-note`、autocomplete
- 修正: `src/utils/statusMessage.ts` — `/status` に通知先を表示する
- 修正: `src/index.ts` — `ready` の後に announcer を呼ぶ
- 修正: `Dockerfile` / `.dockerignore` — `CHANGELOG.md` をイメージに入れる
- テスト: 節の切り出し（先頭、末尾、`[Unreleased]`、見出しの形の崩れ）、版の比較、初回・同じ版・ロールバック・複数版飛ばし、記録の更新が送信より先であること、権限の無いチャンネル、`/release-note` の既定値と存在しない版

### 実装内容

- CHANGELOG は起動時に 1 回読み、プロセスの中で持つ。ファイルが無ければ通知と `/release-note` を無効にし、ログに残す。
- 開発環境の bot は開発用の DB を持つので、本番の記録とは独立する。

## Tasks

- [ ] CHANGELOG をイメージに入れ、節の切り出しと版の比較を実装する
- [ ] `bot_state` と `release_announce_channel_id` を足す
- [ ] 起動時の通知を実装する
- [ ] `/config release-channel` と `/status` の表示を足す
- [ ] `/release-note` と autocomplete を足す
- [ ] 手動確認: 開発環境で記録を古い版に書き換えて起動し、設定したチャンネルに通知が出ることを確かめる
- [ ] `docs/changes/release-announcement/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **CHANGELOG の言語**: 1.5.0 までの節は英語のコミットの件名で、1.6.0 からは日本語の PR のタイトルになる。通知はそのまま流す。
- **通知の量**: 1 回のリリースで数十行になることがある。長すぎる場合に `[type]` の分類ごとに件数だけにするかは、運用を見て決める。
