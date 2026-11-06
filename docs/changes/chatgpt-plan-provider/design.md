---
title: "ChatGPT プランでの応答"
status: investigating
priority: medium
summary: "ホスティング者本人の発言に、Sign in with ChatGPT で接続した本人の ChatGPT プランで答え、OpenRouter の従量課金を減らす"
---

# ChatGPT プランでの応答

## Why

bot の LLM 利用料は、すべてホスティング者の OpenRouter キーに従量で請求される。
ホスティング者が別に ChatGPT の有料プランを払っていても、その枠を bot の応答には使えない。
OpenAI の Sign in with ChatGPT（以下 SIWC）で本人のプランを接続し、本人の発言にはそのプランで答えることで、OpenRouter への支払いを減らす。

## 依存 / 関連 change

- 連携: [OAuth BYOK](../oauth-byok/design.md) — 「誰の発言を誰の支払いで答えるか」を決める仕組みは同じである。本 change は支払い元の種類に ChatGPT プランを足す最初の一歩で、ホスティング者本人だけを対象にする。ほかの利用者が各自のプランを接続する形は、BYOK のキー解決（ユーザー → Guild → デフォルト）に ChatGPT プランを支払い元として加える形で設計する
- 連携: [使用統計](../usage-stats/design.md) — 支払い元を記録する列に、OpenRouter のキーとは別の値（ChatGPT プラン）が要る。プランでの応答はコストを返さないので、金額の集計からは外れる
- 関連: [サーバーツール付きの返答の LLM 入力を見る](../llm-input-server-tools/design.md) — 「LLM 入力を見る」は OpenRouter の生成ログを引くので、プランで答えた返答には使えない

## Goals / Non-Goals

**Goals:**

- `CHATGPT_PLAN_USER_ID` に設定した Discord ユーザーの発言に、そのユーザーの ChatGPT プランで答える
- ローカルで動かすサインイン用スクリプトで資格情報を作り、bot はそれを読み込んで以後のトークン更新を自分で行う
- プランの上限に達したときや、プランで扱えない入力のときは、OpenRouter で答える
- 返答のフッターで、プランで答えたことが分かる

**Non-Goals:**

- ホスティング者以外の利用者の発言をプランで答えること。ホスティング者のプランで他人に答えるのは OpenAI の利用規約に反し、他人が各自のプランを接続する形は OpenAI の承認が要る（設計メモ「SIWC の利用条件」）
- OpenCode Go、Anthropic のサブスクリプション、ChatGPT の `backend-api` を使うこと（設計メモ「採らない選択肢」）
- プロバイダを実行時に追加できるプラグイン機構
- 返答するかどうかの判定、cron の解釈、ツイートの要約など、ストリーミングしない補助の呼び出しをプランに移すこと

**将来別 change 候補:**

