---
title: "推論内容の取得・表示"
status: planned
priority: medium
summary: "OpenRouter の reasoning / reasoning_details を安全に受け取り、設定に応じて Discord へ表示"
---

# 推論内容の取得・表示

## Why

現行実装は OpenRouter が返した `completion_tokens_details.reasoning_tokens` を集計し、LLM 詳細表示が有効な場合は footer の `Reasoning: N` として token 数を表示している。
一方、ストリーム中の `reasoning` だけの delta は接続維持用 heartbeat として扱って本文を破棄しており、モデルが返した推論本文・要約は Discord へ表示されない。
OpenRouter の reasoning response はモデルとプロバイダによって text、summary、暗号化された継続用 data が混在するため、単純に `reasoning` 文字列を本文へ連結せず、取得・継続・表示を分離して設計する。

## 依存 / 関連 change

- 先行: [chat-response-v2](../chat-response-v2/design.md) — reasoning 表示にも文字数・バイト数・fenced code block 対応済みの分割 primitive を使う。
- 連携: [settings-hierarchy](../settings-hierarchy/design.md) — reasoning request の effort / token 上限を scope ごとの LLM parameter として解決する。
- 連携: [conversation-context](../conversation-context/design.md) — multi-turn 継続で必要な `reasoning_details` を assistant turn と同じ保持・削除規則で扱う。
- 連携: [openrouter-api-audit](../openrouter-api-audit/design.md) — reasoning metadata と response DTO の型監査を共有する。

## Goals / Non-Goals

**Goals:**

- `delta.reasoning` と `delta.reasoning_details` を runtime validation してストリーム結果へ伝搬する。
- `reasoning_details` の text / summary と、Discord に表示できない encrypted data を区別する。
- tool call を挟む同一生成では OpenRouter が返した `reasoning_details` を改変せず次 request へ返す。
- provider が返した表示可能な reasoning を、guild の表示設定に従って回答と区別して描画する。
- reasoning 本文が返らないモデルでは token 数だけを表示し、本文を推測・生成しない。

**Non-Goals:**

- 暗号化された reasoning の復号・表示。
- provider が非公開にした chain-of-thought の推測。
- reasoning 非対応モデルへ一律に reasoning parameter を送ること。
- reasoning token 数を completion token 数から差し引いて課金額を独自計算すること。

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| token 数の扱い | 既存の `completion_tokens_details.reasoning_tokens` 集計と `Reasoning: N` 表示を維持する | token 数はすでに runtime validation・tool loop 集計・footer 表示まで実装済みである |
| wire data | `reasoning` と `reasoning_details` を通常 content と別 field のまま保持する | 推論と最終回答を混ぜず、encrypted data を誤表示しない |
| 表示対象 | provider が返した text / summary だけを表示し、encrypted data は継続用に保持する | 表示可能性を provider の response 種別に従って判断できる |
| tool loop 継続 | assistant message の `reasoning_details` を順序・値とも変更せず、tool result に続く request へ再送する | OpenRouter は reasoning model の継続で details の往復を要求する場合がある |
| parser | 既存 SSE parser の validate phase で frame 全体を検証してから state へ反映する | malformed details を部分的に採用せず、現行の stream protocol error 契約を維持する |
| reasoning request | Models API の `supported_parameters` と reasoning metadata に応じて `reasoning.effort` / `reasoning.max_tokens` / `reasoning.exclude` を組み立てる | 未対応 parameter の送信と provider 依存の暗黙挙動を減らす |
| 表示設定 | `/config reasoning-display on\|off` を新設し、既定値を off とする | token・料金表示を制御する既存 `showLlmDetails` と分離し、推論本文を意図せず共有チャンネルへ公開しない |
| 表示タイミング | reasoning はストリーミング中に公開せず、最終応答時だけ表示する | 未確定内容の公開と、reasoning delta による edit 回数の増加を避ける |
| 表示内容 | provider の summary を優先し、summary がなければ text 全文を表示する。Bot による独自要約は行わない | provider が返した表現を改変せず、利用可能な reasoning を欠落させない |

