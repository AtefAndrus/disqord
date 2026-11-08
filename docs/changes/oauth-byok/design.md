---
title: "OAuth BYOK（ユーザー別 OpenRouter キー）"
status: in-progress
priority: high
summary: "OAuth PKCE によるユーザー別 OpenRouter API キー（BYOK）"
---

# OAuth BYOK（OpenRouter キー接続）

## Why

ボットの LLM 利用料は、ホスティング者が環境変数で渡す 1 本の OpenRouter API キーにすべて請求される。
利用者が増えるほどホスティング者の負担が増え、利用者は自分のクレジットで高いモデルを使うこともできない。
OAuth PKCE でユーザーまたは Guild 管理者が自分の OpenRouter アカウントを接続し、そのクレジットで LLM を利用できるようにする。

## 依存 / 関連 change

- 連携: [使用量統計](../usage-stats/design.md) — どのキーが支払ったか（user / guild / default）を記録する列が要る。本 change のキー解決結果がその値の出どころになる
- 連携: [設定階層化](../settings-hierarchy/design.md) — ユーザー → Guild → デフォルトという解決順序は似ているが、API キーは設定値ではなく秘密情報なので、テーブルも解決ロジックも分けたままにする
- 連携: [ChatGPT プランでの応答](../chatgpt-plan-provider/design.md) — ホスティング者本人の発言を ChatGPT プランで答える。利用者ごとのプラン接続は、OpenAI の承認が下りた後に本 change のキー解決へ支払い元の種類として加える
- 連携: [コード実行](../code-execution/design.md) — コンテナは API キーの workspace に scope されるので、生成ファイルの取得は、その生成に使ったのと同じキーで行う必要がある

## Goals / Non-Goals

**Goals:**

- Discord ユーザーが `/connect user` で自分の OpenRouter アカウントを接続できる
- Guild 管理者が `/connect guild` で Guild 用の OpenRouter アカウントを接続できる
- 呼び出された返答は、ユーザーキー → Guild キー → デフォルトキーの順に解決したキーで支払う
- `/disconnect user|guild` で接続を解除できる
- API キーは暗号化して DB に保存する
- 未接続時にデフォルトキーを使わせるかをホスティング者が制御できる

**Non-Goals:**

- OpenRouter 以外のプロバイダーへの対応
- ユーザー / Guild ごとの利用量制限と課金管理（OpenRouter 側のキー上限に委ねる）
- OpenRouter 上のキーの失効操作（削除には Management key が要るので、解除は Bot の保存分だけを消し、OpenRouter のキー設定ページへのリンクを案内する）
- リフレッシュトークンの管理（OAuth PKCE で発行されるのは API キーであり、トークンの更新はない）
- Guild ポリシー（キー解決順序のカスタマイズ）
- `ENCRYPTION_KEY` のローテーション
- キーごとのモデル一覧（`/models/user`）の利用（下の Risks を参照）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 認証方式 | OAuth PKCE (S256) | OpenRouter が公式にサポートする。plain より S256 のほうが code_verifier の漏洩に強い |
| 認可コードの受け取り | 既定は headless モード（画面のコードを Modal に貼り付ける）。`OAUTH_CALLBACK_URL` を設定すると公開コールバックに切り替わる | 既定では公開 HTTPS の受け口が要らず、公開できるホスティング者は貼り付けを省ける。設計メモ「認可コードの受け取り方」で説明する |
| キー保存 | SQLite + AES-256-GCM 暗号化 | 既存 DB をそのまま使う。暗号化キーは環境変数で渡す |
| Bot への直接のメンションと、Bot の発言への返信によるメンションの支払い | ユーザー → Guild → デフォルト | 本人が接続していれば本人が払い、Guild が一括で払う運用も選べる |
| 自動応答（メンションなし）と、Bot の所属ロールだけへのメンションの支払い | Guild → デフォルト。ユーザーキーは使わない | 自動応答は本人が Bot を呼んでいない発言への返答である。接続しただけの利用者が、他の Guild の管理者が選んだ高いモデルの返答を、呼んでもいないのに請求されるのを防ぐ |
| 自動応答の判定（reply gate）の支払い | その発言に返答するときの支払い元と同じ（Guild → デフォルト） | 判定は発言ごとに走るので、ユーザーキーに載せると何も返答しなくても請求が発生する |
| 定期実行の支払い | Guild → デフォルト。ユーザーキーは使わない | ジョブは提案者が去っても動き続け、承認者と提案者が別人のこともあるので、特定の個人のキーに結びつけない。スケジュールの解釈（`interpretCronSchedule`）も同じ |
| 未接続時の扱い | `ALLOW_UNAUTHENTICATED` で制御（既定 `true`） | 既定を `true` にすれば、本 change を入れても既存の Guild の挙動が変わらない |
| 解決したキーが無効だった場合 | 下位のキーへフォールバックせずエラーにする | 失効したユーザーキーの代わりに Guild やホスティング者のキーへ黙って請求すると、支払う側が意図しない請求を受ける |
| 保存したキーを復号できない場合 | 下位のキーへフォールバックせずエラーにする | 理由は上と同じ。`ENCRYPTION_KEY` を変えた場合はここに当たり、利用者が接続し直す |
| キーの渡し方 | 解決したキーごとに `OpenRouterClient` をその都度生成する。デフォルトキーだけ既存の共有インスタンスを使う | 設計メモ「OpenRouterClient へのキーの渡し方」で比較する |
| キー検証 | 接続時に `GET /api/v1/key` を取得したキーで呼ぶ | 取得したキー自身の Bearer で呼べる。`GET /api/v1/credits` は Management key を要するため使わない |
| DB テーブル設計 | `api_keys` 1 テーブル + `scope` カラム | user と guild を同じ処理で扱える |
| 「LLM 入力を見る」とユーザーキー | ユーザーキーの生成はログを取りに行かず、その旨を表示する | 実行者は管理者であり、キーの持ち主とは別人である。本人の認証情報を他人の操作に使わない。Guild キーの生成は、その時点の Guild キーで取りに行く |
| `free_models_only` | 本 change では扱いを変えない | モデルは Guild に 1 つで、`free_models_only` は `/model set` と定期実行の前と reply gate の有効判定でだけ見る。利用者ごとのモデルが無いので、支払い元によって結果が変わる箇所が無い。利用者ごとのモデルを入れるときは [設定階層化](../settings-hierarchy/design.md) で決める |