- 利用者ごとのプラン接続 → OpenAI の waitlist で承認が下りてから、[OAuth BYOK](../oauth-byok/design.md) の支払い元として扱う
- プランで使うモデルを利用者が選ぶ設定 → [設定階層化](../settings-hierarchy/design.md) のユーザー設定に載せる

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| プランで答える範囲 | `CHATGPT_PLAN_USER_ID` の発言だけ | 公開条件で使えるのは open-source かつ self-hosted の利用で、他人の発言を本人のプランで答えるのは規約上できない |
| 推論の宛先 | `POST https://api.openai.com/v1/responses` | SIWC の docs が指定する宛先である。docs は `chatgpt.com/backend-api` を使わないよう明記している |
| サインイン | ローカルのスクリプトで OAuth を済ませ、資格情報ファイルを本番へ写す | SIWC の redirect URI は `127.0.0.1` の loopback だけで、docs の self-hosted VM の手順もこの形である |
| 資格情報の保存 | `DATABASE_PATH` と同じ永続ボリュームのファイル（権限 600）。そのファイルを使うプロセスは本番の bot 1 つだけにする | 対象は一人分で、docs も「protected credential file」を前提にしている。refresh token は更新のたびに替わるので、2 つのプロセスが同じファイルを使うと互いの更新を無効にしうる。プロセスを 1 つに限れば、プロセス間のロックが要らない。DB と暗号化は利用者ごとの接続を入れるときに BYOK と共通で用意する |
| クライアントの構成 | Responses API のストリームを読む処理を共通化し、OpenRouter 用と OpenAI 用の 2 つのクライアントがそれを使う | 今の `OpenRouterClient` もすでに Responses API 形式で通信しており、違いはリクエストの変換と OpenRouter 独自の出力項目に限られる |
| プランで扱えないとき | 何も出力していなければ、その返答を OpenRouter のギルド既定のモデルで答え直す | 目的は費用を減らすことで、OpenRouter のキーもホスティング者のものなので、切り替えても請求先は変わらない |
| モデルの選択 | `CHATGPT_PLAN_MODEL` で 1 つ指定し、起動時に SIWC の `GET /v1/models` で本人のカタログにあることを確認する。能力（画像と PDF の入力、ツール、コンテキスト長、最大出力）は、その応答に含まれていればそれを使い、含まれていなければ OpenRouter のモデル一覧の `openai/<slug>` の項目から読む | 利用者ごとの設定は設定階層化がまだ無い。docs の例は `slug` と `display_name` だけを取り出しており、応答が能力の情報を持つかは実際の応答で確認する。OpenRouter の情報は同じモデルの別の経路のものなので、SIWC の経路での上限や対応と一致する保証はない。どちらからも能力を得られないときは、プランの経路を無効にして起動する |
| 上限の後の支払い | プランの枠だけを使う。ChatGPT の設定画面の App limits で、DisQord の登録に credits を使わせない設定にしてから有効にする | 目的は払い済みのプランの枠を使うことである。Profiles and sessions のページは、利用者がアプリごとに「ChatGPT plan and credits」の使用を設定できると書いている。errors のページは「OpenAI does not silently switch the request to another billing path」と書いているが、設定で credits を許していれば上限のエラーが返らずに credits が減りうる |

## Design

### SIWC の利用条件（2026-11-06 に公式 docs で確認）

- cookbook は「At launch, ChatGPT plan usage is available to open-source projects, personal projects that run locally, and selected private apps」と書き、続けて「If you're building a paid or remotely hosted app, join the waitlist to request access before offering it to users」と書いている。
- open-source 向けの概要は、対象を「open-source and locally hosted apps」とし、動かす場所の例に「a laptop installation or a self-hosted VM」を挙げている。事前の審査は書かれていない。
- 表示の要件は UI/UX guidelines にある。プランを使っている間は「Using ChatGPT plan」と `https://chatgpt.com/settings/usage` への「Manage usage」のリンクを示し、上限に達したときは「Manage usage」を主な操作として示す。初回のサインインでは、プランを使うことと設定画面で管理できることを伝える。本 change での満たし方は「表示」の節に書く。
- 本リポジトリは MIT ライセンスの public リポジトリで、本番はホスティング者自身の Kubernetes クラスタで動く。ホスティング者が自分のプランを自分の発言だけに使う形は、この「open-source かつ self-hosted」に当たると判断する。OpenAI に確認した結果ではない。
- ほかの利用者が自分のプランを接続する形は、その利用者から見れば他人のサーバーで動くアプリなので「remotely hosted app」に当たり、waitlist の承認が先に要る。承認の基準と待ち時間は docs に書かれていない。
- ホスティング者のプランでほかの利用者に答える形は、OpenAI の利用規約の「You may not share your account credentials or make your account available to anyone else」に反するので、承認とは関係なく採らない。
- Plus の 5 時間ごとの上限は、そのプランを使うすべてのアプリで共有される（Pro にはこの上限がない）。Codex など、同じプランを使うほかのアプリの利用と枠を取り合う。

### 採らない選択肢

