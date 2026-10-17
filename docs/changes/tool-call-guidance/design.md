---
title: "client tool の案内と呼び出しの記録"
status: planned        # investigating | planned | in-progress | implemented
priority: medium       # high | medium | low
summary: "read_earlier_messages が 0 件のときの結果と add_reaction の説明を直し、client tool の呼び出しを admin API で読めるログに残す"
---

# client tool の案内と呼び出しの記録

## Why

`read_earlier_messages` は、窓がすでにチャンネルやスレッドの最初の発言から入っているときに 0 件を返す。
2026-10-17 の本番では、モデルがこの 0 件を「履歴を取得できなかった」と言い換え、次の返答で最初の発言を引用して食い違った。

`add_reaction` の説明は「利用者が求めたときだけ付ける」と指示している。
そのため、会話に合う場面でも bot が自分からリアクションを付けることは無い。

client tool の呼び出しは `console.info` で tool 名だけを出しており、ログファイルに入らないので admin API から読めない。
どの返答でどの tool が呼ばれ、何を返したかが分からず、上のような挙動を調べるたびにコンテナの標準出力を取り寄せる必要がある。

## Goals / Non-Goals

**Goals:**

- `read_earlier_messages` が 0 件で、これより古く読める発言が無いとき、そのことをモデルが取り違えない結果にする
- `add_reaction` を、求められなくても会話に合う場面で控えめに使えるようにする
- client tool の呼び出しを、返答の元の発言 ID、引数、結果の状態とともにログファイルに残す

**Non-Goals:**

- tool の結果の本文（読んだ発言の中身など）をログに残すこと
- server tool（Web 検索など）のログ。Web 検索は既に `Web search` の行で検索語と出典を残している

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 0 件の伝え方 | 結果に、0 件で `has_more` が false、`stop_reason` が null のときだけ、これより古く読める発言は無く、窓が読める最も古い発言から始まっていることを書いた `note` を足す。tool の説明は変えない | 説明は既に `has_more` の意味を書いているが、モデルは 0 件の結果だけを見て失敗と解釈した。結果の中の文は、モデルが結果を読むその時点で目に入る。説明に足す案は、すべての返答の入力に常に載るうえ、`has_more` の説明と同じく読み飛ばされうる |
| 自分から付けるリアクション | 説明を「求められたとき、または会話に合うと判断したときに付ける。求められていないときは 1 回の返答で 1 つまでにする」に変える | 1 回の返答で付けられる数は `DiscordActionService` が 3 つに制限しているので（`ACTION_LIMITS`）、説明を緩めても付けすぎは仕組みで止まる。求められていない場合をさらに 1 つに絞るのは説明だけで、仕組みでは制限しない |
| 記録の形 | tool の実行の終わりに `logger.info("Tool call", …)` を 1 行出し、`console.info` の行はやめる | `logger` の行はログファイルに入り、admin API の `logs` と `message` で読める（`docs/admin-api.md`）。終わりに 1 行にすると、結果と所要時間を同じ行に入れられる |
| 記録する項目 | `messageId`（返答の元の発言 ID、tool の呼び出しに渡る `requestId`）、`name`、`status`（`ok`、`error`、`timeout`、`cancelled`）、`elapsed`、`args`（JSON を 200 文字までに切る）、`result`（結果が JSON のオブジェクトなら、真偽値、数値、null、200 文字までの文字列の項目と、配列の要素数。それ以外は文字数） | 結果の要約に `has_more`、`stop_reason`、`error` と件数が入り、今回のような食い違いを調べられる。発言の本文は配列の中にあるので要約に入らない。`Reply gate` の行と同じ `messageId` で、判定と返答とを結び付けられる |

## Design

### 変更対象ファイル

- 修正: `src/services/conversationWindow.ts` — `read_earlier_messages` の結果を作る処理に `note` を足す
- 修正: `src/llm/tools/discord/addReaction.ts` — 説明を変える
- 修正: `src/llm/tools/toolHandler.ts` — `console.info` の行を、実行の終わりの `logger.info` に置き換える
- 修正: `.claude/skills/production-investigation/SKILL.md` — tool 呼び出しはコンテナの標準出力にしか出ない、という記述を直す

## Tasks

- [ ] `note` の追加（単体テスト: 0 件で古い発言が無い、0 件で `stop_reason` がある、1 件以上）
- [ ] `add_reaction` の説明
- [ ] `Tool call` のログ（単体テスト: 各 `status`、結果が JSON のオブジェクト、JSON でない文字列、長い引数の切り詰め）
- [ ] `bun run e2e` の既定シナリオと、`history-set history-recall read-earlier` を通す
- [ ] `docs/changes/tool-call-guidance/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- 自分から付けるリアクションの頻度は、説明の文面とモデルで変わる。リリース後に本番のログの `Tool call` の行で頻度を見て、文面を調整する。