## Design

### OpenRouter OAuth の仕様（2026-11-08 に OAuth ガイドと `openapi.json` で確認）

| 段階 | エンドポイント | 内容 |
| ---- | -------------- | ---- |
| 認可 | `https://openrouter.ai/auth?code_challenge=<S256(code_verifier)>&code_challenge_method=S256[&callback_url=<URL>][&key_label=<ラベル>][&state=<値>]` | ユーザーのブラウザで開く。`callback_url` を付けると認可後に `?code=` 付きでそこへリダイレクトし、付けないと（headless モード）認可コードを画面に表示する |
| キー交換 | `POST /api/v1/auth/keys`（body: `{ code, code_verifier, code_challenge_method: "S256" }`） | レスポンスは `{ key, user_id }`。`user_id` は nullable の OpenRouter アカウント識別子で、Discord の ID とは別物なので保存しない |
| キー検証 | `GET /api/v1/key`（`Authorization: Bearer <取得したキー>`） | 200 なら有効、401 なら無効。`limit_remaining`、`expires_at` などキー単位の情報が返る |

- 認可コードは一度しか使えず、発行から 10 分で失効する（期限切れは `403 Authorization code expired`）。
- headless モードでは `code_challenge` が必須である。コードが画面に表示されても、Bot が持つ `code_verifier` なしには交換できない。
- 任意パラメータに `key_label`（作成されるキーのラベルの初期値）、`workspace_id`（workspace の初期選択）、`required_workspace_id`（workspace の固定）、`state`（callback に同じ値で返る。headless と拒否時には返らない）がある。本 change は `key_label` だけを使い、workspace の選択は接続するユーザーに任せる。
- `POST /api/v1/auth/keys` は `Authorization` ヘッダなしで呼ぶ。`openapi.json` はグローバルの `apiKey` security を継承して見えるが、ガイドの例にヘッダはなく、ヘッダなしで無効なコードを送ると 401 ではなくコードの検証エラー（`400 Invalid code`）が返った（2026-11-08 に確認）。有効なコードでの交換は「手動確認」で確認する。
- キーには `expires_at` があり、失効期限付きのキーが発行されることがある。失効したキーは無効なキーと同じく 401 として扱う。
- キーの SHA-256（小文字 16 進）から、持ち主本人だけが開ける設定ページ `https://openrouter.ai/keys/<hash>` と利用ログ `https://openrouter.ai/logs?api_key_hash=<hash>` のリンクを作れる。
- `POST /api/v1/auth/keys/code` は、サーバー側から認可コードを作るための別の操作であり、ユーザーがブラウザで認可するこのフローでは使わない。
- `POST /api/v1/oauth/token` は workload identity 向けのトークン交換（RFC 8693）であり、このフローとは関係がない。

### 認可コードの受け取り方

受け取り方は二通りあり、`OAUTH_CALLBACK_URL` の有無で切り替える。
どちらも code_verifier の生成、キーの交換と検証、暗号化と保存、pending の同一性の確認は共通である。

#### 貼り付け（既定）

`callback_url` を付けずに認可 URL を開かせ、OpenRouter の画面に表示された認可コードを、ユーザーが Discord の Modal に貼り付ける。

```text
Discord                        Bot                          OpenRouter
  │ /connect user|guild         │                               │
  ├────────────────────────────>│ code_verifier 生成             │
  │                             │ pending に保存 (15 分)         │
  │ Ephemeral: [認可ページを開く]│                               │
  │            [コードを入力]    │                               │
  │<────────────────────────────┤                               │
  │ ブラウザで認可ページを開く、ログインして承認                    │
  ├─────────────────────────────┼──────────────────────────────>│
  │ 画面に認可コードが表示される                                   │
  │<────────────────────────────┼───────────────────────────────┤
  │ [コードを入力] → Modal に貼り付けて送信                         │
  ├────────────────────────────>│ POST /api/v1/auth/keys        │
  │                             ├──────────────────────────────>│
  │                             │ { key, user_id }              │
  │                             │<──────────────────────────────┤
  │                             │ GET /api/v1/key で検証         │
  │                             │ 暗号化して DB 保存              │
  │ Ephemeral: 接続完了          │                               │
  │<────────────────────────────┤                               │
```

