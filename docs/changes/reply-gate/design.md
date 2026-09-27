---
title: "自動応答で返答するかを判断する"
status: investigating  # investigating | planned | in-progress | implemented
priority: medium       # high | medium | low
summary: "自動応答チャンネルの発言ごとに、安いモデルで返答すべきかを先に判定し、口を挟む場面でなければ何も送らない"
---

# 自動応答で返答するかを判断する

## Why

自動応答チャンネルでは、bot はすべての発言に返答する。
人どうしの雑談や相づちにも返答するので、会話に割り込み、読む側にも費用にも無駄が出る。
返答するかどうかを発言ごとに判断し、口を挟む場面でなければ黙るようにする。

## 依存 / 関連 change

- 前提（実装済み）: [conversation-context](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/conversation-context/design.md) — 会話の窓。判定は返答のために作る窓を流用する
- 連携: [settings-hierarchy](../settings-hierarchy/design.md) — 判定の有無や基準をチャンネル単位で変えたくなったら、同 change の設定の階層に載せる

## Goals / Non-Goals

**Goals:**

- 自動応答チャンネル（とその中のスレッド）の、bot へのメンションが無い発言について、返答する前に返答すべきかを判定する
- 返答しないと判定したら、チャンネルに何も送らない
- guild ごとに on/off を切り替えられ、既定は off にする

**Non-Goals:**

- メンションされた発言の判定。メンションは明示的な呼び出しなので、今までどおり必ず返答する
- 自動応答でない通常のチャンネルで、呼ばれていない発言に自発的に返答すること
- 判定の基準を guild ごとに文章で調整すること（必要になったら settings-hierarchy のカスタムプロンプトと合わせて扱う）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 方式 | 返答の生成より前に、別の安いモデルで 1 回だけ判定し、返答すると判定したときだけ「生成中...」を送って生成に進む | 黙るときは画面に何も出ない。本番のモデルに「黙る」出力を持たせる方式は、呼び出しが 1 回で済むが、「生成中...」を先に出すと表示が出て消え、出さずに待つと返答するときの表示が最初の文字まで遅れる |
| 判定のモデル | 固定のモデルを環境変数 `REPLY_GATE_MODEL` で決め、既定の値は Tasks の評価で決める。候補は `openai/gpt-6-luna`（推論 `minimal`）と `deepseek/deepseek-v4.1-flash`（推論 `none`） | 2026-09-27 の試行で、この 2 つは構造化出力を守り、推論のトークンを 0 にでき、1 回 1〜2 秒以内・$0.0001 以下だった（gpt-6-luna は 0.8〜1.1 秒・約 $0.00003、deepseek は 0.2〜0.6 秒・約 $0.00006）。どちらも試行は数回だけなので、既定は正解付きの例で精度と時間を測ってから決める |
| OpenRouter の Auto Router | 使わない | `openrouter/auto` は呼ぶたびに別のモデルを選び、候補を `allowed_models` で絞っても変わった。推論のトークンも付き、固定のモデルより遅かった（2026-09-27 の試行で 0.8〜2.9 秒）。判定の基準がモデルごとに揺れるのも判定器として欠点である |
| 判定の失敗 | 時間切れ（3 秒）、エラー、出力の形の誤りのどれでも返答する | 判定を入れる前の挙動（必ず返答する）に倒す。黙るべき発言に返答する誤りは、返答すべき発言を黙って落とす誤りより害が小さい |
| 判定の入力 | 会話履歴が on なら、返答のために作る会話の窓の新しい方から最大 20 件（合計 3,000 トークンまで、1 件 400 字まで）と新しい発言を渡す。off なら新しい発言と、それが bot の返答への返信かどうかだけを渡す | 返答するかは直近のやり取り（誰に向けた発言か、bot の直前の返答への続きか、人どうしの会話が続いているか）でほぼ決まり、古い履歴はあまり効かない。窓は返答のためにどのみち作るので、判定のための追加の取得は要らない。履歴が off の guild は会話を渡さない選択をしているので、判定にも渡さない。そのぶん判定は弱くなる |
| 判定の出力 | 構造化出力（Responses API の `text.format` の JSON Schema、`strict`）で `{"reply": boolean, "reason": string}` を返させる。`reason` はログにだけ使い、チャンネルには出さない | 自由文から yes/no を読み取るより誤りが少ない。理由をログに残すと、誤判定の傾向を後から調べられる |
| 無料モデル限定の guild | 判定は無料モデル限定の設定に関係なく、`REPLY_GATE_MODEL` で行う | 無料モデル限定は返答の費用を抑えるための設定である。判定は 1 回約 $0.0001 以下で、黙った発言の分だけ返答の費用が減る。判定を無料モデルにすると、上流の 429 で判定が失敗し、失敗時は返答するので意味が無くなる |
| 黙ったときの返答記録 | 作りかけの返答記録（`reply_records` の `pending`）を消し、その発言を返答の無い人の発言として扱う | 返答記録の状態に「返答しなかった」を足すと、SQLite の CHECK 制約の変更に表の作り直しが要る。記録が無ければ、窓は今でもその発言を返答の無い発言として扱う |
| 設定 | 設定パネルの「応答」ページに「自動応答の取捨選択」の on/off を足し、`guild_settings` の列 `reply_gate_enabled`（既定 0）に保存する | 既存の自動応答チャンネルの挙動を、管理者の明示なしに変えない |

