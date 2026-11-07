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

- `CHATGPT_PLAN_USER_ID` に設定した Discord ユーザーの、`CHATGPT_PLAN_GUILD_IDS` のギルドでの発言に、そのユーザーの ChatGPT プランで答える
- ローカルで動かすサインイン用スクリプトで資格情報を作り、bot はそれを読み込んで以後のトークン更新を自分で行う
- プランの上限に達したときや、プランで扱えない入力のときは、OpenRouter で答える
- 返答の表示で、プランで答えたことが分かる

**Non-Goals:**

- ホスティング者以外の利用者の発言をプランで答えること。ホスティング者のプランで他人に答えることは、SIWC の利用規約が、ある利用者のサブスクリプションで別の利用者のリクエストを処理することとして禁じている。他人が各自のプランを接続する形は OpenAI の承認が要る（設計メモ「SIWC の利用条件」）
- OpenCode Go、Anthropic のサブスクリプション、ChatGPT の `backend-api` を使うこと（設計メモ「採らない選択肢」）
- プロバイダを実行時に追加できるプラグイン機構
- 返答するかどうかの判定（`src/services/replyGateService.ts:146`）や cron の解釈（`src/services/chatService.ts:247`）のような、ストリーミングしない補助の呼び出しをプランに移すこと。ツイートの展開を含む返答や、ツイートの要約の依頼への返答は通常の返答なので、ほかの発言と同じく「応答経路の選び方」に従う

**将来別 change 候補:**

- 利用者ごとのプラン接続 → OpenAI の waitlist で承認が下りてから、[OAuth BYOK](../oauth-byok/design.md) の支払い元として扱う
- プランで使うモデルを利用者が選ぶ設定 → [設定階層化](../settings-hierarchy/design.md) のユーザー設定に載せる

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| プランで答える範囲 | `CHATGPT_PLAN_GUILD_IDS` のギルドでの `CHATGPT_PLAN_USER_ID` の発言だけ | 公開条件で使えるのは open-source かつ self-hosted の利用で、他人の発言を本人のプランで答えることは、SIWC の利用規約が禁じている。ギルドを限るのは、本人への返答でもほかの利用者の発言を OpenAI に送るので、SIWC の利用規約が求める通知と確認を済ませたギルドだけで使うためである（「SIWC の利用条件」） |
| 推論の宛先 | `POST https://api.openai.com/v1/responses` | SIWC の docs が指定する宛先である。docs は `chatgpt.com/backend-api` を使わないよう明記している |
| サインイン | ローカルのスクリプトで OAuth を済ませ、資格情報ファイルを本番へ写す | SIWC の redirect URI は `127.0.0.1` の loopback だけで、docs の self-hosted VM の手順もこの形である |
| 資格情報の保存 | `DATABASE_PATH` と同じ永続ボリュームのファイル（権限 600）。そのファイルを使うプロセスは本番の bot 1 つだけにする | 対象は一人分で、docs も「protected credential file」を前提にしている。refresh token は更新のたびに替わるので、2 つのプロセスが同じファイルを使うと互いの更新を無効にしうる。プロセスを 1 つに限れば、プロセス間のロックが要らない。DB と暗号化は利用者ごとの接続を入れるときに BYOK と共通で用意する。このファイルを本番のクラスタに置くことが SIWC の利用規約の保存の条文に合うかは未確認で、確認できるまで本番では有効にしない（「SIWC の利用条件」） |
| クライアントの構成 | Responses API のストリームを読む処理を共通化し、OpenRouter 用と OpenAI 用の 2 つのクライアントがそれを使う | 今の `OpenRouterClient` もすでに Responses API 形式で通信しており、違いはリクエストの変換と OpenRouter 独自の出力項目に限られる |
| プランで扱えないとき | 何も出力していなければ、その返答を OpenRouter のギルド既定のモデルで答え直す | 目的は費用を減らすことで、OpenRouter のキーもホスティング者のものなので、切り替えても請求先は変わらない |
| モデルの選択 | `CHATGPT_PLAN_MODEL` で 1 つ指定し、起動時に SIWC の `GET /v1/models` で本人のカタログにあることを確認する。画像と PDF の入力は、その応答が受け付けると示している場合だけ有効にし、示していなければプランの経路では扱えないものとする。コンテキスト長と最大出力は、その応答に含まれていればそれを使い、含まれていなければ OpenRouter のモデル一覧の `openai/<slug>` の項目を目安に使う。ツールと推論の要約は、その応答が対応を示していればそれに従い、示していなければ OpenRouter の同じ項目の `supported_parameters` にある `tools` と `reasoning` で判定し、どちらからも分からなければ使わない。一覧を取得できないときと、取得した一覧にモデルが無いときの扱いは「失敗の種類ごとの扱い」に書く。確認は起動のたびに行うので、`CHATGPT_PLAN_MODEL` を変えたときも新しいモデルで確認し直す | 利用者ごとの設定は設定階層化がまだ無い。docs の例は `slug` と `display_name` だけを取り出しており、応答が能力の情報を持つかは実際の応答で確認する。OpenRouter の情報は同じモデルの別の経路のものなので、SIWC の経路での対応と一致する保証はない。入力の種類を OpenRouter の情報で有効にすると、SIWC の経路が受け付けないファイルを会話履歴のツール（ツールを実行した後なので OpenRouter に切り替えられない）が返し、返答が失敗しうる。コンテキスト長を超えた場合は、最初のリクエストなら出力の前に失敗するので、OpenRouter で答え直せる。ツールを実行した後のリクエストで超えた場合は切り替えられず、今のツールの結果を外して送り直す処理（`src/llm/toolLoop.ts:1283`）でも収まらなければエラーで終わる。OpenRouter の値が SIWC の経路の実際の上限より大きいと、この場合が起きやすくなる。どちらからもコンテキスト長を得られないときは、プランの経路を無効にして起動する。ツールの定義と推論の指定は最初のリクエストから送るので、OpenRouter の情報で有効にしたものを SIWC の経路が受け付けなければ、出力の前に失敗する。その失敗が `subscription_sharing_unsupported_capability` のように「失敗の種類ごとの扱い」で「答え直す」とした種類なら OpenRouter で答え直し、表に無いコードならエラーで閉じる。docs のエラーの一覧は網羅的ではないので、非対応のときに返るコードは Tasks の実際の API での確認で決め、表に無いものが返れば表に足す。この点で、ツールを実行した後に初めて送ることのある入力の種類とは扱いを分ける |
| 上限の後の支払い | プランの枠だけを使う。ChatGPT の設定画面の App limits で、DisQord の登録に credits を使わせない設定にしてから有効にする | 目的は払い済みのプランの枠を使うことである。Profiles and sessions のページは、利用者がアプリごとに「ChatGPT plan and credits」の使用を設定できると書いている。errors のページは「OpenAI does not silently switch the request to another billing path」と書いているが、設定で credits を許していれば上限のエラーが返らずに credits が減りうる |