- 公開 HTTPS の受け口が要らない。Bot の HTTP サーバー（`src/health.ts` の `startHttpServer`）はヘルスチェックと管理 API のためのもので、外部に公開しない構成を前提にできる。本番も tailnet 内だけに公開している（[docs/admin-api.md](../../admin-api.md)）。
- CSRF 対策の `state` が要らない。pending エントリは `/connect` を実行した Discord ユーザーに紐づき、Modal の送信は Discord がそのユーザーからのものとして届けるので、別人が他人の pending に認可コードを差し込む経路がない。
- Modal の送信は 3 秒以内に応答できないことがあるので、先に Ephemeral で defer してから交換と検証を行い、結果を同じ interaction の返信に書く。DM も元の返信の編集も要らない。
- 代わりにユーザーはコードをコピーして貼り付ける手間が一つ増える。接続は一人一回の操作なので、利用のたびに払う手間ではない。
- リクエストには既存の `HTTP-Referer` と `X-OpenRouter-Title` を付けるので、接続後の利用は OpenRouter の利用ログ上で DisQord に帰属すると考えられる。headless で作られたキー自体の表示は未検証である。

#### 公開コールバック（`OAUTH_CALLBACK_URL` を設定したとき）

認可 URL に `callback_url=<OAUTH_CALLBACK_URL>` と `state` を付け、OpenRouter からのリダイレクトを Bot の HTTP サーバーの `GET /auth/callback` で受ける。

```text
Discord                        Bot                          OpenRouter
  │ /connect user|guild         │                               │
  ├────────────────────────────>│ code_verifier と state 生成    │
  │                             │ pending に保存 (15 分)         │
  │ Ephemeral: [認可ページを開く]│                               │
  │<────────────────────────────┤                               │
  │ ブラウザで認可ページを開く、ログインして承認                    │
  ├─────────────────────────────┼──────────────────────────────>│
  │ ブラウザのリダイレクト        │ GET /auth/callback?code&state │
  │                             │<──────────────────────────────┤
  │                             │ state で pending を引いて確保   │
  │                             │ 権限の再確認、交換、検証、保存   │
  │ ブラウザ: 結果のページ        │                               │
  │<────────────────────────────┤                               │
  │ Ephemeral の編集: 接続完了    │                               │
  │<────────────────────────────┤                               │
```

- ユーザーは承認するだけで済み、コードの貼り付けが要らない。公開 URL の callback には、OpenRouter のガイドによるとアプリ名と marketplace への掲載も付く。
- `state` は OpenRouter が同じ値を callback に返す公式のパラメータで、32 バイトの乱数を base64url にして使い、pending と突合する。拒否時には返らない。
- ルートは `OAUTH_CALLBACK_URL` が設定されているときだけ `Bun.serve` の `routes` に登録し、処理本体は管理 API と同じく `src/http/` に置く。未設定なら他の未知のパスと同じく 404 を返す。
- 同じ HTTP サーバーに `/health` と `/admin/*` があるので、ホスティング者はリバースプロキシで `/auth/callback` だけを公開する。本番の Ingress は tailnet 内限定で、tailnet の外の利用者のブラウザからは届かない。本番で使うなら公開経路を別途用意する必要があり、用意するまでは設定しない。
- `state` が無い、未知、期限切れのとき、および `code` が無いとき（拒否を含む）は、失敗のページを返して何もしない。`code` が無くても pending は消さないので、利用者は同じリンクからやり直せる。
- `state` が一致したら、await の前に pending を「処理中」にして確保する。同じ `state` の 2 回目の要求は「処理済み」のページを返し、交換しない。認可コードは一度しか使えないので、交換に失敗した pending は消し、利用者は `/connect` からやり直す。
- Guild の接続では、HTTP の要求に Discord の権限情報が無いので、交換の前に実行者のメンバー情報を Discord から取得し直して `canManageGuildSettings` で判定する。取得に失敗したときは接続しない。
- 結果はブラウザのページと、`/connect` の Ephemeral 返信の編集の両方で伝える。編集は待たずに起動してページを先に返す。interaction token の寿命は 15 分で pending の寿命と同じなので、期限ぎりぎりでは編集に失敗しうる。その失敗はログだけに残し、ページの結果と保存には影響させない。
- `Bun.serve` の `idleTimeout` は既定で 10 秒で、応答を返す前の処理中の要求にも適用される。このルートでは処理全体の上限を 25 秒（権限の再確認 5 秒、交換 10 秒、検証 10 秒）とし、`server.timeout(req, 30)` で要求ごとに延ばす。`idleTimeout` 全体は変えない。
- ページは固定の文言だけの最小限の HTML とし、クエリの値を埋め込まない。`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`Content-Security-Policy: default-src 'none'` を付ける（URL に認可コードが入るため）。アクセスログに URL を書かない。
- `OAUTH_CALLBACK_URL` は `https`、または `localhost` か `127.0.0.1` の `http` に限り（OpenRouter の `callback_url` が受け付ける範囲）、ユーザー情報、クエリ、フラグメントを含むと起動に失敗する。`ENCRYPTION_KEY` が未設定でも起動に失敗する。URL の path は検証しないので、リバースプロキシが書き換える構成でも Bot に `/auth/callback` として届けばよい。

交換と検証の HTTP 要求は、どちらの受け取り方でも 10 秒で打ち切る。

### キー解決

```text
resolveForMention(userId, guildId):
  1. api_keys WHERE owner_id = userId AND scope = 'user'   → { key, source: 'user' }
  2. resolveForGuild(guildId)

resolveForGuild(guildId):
  1. api_keys WHERE owner_id = guildId AND scope = 'guild' → { key, source: 'guild' }
  2. ALLOW_UNAUTHENTICATED = true → { key: デフォルトキー, source: 'default' }
  3. null
