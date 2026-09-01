---
title: "モデルコマンドの詳細表示"
status: in-progress
priority: medium
summary: "/model current と set の詳細表示を共通化し、OpenRouter のモデルページへリンク"
---

# モデルコマンドの詳細表示

## Why

`/model current` はモデル ID だけを表示する一方、`/model set` はモデル名・コンテキスト長・料金・モダリティを表示しており、現在値を確認する経路によって得られる情報が異なる。
OpenRouter 上のモデル仕様やプロバイダ情報を確認するための直接リンクもないため、モデル変更後に改めてモデルを検索する必要がある。

## Goals / Non-Goals

**Goals:**

- `/model current` と `/model set <model>` が同じ詳細項目を表示する。
- 表示中のモデル ID から OpenRouter のモデルページを直接開ける。
- Models API から詳細を取得できない場合も、モデル ID と OpenRouter URL は表示する。

**Non-Goals:**

- モデル検索・選択ロジックの変更。
- slash command 応答の Components V2 化。
- OpenRouter のモデルページ内容を Bot 内へ複製すること。

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 表示内容 | モデル名・ID、コンテキスト長、prompt/output 料金、モダリティ、OpenRouter URL を共通 helper で構築する | `current` と `set` の項目差分と将来の修正漏れを防ぐ |
| リンクの置き方 | Embed の title URL と、`OpenRouter` field の完全 URL を併記する | title がリンクであることに気づかない場合も、URL を明示して到達できる |
| URL 生成 | `https://openrouter.ai/` 配下へモデル ID の各 path segment を percent-encode して連結する | OpenRouter のモデル URL はモデル ID と同じ `author/slug` 構造であり、外部 URL の混入を防げる |
| 詳細取得失敗 | モデル ID と生成済み OpenRouter URL のみの fallback Embed を返す | 設定済みモデルの確認自体は Models API の一時的な不一致で失敗させない |
| interaction 応答 | guild 内の `/model current` は外部 I/O より前に defer し、結果を editReply する | Models API の応答時間が Discord の初回応答期限を超えても interaction を失効させない |
| モデル cache | Models API が空一覧を返した場合は正常取得済み cache を上書きせず、期限切れでも stale data を返す。正常 cache がなければ空一覧を cache しない | OpenRouter client が非 2xx を空一覧へ変換するため、一時障害を1時間の「全モデル不明」状態へ拡大しない |
| 表示基盤 | 既存の Embed を維持する | slash command 系の Components V2 化は [chat-response-v2](../chat-response-v2/design.md) の Non-Goals である |

## Design

### 変更対象ファイル

- 新規: `src/utils/modelDetailsEmbed.ts` — OpenRouter モデル URL と共通詳細 Embed を構築する。
- 修正: `src/bot/commands/handlers.ts` — `/model current` と `/model set` から共通 helper を呼ぶ。
- 修正: `src/services/modelService.ts` — 空の取得結果で正常なモデル cache を上書きしない。
- 新規: `tests/unit/utils/modelDetailsEmbed.test.ts` — URL と共通 field を検証する。
- 新規: `tests/unit/bot/commands/handlers.test.ts` — 両サブコマンドの表示一致と fallback を検証する。

### 実装内容

`getOpenRouterModelUrl(modelId)` はモデル ID を `/` で分割し、各 segment を `encodeURIComponent` してから OpenRouter の origin へ組み立てる。
`createModelDetailsEmbed(details, options)` はタイトルと説明だけを呼び出し側から受け取り、詳細 field の定義を一箇所に集約する。
`/model current` と `/model set` は設定の読み書きという差分だけを handler に残し、モデル詳細の表現は共有する。

## Tasks

- [x] OpenRouter モデル URL helper を実装する。
- [x] モデル詳細 Embed を共通化する。
- [x] `/model current` と `/model set` を共通表示へ移行する。
- [x] URL・field・fallback の unit test を追加する。
- [x] `/model current` を外部 I/O 前に defer する。
- [x] Models API の空結果で正常 cache を維持する。
- [ ] `docs/changes/model-command-ux/` 削除（リリース完了時、git 履歴がアーカイブ）。

## 参照

- [OpenRouter model page](https://openrouter.ai/google/gemma-4-26b-a4b-it:free) — モデルページ URL の構造。
- [discord.js EmbedBuilder](https://discord.js.org/docs/packages/discord.js/14.26.5/EmbedBuilder%3AClass) — Embed title URL と field の builder API。