## Design

### SIWC の利用条件（2026-11-06 に公式 docs で確認）

- cookbook は「At launch, ChatGPT plan usage is available to open-source projects, personal projects that run locally, and selected private apps」と書き、続けて「If you're building a paid or remotely hosted app, join the waitlist to request access before offering it to users」と書いている。
- open-source 向けの概要は、対象を「open-source and locally hosted apps」とし、動かす場所の例に「a laptop installation or a self-hosted VM」を挙げている。事前の審査は書かれていない。
- 表示の要件は UI/UX guidelines にある。プランを使っている間は「Using ChatGPT plan」と `https://chatgpt.com/settings/usage` への「Manage usage」のリンクを示し、上限に達したときは「Manage usage」を主な操作として示す。初回のサインインでは、プランを使うことと設定画面で管理できることを伝える。本 change での満たし方は「表示」の節に書く。
- 本リポジトリは MIT ライセンスの public リポジトリで、本番はホスティング者自身の Kubernetes クラスタで動く。ホスティング者が自分のプランを自分の発言だけに使う形は、この「open-source かつ self-hosted」に当たると判断する。OpenAI に確認した結果ではない。
- SIWC の利用規約（Sign in with ChatGPT Terms）は、トークンの保存について「Any persistent storage of Authentication Tokens must be local and under the user's control, not in a remote or managed environment」と書き、リクエストの送信元について「Requests must originate from the user's local runtime or a remote runtime only that user controls」と書いている（2026-11-07 に検索結果の抜粋で確認した。ページは直接の取得を 403 で拒んだ）。一方で Self-hosted VMs のページは、ローカルで作った資格情報ファイルを VM に写し、以後の refresh を VM に任せる手順を示している。本番のクラスタ（README の「本番へのデプロイ」の talos2）は、ホスティング者が自分の Proxmox の VM で動かしている。ホスティング者だけが管理するなら、リクエストの送信元は「a remote runtime only that user controls」に当たると考えられる。しかし、そこに資格情報ファイルを置くことが保存の条文の「remote」に当たるかは、条文からも Self-hosted VMs の手順からも決まらない。OpenAI に確認して許されると分かるまで、本番ではプランの経路を有効にしない。
- 同じ規約は、個人データを「a legally adequate privacy notice that is presented to users before processing their data」に従って扱うよう求めている。プランの経路では、本人の発言に加えて、会話履歴に入るほかの利用者の発言と添付も OpenAI に送る（会話履歴を入力に組み込むのは `src/services/chatService.ts:170`）。今の OpenRouter の経路も同じ内容をモデルの提供元へ送っているが、プランの経路ではこの規約の義務が加わる。規約は通知のほかに、利用者の承認と、必要な開示、制御、同意も求めている。この users にほかの利用者が含まれるかは条文から決まらないので、含まれるものとして扱う。プランの経路は、次の 2 つを満たしたギルドでだけ使い、`CHATGPT_PLAN_GUILD_IDS` に並べる。ほかのギルドでは、本人の発言も OpenRouter で答える。1 つ目は、本人の発言への返答ではほかの利用者の発言と添付も OpenAI に送ることを説明する通知を、後から参加した人も読める場所（ルールのチャンネルのピン留めなど）に置くことである。通知より前の発言も会話履歴に入りうることも書く。2 つ目は、その通知で足りるか、承認や同意の手続き、利用者が送られないようにする手段が要るかを確認し、要るものを用意することである。この確認をまだしていないので、満たしたギルドはまだ無い。ほかの利用者の発言と添付をプランの経路に送らない形は、本人への返答で会話の流れを読めなくなり、会話履歴の機能が働かなくなるので採らない。
- ほかの利用者が自分のプランを接続する形は、その利用者から見れば他人のサーバーで動くアプリなので「remotely hosted app」に当たり、waitlist の承認が先に要る。承認の基準と待ち時間は docs に書かれていない。
- ホスティング者のプランでほかの利用者に答える形は採らない。SIWC の利用規約は、ある利用者のサブスクリプションで別の利用者のリクエストを処理することと、別の利用者の操作で認証済みの利用者のアカウントへリクエストを送ることを禁じている。OpenAI の利用規約も「You may not share your account credentials or make your account available to anyone else」と書いている。承認の有無とは関係なく採らない。
- Plus の 5 時間ごとの上限は、そのプランを使うすべてのアプリで共有される（Pro にはこの上限がない）。Codex など、同じプランを使うほかのアプリの利用と枠を取り合う。