```

- `ENCRYPTION_KEY` が未設定のときは接続機能全体が無効で、デフォルトキーを返す。`ALLOW_UNAUTHENTICATED=false` と `ENCRYPTION_KEY` 未設定の組み合わせは誰も使えなくなるので、起動時の設定検証で失敗させる。
- `api_keys` に行があるのに `ENCRYPTION_KEY` が未設定なら、DB を開いた直後に起動を失敗させる。設定の抜けで接続済みの利用がホスティング者への請求に切り替わるのを防ぐためである。接続機能をやめるときは、`api_keys` を空にしてから `ENCRYPTION_KEY` を外す。
- 復号に失敗したら `null` にもデフォルトキーにもせず、`ApiKeyUnreadableError` を投げる。

`source` は使用量統計が支払元として記録する値であり、「LLM 入力を見る」やコード実行のファイル取得など、同じ生成の後続処理がどのキーの生成かを知る手がかりにもなる。

OpenRouter のキーを使う `src/` の呼び出し元と、それぞれが使うキーは次のとおりである。

| 呼び出し元 | 用途 | 使うキー |
| ---------- | ---- | -------- |
| `ChatService.generateChatResponse()` から `runToolLoop()` の `llmClient.chatStream()` | メンションへの返答の生成 | `resolveForMention(投稿者, guildId)` |
| 同上 | 自動応答の生成 | `resolveForGuild(guildId)` |
| `ReplyGateService.judge()` の `client.decideNoul()` | 自動応答の判定 | `resolveForGuild(guildId)` |
| `ChatService.generateScheduledResponse()` の `llmClient.chat()` | 定期実行の生成 | `resolveForGuild(job.guildId)` |
| `ChatService.interpretCronSchedule()` の `llmClient.chat()` | スケジュールの解釈 | `resolveForGuild(guildId)` |
| `ChatService.generateResponse()` | 非 streaming の応答生成 | `src/` 内に呼び出し元がなく請求先を決める理由もないので、メソッドとテストを削除する |
| `/status` の `llmClient.getCredits()`（`createCommandHandlers` の `status` と、`handleButtonInteraction` の再描画） | キーの利用上限までの残額の表示（`GET /api/v1/key` の `limit_remaining`） | Guild キーがあれば Guild キー、なければデフォルトキー。詳細は節「残額の表示」 |
| `OpenRouterGenerationLogClient` | 「LLM 入力を見る」の `/generation` と `/generation/content` | 生成に記録した `key_source` で決める（「LLM 入力を見る」の節） |
| `ModelService.getAllModels()` の `listModelsWithPricing()` | 全 Guild で共有するモデル一覧キャッシュ | デフォルトキー。キャッシュは 1 つなので、キーごとに引き直さない |

`messageCreate` は応答すると判定した直後に支払い元を解決し、その結果を reply gate と `generateChatResponse()` の `ctx` に渡す。
1 回の発言の判定と返答で解決を分けないので、途中で接続が変わっても同じ発言の中で支払い元が変わらない。

本人が支払う「メンション」は、Bot への直接のメンションと、Bot の発言への返信によるメンションに限る。
既存の `isMention` は `message.mentions.has(botId, { ignoreEveryone: true })` で、Bot の所属ロールへのメンションでも真になる。
人と Bot が共有するロールへの連絡を投稿者に請求しないように、支払いの判定には `ignoreRoles: true` を足した値を別に使う。
ロールだけのメンションは返答の有無も reply gate の扱いも現状のままで、支払いだけ `resolveForGuild(guildId)` にする。

解決結果が `null` のときの扱いは、この直接のメンションかどうかで分ける。

- 直接のメンションには「`/connect user` で OpenRouter アカウントを接続してください」と返信する。
- 自動応答とロールだけのメンションでは何も送らず、reply gate も呼ばない。自動応答チャンネルの発言のたびに案内を投稿すると、会話を埋めてしまう。

`ApiKeyUnreadableError` も同じく、直接のメンションにはエラーを返信し、それ以外ではログだけ残して何も送らない。
定期実行では、`null` は「`/connect guild` が要る」旨の `ApiKeyRequiredError` として投げ、既存の失敗処理（`last_error` の記録と 3 回連続での停止）に任せる。
スケジュールの解釈（提案の作成）でも同じ例外を投げる。`CronService.createProposal()` が例外の `userMessage` を提案の失敗として返すので、提案は保存されず、ジョブの失敗回数も変わらない。
`/cron` の Modal ではこの案内がそのまま表示される。
会話中の `propose_cron_job` ではツール結果としてモデルに返るだけなので、利用者に伝わるかはモデルの返答による。

### 残額の表示

`GET /api/v1/key` の `limit_remaining` はキーの利用上限までの残額であり、アカウントのクレジット残高ではない。
上限を設定していないキーでは `null` になる。
アカウントのクレジットを返す `GET /api/v1/credits` は Management key を要するので、接続したキーでは読めない。
そのため接続したキーについては、次の 3 通りを区別して表示する。

- 上限があるキー：「キーの上限までの残額 $x.xx」
- 上限がないキー：「上限なし」と、アカウントのクレジットは OpenRouter で確認する旨
- 取得に失敗したとき（無効なキーを含む）、または復号できないとき：「取得できません」

`/status` は Ephemeral ではないので、ユーザーキーの情報を出さず、Guild キーがあればその Guild キーの残額を上の形で出す。
Guild キーが無いときは、デフォルトキーについて現在の「OpenRouter残高」の表示をそのまま使う。
ユーザーキーの残額は `/connect status` で本人にだけ見せる。

### エラー文の出し分け

`AuthenticationError`（401）と `InsufficientCreditsError`（402）の `userMessage` は「管理者にお問い合わせください」であり、接続したキーの持ち主にとっては誤りになる。
`ModerationError`（403）の `userMessage` は表現を変えるよう促すが、OpenRouter は workspace の予算制限、モデルの許可制限、データリージョン制限でも 403 を返すので、接続したキーでは入力の問題と断定できない。
`OpenRouterClient` はコンストラクタで `source` も受け取り、`buildApiError()` で `source` に応じた文を入れる。
生成の HTTP の失敗とストリーム中のエラーはどちらも `buildApiError()` を通る。

`decideNoul()`（reply gate）は `buildApiError()` を通らず、`ReplyGateService.judge()` は例外を「返答する」に倒す。
タイムアウト、ネットワークの失敗、429、5xx のような一時的な失敗では判定なしで返答するこの動作を保つが、接続したキーの 429 以外の 4xx では `judge()` が `silent` を返してログに残す。
接続先の制限は 403 と 404 のどちらでも返り、キーの無効は 401、クレジットの不足は 402 で返るので、拒否の理由ごとに列挙せず 4xx でまとめて扱う。
そうしないと、判定用の固定モデル（`REPLY_GATE_MODEL`）だけが接続先の制限で拒否されたときに、自動応答の対象の発言すべてで通常の生成が走って請求が続き、キーが無効なら発言のたびにエラーを投稿することになる。
そのため `judge()` は支払い元の `source` も受け取る。
デフォルトキーの動作は変えない。
`/connect guild` の案内に、自動応答の取捨選択を使うならそのモデルも workspace で許可する必要があることを添える。

| source | 401 | 402 | 403 |
| ------ | --- | --- | --- |
| `user` | 接続した OpenRouter キーが使えなくなっています。`/connect user` で接続し直すか、`/disconnect user` で解除してください。 | 接続した OpenRouter アカウントのクレジットかキーの上限が不足しています。 | 接続した OpenRouter の制限（入力の検査、workspace の予算、モデルの許可）で拒否されました。OpenRouter の設定を確認するか、表現を変えてお試しください。 |
| `guild` | このサーバーの OpenRouter キーが使えなくなっています。管理者が `/connect guild` で接続し直すか、`/disconnect guild` で解除してください。 | このサーバーの OpenRouter アカウントのクレジットかキーの上限が不足しています。管理者にお問い合わせください。 | このサーバーの OpenRouter の制限（入力の検査、workspace の予算、モデルの許可）で拒否されました。管理者にお問い合わせいただくか、表現を変えてお試しください。 |
| `default` | 現在の文のまま | 現在の文のまま | 現在の文のまま |

無効になったキーの行は自動では消さない。一時的な 401 で接続を失わないようにするためで、消す操作は本人の `/disconnect` に任せる。

### OpenRouterClient へのキーの渡し方

`OpenRouterClient` はキーをコンストラクタで受け取り、すべてのリクエストでそのキーを `Authorization` ヘッダに使う。
解決したキーで `OpenRouterClient` をその都度生成し、`ChatService.generateChatResponse()` が既存の `onGenerationId` のラッパー経由で `runToolLoop()` に渡す。
デフォルトキーでは既存の共有インスタンスを使うので、接続していない Guild の挙動は変わらない。

- インスタンスをキャッシュしない。`rateLimitResetAt` はレスポンスヘッダから決まる事前の打ち切りで、インスタンスが変わると失われるが、その場合もリクエストは送られて OpenRouter が 429 を返し、利用者には同じ文が表示される。この差のために、復号済みのキーをメモリに持ち続け、`/disconnect` で消す処理を足すことはしない。1 回の返答の中ではインスタンスが共通なので、ツールループの途中では事前の打ち切りが働く。
- 呼び出しごとにキーを渡す形は採らない。`chat()` / `chatStream()` / `getCredits()` に引数を足すと `ILLMClient` のすべての mock を変える必要がある。キーを `IToolLoopParams.requestFields` で運ぶこともできない。`requestFields` はリクエスト body にそのまま展開されるので、キーが body に載ってしまう。

### 「LLM 入力を見る」

`/generation` と `/generation/content` は、生成に使ったキーの持ち主のログを読む操作である。
どのキーの生成かを `reply_generations.key_source` に記録し、参照するキーを次のように決める。

- `default`：これまでどおりデフォルトキーで取りに行く。記録より前の行もこの値になる。
- `guild`：その時点の Guild キーで取りに行く。Guild の接続が解除されていれば取りに行かず、その旨を表示する。接続先のアカウントが変わった後は 404 になりうる。
- `user`：取りに行かず、「本人の OpenRouter アカウントの生成なので表示しない」と表示する。`serverTools` の生成と同じくログ本体を持たない行になる。

### DB スキーマ変更

```sql
CREATE TABLE IF NOT EXISTS api_keys (
  owner_id TEXT NOT NULL,              -- Discord User ID or Guild ID
  scope TEXT NOT NULL CHECK (scope IN ('user', 'guild')),
  encrypted_key TEXT NOT NULL,         -- AES-256-GCM 暗号化済みキー (Base64)
  iv TEXT NOT NULL,                    -- 初期化ベクトル、12 バイト (Base64)
  auth_tag TEXT NOT NULL,              -- 認証タグ (Base64)
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, scope)
);