## Design

### 変更対象ファイル

- 新規: `src/services/replyGateService.ts` — 判定の入力の組み立て、判定の呼び出し、時間切れと失敗の扱い
- 修正: `src/llm/openrouter.ts` — 非ストリーミングの `chat()` に `AbortSignal` を渡せるようにする
- 修正: `src/types/index.ts` — リクエストの型に `text`（構造化出力）と `reasoning.effort` を足す
- 修正: `src/bot/events/messageCreate.ts` — 自動応答の発言で設定が on のとき、窓を作った後、「生成中...」を送る前に判定を呼び、黙るなら作りかけの返答記録を消して終える
- 修正: `src/services/replyRecordService.ts` / 返答記録の repository — ページの無い `pending` の記録を消す関数
- 修正: `src/config/envVars.ts` — `REPLY_GATE_MODEL`
- 修正: `src/db/schema.ts` / `src/db/repositories/guildSettings.ts` / `src/services/settingsService.ts` / `src/utils/configPanel.ts` / `src/utils/statusMessage.ts` — 設定の列、setter、設定パネルの項目、`/status` の表示
- 新規: `scripts/reply-gate-eval.ts` — 正解付きの例で候補のモデルの精度と時間を測る
- テスト: 判定の入力の組み立て（件数とトークンの上限、履歴 off の入力）、失敗時に返答すること、メンションでは判定しないこと、黙ったときに何も送らず記録を消すこと

### 判定の指示

判定のモデルには、bot の名前と、次の基準を system メッセージで渡す。
文面は評価の結果に合わせて調整する。

- 返答する: bot に向けた発言（名前で呼ぶ、bot の直前の返答への返信や続き）、会話の参加者が答えを求めている質問で bot が役に立つもの、bot に意見や作業を頼むもの
- 返答しない: 人どうしで続いている会話、相づちや感想、特定の人に向けた発言、bot が直前に答えた話題への人どうしの反応

### 評価

`scripts/reply-gate-eval.ts` は、会話の窓と新しい発言と正解（返答すべきか）を組にした例を読み、候補のモデルごとに正解率、返答すべきなのに黙った件数、1 回の時間と費用を出す。
例は日本語の自動応答チャンネルを想定して 40 件以上作り、返答すべき例と黙るべき例を半々程度にする。
既定のモデルは、返答すべきなのに黙った件数が少ないことを優先して選ぶ。

### e2e

e2e のテスト bot は、メンションを付けた発言にしか返答されない（2 つの開発用の bot が互いに自動応答し続けるのを防ぐため）。
そのため、メンションの無い発言の判定は e2e では確かめられない。
判定の入力と分岐は単体テストで、判定の質は評価のスクリプトで、実際の挙動は手動確認で確かめる。

## Tasks

- [ ] `chat()` の `AbortSignal` と、リクエストの型の `text` と `reasoning.effort` を足す
- [ ] `replyGateService` を実装し、`messageCreate` に組み込む
- [ ] ページの無い `pending` の返答記録を消す関数を足す
- [ ] 設定の列、設定パネルの項目、`/status` の表示を足す
- [ ] 評価のスクリプトと例を作り、候補のモデルを測って `REPLY_GATE_MODEL` の既定の値を決める
- [ ] 単体テストを足す
- [ ] 手動確認: 自動応答チャンネルで設定を on にし、人どうしの雑談に bot が黙り、bot に向けた質問には返答することを確かめる
- [ ] `docs/changes/reply-gate/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **返答の遅れ**: 返答するときは、判定の時間（候補の試行で 0.2〜1.1 秒）だけ「生成中...」が出るのが遅れる。評価で時間も測り、遅れが目立つモデルは既定にしない。
- **履歴 off の判定の弱さ**: 新しい発言だけでは、人どうしの会話の続きかを判断しにくい。履歴 off の guild では、黙るべき発言に返答する側に誤りやすい。
- **プロバイダによる構造化出力の差**: `deepseek/deepseek-v4.1-flash` は構造化出力を扱わないプロバイダもある。使うときは `provider.require_parameters: true` を付ける。

## 参照

- OpenRouter Auto Router（<https://openrouter.ai/docs/guides/routing/routers/auto-router.md）—> 候補の選び方、`allowed_models`、料金
- OpenRouter Structured Outputs（<https://openrouter.ai/docs/guides/features/structured-outputs.md）と> `openapi.json` の `ResponsesRequest`（`text.format`、`reasoning.effort`）
- OpenRouter Provider Selection（<https://openrouter.ai/docs/guides/routing/provider-selection.md）—> `require_parameters`、`sort`
