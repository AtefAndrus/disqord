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
本番はこのイメージを取りに行って動く（下の「本番へのデプロイ」）。

- イメージは GitHub-hosted runner の x64 上でビルドするので、`linux/amd64` だけである。
- タグは Release のタグ名（`v1.10.0` など）とコミットの完全な SHA の 2 つで、`latest` は自動では付けない。workflow を手動実行したときは完全な SHA だけを付ける。
- Release のタグ名は `v<major>.<minor>.<patch>` の形でなければ、push せずに失敗する。
- 付けるタグが 1 つでも既にレジストリにあれば、push せずに失敗する。GHCR はタグの書き換えを禁止できないので、イメージを取得する側は digest で固定する。
- 同じコミットのイメージを既に公開していると SHA のタグが重なるため、そのコミットを指す Release の公開や手動実行は失敗する。
- push した digest には別の job で build provenance の attestation が付き、`gh attestation verify oci://ghcr.io/atefandrus/disqord@sha256:<digest> --repo AtefAndrus/disqord` で検証できる。その job だけが失敗したときは、実行画面の「Re-run failed jobs」で attestation だけをやり直せる。

初回の公開で作られる package は private なので、公開後に package の設定画面で公開範囲を public に切り替える。

### OpenRouter の入出力ログ

返答を右クリックして「アプリ → LLM 入力を見る」で入力と出力を取得するには、デプロイ先の OpenRouter アカウントで Input & Output Logging を有効にし、API キーの絞り込みで bot のキーを除外しない。
有効にする前の generation には、入出力ログが保存されない。
この操作は「サーバーの管理」権限か `/config` の管理者ロールを持ち、対象チャンネルの履歴を読める人だけが使える。
管理者ロールでメニューを使うには、サーバーの連携サービス設定でコマンドを許可する。

### 本番へのデプロイ

本番は talos2 の Kubernetes クラスタの個人テナント（namespace `personal`）で、レプリカ 1 つの StatefulSet `disqord` として動く。
マニフェストは private リポジトリ `AtefAndrus/k8s-tenant-personal` の `apps/disqord/` にあり、データは PVC `disqord-data` の `/app/data` に置く。

このリポジトリから本番へ届く workflow はない。
本番側の Flux が GHCR のタグから `v<major>.<minor>.<patch>` の形のものを選び、semver で最も新しいバージョンのタグと digest を `statefulset.yaml` の image 行へ書き戻して、Pod を新しいイメージで起動し直す。
そのため、Release を正式版として公開すれば、`publish-image.yml` が push したイメージがそのまま本番に入る。
GHCR のタグの確認と書き戻しはそれぞれ 30 分間隔で動くので、イメージの公開から起動し直すまでに数十分かかることがある。
workflow の手動実行で付くのは完全な SHA のタグだけで、Flux が選ぶタグの形に合わないので、本番には入らない。

StatefulSet は古い Pod を止めてから新しい Pod を起動するので、同じ Discord の token で 2 つのプロセスが同時に接続することはない。
停止の猶予は Kubernetes の既定の 30 秒である。
bot は SIGTERM を受けると応答中の返答を打ち切り、`🛑 Stopped by restart` を付けて閉じ終わるのを最大 8 秒待ってから終了する（`src/index.ts` の `CHAT_SHUTDOWN_TIMEOUT_MS`）。
新しいバージョンが動き始めたかは、管理 API の `/health` が HTTP 200 と新しい `version` を返すかで確認する。
HTTP サーバーは Discord へのログインの後に起動し、Pod が Ready になるまでは Service から届かないので、起動の途中では応答が得られないことがある。
起動後に Discord との接続が切れている間は、同じ `version` で 503 を返す。
管理 API は tailnet 上の `talos2-personal-disqord` に HTTPS で届く（[docs/admin-api.md](docs/admin-api.md)）。

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
| ADMIN_API_BASE_URL | No | 調査する bot の管理 API のベース URL（`bun scripts/admin.ts` だけが使う） |
| LOG_DIR | No | ログファイル保存ディレクトリ（本番のみ書込み、未設定でno-op） |
| LOG_MAX_BYTES | No | ログローテーション閾値（バイト）（デフォルト: `10485760`） |
| WEB_SEARCH_ENGINE | No | Web検索のエンジン（perplexity / exa / parallel / native / auto / firecrawl）。料金はエンジンごとに異なる（デフォルト: `perplexity`） |
| REPLY_GATE_THRESHOLD | No | 自動応答の取捨選択で返答する確率のしきい値（0〜1）（デフォルト: `0.4`） |
| FXTWITTER_API_BASE | No | ツイート展開に使う fxtwitter API のベース URL（デフォルト: `https://api.fxtwitter.com`） |
| E2E_TESTER_BOT_ID | No | e2e 用テスト bot のユーザ ID。この bot からの発言にだけ応答する（NODE_ENV=production では無視） |
| E2E_TESTER_BOT_TOKEN | No | e2e 用テスト bot のトークン（`bun run e2e` だけが使う） |
| E2E_CHANNEL_ID | No | e2e の発言を送るチャンネル ID（`bun run e2e` だけが使う） |
<!-- AUTO:ENV_VARS:END -->

ツイート展開は、呼びかけ本文で検出したツイート ID を `FXTWITTER_API_BASE` のホストへ送信して本文を取得する。
会話履歴が有効で返信先を読み取れた場合は、その返信先のX投稿リンクも展開する。
対象には `x.com`、`twitter.com`、`fixupx.com`、`fxtwitter.com` などのリンクを含み、呼びかけ本文を優先して返信先と合わせて最大3投稿、4画像まで取得する。
会話履歴とツイート展開が有効で、モデルがtoolに対応するときは、履歴、過去の発言、ピン留めとしてモデルに示した発言のX投稿も、モデルが必要に応じて `read_x_post` で読む。
このtoolは発言番号と投稿の順番を指定して1投稿ずつ取得し、画像は画像入力に対応するモデルに最大4枚渡す。
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

返答を右クリック → アプリ → **LLM 入力を見る**: 管理者向けに、その返答の入出力ログと生成情報を JSON ファイルで本人だけに返す。

## ライセンス

MIT