ALTER TABLE reply_generations
  ADD COLUMN key_source TEXT NOT NULL DEFAULT 'default'
  CHECK (key_source IN ('user', 'guild', 'default'));
```

暗号化では `scope:owner_id` を AAD（認証付き追加データ）に渡す。
行の値を別の持ち主の行へ移すと復号に失敗するので、DB の書き換えだけで他人のキーを使わせることはできない。

Bot が Guild から外れたら、その Guild の `api_keys` の行を消す。
`GuildDelete` と起動時の `reconcileGuilds` が返答記録と定期実行を消している箇所（`createReplyRecordCleanupHandlers`）に加える。
ユーザーの行は特定の Guild に属さないので残す。

### 新規環境変数

| 変数名 | 必須 | 説明 |
| ------ | ---- | ---- |
| `ENCRYPTION_KEY` | 接続機能を使うとき | API キー暗号化用の 256-bit キー (hex 64 文字)。`openssl rand -hex 32` で生成する。未設定なら `/connect` は無効である旨を返す。形式が違うとき、および `api_keys` に行があるのに未設定のときは起動に失敗する |
| `ALLOW_UNAUTHENTICATED` | No | 未接続時にデフォルトキーを使わせるか (`true`/`false`, default: `true`)。ほかの値と、`false` かつ `ENCRYPTION_KEY` 未設定は起動に失敗する |
| `OAUTH_CALLBACK_URL` | No | 設定すると認可コードを公開コールバックで受ける（例: `https://bot.example.com/auth/callback`）。未設定なら Modal への貼り付けで受ける |

