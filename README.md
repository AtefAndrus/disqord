# DisQord

[![CI](https://github.com/AtefAndrus/disqord/actions/workflows/ci.yml/badge.svg)](https://github.com/AtefAndrus/disqord/actions/workflows/ci.yml)

Discord上でOpenRouter経由のLLMと対話するBot。メンションで呼び出す単発応答型。

## セットアップ

### 必要なもの

- [mise](https://mise.jdx.dev/)
- Discord Bot Token
- OpenRouter API Key

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
ギルド単位で `/config twitter-expand off` を実行すると無効にできる。
`FXTWITTER_API_BASE` を変更すれば、自ホストした fxtwitter インスタンスを取得先に指定できる。

`/config history on` を有効にすると、Botは同じチャンネルの直近の会話をDiscordから読み取り、窓に入った発言、reply先、および必要に応じてtoolで取得した過去の発言や添付ファイルをLLMへ送る。
窓とtoolが参照できるのは現在の発言から24時間以内の範囲であり、添付ファイルの中身は質問への応答中だけ取得して次の発言へ持ち越さない。
Discord上で既にLLMへ送られた内容は、後から発言や添付ファイルを削除しても送信済みの状態を取り消せない。
`/config history off` にすると、以後の発言について過去の会話をLLMへ送らない。

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
| `/config free-only <enabled>` | 無料モデル限定の切り替え |
| `/config llm-details <enabled>` | LLM詳細情報表示の切り替え |
| `/config web-search <enabled>` | Web検索の切り替え（検索ごとに費用が発生） |
| `/config reasoning-display <enabled>` | 推論内容の表示切り替え |
| `/config twitter-expand <enabled>` | ツイート展開の切り替え |
| `/config history <enabled>` | 会話履歴の切り替え |
| `/config auto-reply add <channel>` | 自動応答チャンネルを追加 |
| `/config auto-reply remove <channel>` | 自動応答チャンネルを削除 |
| `/config auto-reply list` | 自動応答チャンネル一覧を表示 |
<!-- AUTO:COMMANDS:END -->

## ライセンス

MIT
