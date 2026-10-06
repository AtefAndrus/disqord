---
title: "別Botの返信先引用とX投稿の展開"
status: implemented
priority: medium
summary: "別Botへの明示的な返信先を引用し、呼びかけ本文と返信先のX投稿リンクを展開する"
---

# 別Botの返信先引用とX投稿の展開

## Why

別Botの発言に返信してDisQordを呼び出すと、返信先がLLMへ渡らず、何について尋ねているのか伝わらない。
返信先にX投稿リンクがある場合も投稿内容を参照できるようにし、返信で指定した資料に基づく応答を可能にする。

## Goals / Non-Goals

**Goals:**

- 会話履歴が有効で読み取り権限がある場合に、同じチャンネルの別BotやWebhookの明示的な返信先を非信頼の引用として渡す。
- 呼びかけ本文に返信先の参照番号を示し、窓内の返信先本文を重複送信しない。
- 呼びかけ本文と解決済みの返信先にあるX投稿リンクを、既存の取得上限と設定に従って展開する。

**Non-Goals:**

- 通常の会話窓や `read_earlier_messages` に別BotやWebhookを含める。
- 返信先以外の履歴にあるX投稿リンクを展開する。
- DBスキーマ、依存ライブラリ、設定項目を追加する。

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 別Botを読む範囲 | 明示的な返信先だけ | ユーザーが指定した資料を引用し、通常履歴の対象範囲を保つため |
| 引用のロール | `user` | 外部Botの内容をDisQord自身の応答として扱わないため |
| 文字情報 | content、Embed、TextDisplay | 本文が空の通知Botでも表示されている内容を参照するため |
| X展開の入力 | 呼びかけ本文、返信先の順で一回にまとめる | 投稿IDの重複排除、合計上限、期限、キャンセルを既存サービスへ任せるため |
| 窓内の返信先 | 本文は窓の一件として送り、現在発言には参照番号を付ける | 引用の重複を避けながら質問との対応を示すため |

## Design

### 変更対象ファイル

- `src/services/conversationWindow.ts`: 明示的な返信先の別Bot引用、`replyTargetRef` の割り当て、再構築時の返答検証候補の絞り込み。
- `src/utils/discordMessageNormalizer.ts`: 別Botの表示文字列を `user` ロールへ正規化。
- `src/services/chatService.ts`: 現在発言への返信先参照の付加とX展開対象の組み立て。
- `tests/unit/services/conversationContext.test.ts`、`tests/unit/services/chatService.test.ts`、`tests/unit/utils/discordMessageNormalizer.test.ts`: 引用、除外、参照、展開の回帰テスト。
- `scripts/e2e/scenarios.ts`、`scripts/e2e/send.ts`: 別Botの返信先を使う3シナリオ、実Botメッセージの投稿、設定の事前確認。
- `scripts/e2e/preload.ts`、`scripts/e2e/input.ts`、`scripts/e2e/index.ts`: E2E子プロセスの入力観測、testerの履歴特例解除、入力検査、失敗証拠の保存。
- `tests/unit/scripts/e2eInput.test.ts`、`tests/unit/scripts/e2eSend.test.ts`: 入力欠落や重複の検出、観測の範囲、投稿順序、設定不足の回帰テスト。
- `README.md`: 返信先引用の範囲とX展開対象の説明。

### 返信先の解決

会話窓の取得が成功した場合だけ返信先を解決する。
会話履歴が無効、権限不足、異なるチャンネルへの参照では返信先を取得しない。
404や取得失敗では返信先を渡さない。

別BotやWebhookの通常発言と返信（type 0、19、またはtype省略）を明示的な引用として扱う。
systemメッセージはこの対象に含めない。
DisQord自身の返答は既存の記録確認と削除検証を通して解決し、2ページ目への返信でも全ページを組み立てた返答を引用する。

窓内の返信先にはそのメッセージの参照番号を使い、窓外の返信先には新たな参照番号を割り当てる。
`ConversationWindowContext.replyTarget` は窓外の本文だけを保持し、`replyTargetRef` は窓内外のどちらにも設定する。
現在発言には `(reply to [mN])` を付け、返信先本文は一回だけ送る。

### 会話窓の再構築

再構築時は、取得した発言のうち30分以内のものだけを通常の会話窓の検証候補にする。
30分ちょうどの発言は候補に含める。
窓外の古い返答記録を先に検証すると、Discord RESTの再試行で5秒の期限を使い切り、最近の返信先を含む会話窓全体が取得失敗になるためである。