### 変更対象ファイル

- 新規: `src/llm/openrouterAuth.ts` — 認可 URL の組み立て、`POST /auth/keys`、`GET /key`（`getCredits()` は失敗を残高 0 に丸めるので検証には使えない）
- 新規: `src/services/apiKeyService.ts` — PKCE 生成、pending 管理、接続の完了と解除、キー解決、支払い元のクライアント生成
- 新規: `src/services/cryptoService.ts` — API キーの暗号化と復号
- 新規: `src/db/repositories/apiKey.ts` — API キーの CRUD
- 新規: `src/bot/commands/connect.ts` — `/connect` と `/disconnect` のコマンド定義
- 新規: `src/bot/events/connectHandler.ts` — 両コマンド、「コードを入力」ボタン、Modal 送信の処理
- 新規: `src/http/oauthCallback.ts` — `GET /auth/callback` の処理と結果のページ
- 修正: `src/health.ts` — `OAUTH_CALLBACK_URL` が設定されているときの `/auth/callback` の登録
- 新規: 上記それぞれの単体テスト、`scripts/e2e/scenarios.ts` のシナリオ `byok-invalid-key`
- 修正: `src/config/envVars.ts` / `src/config/index.ts` — 新規環境変数
- 修正: `src/db/schema.ts` — `api_keys` テーブルと `reply_generations.key_source`
- 修正: `src/db/repositories/replyRecord.ts` — `ReplyGeneration.keySource` の保存と読み出し
- 修正: `src/llm/openrouter.ts` / `src/errors/index.ts` — `source` に応じたエラー文、`ApiKeyRequiredError` と `ApiKeyUnreadableError`
- 修正: `src/services/chatService.ts` — `ctx` の支払い元からクライアントを選ぶ、定期実行で Guild の支払い元を解決する、`generateResponse()` の削除
- 修正: `src/services/replyGateService.ts` — `judge()` が支払い元のクライアントを受け取る
- 修正: `src/bot/commands/index.ts` / `src/bot/commands/handlers.ts` / `src/bot/events/interactionCreate.ts` / `src/utils/statusMessage.ts` — コマンドの登録と振り分け、`/help` の追記、`/status` の残額のキー選択と表示
- 修正: `src/bot/events/messageCreate.ts` — 支払い元の解決と未接続時の案内
- 修正: `src/bot/events/inspectInputCommand.ts` / `src/llm/generationLog.ts` — `key_source` に応じたログの取得
- 修正: `src/bot/events/replyRecordCleanup.ts` — Guild から外れたときの `api_keys` の削除
- 修正: `src/index.ts` — DI 配線
- 修正: `README.md` / `AGENTS.md` — `/connect` の使い方と e2e シナリオの説明。環境変数とコマンドの一覧は生成で更新される

### インターフェース設計

