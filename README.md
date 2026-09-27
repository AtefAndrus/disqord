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
招待 URL は OAuth2 → URL Generator で、Scopes に `bot` を選び、Bot Permissions に次を選んで作る（`permissions=2815059004869696`）。

- View Channels
- Send Messages
- Send Messages in Threads
- Read Message History
- Embed Links
- Attach Files
- Add Reactions、Create Polls、Create Public Threads、Pin Messages（`/config` の 機能 → Discord 操作 が使う）

既にサーバーにいる bot も、権限を足した URL で認可し直すと、bot のロールの権限が更新される。
Discord 操作は bot と依頼したメンバーの双方がその権限を持つときだけ実行するので、足りなければ実行せずにその旨をモデルが伝える。

`bun run e2e` のテスト bot には、上の権限に加えて Manage Threads を付ける（`discord-tools` シナリオが作ったスレッドを片付けるため）。

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

ツイート展開は、投稿内で検出したツイート ID を `FXTWITTER_API_BASE` のホストへ送信して本文を取得する。
`/config` の「応答」ページで「ツイート展開を無効にする」を押すと、ギルド単位で無効にできる。
`FXTWITTER_API_BASE` を変更すれば、自ホストした fxtwitter インスタンスを取得先に指定できる。

`/config` の「機能」ページで会話履歴を有効にすると、Botは同じチャンネルの直近の会話をDiscordから読み取り、窓に入った発言、reply先、および必要に応じてtoolで取得した過去の発言や添付ファイルをLLMへ送る。
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
| `/release-note` | リリースノート（変更点）を表示 |
<!-- AUTO:COMMANDS:END -->

## ライセンス

MIT