## Design

### 変更対象ファイル

- 修正: `src/types/index.ts` — reasoning request、normalized reasoning detail、stream chunk / final result の型を追加する。
- 修正: `src/llm/openrouter.ts` — reasoning delta の runtime validation、蓄積、yield を実装する。
- 修正: `src/llm/toolLoop.ts` — reasoning details を assistant history へ保持し、tool call 後の request へ再送する。
- 修正: `src/services/chatService.ts` — 解決済み reasoning parameter を request へ適用する。
- 修正: `src/utils/chatContainerBuilder.ts` — reasoning と final answer を別 TextDisplay として描画する。
- 修正: `src/db/schema.ts` / `src/db/repositories/` — conversation-context 実装後は表示可能 text と opaque details を assistant turn に保存する。
- 修正: `tests/unit/llm/openrouter.test.ts` / `tests/unit/llm/toolLoop.test.ts` — reasoning の parsing・継続・異常系を検証する。

### stream と tool loop

`StreamReasoningChunk` は表示可能な text delta と normalized detail delta を通常 content から分離して返す。
SSE frame に content と reasoning が同居する場合も両方を順序どおり観測できるよう、一方を heartbeat へ落とさない。
terminal result は最終回答、表示可能 reasoning、OpenRouter へ再送する reasoning details を別 field で返す。
tool call で次の request が必要な場合は、当該 assistant message の content・tool calls・reasoning details を一組として history へ追加する。

### 永続化と削除

conversation-context 導入後は reasoning を assistant turn の versioned content へ含め、通常 content と同じ TTL・Discord message 削除・guild purge の対象にする。
encrypted details は Bot が解釈しない opaque JSON として schema version を付けて保存し、OpenRouter への継続 request だけに利用する。
履歴無効化時は reasoning details も本文と同時に物理削除し、別 cache やログへ複製しない。

### 表示

reasoning 表示を有効にした場合は `Reasoning` と最終回答を別 TextDisplay にし、[chat-response-v2](../chat-response-v2/design.md) の文字数・UTF-8 バイト数・fenced code block 対応 splitter を共用する。
表示は最終応答時に確定し、provider の summary が一つ以上あれば summary を順序どおり表示し、summary がなければ text を全文表示する。
`/config reasoning-display` の既定値は off とし、既存 `showLlmDetails` の値からは推論本文の表示可否を決めない。
reasoning が空、encrypted のみ、または provider が返さない場合は空の表示領域を作らず、token 数があれば既存 footer だけに表示する。

## Tasks

- [x] reasoning 表示方針を確定する。
- [ ] request / response / normalized detail の型を確定する。
- [ ] SSE parser で reasoning / reasoning_details を検証・伝搬する。
- [ ] tool loop で reasoning details を改変せず往復する。
- [ ] Models API metadata に基づく reasoning request validation を実装する。
- [ ] chat response builder に reasoning 表示を追加する。
- [ ] conversation-context の assistant turn へ reasoning details を統合する。
- [ ] provider が text / summary / encrypted を返す各ケースと malformed response をテストする。
- [ ] `docs/changes/reasoning-output/` 削除（リリース完了時、git 履歴がアーカイブ）。

## Risks

- **保存量と機微情報**: raw reasoning は最終回答より長く、ユーザ入力の断片を反復する可能性がある。conversation-context の TTL / purge と一体化し、reasoning だけを長期保持しない。
- **provider 差**: reasoning 本文や details の返却は model / provider に依存するため、reasoning を request しても token 数だけ、summary だけ、または encrypted data だけになる場合がある。

## 参照

- [OpenRouter Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) — reasoning request、reasoning / reasoning_details response、tool call 継続。
- [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models) — supported parameters と reasoning metadata。