```typescript
// src/types/index.ts
type ApiKeyScope = "user" | "guild";
type ApiKeySource = ApiKeyScope | "default";

interface ResolvedApiKey {
  key: string;
  source: ApiKeySource;
}

// src/services/apiKeyService.ts
type ConnectionTarget =
  | { scope: "user"; userId: string }
  | { scope: "guild"; guildId: string };

interface IApiKeyService {
  /** ENCRYPTION_KEY が設定されているか */
  readonly enabled: boolean;

  resolveForMention(userId: string, guildId: string): ResolvedApiKey | null;
  resolveForGuild(guildId: string): ResolvedApiKey | null;

  /** デフォルトキーでは共有インスタンス、それ以外は source 付きの新しいインスタンスを返す */
  clientFor(resolved: ResolvedApiKey): OpenRouterClient;

  /** OAUTH_CALLBACK_URL が設定されていれば callback、なければ paste */
  readonly connectionMode: "paste" | "callback";

  /**
   * code_verifier（callback では state も）を生成して pending に保存し、認可 URL を返す。
   * pending は対象ごとに 1 つで、実行者が違っても置き換える。
   * hooks は callback でだけ使う。interaction に結びつく処理を pending に持たせるためである。
   */
  startConnection(actorId: string, target: ConnectionTarget, hooks: ConnectionHooks): string;

  /** この実行者の pending があるか（ボタンから Modal を開く前の確認） */
  hasPendingConnection(actorId: string, target: ConnectionTarget): boolean;

  /** GET /auth/callback の処理本体。state で pending を引いて確保し、接続を完了する */
  completeCallback(state: string | null, code: string | null): Promise<CallbackOutcome>;

  /**
   * pending の code_verifier で交換し、検証してから保存する。成功時に pending を消す。失敗は OAuthError。
   * 交換と検証の後、保存の直前に pending が同じエントリのままであることを確認し、違えば保存しない。
   */
  completeConnection(actorId: string, target: ConnectionTarget, code: string): Promise<void>;

  /**
   * 対象の pending をすべて無効にし、行を消す。行が無ければ removed は false。
   * keyHash は消す前のキーの SHA-256 で、復号できなかった行では null になる。復号できなくても行は消す。
   */
  disconnect(target: ConnectionTarget): { removed: boolean; keyHash: string | null };

  /** 接続の有無と SHA-256。復号できないときは unreadable */
  getConnection(target: ConnectionTarget): ConnectionStatus;

  /** Guild から外れたときの処理。その Guild の pending を無効にし、行を消す */
  removeGuild(guildId: string): void;

  /** 起動時の照合。参加していない Guild の行を消す */
  removeGuildsNotIn(guildIds: readonly string[]): void;
}
```

```typescript
// src/services/apiKeyService.ts
interface ConnectionHooks {
  /** Guild の接続で権限を判定し直す。false か例外なら接続しない */
  authorize(): Promise<boolean>;
  /** /connect の Ephemeral 返信に結果を書く。失敗はログだけに残す */
  report(result: "connected" | "failed"): Promise<void>;
}

type CallbackOutcome = "connected" | "invalid" | "already_used" | "failed";
```

```typescript
// src/services/cryptoService.ts
interface ICryptoService {
  encrypt(plaintext: string, aad: string): { ciphertext: string; iv: string; authTag: string };
  decrypt(ciphertext: string, iv: string, authTag: string, aad: string): string;
}

// src/db/repositories/apiKey.ts
interface IApiKeyRepository {
  find(ownerId: string, scope: ApiKeyScope): ApiKeyRecord | null;
  upsert(record: ApiKeyRecord): void;
  delete(ownerId: string, scope: ApiKeyScope): boolean;
  deleteGuildsNotIn(guildIds: readonly string[]): number;
}
```

`ChatRequestContext` に必須の `payer: ResolvedApiKey` を足す。
省略を許すと、渡し忘れがホスティング者のキーへの請求になるからである。

`ReplyGeneration` に `keySource: ApiKeySource` を足し、`generateChatResponse()` の `onGenerationId` で `ctx.payer.source` を入れる。

### コマンド設計

```text
/connect user       -- 自分の OpenRouter アカウントを接続
/connect guild      -- Guild 用の OpenRouter アカウントを接続（canManageGuildSettings で認可）
/connect status     -- 自分と Guild の接続状態、自分のキーの上限までの残額と設定ページへのリンクを表示
/disconnect user    -- 自分の接続を解除
/disconnect guild   -- Guild の接続を解除（canManageGuildSettings で認可）
```

- すべて本人にだけ見える Ephemeral で返す。
- `/connect guild` と `/disconnect guild` は Guild の外では使えない旨を返す。`/connect user`、`/disconnect user`、`/connect status` は DM でも動く。
- `/connect` の案内には次を書く。キーは Bot の運営者のサーバーに暗号化して保存すること、利用額は OpenRouter 側のキー上限で抑えられること。`/connect user` には、メンションした返答がそのサーバーの管理者が選んだモデルで自分のクレジットから支払われること、自動応答と定期実行には使われないことを添える。`/connect guild` には、OpenRouter の入出力ログを有効にしているとそのアカウントで会話を読めることを添える。認可ページのリンクを他人に渡さないことも書く（Risks を参照）。
- 公開コールバックのときは「コードを入力」ボタンを出さず、認可ページのリンクだけを出す。
- `/disconnect` の返答には、Bot の保存分を消したことと、OpenRouter 上のキーは残るので不要なら設定ページ（`https://openrouter.ai/keys/<hash>`、復号できなかった行ではキー一覧の `https://openrouter.ai/keys`）で削除することを書く。接続し直すと古いキーも同じく OpenRouter に残る。

`/connect guild`、`/disconnect guild`、および `/connect guild` の Modal 送信の認可は、`canManageGuildSettings`（`src/services/settingsAuthorization.ts`）で判定する。
Modal の送信時にも判定し直すのは、pending の寿命の間に権限を失うことがあるからである。

ボタンと Modal の `customId` は `connect:enter:<scope>` と `connect:code:<scope>` とし、対象の Guild は interaction の `guildId` から取る。
`customId` に code_verifier を載せない。

### セキュリティ考慮事項