取得した発言全体は保持し、窓内の返答を検証する際には古いtriggerや分割ページも利用する。
明示的な返信先は年齢で除外せず、窓外でも取得して既存の返答記録と削除状態を検証する。
分割返答は全ページを検証し、先頭ページの時刻を使って窓へ含めるか判断する。
この候補の絞り込みは再構築だけに適用する。
窓への追加と縮小は既存の起点と上限に従い、`read_earlier_messages` は期間を制限せずに過去を読む。

### 別Botの文字情報

`normalizeExternalBotMessage` は既存の人の発言の正規化を使い、contentにEmbedのtitle、description、url、author、fields、footerの文字情報と、再帰的に収集したTextDisplayのcontentを加える。
添付ファイルのメタデータと投票も既存の正規化で保持する。
DisQord専用のモデル表示、推論のcomponent ID、フッターを除去する規則は外部Botには適用しない。
引用は既存の非信頼データのsystem指示の後へ置く。

### X投稿の展開

`ChatService` は会話履歴設定が有効な場合に、窓外の `replyTarget` または `replyTargetRef` に対応する窓内のメッセージを参照する。
呼びかけ本文と返信先のtextを改行で連結し、既存の `TweetService.expandTweets` を一回呼ぶ。
ツイート展開設定が無効な場合はURL検出も取得も行わない。
返信先を解決できない場合は呼びかけ本文だけを対象にする。

投稿IDの重複排除、最大3投稿、最大4画像、5秒の取得期限、画像対応判定、キャンセルは既存のTweetServiceが処理する。
取得した投稿は既存の非信頼データの指示とともに現在発言へ追加する。

### 実Discordの返信先シナリオ

`bot-reply-embed`、`bot-reply-v2`、`bot-reply-tweet` は名前を指定したときだけ実行する。
3件とも会話履歴とLLM 詳細表示を必要とし、`bot-reply-tweet` はツイート展開も必要とする。
投稿前にDiscord RESTから対象チャンネルのguildを取得し、Botが使うDBの設定を確認する。
必要な設定が無効なら理由を表示して失敗とし、fixtureも呼びかけも投稿しない。
実行後は会話履歴を無効へ戻す。

testerはメンションなしの返信先fixtureを投稿し、無関係な本文のBot発言とComponents V2のBot発言を続けて投稿する。
その後、返信先fixtureのIDを `message_reference` に指定してDisQordを呼びかける。
投稿のREST応答でfixtureと無関係な発言の `author.bot` がtrueであることを確認する。
各fixtureには実行ごとのランダム文字列を入れ、呼びかけ本文には期待値の文字列を含めない。

| シナリオ | 返信先fixture | 検査する入力と返答 |
| -------- | ------------ | ------------------ |
| `bot-reply-embed` | 本文とEmbedのタイトル、説明、フィールド値 | 4つの文字列が引用とモデルの返答に含まれる |
| `bot-reply-v2` | 本文が空で、Container内のTextDisplayに文字列を持つComponents V2 | TextDisplayの文字列が引用とモデルの返答に含まれる |
| `bot-reply-tweet` | ランダム文字列と `https://fixupx.com/jack/status/20` | 文字列が引用に含まれ、取得したX投稿本文が現在発言に含まれ、返答に `twttr` が含まれる |

`bot-reply-tweet` の呼びかけ本文にはXリンクも投稿本文の期待値も含めない。
これにより返信先からのURL検出を検査する。
既定の `tweet` もツイート展開とLLM 詳細表示を事前確認し、呼びかけ本文のXリンクから取得した投稿本文を入力で検査する。

### LLMへ送信するHTTP入力の観測

モデルの返答だけでは、引用の欠落や、既知のX投稿に答えたことによる偽PASSを検出できない。
そのため、E2E子プロセスがOpenRouterへ送る実際の `POST /responses` のHTTP bodyを観測し、返答の検査と入力の検査がともに通った場合にPASSとする。
入力の観測がなければ失敗とし、`--no-spawn` では入力観測が必要なシナリオを投稿前に失敗とする。