- **OpenCode Go**：利用規約が「You will only use the Services for your own internal use, and not on behalf of or for the benefit of any third party」と定め、Go の docs は対象を「OpenCode and other coding agents」としてトラフィックを監視すると書いている。ギルドの複数人に雑談で答える bot はどちらにも合わない。
- **ChatGPT の `backend-api`**：Codex CLI がプランで使う宛先だが、SIWC の docs は使わないよう明記している。
- **Anthropic のサブスクリプション**：Claude Code の legal and compliance のページは、第三者のアプリが Free、Pro、Max、Ultra のプランの資格情報で利用者のリクエストを中継することを禁じている。
- **DSH（deepseek-harness）のようなプラグイン機構**：DSH のプラグインは同じプロセス内で動く npm パッケージで、分離にはならない。運営者が一人の bot では、パッケージを後から入れられる利点がなく、読み込む外部コードの分だけ攻撃面が増える。
- **Vercel AI SDK への移行**：`openrouter.ts` と `toolLoop.ts` に入っているストリームの検証を作り直すことになる。加えて、OpenRouter のサーバーツールとプラグインが AI SDK の OpenRouter 用 provider でそのまま使えるかは確認できていない。

### 応答経路の選び方

経路は、返答 1 回ごとに、`messageCreate` が入力を検証する前に次の順で決める。

1. 投稿者が `CHATGPT_PLAN_USER_ID` でない、プランの経路が無効になっている、または停止中（下の「失敗の種類ごとの扱い」）である → OpenRouter
2. 入力がプランで扱えない（下の「機能ごとの扱い」で OpenRouter と書いたものを含む） → OpenRouter
3. それ以外 → プラン（`CHATGPT_PLAN_MODEL`）

今はモデルに依存する判定が、どれもギルド既定のモデルを見ている。
画像入力の事前判定（`src/bot/events/messageCreate.ts:375`）、ツールと推論表示とコンテキスト長の判定（`src/services/chatService.ts:451`）、会話履歴の画像の判定（`src/index.ts:158`）がそれに当たる。
これらは、決めた経路のモデルで判定するように変える。
プランの経路では、モデルの情報を Decisions の「モデルの選択」の順で得る。

1 回の返答の中で経路を変えるのは、プランの経路が何も出力しないうちに失敗したときだけである。
「何も出力しない」は、本文を 1 文字も生成しておらず、クライアントツール（投票の作成のように Discord を変えるものを含む）を 1 つも実行していないことを指す。
今ある、ツイートの画像を外して答え直す処理（`src/services/chatService.ts:654`）と同じ条件である。
ツールを実行した後に答え直すと、同じ操作を OpenRouter の側でもう一度行いうるので、その場合は切り替えずにエラーとして閉じる。
答え直すときは元の入力から OpenRouter 用のリクエストを組み立て直し、失敗したプランの経路の推論の項目やツール呼び出しの ID は引き継がない。
ギルド既定のモデルが画像を受け付けないなど、OpenRouter の経路で入力を受け付けられないときは、その経路のエラー表示になる。

モデルが答えを拒否した場合（Responses API の `response.refusal.delta` と `response.refusal.done`）は失敗ではない。
今のストリーム処理は知らないイベントを読み飛ばす（`src/llm/openrouter.ts:1392`）ので、拒否の文だけが返ると本文が空になり、`toolLoop.ts` が空の応答のエラーにする（`src/llm/toolLoop.ts:1482`）。
このままでは、拒否が「何も出力しない失敗」と区別できず、OpenRouter で答え直すことになる。
共有するストリーム処理は拒否の文を本文として表示し、拒否で終わった返答は切り替えずにそのまま閉じる。
OpenRouter の経路にも同じ処理が入るので、拒否の文が空の応答のエラーではなく本文として表示されるようになる。

### サインインと資格情報

```text
ローカルの PC                                      本番の Pod
  bun scripts/chatgpt-login.ts
    127.0.0.1:1455 で callback を待つ
    ブラウザで auth.openai.com を開いて承認
    code を token に交換
    資格情報ファイルを書く
  kubectl cp で /app/data/ の取り込み用の名前へ写す ──>  （動いている bot はこのファイルを読まない）
  Pod を削除して起動し直す ─────────────────────────>  起動時に取り込み用のファイルを検証し、
                                                        資格情報ファイルへ rename して読み込む
                                                        期限の手前で refresh し、ファイルを置き換える
```

