# Bot 管理 API（admin endpoints）

## Why

開発は Claude Code 中心で進めているが、本番（Coolify ホスト）で問題が発生した際に Claude Code から直接ログ・メトリクスを取得する手段がなく、開発者が Coolify ダッシュボードで `docker logs` を覗いて手動コピーするフローになっている。フィードバックループが遅く、調査の起点が手作業に依存している。

Bot 自身に HMAC 認証付きの管理エンドポイント `/admin/logs` と `/admin/metrics` を追加することで、Claude Code が `WebFetch` / `Bash`+`curl` で直接ログとメトリクスを引けるようにする。クラッシュ前のログも追えるようにファイルローテーションを併設する。

## Goals / Non-Goals

**Goals:**

- HMAC-SHA256 認証付きの `GET /admin/logs` `GET /admin/metrics` を `src/health.ts` の Bun.serve に追加
- ログをファイルにローテーション保存し（10 MB × 5 世代）、再起動を跨いで直近ログを保持
- `process.uptime()` / `memoryUsage()` / Discord ws ping / OpenRouter リクエスト・エラー数 / コマンド実行数 / SQLite 合計バイト数 / ログ合計バイト数 を JSON で返す軽量メトリクス
- ログのレベルフィルタ（`?level=warn`）、行数指定（`?lines=500`）、時刻フィルタ（`?since=<ISO>`）対応
- 既存の Cloudflare Tunnel 経路をそのまま使い、追加インフラ不要

**Non-Goals:**

- Prometheus exposition format 互換
- 外部ログ集約サービスへの転送（Phase 2 で別途対応）
- トレーシング / APM 級観測
- 長期履歴（30 日以上）
- 書込系 admin API（POST/PUT/DELETE は 405 で拒否）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 認証方式 | HMAC-SHA256 over `METHOD\npath\ncanonicalQuery\ntimestamp` | 既存 `verifyGitHubSignature` と同じ Web Crypto + `timingSafeEqual` パターンを再利用 |
| ボディ署名 | しない | GET 読み取り専用で副作用なし、body そのものが存在しない |
| Replay 保護（nonce） | 採用しない | TLS 終端された経路で攻撃者が暗号文を捕捉できる前提なら応答も復号可能。nonce ストアの複雑性に見合う防御効果がない。残存リスクは「5 分以内の同一 GET 再送が成功」のみで副作用ゼロ |
| Timestamp ドリフト窓 | 5 分 | GitHub Webhook と同等の標準値 |
| Timestamp バリデーション | `/^\d{1,15}$/` + `Number.isSafeInteger && >0` | `Math.abs(Date.now() - NaN)` が `false` 評価される NaN バイパスを塞ぐ |
| Query 正規化 | `URLSearchParams` パース → key/value 昇順安定ソート → `encodeURIComponent` で `&` 連結 | クライアントとサーバの順序差異を吸収。`+` と `%20` は `URLSearchParams` が両方 space に正規化するため同じ署名になる |
| HTTP メソッド | GET のみ | 副作用なしの読み取り専用 API。それ以外は 405 + `Allow: GET` |
| ルーティング実装 | Bun.serve の `routes` オプション（per-method ハンドラ）で `/admin/*` を定義 | 現状の `health.ts` は `fetch(req)` 内で `url.pathname` を手動分岐している。Bun 1.2.3+ の `routes` は `{ "/admin/metrics": { GET: handler } }` のように method 別ハンドラを書ける。**未定義 method の扱いは要検証**（バージョンによっては 404 や `fetch` フォールバックに落ちる既知 issue があるため、405 + `Allow: GET` を返せるか実装時に確認。確実を期すなら各 route で全 method を受けて非 GET を明示的に 405 にする）。`/admin/*` を `routes` で追加し、既存の `/health` `/webhook/github` は `fetch` フォールバックに残すか同時に `routes` へ寄せる（移行は任意・最小差分優先） |
| ログローテーション実装 | 自前（外部ライブラリなし） | 30 LOC 程度。Bun の `fs.writeSync(fd, ...)` で十分。pino 等を入れると `logger.ts` 全面書き換えが必要 |
| ログ書込みエラー時の挙動 | `console.error` に 1 回フォールバック報告し、`write()` を no-op 化 | disk full 時に `logger.error()` から二次例外を投げて Bot を落とさない |
| メトリクス保存 | 1 分粒度 × 60 スロットのリングバッファ + 各スロットに絶対分番号を保持 | 「直近 1 時間」を低コストで返せる。長時間無書込み後でも古いスロットが集計に混入しない |
| SQLite サイズ計算 | 本体 + `-wal` + `-shm` を合計 | WAL モード有効下では本体のみだと実ディスク使用量を過小評価 |
| OpenRouter エラー計上 | `chat()` / `chatStream()` の本体全体を `try/catch` し outer catch で 1 回計上 | non-2xx / JSON parse 失敗 / stream 中の例外を漏れなく拾う。内側で重複カウントしない |
| 開発モード時のファイル書込み | `NODE_ENV !== "production"` かつ `LOG_DIR` 未設定なら no-op | `bun --hot` の HMR で fd リークするのを回避 |