### 採らない選択肢

- **OpenCode Go**：利用規約が「You will only use the Services for your own internal use, and not on behalf of or for the benefit of any third party」と定め、Go の docs は対象を「OpenCode and other coding agents」としてトラフィックを監視すると書いている。ギルドの複数人に雑談で答える bot はどちらにも合わない。
- **ChatGPT の `backend-api`**：Codex CLI がプランで使う宛先だが、SIWC の docs は使わないよう明記している。
- **Anthropic のサブスクリプション**：Claude Code の legal and compliance のページは、第三者のアプリが Free、Pro、Max、Ultra のプランの資格情報で利用者のリクエストを中継することを禁じている。
- **DSH（deepseek-harness）のようなプラグイン機構**：DSH のプラグインは同じプロセス内で動く npm パッケージで、分離にはならない。運営者が一人の bot では、パッケージを後から入れられる利点がなく、読み込む外部コードの分だけ攻撃面が増える。
- **Vercel AI SDK への移行**：`openrouter.ts` と `toolLoop.ts` に入っているストリームの検証を作り直すことになる。加えて、OpenRouter のサーバーツールとプラグインが AI SDK の OpenRouter 用 provider でそのまま使えるかは確認できていない。

### 応答経路の選び方

経路は、返答 1 回ごとに、`messageCreate` が入力を検証する前に次の順で決める。

1. 投稿者が `CHATGPT_PLAN_USER_ID` でない、発言したギルドが `CHATGPT_PLAN_GUILD_IDS` に無い、プランの経路が無効になっている、または停止中（下の「失敗の種類ごとの扱い」）である → OpenRouter
2. 入力がプランで扱えない（下の「機能ごとの扱い」で OpenRouter と書いたものを含む） → OpenRouter
3. それ以外 → プラン（`CHATGPT_PLAN_MODEL`）

ギルドの「無料モデル限定」（`freeModelsOnly`、`src/utils/configPanel.ts:22`）は、この選び方に入れない。
この設定は OpenRouter で従量の支払いが出るモデルを止めるためのもので、プランの経路は払い済みのプランの枠を使い、App limits で credits を使わせない設定にしてから有効にするので、追加の支払いが出ない。
`CHATGPT_PLAN_GUILD_IDS` にギルドを入れるのはホスティング者なので、プランを使うかはそちらで決まる。
設定の説明（「無料モデルだけを利用します。」）には、ホスティング者の ChatGPT プランで答える発言は対象外であることを書き足す。

今はモデルに依存する判定が、どれもギルド既定のモデルを見ている。
画像入力の事前判定（`src/bot/events/messageCreate.ts:375`）、ツールと推論表示とコンテキスト長の判定（`src/services/chatService.ts:451`）、会話履歴の画像の判定（`src/index.ts:158`）がそれに当たる。
これらは、決めた経路のモデルで判定するように変える。
プランの経路では、モデルの情報を Decisions の「モデルの選択」の順で得る。

1 回の返答の中で経路を変えるのは、プランの経路が何も出力しないうちに失敗し、その失敗が下の「失敗の種類ごとの扱い」の表で「答え直す」とした種類に当たるときだけである。
表で「エラーで閉じる」とした種類と、表に無い失敗は、切り替えずに今のエラー表示で閉じる。
安全ポリシーで拒否されたことを示すエラー（Responses API の `error.code` の `bio_policy`、`misalignment_policy_violation`、`image_content_policy_violation` など）と、分類できないエラーがこれに当たる。
これらは HTTP のエラー応答で届いても、ストリームの途中の `response.failed` で届いても同じに扱う。
ポリシーで止められた入力を OpenRouter に送り直さないためと、知らない失敗を切り替えで隠さないためである。
「何も出力しない」は、本文を 1 文字も生成しておらず、クライアントツール（投票の作成のように Discord を変えるものを含む）を 1 つも実行していないことを指す。
今ある、ツイートの画像を外して答え直す処理（`src/services/chatService.ts:654`）と同じ条件である。
ツールを実行した後に答え直すと、同じ操作を OpenRouter の側でもう一度行いうるので、その場合は切り替えずにエラーとして閉じる。
答え直すときは元の入力から OpenRouter 用のリクエストを組み立て直し、失敗したプランの経路の推論の項目やツール呼び出しの ID は引き継がない。
ギルド既定のモデルが画像を受け付けないなど、OpenRouter の経路で入力を受け付けられないときは、その経路のエラー表示になる。