- 認可は `https://auth.openai.com/api/accounts/authorize` に、初回は `client_id=dynamic_agent_client`、`agent_name_hint=DisQord`、`ext_agent_host_id`、PKCE（S256）、`state`、`nonce`、scope `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`、`resource=https://api.openai.com/v1` を付けて行う。
- `ext_agent_host_id` は、資格情報を使うホストごとに 1 つ、ランダムな値で作る。スクリプトは「本番用」のホスト ID を作ってローカルに保存し、本番用の資格情報を作るとき（再認証を含む）は毎回それを使う。ローカルの PC 自身のホスト ID と混ぜない。
- 新規登録の callback は `code`、`state`、発行済みの `client_id`（`oaiapp_...`）を返す。スクリプトは `state` を照合し、発行済みの `client_id` でコードを交換する。`dynamic_agent_client` は登録の入口であり、交換にも保存にも使わない。再認証では保存済みの `client_id` を使い、callback が別の `client_id` を返したら結果を捨てる。
- 発行済みの `client_id` とホスト ID は、受け取った時点で資格情報とは別の登録情報としてローカルに保存する。コードの交換が `invalid_grant` になった場合や下の検証に通らなかった場合も、登録そのものは成立しているので、次は新規登録ではなく、この `client_id` での再認証から始める。
- 交換の後、ID token の署名（OpenAI の JWKS）、issuer、audience（発行済みの `client_id`）、有効期限、`nonce` を検証し、返った scope に `chatgpt.tokens.use.direct` があることを確認する。docs は「A valid ID token alone does not authorize ChatGPT plan usage」と書いている。どれかが満たされなければファイルを書かない。再認証では、ID token の `sub` が保存済みのものと同じことも確認する。
- ファイルには、発行済みの `client_id`、`access_token`、`refresh_token`、`id_token`、`sub`、付与された scope、access token の期限、ホスト ID を書く。
- 取り込みは起動時だけ行う。動いている bot は取り込み用のファイルを見ないので、写した後に古い bot が refresh の結果を保存しても、資格情報ファイルが上書きされるだけで取り込み用のファイルは残る。起動時の取り込みは、ファイルの権限が 600 であること、上の検証で保存した項目がそろっていることを確認してから rename する。満たさないファイルは取り込まずにログに残し、今の資格情報ファイルを使う。
- bot は access token の期限（サンプルでは `expires_in: 3600`）の手前で `https://auth.openai.com/api/accounts/oauth/token` に refresh grant を送る。プロセス内の同時の更新は 1 つの Promise にまとめ、新しいトークンを一時ファイルに書いてから rename で置き換える。
- refresh の結果が分からない場合がある。サーバーがトークンを更新した後で応答が届かなかった場合と、新しいトークンを受け取ってから保存する前にプロセスが終わった場合で、どちらも手元には古い refresh token しか残らない。古い refresh token を送り直すと、サーバーが更新を済ませていれば `refresh_token_reused` で拒否される。そのため、結果が分からない refresh の後は古い refresh token で 1 回だけ送り直し、`refresh_token_reused` などの終端のエラーなら「資格情報が使えない」として無効にする。登録情報（`client_id` とホスト ID）は残し、スクリプトでの再認証を求める。
- 終了するとき（SIGTERM）は、進行中の refresh が終わって保存されるのを、今の終了処理の待ち時間（`src/index.ts` の `CHAT_SHUTDOWN_TIMEOUT_MS`、8 秒）の範囲で待つ。新しい refresh は始めない。
- 資格情報ファイルを使うのは本番の bot だけにする。StatefulSet は古い Pod を止めてから新しい Pod を起動する（README の「本番へのデプロイ」）ので、本番の中で 2 つのプロセスが重なることはない。開発用の bot でプランを試すときは、本番のファイルを写さず、スクリプトで別に登録する。登録が別なら `client_id` もトークンも別になるので、互いの refresh が衝突しない。
- トークンはログ、エラー表示、管理 API の出力に出さない。
- docs は、資格情報を写したセッションについて「Host-specific usage attribution and revocation of ChatGPT plan access for transferred sessions are not yet available」と書いている。ChatGPT の設定画面から取り消せるのはアプリ単位になる。