- **PKCE**: code_verifier は 43-128 文字のランダム文字列とし、S256 のハッシュだけを認可 URL に載せる。code_verifier はボタンの `customId` にも Modal にも載せず、Bot のメモリにだけ置く。
- **pending の寿命**: 15 分で破棄する。認可コード自体は発行から 10 分で失効するので、ログインや承認に時間がかかっても 15 分あれば足りる。Bot を再起動すると pending は消え、ユーザーは `/connect` からやり直す。期限切れの破棄はアクセス時に行い、タイマーは持たない。
- **解除と接続の競合**: pending は対象ごとに 1 つで、後から始めた `/connect` が実行者を問わず前の pending を置き換える。接続の完了と解除も対象の pending を消す。交換と検証の間にこれらが起きると、保存の直前のエントリの同一性の確認で保存を取りやめるので、管理者 B が接続か解除をした後に管理者 A の古い試行が上書きすることはない。Guild からの退出も同じである。
- **`state`**: 公開コールバックの CSRF 対策である。`customId` にもログにも載せない。
- **Ephemeral メッセージ**: 認可 URL、コード入力の案内、接続結果は、本人にだけ見える Ephemeral で返す。
- **暗号化キー**: `ENCRYPTION_KEY` は 256-bit (32 バイト) の hex 文字列とする。
- **ログ**: 復号済みのキーと認可コードはログに出さない。交換の失敗は HTTP ステータスだけを残す。
- **復号済みのキーの寿命**: 1 回の返答か操作の間だけメモリにある。

## Tasks

- [ ] DB: `api_keys` テーブルと `reply_generations.key_source` のマイグレーション追加
- [ ] 環境変数: `ENCRYPTION_KEY`, `ALLOW_UNAUTHENTICATED`, `OAUTH_CALLBACK_URL` と起動時の検証
- [ ] `CryptoService`: AES-256-GCM 暗号化と復号の実装 + テスト
- [ ] `ApiKeyRepository`: CRUD 実装 + テスト
- [ ] `openrouterAuth`: 認可 URL、キー交換、キー情報の取得 + テスト
- [ ] `ApiKeyService`: PKCE 生成、pending 管理、接続と解除、キー解決、クライアント生成 + テスト
- [ ] `OpenRouterClient` の `source` と、エラー文の出し分け + テスト
- [ ] `ChatService`、`ReplyGateService`、`messageCreate` の支払い元の適用 + テスト
- [ ] 定期実行とスケジュールの解釈の支払い元 + テスト
- [ ] `/connect`, `/disconnect` のコマンド定義とハンドラー、コード入力ボタンと Modal の処理 + テスト
- [ ] `GET /auth/callback`: `state` の突合と確保、権限の再確認、結果のページと Ephemeral の編集 + テスト
- [ ] `/status` の残額のキー選択、`/connect status` の表示
- [ ] 「LLM 入力を見る」の `key_source` による分岐 + テスト
- [ ] Guild から外れたときの `api_keys` の削除 + テスト
- [ ] DI 配線: `index.ts` に新規サービスを追加
- [ ] e2e シナリオ `byok-invalid-key`: テスト bot の無効なキーを DB に入れて bot にメンションし、接続し直しを促すエラーが返ること（デフォルトキーで答えないこと）を確認する
- [ ] 手動確認: 開発 bot で `/connect user` から認可ページを開き、表示されたコードを貼り付けて接続できること、メンションへの返答がそのキーの利用として OpenRouter に記録されること、`/connect status` に上限までの残額か「上限なし」が出ること、`/disconnect user` の後はデフォルトキーに戻ること、認可ページの表示と作られたキーのアプリ名
- [ ] 手動確認: 開発 bot で `/connect guild` から接続し、別のユーザーのメンションが Guild キーで支払われること、`/status` の残額が Guild キーのものになること
- [ ] 手動確認: 開発 bot に `OAUTH_CALLBACK_URL=http://localhost:3000/auth/callback` を設定し、`/connect user` の認可ページで承認すると、ブラウザに結果のページが出て、`/connect` の返信が接続完了に変わること、`state` がそのまま返ること
- [ ] `docs/changes/oauth-byok/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- ユーザーが接続時に選んだ workspace の guardrail によって、そのキーで使えるモデルが Bot のモデル一覧キャッシュ（デフォルトキーで取得）と食い違うことがある。`/models/user` はキーごとの結果を返すが、返答のたびに引き直すと応答が遅れるので使わない。使えないモデルは生成時に OpenRouter のエラーとして表示される。
- OpenRouter の入出力ログを有効にしたアカウントのキーを接続すると、そのアカウントの持ち主は支払った生成の入力を OpenRouter 上で読める。ユーザーキーの入力は本人が読める範囲の会話に限られる（会話履歴は投稿者の権限で確認している）が、Guild キーを接続した管理者は、自分が閲覧権限を持たないチャンネルの会話も読めることになる。`/connect guild` の案内に書くにとどめ、機能としては制限しない。管理ロールの持ち主も接続できるので、Guild の設定を任せる相手を決めるときの判断材料になる。
- 定期実行には Guild → デフォルトの支払いだけを適用するので、`ALLOW_UNAUTHENTICATED=false` で Guild キーが無い Guild ではすべてのジョブが失敗し、3 回連続で停止する。
- `ENCRYPTION_KEY` を失うと全員が接続し直しになる。バックアップから DB を戻すときは同じキーが要る。
- 認可ページのリンクを他人に開かせると、開いた人のキーが `/connect` を実行した人の接続として保存される。`state` と PKCE はブラウザと Discord のユーザーを結びつけないので、この経路は防げない。公開コールバックでは相手が承認するだけで成立し、貼り付けでは相手がコードを渡す必要がある。リンクは本人にだけ見える Ephemeral で出し、`/connect` の案内に他人に渡さないことを書く。

## 参照

- [OpenRouter OAuth PKCE ガイド](https://openrouter.ai/docs/guides/overview/auth/oauth.md)
- [OpenRouter OpenAPI 定義](https://openrouter.ai/openapi.json) — `POST /auth/keys`, `GET /key`, `GET /generation`