モデルが答えを拒否した場合（Responses API の `response.refusal.delta` と `response.refusal.done`）は失敗ではない。
今のストリーム処理は知らないイベントを読み飛ばす（`src/llm/openrouter.ts:1392`）ので、拒否の文だけが返ると本文が空になり、`toolLoop.ts` が空の応答のエラーにする（`src/llm/toolLoop.ts:1482`）。
このままでは、モデルが返した拒否の文が表示されず、利用者には原因の分からないエラーだけが見える。
共有するストリーム処理は拒否の文を本文として表示し、拒否で終わった返答は切り替えずにそのまま閉じる。
OpenRouter の経路にも同じ処理が入るので、拒否の文が空の応答のエラーではなく本文として表示されるようになる。

安全フィルターで止まった場合（`response.incomplete` の `reason: "content_filter"`）も切り替えない。
今のコードはこの終了理由を `content_filter` として読み（`src/llm/openrouter.ts:662`）、本文が空なら空の応答のエラーにする（`src/llm/toolLoop.ts:1530`）。
プランの経路では、`content_filter` で終わった返答は本文の有無によらず切り替えず、本文が空なら今のエラー表示で閉じる。

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
- `ext_agent_host_id` は、資格情報を使うホストごとに 1 つ、UUIDv4 を生成して `urn:uuid:<UUID>` の形で作る。docs は JWK thumbprint URI、`urn:uuid:`、`did:key:` の形を受け付けるとし、UUID を使うなら UUIDv4 に `urn:uuid:` を付けて使い続けるよう求めている。スクリプトは「本番用」のホスト ID を作ってローカルに保存し、本番用の資格情報を作るとき（再認証を含む）は毎回それを使う。ローカルの PC 自身のホスト ID と混ぜない。
- 新規登録の callback は `code`、`state`、発行済みの `client_id`（`oaiapp_...`）を返す。スクリプトは `state` を照合し、発行済みの `client_id` でコードを交換する。`dynamic_agent_client` は登録の入口であり、交換にも保存にも使わない。再認証では保存済みの `client_id` を使い、callback が別の `client_id` を返したら結果を捨てる。
- 発行済みの `client_id` とホスト ID は、受け取った時点で資格情報とは別の登録情報としてローカルに保存する。コードの交換が `invalid_grant` になった場合や下の検証に通らなかった場合も、登録そのものは成立しているので、次は新規登録ではなく、この `client_id` での再認証から始める。
- 交換の後、ID token の署名（OpenAI の JWKS）、issuer、audience（発行済みの `client_id`）、有効期限、`nonce` を検証し、返った scope に `chatgpt.tokens.use.direct` があることを確認する。docs は「A valid ID token alone does not authorize ChatGPT plan usage」と書いている。署名から `nonce` までのどれかが満たされなければファイルを書かない。検証は通ったのに scope に `chatgpt.tokens.use.direct` が無いとき（プランの利用への同意が断られたときを含む）は、サインインの結果とは別の失敗として扱い、ファイルを書かずに同意が足りないことを表示する。再び試すときは、保存済みの `client_id` と、`chatgpt.tokens.use.direct` を含む全部の scope で OAuth をやり直し、同意の画面を出すために `prompt=consent` を付ける。docs は通常の再認証では同意を強制しないよう求め、`force_reconsent=true` は OpenAI が導入を確認した後に使うとしているので、`prompt=consent` を付けるのはこの再試行のときだけにする。最初に検証を通った ID token の `sub` は、登録情報にも保存する。再認証では、登録情報に `sub` があるときだけ、ID token の `sub` がそれと同じことを確認する。初回の交換が失敗した後の再認証のように `sub` がまだ無いときは、検証を通った ID token の `sub` を登録情報に保存する。
- ファイルには、発行済みの `client_id`、`access_token`、`refresh_token`、`id_token`、`sub`、付与された scope、access token の期限、ホスト ID を書く。
- 取り込みは起動時だけ行う。動いている bot は取り込み用のファイルを見ないので、写した後に古い bot が refresh の結果を保存しても、資格情報ファイルが上書きされるだけで取り込み用のファイルは残る。起動時の取り込みは、ファイルの権限が 600 であること、上の検証で保存した項目がそろっていることを確認してから rename する。満たさないファイルは取り込まずにログに残し、今の資格情報ファイルを使う。
- bot は access token の期限（サンプルでは `expires_in: 3600`）の手前で `https://auth.openai.com/api/accounts/oauth/token` に refresh grant を送る。プロセス内の同時の更新は 1 つの Promise にまとめ、新しいトークンを一時ファイルに書いてから rename で置き換える。
- refresh の結果が分からない場合がある。サーバーがトークンを更新した後で応答が届かなかった場合と、新しいトークンを受け取ってから保存する前にプロセスが終わった場合で、どちらも手元には古い refresh token しか残らない。古い refresh token を送り直すと、サーバーが更新を済ませていれば `refresh_token_reused` で拒否される。そのため、結果が分からない refresh の後は古い refresh token で 1 回だけ送り直し、`refresh_token_reused` などの終端のエラーなら「資格情報が使えない」として無効にする。登録情報（`client_id`、ホスト ID、`sub`）は残し、スクリプトでの再認証を求める。
- 終了するとき（SIGTERM）は、進行中の refresh が終わって保存されるのを、今の終了処理の待ち時間（`src/index.ts` の `CHAT_SHUTDOWN_TIMEOUT_MS`、8 秒）の範囲で待つ。新しい refresh は始めない。
- 資格情報ファイルを使うのは本番の bot だけにする。StatefulSet は古い Pod を止めてから新しい Pod を起動する（README の「本番へのデプロイ」）ので、通常の削除と更新では本番の中で 2 つのプロセスが重ならず、プロセス間のロックは置かない。この前提は Pod の強制削除（`kubectl delete --force --grace-period=0`）では崩れる。Kubernetes は、強制削除では古い Pod の停止を確認しないまま同じ名前の Pod が作られうると書いている。強制削除が要るときは、古いプロセスが止まったことをノードで確認してから新しい Pod を起動させる。開発用の bot でプランを試すときは、本番のファイルを写さず、スクリプトで別に登録する。登録が別なら `client_id` もトークンも別になるので、互いの refresh が衝突しない。
- トークンはログ、エラー表示、管理 API の出力に出さない。
- docs は、資格情報を写したセッションについて「Host-specific usage attribution and revocation of ChatGPT plan access for transferred sessions are not yet available」と書いている。ChatGPT の設定画面から取り消せるのはアプリ単位になる。