### クライアントの分割

今の `ILLMClient`（`src/llm/openrouter.ts:238`）は、チャットと OpenRouter だけの機能（モデル一覧と料金、残りクレジット）を 1 つにまとめている。
プランの経路が実装するのはストリーミングのチャットだけなので、`toolLoop.ts` が使う `chatStream()` と `isRateLimited()` を別の interface に切り出し、OpenRouter 用と OpenAI 用のクライアントがそれを実装する。

SSE を読み、Responses API のイベントを内部の chunk に変える処理は、今は `OpenRouterClient` の中にある。
OpenAI の Responses API も同じイベントを送るので、この処理をクライアントから切り出して共有する。
OpenRouter 独自の部分（`openrouter:web_search` の出力項目、`openrouter_metadata` のプロバイダ名、`usage.cost`）は OpenRouter 用クライアントの側に残す。

OpenAI 用クライアントは、内部のリクエストを次のように変換する。

| 内部のリクエスト | プランへ送る形 | 根拠 |
| ---------------- | -------------- | ---- |
| `role: "system"` のメッセージ | 同じ位置の `role: "developer"` のメッセージ | SIWC は system の項目を拒否し、`instructions` か developer メッセージを求める。日時や書式の指示が会話の途中に入るので、位置を保てる developer を使う |
| `max_output_tokens` | 送らない | SIWC が送らないよう求めている。`contextBudget.ts` の出力分の確保はそのまま残す |
| `plugins`（PDF を読むプラグイン） | 送らない。PDF は `input_file` のまま送る | OpenRouter のプラグインである。SIWC はモデルが受け付ける場合に files を扱う |
| `session_id` | 送らない | OpenRouter の項目である |
| function tool | namespace にまとめるか、`additional_tools` の入力項目で渡す。どちらを使うかと、ツール呼び出しの名前と履歴の変換は、実際の API で確認してから決める | SIWC は「Group function/custom tools in namespaces or supply them through `additional_tools` input items」と指定している。今の `toResponsesBody()`（`src/llm/openrouter.ts:597`）のように最上位の `tools` に並べる形が受け付けられるかは、docs に書かれていない |
| `openrouter:datetime`、`openrouter:web_search` | 送らない | OpenRouter のサーバーツールである。日時は system メッセージでも渡している |
| なし | `store: false`、`stream: true` を必ず付ける | SIWC が必須とする |
| `include: ["reasoning.encrypted_content"]` | そのまま送る | `store: false` で推論の項目を次のリクエストに戻すために要る。SIWC で受け付けるかは未確認 |

### 機能ごとの扱い

| 機能 | プランの経路での扱い |
| ---- | -------------------- |
| Web 検索（ギルドで有効なとき） | OpenRouter で答える。OpenAI の `web_search` は「subject to model and account/workspace policy」なので、実際に使えると確認したら、それを送る形に変える |
| 会話履歴のツール、Discord 操作、cron の提案 | function tool なので、上の送信形式でプランの経路に渡す |
| 画像と PDF の入力 | モデルが受け付ける場合はプランの経路で送る。受け付けない場合は OpenRouter で答える |
| 推論表示 | 推論の要約が返れば表示する |
| フッターのコスト | 金額の代わりに、下の「表示」の節の表示を出す。トークン数が返るかは未確認 |
| LLM 入力を見る | 使えない。プランで答えた返答では、使えない理由を表示する |
| 返答するかどうかの判定 | OpenRouter の Decisions API のまま |

### 表示

UI/UX guidelines の表示の要件を、Discord とサインイン用スクリプトで次のように満たす。

- プランで答えた返答のフッターに「Using ChatGPT plan」と、`https://chatgpt.com/settings/usage` への「Manage usage」のリンクを出す。Discord には入力欄の横に表示を置く場所がないので、返答ごとのフッターをその代わりにする。
- 上限に達して OpenRouter で答え直した返答のフッターには、上限に達したことと「Manage usage」のリンクを出す。
- サインイン用スクリプトは、初回の登録が済んだときに、bot の返答の一部がこのプランを使うことと、ChatGPT の設定画面の Usage で管理できることを表示する。