## Design

### 変更対象

**新規ファイル:**

- `src/utils/logFile.ts` — 回転ファイルライター
- `src/utils/metrics.ts` — インメモリカウンタ + snapshot
- `src/http/adminAuth.ts` — HMAC 検証 + auth ミドルウェア
- `src/http/adminEndpoints.ts` — `/admin/logs` `/admin/metrics` ハンドラ
- `docs/admin-api.md` — 管理 API 仕様 + curl 例
- `tests/unit/utils/logFile.test.ts`
- `tests/unit/utils/metrics.test.ts`
- `tests/unit/http/adminAuth.test.ts`
- `tests/unit/http/adminEndpoints.test.ts`

**変更ファイル:**

- `src/utils/logger.ts` — `console[level]()` 直後に `logFileWriter.write(line)` を追加（遅延初期化）
- `src/health.ts` — `HttpServerOptions` に `adminApiSecret` / `db` / `databasePath` を追加し、Bun.serve の `routes` で `/admin/logs` `/admin/metrics` を per-method（GET）定義（GET 以外は Bun 自動 405、`Allow: GET` を明示付与）。既存の `fetch` 分岐（`/health` `/webhook/github`）はフォールバックとして温存可
- `src/index.ts` — `metrics.attach({ client, db, databasePath })` 呼び出し、`startHttpServer` への DI 追加、shutdown フックに `logFileWriter.flush(); close()`
- `src/config/envVars.ts` — `ADMIN_API_SECRET` / `LOG_DIR` / `LOG_MAX_BYTES` の env var 定義追加
- `src/config/index.ts` — `Config` 型と `loadConfig()` に上記を追加
- `src/llm/openrouter.ts` — `chat()` / `chatStream()` 全体を `try/catch` で囲い `metrics.increment("openrouter.requests")` `metrics.increment("openrouter.errors")` を挿入（二重カウントしない）
- `src/bot/events/interactionCreate.ts` — `metrics.increment(\`command.${commandName}\`)` と `metrics.increment("command.errors")` を挿入

### HMAC スキーム

ヘッダ:

- `X-Admin-Timestamp`: Unix epoch milliseconds（10 進文字列）
- `X-Admin-Signature`: `sha256=<hex>` 形式

正規化文字列（LF 区切り、末尾改行なし）:

```text
${METHOD}\n${path}\n${canonicalQuery}\n${timestamp}
```

`canonicalQuery` 生成手順（クライアント・サーバ共通）:

1. `URLSearchParams` で query をパース → `[key, value][]` 取得
2. `key` 昇順 → 同一 `key` 内は `value` 昇順で安定ソート（重複キー保持）
3. `key` / `value` を `encodeURIComponent` で個別エンコード
4. `${encodedKey}=${encodedValue}` を `&` で連結。query なしなら空文字

### ログローテーション順序

`LOG_MAX_BYTES`（既定 10 MB）超過で:

1. `disqord.5.log` が存在すれば `unlinkSync`
2. `.4 → .5`, `.3 → .4`, `.2 → .3`, `.1 → .2` の順で `renameSync`
3. 現行 fd を close → `disqord.log → disqord.1.log` を `renameSync` → 新しい `disqord.log` を `openSync("a")` で再オープン

逆順（current → .1 を最初）にすると `.1` が上書きされて消える。

### メトリクス JSON shape

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

### 環境変数

| 名前 | 必須 | デフォルト | 説明 |
| ---- | ---- | --------- | ---- |
| `ADMIN_API_SECRET` | No | (未設定なら 503) | 管理 API HMAC 署名検証用 |
| `LOG_DIR` | No | `data/logs` | ログ保存ディレクトリ |
| `LOG_MAX_BYTES` | No | `10485760` (10 MB) | ローテーション閾値 |

### 検証用 curl 例

メトリクス取得:

```bash
SECRET="$ADMIN_API_SECRET"
TS=$(date +%s%3N)
PATH_=/admin/metrics
SIG=$(printf 'GET\n%s\n\n%s' "$PATH_" "$TS" \
      | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -sS "https://webhook.example.com$PATH_" \
  -H "X-Admin-Timestamp: $TS" \
  -H "X-Admin-Signature: sha256=$SIG" | jq .
```

ログ取得（直近 200 行、warn 以上）:

```bash
PATH_=/admin/logs
QUERY="level=warn&lines=200"
TS=$(date +%s%3N)
SIG=$(printf 'GET\n%s\n%s\n%s' "$PATH_" "$QUERY" "$TS" \
      | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -sS "https://webhook.example.com$PATH_?$QUERY" \
  -H "X-Admin-Timestamp: $TS" \
  -H "X-Admin-Signature: sha256=$SIG"
```

### 参照

- 設計プラン: `~/.claude/plans/claude-code-claude-code-claude-code-shiny-bear.md`
- HMAC 実装の範: `src/http/webhookHandler.ts:9-49`
- 既存 logger: `src/utils/logger.ts`
- 既存 HTTP サーバ: `src/health.ts`

## Tasks

- [ ] `src/utils/logFile.ts` 作成 + テスト（rotate / getRecent / エラー封じ込め）
- [ ] `src/utils/metrics.ts` 作成 + テスト（リングバッファ / snapshot / 長時間放置時の挙動）
- [ ] `src/http/adminAuth.ts` 作成 + テスト（timestamp バリデーション / 署名検証 / canonicalQuery）
- [ ] `src/http/adminEndpoints.ts` 作成 + テスト（GET 以外は 405 / フィルタ動作 / 401・503 分岐）
- [ ] `src/utils/logger.ts` に `logFileWriter.write` 追記
- [ ] `src/config/envVars.ts` / `src/config/index.ts` に env var 追加
- [ ] `src/health.ts` に Bun.serve `routes` で `/admin/*` 追加（per-method GET、GET 以外は自動 405 + `Allow: GET`。未登録 method が `fetch` フォールバックに落ちないか動作確認）
- [ ] `src/index.ts` で DI とシャットダウンフック配線
- [ ] `src/llm/openrouter.ts` / `src/bot/events/interactionCreate.ts` にカウンタ挿入
- [ ] `docs/admin-api.md` 作成
- [ ] `bun test && bun typecheck && bun lint` パス
- [ ] ローカルで E2E 確認（`bun dev` + `curl http://localhost:3000`）
- [ ] Coolify に `ADMIN_API_SECRET` 設定 → 本番デプロイ → 本番 URL で curl 確認