### クライアントの分割

今の `ILLMClient`（`src/llm/openrouter.ts:238`）は、チャットと OpenRouter だけの機能（モデル一覧と料金、残りクレジット）を 1 つにまとめている。
プランの経路が実装するのはストリーミングのチャットだけなので、`toolLoop.ts` が使う `chatStream()`（`src/llm/toolLoop.ts:585`）を別の interface に切り出し、OpenRouter 用と OpenAI 用のクライアントがそれを実装する。レート制限の判定（今の `isRateLimited()`、`src/llm/openrouter.ts:853`）はクライアントの中で使うものなので、それぞれのクライアントの内部に置く。

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
| `include: ["reasoning.encrypted_content"]` | 送らない | reasoning ガイドは、`store: false` の応答の推論の項目には既定で `encrypted_content` が含まれ、`include` のこの値は互換のために受け付けるが必須ではないと書いている。SIWC の経路で既定どおり返るかは未確認 |
| assistant の出力項目（推論、本文の message、function call）と、message ごとの `phase`（`commentary` か `final_answer`） | 受け取った順と項目の境界のまま、各 message の `phase` を付けて戻す | OpenAI の reasoning ガイドは、GPT-5.5 と GPT-5.4 のツールを多く使う流れで `phase` を使い、履歴を手で送り直すときは元の値を保つよう求めている。落とすと、ツール呼び出しの前置きが最終回答として扱われうる。conversation state のガイドも、`store` を使わない場合は `output` の項目を送り直すよう求めている。今のコードは 1 回の応答の本文を連結して 1 つの assistant メッセージにし（`src/llm/toolLoop.ts:1433`）、送るときに推論、本文、function call の順に並べ直す（`src/llm/openrouter.ts:558`）ので、1 つの `phase` を足すだけでは項目ごとの値と順序が残らない。そこで `AssistantChatMessage`（`src/types/index.ts:116`）に、表示用の連結した本文とは別に、出力項目を受け取った順に並べた列を足し、プランの経路ではこの列から送り直す。OpenRouter に送る形は今のまま変えない |

### 機能ごとの扱い

| 機能 | プランの経路での扱い |
| ---- | -------------------- |
| Web 検索（ギルドで有効なとき） | OpenRouter で答える。OpenAI の `web_search` は「subject to model and account/workspace policy」なので、実際に使えると確認したら、それを送る形に変える |
| 会話履歴のツール、Discord 操作、cron の提案 | function tool なので、上の送信形式でプランの経路に渡す |
| 画像と PDF の入力 | モデルが受け付ける場合（Decisions の「モデルの選択」のとおり、SIWC の `GET /v1/models` の応答が示している場合に限る）はプランの経路で送る。受け付けない場合は OpenRouter で答える。OpenRouter に回すのは、経路を決める時点で分かる入力（今の発言とその添付）に限る |
| 会話履歴の添付を開くツール（`view_attachment`） | 返答の途中で開くので、その時点ではクライアントツールを実行済みで、OpenRouter に切り替えられない。今のツールは画像だけモデルが受け付けるかを確認し（`src/services/conversationWindow.ts:1517`）、PDF は確認せずに `input_file` で返す（`src/services/conversationWindow.ts:1612`）。OpenRouter では PDF を読むプラグインがこれを補う（`src/services/chatService.ts:144`）が、プランの経路ではプラグインを送らない。そこでプランの経路では画像と PDF の両方を、上の行と同じ基準でモデルが受け付けるかを確認し、受け付けなければファイルを送らずに、開けない理由をツールの結果で返してプランで続ける |
| 推論表示 | 推論の要約が返れば表示する |
| フッターのコスト | 金額の代わりに、下の「表示」の節の表示を出す。トークン数が返るかは未確認 |
| LLM 入力を見る | 使えない。プランで答えた返答では、使えない理由を表示する |
| 返答するかどうかの判定 | OpenRouter の Decisions API のまま |