子プロセス専用のpreloadはfetchの引数をそのまま転送し、レスポンスを読み取らずに、bodyのinputからメッセージのroleとテキストだけを親プロセスへ送る。
HTTPヘッダーは読み取らず、bodyのAPIキー、画像やファイルのbase64、推論、ツールの引数や結果は観測の出力に含めない（`scripts/e2e/preload.ts:18`、`scripts/e2e/input.ts:32`）。
テキスト内のbase64のdata URLも置換する。
この観測範囲とfetch転送は `tests/unit/scripts/e2eInput.test.ts` で検査する。

呼びかけごとに一意なマーカーを付け、現在発言にそのマーカーがある最初のHTTP入力を選ぶ。
過去の引用だけにマーカーがある入力は選ばず、後続のツール結果で最初の入力の欠落を補ってPASSにしない。
3件の返信先シナリオでは、次の条件を検査する。

- 返信先fixtureの期待値が、HTTP入力全体でそれぞれ一回だけ、同じ `user` ロールの引用に含まれる。
- 現在発言も `user` ロールであり、`[current]` の行の返信先refが引用の `[mN]` と一致する。
- 間に挟んだ無関係な本文とV2のBot発言の期待値が、入力に含まれない。
- preloadがその呼びかけに対するtesterの履歴特例解除を実行した記録がある。

`tweet` と `bot-reply-tweet` は、現在発言の `user` 入力に対象IDの `untrusted-tweet` ブロックがあり、そのブロックに取得した投稿本文が含まれることを要求する。
URLだけが含まれる入力や、モデルが既知の `twttr` を答えただけの返答は、この検査を満たさない。
失敗時はroleとテキストの入力証拠を `.e2e-failures/*.input.json` に保存し、返答のcomponentsを保存する既存JSONと併せて確認する。

### testerの履歴特例と検証範囲

新3件の呼びかけには専用の `[e2e-bot-context:UUID]` マーカーを付ける。
preloadは、現在発言がこのマーカーを持つtester Botの発言である場合だけ、`ConversationWindowService.build` に渡す `e2eTesterBotId` を外す。
testerを人として履歴へ含める特例を解除し、返信先fixtureを別Botとして引用する処理と、無関係なBot発言を通常窓から除外する処理を検査する。
既存のhistoryシナリオには専用マーカーを付けず、通常のtester特例を使う。

testerへの応答を許す入口の特例は使用し、Discordのメッセージ、HTTP通信、LLMの返答は実物を使う。
このため3件は、本番環境で別Botからの呼びかけを受け付けるかという入口判定や、別アカウントのBotやWebhookによる投稿を検証するものではない。
特例を外す範囲は会話窓への入力に限定されている（`scripts/e2e/preload.ts:8`）。
権限不足、削除、窓外の返信先などの条件は単体テストで検証する。

## Tasks

- [x] 別Botの引用欠落、返信先参照の欠落、X展開入力の欠落を回帰テストで再現する。
- [x] 明示的な返信先の正規化と返信先参照を実装する。
- [x] 呼びかけ本文と返信先を対象にX投稿を展開する。
- [x] 通常履歴での除外、窓内外、分割返答、削除、権限、設定、展開上限、キャンセルを単体テストで検証する。
- [x] 再構築時の窓外検証を省き、古い返信先、取得済みのtriggerと分割ページ、30分境界、削除検証を単体テストで確認する。
- [x] 実Botの返信先fixtureと無関係なBot発言を使う3シナリオ、設定の事前確認、専用マーカーによるtesterの履歴特例解除を実装する。
- [x] 実HTTP入力のrole、引用、ref、無関係な発言の除外、取得したX投稿本文を検査し、観測範囲と欠落検出の単体テストを追加する。
- [x] 実Discordで `bot-reply-embed`、`bot-reply-v2`、`bot-reply-tweet` のHTTP入力検査と返答検査を通す。
- [x] 型検査と全テスト1653件、コードlint、Markdown整形とlint、文書生成を通す。
- [x] 実Discordで既定シナリオと履歴シナリオを実行し、実行後に会話履歴を無効へ戻す。
- [ ] `docs/changes/reply-context-bots/` を削除する（リリース完了時、git履歴がアーカイブ）。

## Open Questions / Risks

別Botの引用資料や展開した投稿には外部の指示が含まれ得るため、非信頼データとしてモデルへ渡す。
system指示による扱いはモデルの指示追従に依存する。
Embedの画像やTextDisplay以外の文字を持たないコンポーネントは、この変更では文字情報として引用しない。