### 失敗の種類ごとの扱い

エラーは、ストリームが始まる前の HTTP の応答として届くことも、始まった後の `response.failed` として届くこともある。
どちらでも、その返答の扱いは「応答経路の選び方」のとおりで、何も出力していなければ OpenRouter で答え直し、フッターに切り替えたことを書く。
何か出力した後なら、今のエラー表示で閉じる。
種類によって変わるのは、その後のプランの経路の扱いである。

| 種類 | 例（errors and recovery のページ） | プランの経路の扱い |
| ---- | ---------------------------------- | ------------------ |
| 使用量の上限 | `subscription_sharing_usage_limit_exceeded`（429） | 停止する。30 分ごとに再び試す。docs はこのコードから回復の時刻を推定しないよう求めており、30 分は回復の見込みではなく再確認の間隔である。長くすると上限が戻った後も OpenRouter に払い続け、短くすると上限のエラーを繰り返す |
| 一時的な障害 | `subscription_sharing_usage_unavailable`、`subscription_sharing_user_unavailable`（503）、refresh のネットワークエラーと 5xx | 資格情報を残したまま、上限を付けた backoff の間だけ停止する |
| 入力が扱えない | `subscription_sharing_unsupported_capability`（400） | 停止しない。`error.param` をログに残し、同じ形の入力を次からも OpenRouter に回すかは、ログを見てコードで直す |
| 資格情報が使えない | refresh の `invalid_grant`、`refresh_token_reused` など、`subscription_sharing_invalid_user`（401）のうち refresh でも回復しないもの | 無効にする。ログに残し、スクリプトで再認証して写し直すまで戻らない |
| 権限や設定の誤り | `subscription_sharing_user_not_eligible`、`chatpass_v2_scope_not_authorized`（403）、`invalid_client` | 無効にする。再試行も再認証も自動では行わない |

停止と無効の状態はメモリに置き、再起動で解ける。
再起動の直後の 1 回目で同じエラーを受ければ、同じ状態に戻る。

### 新規環境変数

| 変数名 | 必須 | 説明 |
| ------ | ---- | ---- |
| `CHATGPT_PLAN_USER_ID` | No | プランで答える Discord ユーザーの ID。未設定ならプランの経路は無効 |
| `CHATGPT_PLAN_MODEL` | `CHATGPT_PLAN_USER_ID` を設定する場合 | プランで使うモデルの slug |
| `CHATGPT_CREDENTIALS_PATH` | No | 資格情報ファイルのパス（既定: `data/chatgpt-credentials.json`）。取り込み用のファイルは、このパスに `.import` を付けた名前にする |

### 変更対象ファイル

- 新規: `src/llm/responsesStream.ts` — `OpenRouterClient` から切り出す、Responses API のイベントを内部の chunk に変える処理
- 新規: `src/llm/openaiPlan.ts` — プランの経路のクライアント（リクエストの変換、トークン更新、上限到達の検出）
- 新規: `src/llm/chatgptCredentials.ts` — 資格情報ファイルの読み込み、直列の refresh、置き換え
- 新規: `scripts/chatgpt-login.ts` — ローカルでのサインイン
- 修正: `src/llm/openrouter.ts` — interface の分割と共通処理の利用
- 修正: `src/services/chatService.ts` — 応答経路の選択と、出力前の失敗時のやり直し
- 修正: `src/bot/events/messageCreate.ts` — 入力の検証より前の経路の決定、決めた経路のモデルでの画像の判定、フッターの「Using ChatGPT plan」と「Manage usage」の表示
- 修正: `src/index.ts` の会話履歴の画像の判定 — 決めた経路のモデルで判定する
- 修正: `scripts/e2e/preload.ts`、`scripts/e2e/input.ts` — OpenAI の宛先の観測と、通った経路の記録
- 修正: `src/bot/events/inspectInputCommand.ts` — プランで答えた返答での案内
- 修正: `src/config/envVars.ts`、`src/config/index.ts`、`src/index.ts` — 環境変数と DI の配線
- 新規: `tests/unit/llm/openaiPlan.test.ts`、`tests/unit/llm/chatgptCredentials.test.ts`