### 表示

UI/UX guidelines の表示の要件を、Discord とサインイン用スクリプトで次のように満たす。

- プランの経路の返答には「Using ChatGPT plan」と、`https://chatgpt.com/settings/usage` への「Manage usage」のリンクを出す。Discord には入力欄の横に表示を置く場所がないので、返答ごとの表示をその代わりにする。生成中の表示、完了したときのフッター、停止したときのフッター（`buildStoppedFooterText()`）、エラー表示のどれにも出し、LLM 詳細表示の設定（`messageCreate.ts:628` の `showDetails`）によらず出す。
- 使用量の上限のエラーを受けたときは、出力の有無と切り替えの結果によらず、上限に達したことと「Manage usage」のリンクを出す。OpenRouter で答え直した返答ではそのフッターに、出力の後で上限に達してエラーで閉じた返答ではエラー表示に出す。
- サインイン用スクリプトは、初回の登録が済んだときに、bot の返答の一部がこのプランを使うことと、ChatGPT の設定画面の Usage で管理できることを表示する。

### 失敗の種類ごとの扱い

エラーは、ストリームが始まる前の HTTP の応答として届くことも、始まった後の `response.failed` として届くこともある。
どちらでも、表の「この返答」が「答え直す」の種類で、何も出力していなければ、OpenRouter で答え直し、フッターに切り替えたことを書く。
「エラーで閉じる」の種類と、何か出力した後の失敗は、今のエラー表示で閉じる（使用量の上限のエラーなら、「表示」の節の案内を添える）。
「プランの経路の扱い」は、その後の返答で経路を決めるときに効く。

| 種類 | 例（errors and recovery のページ） | この返答 | プランの経路の扱い |
| ---- | ---------------------------------- | -------- | ------------------ |
| 使用量の上限 | `subscription_sharing_usage_limit_exceeded`（429） | 答え直す | 停止する。30 分ごとに再び試す。docs はこのコードから回復の時刻を推定しないよう求めており、30 分は回復の見込みではなく再確認の間隔である。長くすると上限が戻った後も OpenRouter に払い続け、短くすると上限のエラーを繰り返す |
| 一時的な障害 | `subscription_sharing_usage_unavailable`、`subscription_sharing_user_unavailable`（503）、推論と refresh のネットワークエラーと 5xx、`error.code` の `server_error` | 答え直す | 資格情報を残したまま、上限を付けた backoff の間だけ停止する |
| 入力が扱えない | `subscription_sharing_unsupported_capability`（400）、入力がコンテキスト長を超えたことを示す 400（コードは実際の API で確認する） | 答え直す | 停止しない。`error.param` をログに残し、同じ形の入力を次からも OpenRouter に回すかは、ログを見てコードで直す |
| 加入者を確認できない | `subscription_sharing_invalid_user`（401）。refresh を 1 回試し、refresh が成功しても同じエラーが続くもの | 答え直す | 資格情報を残したまま無効にし、request ID をログに残して原因を調べる。docs は、このコードでは request ID を残して資格情報の失敗を診断し、取り消しか終端の refresh エラーを確認してから再びのサインインを求めるとしているので、トークンは消さない。refresh が終端のエラーで失敗したときは「資格情報が使えない」に当たる |
| 資格情報が使えない | refresh の `invalid_grant`、`invalid_refresh_token`、`token_expired`、`refresh_token_expired`、`refresh_token_invalidated`、`refresh_token_reused` | 答え直す | 無効にする。docs は使えなくなったトークンを消して、保存済みの `client_id` で OAuth をやり直すよう求めているので、資格情報ファイルからトークンを消し、登録情報（`client_id`、ホスト ID、`sub`）だけを残す。ログに残し、スクリプトで再認証して写し直すまで戻らない |
| 権限や設定の誤り | `subscription_sharing_user_not_eligible`、`chatpass_v2_scope_not_authorized`（403）、`invalid_client` | エラーで閉じる | 無効にする。再試行も再認証も自動では行わない。docs は `chatpass_v2_scope_not_authorized` について「Check the client and grant configuration rather than retrying or changing billing」と書き、`subscription_sharing_user_not_eligible` でも同じリクエストの繰り返しを禁じているので、この返答を OpenRouter で答え直さない。無効にした後の返答は、経路を決める時点で OpenRouter になる |

「資格情報が使えない」ではトークンを消すので、再起動しても同じトークンを送り直さない。
それ以外の停止と無効の状態はメモリに置き、再起動で解ける。
再起動の直後の 1 回目で同じエラーを受ければ、同じ状態に戻る。

