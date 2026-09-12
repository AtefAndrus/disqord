# 管理 API（Admin Endpoints）

Bot 自身に組み込まれた HMAC 認証付きの読み取り専用 HTTP API。
Claude Code や運用者がログ・メトリクスを直接取得するための窓口で、`/health` と同じ Bun サーバから提供される。

## エンドポイント

| メソッド | パス | 説明 |
| -------- | ---- | ---- |
| `GET` | `/admin/metrics` | プロセス・Discord・OpenRouter・コマンド・SQLite・ログ容量の JSON スナップショット |
| `GET` | `/admin/logs` | 直近のログ行（`?level=` `?lines=` `?since=` でフィルタ）|

非 GET メソッドは常に `405 Method Not Allowed` + `Allow: GET` を返す。

## 認証

ヘッダ:

| 名前 | 形式 |
| ---- | ---- |
| `X-Admin-Timestamp` | Unix epoch milliseconds の 10 進文字列（例: `1751342400000`） |
| `X-Admin-Signature` | `sha256=<hex>` 形式の HMAC-SHA256 |

署名対象（正規化済み文字列、LF 区切り、末尾改行なし）:

```text
${METHOD}\n${path}\n${canonicalQuery}\n${timestamp}
```

`canonicalQuery` の生成手順:

1. `URLSearchParams` で query をパースして `[key, value][]` を取得
2. `key` 昇順 → 同一 `key` 内では `value` 昇順で安定ソート（重複キーは保持）
3. `key` / `value` をそれぞれ `encodeURIComponent`
4. `${encodedKey}=${encodedValue}` を `&` で連結。query が無い場合は空文字

検証ルール:

- `ADMIN_API_SECRET` が未設定なら全リクエストが `503 Service Unavailable`
- `X-Admin-Timestamp` 欠落 / 数値以外 / `Number.isSafeInteger` を満たさない / 5 分のドリフト窓を外れる → `401`
- `X-Admin-Signature` 欠落 / `sha256=` プレフィックス無し / HMAC 不一致 → `401`

nonce は持たない。残存リスクは「5 分以内の同一 GET 再送が成功する」のみで、書込系エンドポイントが存在しないため副作用ゼロ。

## メトリクスのレスポンス

`GET /admin/metrics` は以下の JSON を返す:

```json
{
  "uptime": 3600,
  "memory": { "rss": 123456, "heapUsed": 65432 },
  "discord": { "ping": 45 },
  "counters": {
    "openrouter.requests": 12,
    "openrouter.errors": 0,
    "command.chat": 5,
    "command.errors": 0
  },
  "dbBytes": 78901,
  "logBytes": 234567
}
```

- `uptime` はプロセス起動からの秒数（`Date.now()` ベース）
- `discord.ping` は `-1`（未接続 / 未計測）を `null` に正規化
- `counters` はプロセス開始からの累積。OpenRouter API 呼び出しは試行ごとに `openrouter.requests` を計上し、throw された場合のみ `openrouter.errors` も計上
- `dbBytes` は SQLite 本体 + `-wal` + `-shm` の合計（不在ファイルは 0）
- `logBytes` は `LOG_DIR` 配下の現行 + ローテ済みログの合計

## ログのレスポンス

`GET /admin/logs` は `text/plain; charset=utf-8` で、フィルタ後の最新行を最大 `lines` 件返す（古い順に並ぶ）。
ログファイルが無い、または `LOG_DIR` 未設定なら空文字を返す。

query パラメータ:

| 名前 | デフォルト | 説明 |
| ---- | --------- | ---- |
| `level` | (なし、全レベル) | `debug` / `info` / `warn` / `error`。指定すると当該以上のレベルだけ返す |
| `lines` | `200` | `[1, 10000]` の整数。最後尾から N 件 |
| `since` | (なし) | `Date.parse` で解釈可能な文字列（ISO 8601 推奨）。タイムスタンプがそれ以降の行のみ返す |

不正値（範囲外、形式不正など）は `400 Bad Request`。

## 検証用 curl 例

