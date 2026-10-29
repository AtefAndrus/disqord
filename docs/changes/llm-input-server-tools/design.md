---
title: "サーバーツール付きの返答の LLM 入力を見る"
status: investigating
priority: low
summary: "Web 検索や会話履歴を有効にしたギルドでは、OpenRouter のサーバーツールを渡すので「LLM 入力を見る」で入力を見られない。見られるようにする方法を決める"
---

# サーバーツール付きの返答の LLM 入力を見る

## Why

「LLM 入力を見る」は、返答の generation ID で OpenRouter の `/generation/content` から入力を引く。
OpenRouter は、サーバーツール（`openrouter:web_search` と `openrouter:datetime`）を渡したリクエストの入力を残さないので、そうした generation では入力を見られない。
chat service はサーバーツールを渡す条件が広く、Web 検索か会話履歴を有効にしたギルドでは、ほとんどの返答がこれに当たる。
bot の挙動を調べたい場面の多くで、このコマンドが役に立たない。

## 依存 / 関連 change

- 先行: [LLM 入力の表示（コンテキストメニュー）](https://github.com/AtefAndrus/disqord/blob/9d88df97619473aa409ae57f96b86af3255d4cb9/docs/changes/llm-input-inspect/design.md) — コマンドと `reply_generations` の記録。Decisions の「サーバーツールを渡した generation」に測定の記録がある。

## Goals / Non-Goals

**Goals:**

- Web 検索か会話履歴を有効にしたギルドの返答でも、モデルに渡した入力を確認できるようにする方法を決める。

**Non-Goals:**

- OpenRouter の側の記録の仕方を変えること。

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 進め方 | 未決（要判断） | 下の「選択肢」のどれを採るかを決めてから `planned` にする |

## Design

### 現状

- Web 検索が有効なギルドでは、chat service は毎回のリクエストに `openrouter:web_search` を渡す（`src/services/chatService.ts` の `buildWebSearchServerTool` の呼び出し）。検索しなかった返答も含む。
- Web 検索が無効でも、会話履歴が有効で、モデルが tool に対応していれば、`openrouter:datetime` を渡す（同じファイルの `DATETIME_SERVER_TOOL`）。
- `openrouter:datetime` は、`google/gemini-3.8-flash` で `view_attachment` が画像を返した後の turn が HTTP 400（"Corrupted thought signature"）になるのを避けるために渡している。2026-09-24 に、サーバーツールが無いと 3 回中 3 回失敗し、`openrouter:web_search` か `openrouter:datetime` があると 3 回中 3 回成功した（`DATETIME_SERVER_TOOL` の注記）。
- サーバーツールを渡した generation は `reply_generations.server_tools` に記録され、「LLM 入力を見る」はその generation を問い合わせずに、入力が残っていないと表示する。

### 選択肢

1. `openrouter:datetime` を渡す条件を、HTTP 400 の不具合が出るモデルに限る。会話履歴だけを有効にしたギルドでは入力を見られるようになる。Web 検索を有効にしたギルドは変わらない。不具合が今も出るかを、渡さない状態で測り直す必要がある。
2. サーバーツールを渡したリクエストに限って、bot が送った入力を自分の DB に保存し、コマンドはそれを表示する。どのギルドでも見られるが、会話の内容を本番の DB に持つことになり、保存期間、容量、削除の扱いを決める必要がある。画像と PDF のデータの扱いも決める。
3. 現状のままにし、サーバーツール付きの返答は見られないことを README に書く。

## Tasks

- [ ] 進め方を決め、Decisions を埋めて `status` を `planned` にする
- [ ] `docs/changes/llm-input-server-tools/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **OpenRouter の仕様の変化（未確認）**: サーバーツールを渡したリクエストの入力が残らないのは、2026-10-29 の測定による。OpenRouter の文書には書かれていないので、仕様が変われば選択肢を選び直す。