起動時の `GET /v1/models` の失敗も、プランの経路だけを止め、bot の起動は止めない。
その間は、本人の発言も OpenRouter で答える。
一覧を取得できないときは、受けたエラーを上の表の種類に当てはめる。
ネットワークエラーや 5xx のような一時的な障害なら、同じ backoff で一覧の取得を試し直し、取得してモデルを確認できた時点でプランの経路を戻す。
一覧を取得できたのに `CHATGPT_PLAN_MODEL` が無いときは、設定を確認すべきものとして無効にし、ログに残して再起動まで戻さない。
一覧はアカウントのその時点のカタログなので後から変わることはあるが、無いモデルが現れるのを待つより、ホスティング者が設定を確認して起動し直すほうが原因に気付きやすいので、一覧を取り直さない。

### 新規環境変数

| 変数名 | 必須 | 説明 |
| ------ | ---- | ---- |
| `CHATGPT_PLAN_USER_ID` | No | プランで答える Discord ユーザーの ID。未設定ならプランの経路は無効 |
| `CHATGPT_PLAN_GUILD_IDS` | No | プランの経路を使うギルドの ID（カンマ区切り）。「SIWC の利用条件」の通知と確認を済ませたギルドだけを入れる。未設定ならプランの経路は無効 |
| `CHATGPT_PLAN_MODEL` | `CHATGPT_PLAN_USER_ID` を設定する場合 | プランで使うモデルの slug |
| `CHATGPT_CREDENTIALS_PATH` | No | 資格情報ファイルのパス（既定: `data/chatgpt-credentials.json`）。取り込み用のファイルは、このパスに `.import` を付けた名前にする |

### 変更対象ファイル

- 新規: `src/llm/responsesStream.ts` — `OpenRouterClient` から切り出す、Responses API のイベントを内部の chunk に変える処理
- 新規: `src/llm/openaiPlan.ts` — プランの経路のクライアント（リクエストの変換、トークン更新、上限到達の検出）
- 新規: `src/llm/chatgptCredentials.ts` — 資格情報ファイルの読み込み、直列の refresh、置き換え
- 新規: `scripts/chatgpt-login.ts` — ローカルでのサインイン
- 修正: `src/llm/openrouter.ts` — interface の分割と共通処理の利用
- 修正: `src/services/chatService.ts` — 応答経路の選択と、出力前の失敗時のやり直し
- 修正: `src/bot/events/messageCreate.ts` — 入力の検証より前の経路の決定、決めた経路のモデルでの画像の判定、生成中、完了、停止、エラーの各表示での「Using ChatGPT plan」と「Manage usage」
- 修正: `src/types/index.ts`、`src/llm/toolLoop.ts` — assistant の出力項目を、受け取った順と各 message の `phase` のまま履歴に保つ
- 修正: `src/services/conversationWindow.ts` — プランの経路で、会話履歴の PDF をモデルが受け付けるかを確認する
- 修正: `src/index.ts` の会話履歴の画像の判定 — 決めた経路のモデルで判定する
- 修正: `scripts/e2e/preload.ts`、`scripts/e2e/input.ts` — OpenAI の宛先の観測と、通った経路の記録
- 修正: `src/bot/events/inspectInputCommand.ts` — プランで答えた返答での案内
- 修正: `src/config/envVars.ts`、`src/config/index.ts`、`src/index.ts` — 環境変数と DI の配線
- 修正: `src/utils/configPanel.ts` — 「無料モデル限定」の説明に、ホスティング者の ChatGPT プランで答える発言は対象外であることを足す
- 新規: `tests/unit/llm/openaiPlan.test.ts`、`tests/unit/llm/chatgptCredentials.test.ts`

## Tasks

