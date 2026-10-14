# DisQord

[![CI](https://github.com/AtefAndrus/disqord/actions/workflows/ci.yml/badge.svg)](https://github.com/AtefAndrus/disqord/actions/workflows/ci.yml)

Discord上でOpenRouter経由のLLMと対話するBot。メンションで呼び出す単発応答型。

## セットアップ

### 必要なもの

- [mise](https://mise.jdx.dev/)
- Discord Bot Token
- OpenRouter API Key

### Discord への招待

Developer Portal の Bot ページで Message Content Intent を有効にする。
招待 URL は OAuth2 → URL Generator で、Scopes に `bot` を選び、Bot Permissions に次を選んで作る（`permissions=2832651191962688`）。

- View Channels
- Send Messages
- Send Messages in Threads
- Read Message History
- Embed Links
- Attach Files
- Add Reactions、Create Polls、Create Public Threads、Pin Messages、Create Events、Connect（`/config` の 機能 → Discord 操作 が使う。Connect はボイスチャンネルのイベントを作るときに要る）

URL Generator を使わずに作るときは、次のひな型の `<CLIENT_ID>` に Developer Portal の Application ID を入れる。

```text
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&permissions=2832651191962688&integration_type=0&scope=bot
```

既にサーバーにいる bot も、権限を足した URL で認可し直すと、bot のロールの権限が更新される。
Discord 操作は bot と依頼したメンバーの双方がその権限を持つときだけ実行するので、足りなければ実行せずにその旨をモデルが伝える。

`bun run e2e` のテスト bot には、上の権限に加えて次を付ける。
テスト bot は Discord 操作の依頼者になるので、bot と同じ操作の権限が要る。e2e で作るイベントは外部イベントだけなので、Connect は外してもよい。

- Manage Threads（`discord-tools` シナリオが作ったスレッドを片付けるため）
- `/config` で設定した管理者ロール（`cron` と `cron-search` シナリオが定期実行を提案するため。Manage Server でも足りるが、サーバーの設定をすべて変えられる権限なので管理者ロールを勧める）

テスト bot の招待 URL の `permissions` は、管理者ロールを付けるなら `2832668371831872`、代わりに Manage Server を付けるなら `2832668371831904` にする（どちらも Connect を含む）。

### ローカル開発

```bash
mise install       # Bun を自動インストール
mise run setup     # bun install + .env コピー
# .env を編集して環境変数を設定
bun dev            # 起動
```

### Docker

```bash
docker build -t disqord .
docker run -d \
  -e DISCORD_TOKEN=your_token \
  -e DISCORD_APPLICATION_ID=your_app_id \
  -e OPENROUTER_API_KEY=your_api_key \
  -v disqord-data:/app/data \
  disqord
```

### コンテナイメージ (GHCR)

GitHub Release を正式版として公開すると（prerelease を正式版に変えたときを含む）、`.github/workflows/publish-image.yml` がイメージをビルドして `ghcr.io/atefandrus/disqord` へ push する。
Coolify へのデプロイは `.github/workflows/deploy.yml` がこれまでどおり Release の公開で行う。
そのため、prerelease を正式版に変えたときはイメージの公開だけが動く。

- イメージは GitHub-hosted runner の x64 上でビルドするので、`linux/amd64` だけである。
- タグは Release のタグ名（`v1.10.0` など）とコミットの完全な SHA の 2 つで、`latest` は自動では付けない。workflow を手動実行したときは完全な SHA だけを付ける。
- Release のタグ名は `v<major>.<minor>.<patch>` の形でなければ、push せずに失敗する。
- 付けるタグが 1 つでも既にレジストリにあれば、push せずに失敗する。GHCR はタグの書き換えを禁止できないので、イメージを取得する側は digest で固定する。
- 同じコミットのイメージを既に公開していると SHA のタグが重なるため、そのコミットを指す Release の公開や手動実行は失敗する。
- push した digest には別の job で build provenance の attestation が付き、`gh attestation verify oci://ghcr.io/atefandrus/disqord@sha256:<digest> --repo AtefAndrus/disqord` で検証できる。その job だけが失敗したときは、実行画面の「Re-run failed jobs」で attestation だけをやり直せる。

初回の公開で作られる package は private なので、公開後に package の設定画面で公開範囲を public に切り替える。

### Coolify へのデプロイ

`.github/workflows/deploy.yml` は Release の公開時に Coolify の Deploy Webhook を呼び、新しい版が本番で動き始めるまで待つ。
リポジトリの Secrets に `COOLIFY_WEBHOOK` (Deploy Webhook の URL) と `COOLIFY_TOKEN` (`deploy` 権限の API トークン) を、Variables に本番の `/health` の URL を `PRODUCTION_HEALTH_URL` として登録する。

デプロイ API の成功は Coolify がデプロイ要求を受け付けたことしか示さず、Coolify は新しいコンテナのヘルスチェックが通らないと旧コンテナへ戻す。
そのため workflow は続けて `scripts/wait-for-deploy.sh` を実行する。
待つ版は Coolify がビルドする `main` の `package.json` から読む。
workflow はデプロイ要求の直前に `/health` の `now` (サーバーの時刻) を記録する。
`/health` が、その版で、起動時刻 (`startedAt`) が記録した時刻より後のプロセスだけを返し続け、180 秒たった時点で 200 を返したら成功する。
比べる時刻はどちらもサーバーの時計なので、ランナーとの時計のずれは判定に入らない。
ただし、サーバーの時計が大きく戻されないことを前提にしている。旧プロセスの起動後に、その稼働時間を超えて時計が戻されてから記録すると旧プロセスを新しいとみなし、記録の後に戻されると新しいプロセスを見分けられずに失敗する。
前のデプロイがまだ終わらずに同じ版の候補と元のプロセスが重なっていても、どちらも記録より前に起動しているので、ロールバックで残ったプロセスを成功としない。
ただし、記録の後に前のデプロイ要求が起動した同じ版の候補が、こちらの要求の失敗後に残った場合は成功とみなす。動いているのは待っている版なので、これは許容している。
Coolify が戻すと決めた後、ログの取得などのリモートコマンドが長く止まって、戻すのが判定期間より大きく遅れた場合も、戻される前に成功とみなしうる。Coolify と同じホストへのコマンドが数分止まるのは障害時に限られるので、これも許容している。
旧プロセスの応答や読めない応答を挟んだら待ち直し、ビルドを含めて 25 分以内に成功しなければ失敗する。
デプロイ前の `/health` からサーバーの時刻を読めなかったときは、デプロイは起こすが、新旧のプロセスを見分けられないので確認は失敗にする。
`now` を返さない応答を基準なしで進めるのは、`version` と `now` の欄を持たない旧版の `/health` の形をしている場合に限る。proxy のエラー本文などを旧版と取り違えないためである。
待っている間に次のリリースの実行が始まったら、前の実行は取り消される (Coolify は main の先頭をビルドするので、前の版はデプロイされない)。
180 秒の根拠は Coolify のロールバックの仕組みにある。Coolify は、アプリ設定の Health Check を無効にしている間、デプロイのたびに Dockerfile の `HEALTHCHECK` から自分のヘルスチェック設定 (start period、interval、retries) を取り込み、start period だけ待ってから interval ごとに retries 回、Docker の health 状態を見る。healthy を見たら旧コンテナを外すだけで戻さず、見られないまま回数を使い切ったら戻す。そのため戻すのは新しいコンテナの起動から start period + retries × interval 秒 (今の Dockerfile では 10 + 3 × 30 = 100 秒) までである。同じ計算で 105 秒になる ratatoskr では、2026-10-13 にデプロイログの上でちょうど 105 秒で戻された。180 秒との差は、Coolify が毎回 Docker の状態を読むのにかかる時間を吸収する。`HEALTHCHECK` を延ばして 180 秒を超えるとテストが失敗するので、そのときは `STABLE_SECONDS` の既定値も延ばす。Coolify の Health Check は無効のままにする。有効にすると Coolify は画面に保存した値で判定し、Dockerfile から計算した期間とテストが当てはまらなくなる。
確認の失敗はデプロイの失敗とは限らない (観測中に読めない応答が続いた、など)。
失敗したときは、Coolify のデプロイログで、そのデプロイが完了したか (新しいコンテナがヘルスチェックを通り、旧コンテナが外されたか)、ヘルスチェックの失敗による戻しか、ビルドの失敗かを確かめる。
`/health` を 1 回読んだだけでは、ロールバック判定の前の新しいコンテナを見ている場合があるので、切り替わったとはみなさない。

## 環境変数

<!-- AUTO:ENV_VARS:START -->
| 変数名 | 必須 | 説明 |
| ------ | ---- | ---- |
| DISCORD_TOKEN | Yes | Discord Bot Token |
| DISCORD_APPLICATION_ID | Yes | Discord Application ID |
| OPENROUTER_API_KEY | Yes | OpenRouter API Key |
| NODE_ENV | No | アプリ動作モード（development または production）（デフォルト: `development`） |
| DATABASE_PATH | No | SQLiteパス（デフォルト: `data/disqord.db`） |
| DEFAULT_MODEL | No | デフォルトモデル（デフォルト: `google/gemma-4-26b-a4b-it:free`） |
| HEALTH_PORT | No | ヘルスチェック用HTTPポート（デフォルト: `3000`） |
| ADMIN_API_SECRET | No | 管理API HMAC署名検証用シークレット（未設定時は /admin/* が 503） |
| LOG_DIR | No | ログファイル保存ディレクトリ（本番のみ書込み、未設定でno-op） |
| LOG_MAX_BYTES | No | ログローテーション閾値（バイト）（デフォルト: `10485760`） |
| WEB_SEARCH_ENGINE | No | Web検索のエンジン（perplexity / exa / parallel / native / auto / firecrawl）。料金はエンジンごとに異なる（デフォルト: `perplexity`） |
| FXTWITTER_API_BASE | No | ツイート展開に使う fxtwitter API のベース URL（デフォルト: `https://api.fxtwitter.com`） |
| E2E_TESTER_BOT_ID | No | e2e 用テスト bot のユーザ ID。この bot からの発言にだけ応答する（NODE_ENV=production では無視） |
| E2E_TESTER_BOT_TOKEN | No | e2e 用テスト bot のトークン（`bun run e2e` だけが使う） |
| E2E_CHANNEL_ID | No | e2e の発言を送るチャンネル ID（`bun run e2e` だけが使う） |
<!-- AUTO:ENV_VARS:END -->

ツイート展開は、呼びかけ本文で検出したツイート ID を `FXTWITTER_API_BASE` のホストへ送信して本文を取得する。
会話履歴が有効で返信先を読み取れた場合は、その返信先のX投稿リンクも展開する。
対象には `x.com`、`twitter.com`、`fixupx.com`、`fxtwitter.com` などのリンクを含み、呼びかけ本文を優先して返信先と合わせて最大3投稿、4画像まで取得する。
`/config` の「応答」ページで「ツイート展開を無効にする」を押すと、ギルド単位で無効にできる。
`FXTWITTER_API_BASE` を変更すれば、自ホストした fxtwitter インスタンスを取得先に指定できる。

`/config` の「機能」ページで会話履歴を有効にすると、Botは同じチャンネルの直近の会話をDiscordから読み取り、窓に入った発言、reply先、および必要に応じてtoolで取得した過去の発言や添付ファイルをLLMへ送る。
別BotやWebhookの発言に返信してDisQordを呼び出した場合も、その返信先の本文、Embedの文字情報、Components V2のTextDisplayを引用資料としてLLMへ送る。
別BotやWebhookの発言を読むのは明示的な返信先だけであり、通常の会話履歴や過去の発言を読むtoolには含めない。
toolで取得できる過去の発言に期間の制限は無く、Discordに残っている同じチャンネルの人の発言と、下の記録が残っているBotの返答をさかのぼって読む。
一度に読む量は、使っているモデルのコンテキスト長から応答ごとに決まる。
Botが保存する返答の記録は、どの発言にどのメッセージで返答したかというIDとページの順序、返答の状態とページ数、作成と確定の時刻であり、発言の本文や添付ファイルは保存しない。
この記録は期限では消さず、Botがguildから外れたとき（停止中に外れた場合は次の起動時）と、Botが削除を受け取ったチャンネルやスレッドの分を消す。
Botの停止中に削除されたチャンネルやスレッドの記録は残るが、そのチャンネルは二度と読まれない。
添付ファイルの中身は質問への応答中だけ取得して次の発言へ持ち越さない。
Discord上で既にLLMへ送られた内容は、後から発言や添付ファイルを削除しても送信済みの状態を取り消せない。
同じページで会話履歴を無効にすると、以後の発言について過去の会話をLLMへ送らない。

## コマンド一覧

<!-- AUTO:COMMANDS:START -->
| コマンド | 説明 |
| -------- | ---- |
| `/help` | DisQordの使い方を表示 |
| `/status` | Botのステータス（OpenRouter残高等）を表示 |
| `/model current` | 現在のデフォルトモデルを表示 |
| `/model set <model>` | デフォルトモデルを変更 |
| `/model list` | OpenRouterのモデル一覧ページへ |
| `/model refresh` | モデルキャッシュを更新 |
| `/config` | 設定パネルを開く |
| `/cron` | 定期実行のパネルを開く |
| `/release-note` | リリースノート（変更点）を表示 |
<!-- AUTO:COMMANDS:END -->

## ライセンス

MIT