```bash
SECRET="$ADMIN_API_SECRET"
BASE="http://localhost:3000"

# 1. メトリクス取得（query なし）
TS=$(date +%s%3N)
PATH_=/admin/metrics
SIG=$(printf 'GET\n%s\n\n%s' "$PATH_" "$TS" \
      | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -sS "$BASE$PATH_" \
  -H "X-Admin-Timestamp: $TS" \
  -H "X-Admin-Signature: sha256=$SIG" | jq .

# 2. ログ取得（直近 200 行、warn 以上）
PATH_=/admin/logs
QUERY="level=warn&lines=200"
TS=$(date +%s%3N)
SIG=$(printf 'GET\n%s\n%s\n%s' "$PATH_" "$QUERY" "$TS" \
      | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -sS "$BASE$PATH_?$QUERY" \
  -H "X-Admin-Timestamp: $TS" \
  -H "X-Admin-Signature: sha256=$SIG"

# 3. POST → 405 を確認
TS=$(date +%s%3N)
SIG=$(printf 'POST\n/admin/metrics\n\n%s' "$TS" \
      | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -sS -X POST "$BASE/admin/metrics" \
  -H "X-Admin-Timestamp: $TS" \
  -H "X-Admin-Signature: sha256=$SIG" -i | head -n 5
```

## 設定

| 環境変数 | 必須 | デフォルト | 説明 |
| -------- | ---- | --------- | ---- |
| `ADMIN_API_SECRET` | No | (未設定なら全 `/admin/*` が 503) | HMAC 検証用の共通シークレット。ランダム 32 バイト以上推奨 |
| `LOG_DIR` | No | (未設定なら no-op) | ログ保存ディレクトリ。`nodeEnv === "production"` のときのみ書込みが有効 |
| `LOG_MAX_BYTES` | No | `10485760` (10 MB) | ローテーション閾値。超過すると `disqord.5.log` を破棄して `.4 → .5`、`.3 → .4`、... 、`disqord.log → disqord.1.log` の順にシフト |

### ローカル

`.env.local` に追記する:

```bash
ADMIN_API_SECRET=$(openssl rand -hex 32)
LOG_DIR=data/logs
```

`bun dev` で起動し、上の curl 例をそのまま実行して `200` / `405` / `503` を目視する。

### 本番

ホスト（Coolify など）の環境変数に `ADMIN_API_SECRET` を設定する。
`LOG_DIR` は永続ボリュームを指すパスを推奨（コンテナ再起動でログを失わないため）。

既存の公開 HTTPS 経路がある場合、`/admin/*` はその経路を流用できる。
Cloudflare Tunnel で新しく公開する場合は、次の手順で DisQord の HTTP サーバーへ接続する。

#### Coolify のポートマッピング

1. Coolify ダッシュボードで DisQord プロジェクトを開く
2. DisQord の **Port Mappings** に `3000:3000` を設定する（左がホストポート、右がコンテナポート）
3. **Deploy** を選択する

#### Cloudflare Tunnel と公開ホスト名

1. Cloudflare ダッシュボードの **Networking** → **Tunnels** を開く
2. **Add a tunnel** から Cloudflared を選択し、トンネル名（例: `disqord-admin`）を設定する
3. 表示された実行コマンドからトンネルトークンを取得して安全に保管する
4. トンネルの **Routes** で **Add route** → **Published application** を選択する
5. 管理 API 用のドメインまたはサブドメイン（例: `disqord.example.com`）を指定する
6. Service type に **HTTP**、Service URL に `localhost:3000` を指定してルートを追加する

トンネルトークンを取得した第三者はトンネルを実行できるため、リポジトリやログに記録しない。

#### Coolify での Cloudflared デプロイ

1. Coolify ダッシュボードで DisQord と同じプロジェクトを開く
2. **+ New** から `Cloudflared` を検索して選択する
3. Cloudflared の環境変数 `TUNNEL_TOKEN` に取得したトンネルトークンを設定する
4. **Deploy** を選択し、Cloudflare Tunnel が接続済みになることを確認する

公開後は、上の curl 例の `BASE` を公開 URL（例: `https://disqord.example.com`）へ変更して管理 API の応答を確認する。

### Claude Code から呼ぶ

`Bash` から `curl`、または `WebFetch` から URL を叩く。
`WebFetch` を使う場合は HMAC を別途計算した URL は使えないため、`Bash` 経由を推奨する。

## 参考リンク

- [Coolify: Access Single Resource via Cloudflare Tunnels](https://coolify.io/docs/integrations/cloudflare/tunnels/single-resource)
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