- [ ] 手動確認: 資格情報ファイルを本番のクラスタに置くことが SIWC の利用規約の保存の条文（「SIWC の利用条件」）に合うかを OpenAI に確認する。許されないと分かったら、本番でのプランの経路を採らず設計し直す
- [ ] 手動確認: 本人の発言への返答ではほかの利用者の発言と添付も OpenAI に送ることを説明する通知の文面を書き、SIWC の利用規約が求める承認、開示、制御、同意のうち、通知のほかに要るものを確認する。要るものを用意したギルドだけを `CHATGPT_PLAN_GUILD_IDS` に入れる
- [ ] 手動確認: `scripts/chatgpt-login.ts` で実際にサインインし、発行された資格情報で `GET /v1/models` と `POST /v1/responses` が通ることを確認する
- [ ] function tool の送信形式（namespace か `additional_tools` か）を決め、function call、ツールの実行結果、次の推論までの 1 往復が通ることを実際の API で確認する
- [ ] `include` を送らずに推論の項目に `encrypted_content` が返り、それを次のリクエストに戻して受け付けられること、developer メッセージを会話の途中に置くこと、`input_file` の PDF、`usage` のトークン数を実際の API で確認する
- [ ] 手動確認: ChatGPT の設定画面の App limits で、DisQord の登録に credits を使わせない設定ができることを確認し、そう設定する。設定した状態で上限に達し、`subscription_sharing_usage_limit_exceeded` が返ること、その前後で credits の残高が変わらないことを確認する。設定できない場合は、プランの経路を有効にする前に設計し直す
- [ ] SIWC の `GET /v1/models` の実際の応答に、能力の情報（入力の種類、ツール、推論、コンテキスト長、最大出力）が含まれるかを確認する。モデルが受け付けないツールや推論の指定を送ったときに返るエラーのコードも確認し、「失敗の種類ごとの扱い」の表に無ければ足す
- [ ] OpenAI の `web_search` ツールがプランで使えるかを確認し、「機能ごとの扱い」の Web 検索の行を決める
- [ ] Responses API のストリーム処理を `OpenRouterClient` から切り出す（挙動を変えない refactor として先に入れる）
- [ ] 共有したストリーム処理で、`response.refusal.delta` と `response.refusal.done` を本文として扱う + テスト
- [ ] プランの経路で `content_filter` で終わった返答を切り替えずに閉じる + テスト
- [ ] assistant の出力項目を受け取った順と各 message の `phase` のまま内部の型に保ち、プランの経路で送り直す + テスト
- [ ] プランの経路の `view_attachment` で、モデルが画像や PDF を受け付けないときにファイルを送らず理由を返す + テスト
- [ ] 失敗の種類の表に無いエラー（安全ポリシーの `error.code` を含む）で、出力の前でも OpenRouter に切り替えない + テスト
- [ ] 起動時の `GET /v1/models` が一時的な障害で失敗したときに bot を起動してプランの経路だけを止め、取得できた時点で戻す。一覧にモデルが無いときは無効にする + テスト
- [ ] `chatStream()` の interface を分ける
- [ ] OpenAI 用クライアント、資格情報の読み込みと refresh + テスト
- [ ] `ChatService` の経路選択と、出力前の失敗時のやり直し + テスト
- [ ] フッターと「LLM 入力を見る」の表示
- [ ] 環境変数と DI の配線、README の環境変数と本番への資格情報の写し方
- [ ] e2e の入力の観測（`scripts/e2e/preload.ts` は今 `https://openrouter.ai/api/v1/responses` への POST だけを観測する）を `https://api.openai.com/v1/responses` にも広げ、どちらの経路を通ったかを記録する
- [ ] tester bot の ID を `CHATGPT_PLAN_USER_ID` にして既定のシナリオを実行し、シナリオごとに期待する経路を通ったことを確認する。テキストだけのシナリオはプランの経路を通ることを必須にする。画像と PDF のシナリオは、起動時に確認した能力で決まる経路（受け付けるならプラン、受け付けないなら経路を決める時点で OpenRouter）を期待する。経路を決める時点で OpenRouter にしたものと、プランで失敗した後に切り替わったものを記録で分け、切り替わった返答を成功と数えない。`CHATGPT_PLAN_USER_ID` を外した実行で、同じ発言が OpenRouter の経路を通ることも確認する
- [ ] `docs/changes/chatgpt-plan-provider/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- 「ホスティング者が自分のプランを自分の発言だけに使う」を open-source かつ self-hosted の利用とみなす判断は、docs の文言からの推論である。OpenAI が bot の形の利用をどう扱うかは確認していない。
- 資格情報ファイルを本番のクラスタに置くことが、SIWC の利用規約の「local and under the user's control, not in a remote or managed environment」に当たるかは未確認である。確認するまで本番ではプランの経路を有効にしない。
- ギルドで示す通知が SIWC の利用規約の「legally adequate privacy notice」として十分か、通知のほかに承認や同意の手続きが要るかは確認していない。確認するまで `CHATGPT_PLAN_GUILD_IDS` にギルドを入れない。
- e2e で tester bot の ID を `CHATGPT_PLAN_USER_ID` にすると、bot アカウントの発言をホスティング者のプランで答えることになる。tester bot もホスティング者が操作するものだが、これが本人の利用に当たるかは確認していない。e2e のギルドも、`CHATGPT_PLAN_GUILD_IDS` に入れる前に「SIWC の利用条件」の通知と確認を済ませる。
- 出力の前に失敗したときに OpenRouter でやり直すと、その返答の待ち時間が延びる。上限の手前で失敗が続く間は、プランの経路を止める待ち時間でしか抑えられない。
- docs の SIWC は preview の段階で、エンドポイントや制約は変わりうる。変わったときは、プランの経路だけを止めれば OpenRouter で答え続けられる構成にしておく。
- ChatGPT の設定画面から取り消すと、bot の資格情報は次の refresh で失敗する。それまでの間に送ったリクエストがどう扱われるかは未確認である。

## 参照

- [Sign in with ChatGPT（cookbook）](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)
- [ChatGPT plan usage for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source) と、その下の Registration and sign-in、Profiles and sessions、Models and inference、Preview limitations、Errors and recovery、Self-hosted VMs の各ページ
- [OpenAI Terms of Use](https://openai.com/policies/terms-of-use)
- [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/)
- [Reasoning models の phase](https://developers.openai.com/api/docs/guides/reasoning#phase-parameter) と [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- [SIWC の UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)
- [StatefulSet の Pod の強制削除](https://kubernetes.io/docs/tasks/run-application/force-delete-stateful-set-pod/)
- [OpenCode Go](https://opencode.ai/docs/go/) と [OpenCode の利用規約](https://opencode.ai/legal/terms-of-service)
- [Claude Code の Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