## Tasks

- [ ] `scripts/chatgpt-login.ts` で実際にサインインし、発行された資格情報で `GET /v1/models` と `POST /v1/responses` が通ることを確認する
- [ ] function tool の送信形式（namespace か `additional_tools` か）を決め、function call、ツールの実行結果、次の推論までの 1 往復が通ることを実際の API で確認する
- [ ] 推論の項目（`include: ["reasoning.encrypted_content"]` と、それを次のリクエストに戻すこと）、developer メッセージを会話の途中に置くこと、`input_file` の PDF、`usage` のトークン数を実際の API で確認する
- [ ] ChatGPT の設定画面の App limits で、DisQord の登録に credits を使わせない設定ができることを確認し、そう設定する。設定した状態で上限に達し、`subscription_sharing_usage_limit_exceeded` が返ること、その前後で credits の残高が変わらないことを確認する。設定できない場合は、プランの経路を有効にする前に設計し直す
- [ ] SIWC の `GET /v1/models` の実際の応答に、能力の情報（入力の種類、コンテキスト長、最大出力）が含まれるかを確認する
- [ ] OpenAI の `web_search` ツールがプランで使えるかを確認し、「機能ごとの扱い」の Web 検索の行を決める
- [ ] Responses API のストリーム処理を `OpenRouterClient` から切り出す（挙動を変えない refactor として先に入れる）
- [ ] 共有したストリーム処理で、`response.refusal.delta` と `response.refusal.done` を本文として扱う + テスト
- [ ] `chatStream()` と `isRateLimited()` の interface を分ける
- [ ] OpenAI 用クライアント、資格情報の読み込みと refresh + テスト
- [ ] `ChatService` の経路選択と、出力前の失敗時のやり直し + テスト
- [ ] フッターと「LLM 入力を見る」の表示
- [ ] 環境変数と DI の配線、README の環境変数と本番への資格情報の写し方
- [ ] e2e の入力の観測（`scripts/e2e/preload.ts` は今 `https://openrouter.ai/api/v1/responses` への POST だけを観測する）を `https://api.openai.com/v1/responses` にも広げ、どちらの経路を通ったかを記録する
- [ ] tester bot の ID を `CHATGPT_PLAN_USER_ID` にして既定のシナリオを実行し、tester bot の発言がプランの経路を通ったこと、OpenRouter に切り替わった返答を成功と数えていないことを確認する。`CHATGPT_PLAN_USER_ID` を外した実行で、同じ発言が OpenRouter の経路を通ることも確認する
- [ ] `docs/changes/chatgpt-plan-provider/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- 「ホスティング者が自分のプランを自分の発言だけに使う」を open-source かつ self-hosted の利用とみなす判断は、docs の文言からの推論である。OpenAI が bot の形の利用をどう扱うかは確認していない。
- e2e で tester bot の ID を `CHATGPT_PLAN_USER_ID` にすると、bot アカウントの発言をホスティング者のプランで答えることになる。tester bot もホスティング者が操作するものだが、これが本人の利用に当たるかは確認していない。
- 出力の前に失敗したときに OpenRouter でやり直すと、その返答の待ち時間が延びる。上限の手前で失敗が続く間は、プランの経路を止める待ち時間でしか抑えられない。
- docs の SIWC は preview の段階で、エンドポイントや制約は変わりうる。変わったときは、プランの経路だけを止めれば OpenRouter で答え続けられる構成にしておく。
- ChatGPT の設定画面から取り消すと、bot の資格情報は次の refresh で失敗する。それまでの間に送ったリクエストがどう扱われるかは未確認である。

## 参照

- [Sign in with ChatGPT（cookbook）](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)
- [ChatGPT plan usage for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source) と、その下の Registration and sign-in、Profiles and sessions、Models and inference、Preview limitations、Errors and recovery、Self-hosted VMs の各ページ
- [OpenAI Terms of Use](https://openai.com/policies/terms-of-use)
- [OpenCode Go](https://opencode.ai/docs/go/) と [OpenCode の利用規約](https://opencode.ai/legal/terms-of-service)
- [Claude Code の Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
