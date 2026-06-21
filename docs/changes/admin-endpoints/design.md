---
title: "Bot 管理 API（admin endpoints）"
status: implemented
priority: high
summary: "HMAC 認証付き管理エンドポイント（ログ取得・メトリクス）"
---

# Bot 管理 API（admin endpoints）

## Why

開発は Claude Code 中心で進めているが、本番ホストで問題が発生した際に Claude Code から直接ログ・メトリクスを取得する手段がなく、開発者がホスト側のダッシュボードで `docker logs` を覗いて手動コピーするフローになっている。フィードバックループが遅く、調査の起点が手作業に依存している。

Bot 自身に HMAC 認証付きの管理エンドポイント `GET /admin/logs` と `GET /admin/metrics` を追加することで、Claude Code が `WebFetch` / `Bash`+`curl` で直接ログとメトリクスを引けるようにする。クラッシュ前のログも追えるようにファイルローテーションを併設する。

## 依存 / 関連 change

- 連携: [release-polling](../release-polling/design.md) — 同じ HMAC 検証コア（Web Crypto + `timingSafeEqual`）を共有する。`release-polling` 側は Webhook 撤去のために `src/http/hmac.ts` への切り出しを Phase 2 task として明文化している。本 change が先着なら **本 change で `src/http/hmac.ts` を新規作成し**、`webhookHandler.ts` を helper 経由に薄くリファクタする（`release-polling` 着手時に再切り出しが不要になる）。`release-polling` が先着なら本 change は既存 helper を import するだけでよい。
- 独立: [oauth-byok](../oauth-byok/design.md) — ユーザー / ギルドの OpenRouter キー接続（OAuth PKCE）。認証主体・スコープが直交。重複懸念なし。
- 独立: [permissions-stats](../permissions-stats/design.md) — Discord ギルド内のコマンド実行権限（`admin_role_id`）。本 change の HMAC は Bot 運用者向けで、ギルド管理者権限とは別レイヤ。

## Goals / Non-Goals

**Goals:**

- HMAC-SHA256 認証付きの `GET /admin/logs` `GET /admin/metrics` を `src/health.ts` の Bun.serve に追加
- ログをファイルにローテーション保存し（10 MB × 5 世代）、再起動を跨いで直近ログを保持
- `process.uptime()` / `memoryUsage()` / Discord ws ping / OpenRouter リクエスト・エラー数 / コマンド実行数 / SQLite 合計バイト数 / ログ合計バイト数 を JSON で返す軽量メトリクス
- ログのレベルフィルタ（`?level=warn`）、行数指定（`?lines=500`）、時刻フィルタ（`?since=<ISO>`）対応
- 既存の公開 HTTPS 経路（TLS 終端された inbound、例: Cloudflare Tunnel）を流用し、追加インフラ不要

**Non-Goals:**

- Prometheus exposition format 互換
- 外部ログ集約サービスへの転送（将来の別 change）
- トレーシング / APM 級観測
- 長期履歴（30 日以上）
- 書込系 admin API（POST/PUT/DELETE は 405 で拒否）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 認証方式 | HMAC-SHA256 over `METHOD\npath\ncanonicalQuery\ntimestamp` | 既存 `verifyGitHubSignature` と同じ Web Crypto + `timingSafeEqual` パターンを共通 helper として再利用 |
| HMAC 共通化 | `src/http/hmac.ts` を新設し、Web Crypto による HMAC-SHA256 計算と `timingSafeEqual` を 1 箇所で持つ。`webhookHandler` / `adminAuth` の双方から呼ぶ | `release-polling` でも同じ切り出しが必要。同じロジックを 2 箇所に重複させない |
| ボディ署名 | しない | GET 読み取り専用で副作用なし、body そのものが存在しない |
| Replay 保護（nonce） | 採用しない | TLS 終端された inbound 経路で攻撃者が暗号文を捕捉できる前提なら応答も復号可能。nonce ストアの複雑性に見合う防御効果がない。残存リスクは「5 分以内の同一 GET 再送が成功」のみで副作用ゼロ |
| Timestamp ドリフト窓 | 5 分 | GitHub Webhook と同等の標準値 |
| Timestamp バリデーション | `/^\d{1,15}$/` + `Number.isSafeInteger && >0` | `Math.abs(Date.now() - NaN)` が `false` 評価される NaN バイパスを塞ぐ |
| Query 正規化 | `URLSearchParams` パース → key/value 昇順安定ソート → `encodeURIComponent` で `&` 連結。query が無ければ空文字 | クライアントとサーバの順序差異を吸収。`+` と `%20` は `URLSearchParams` が両方 space に正規化するため同じ署名になる |
| HTTP メソッド | GET のみ | 副作用なしの読み取り専用 API。それ以外は 405 + `Allow: GET` |
| ルーティング実装 | Bun.serve の `routes` オプションで `/admin/logs` `/admin/metrics` を per-method 定義しつつ、**確実性のため各 route で全 method を受け、非 GET は明示的に 405 + `Allow: GET` を返す**（Bun のバージョン差異で 404 や `fetch` フォールバックに落ちる既知 issue を避ける） | 現状 `src/health.ts:28-55` は `fetch(req)` 内で `url.pathname` を手動分岐している。`/health` `/webhook/github` は既存どおり `fetch` フォールバックに残し、本 change は `/admin/*` のみ `routes` で追加する（最小差分） |
| ログローテーション実装 | 自前（外部ライブラリなし） | 30 LOC 程度。Bun の `fs.writeSync(fd, ...)` で十分。pino 等を入れると `logger.ts` 全面書き換えが必要 |
| ローテーション 2-phase | Phase 1（古い世代の shuffling: `.5` 削除 → `.4→.5`, … `.1→.2`）と Phase 2（current の close → `.1` リネーム → 再 open）を分け、Phase 1 失敗は warning + writes 継続、Phase 2 失敗のみ no-op 化 | Phase 1 はアーカイブ維持の補助作業で、失敗しても `disqord.log` は無傷で append 可能。Phase 1 失敗で writer を破綻させると、disk 不調や arch-shuffling の単発エラーで全ファイル logging が止まる |
| ログ書込みエラー時の挙動 | `console.error` に 1 回フォールバック報告し、`write()` を no-op 化 | disk full 時に `logger.error()` から二次例外を投げて Bot を落とさない |
| メトリクス保存 | 累積カウンタのみ（`Map<name, number>`）。本 change ではリングバッファを持たない | スナップショット API は累積値しか返さないので、内部に時系列バッファを持っても dead code になる。時系列が必要になったら別 change で `?window=1h` 等とセットで導入 |
| SQLite サイズ計算 | 本体 + `-wal` + `-shm` を合計 | WAL モード有効下では本体のみだと実ディスク使用量を過小評価 |
| OpenRouter リクエスト計上のスコープ | `isRateLimited()` の short-circuit はカウントから除外し、`fetch` の試行直前で `openrouter.requests` を、その後に throw された場合のみ `openrouter.errors` を計上 | `docs/admin-api.md` の「OpenRouter API 呼び出し」は実 fetch を指す。ローカル rate-limit cooldown は API 呼び出しではなく、計上すると本数が膨らんで現場の指標がブレる |
| 開発モード時のファイル書込み | `nodeEnv !== "production"` かつ `LOG_DIR` 未設定なら no-op | `bun --hot` の HMR で fd リークするのを回避 |
| テスト配置 | 既存の `tests/unit/<name>.test.ts` フラット配置に揃える（http/ サブディレクトリは新設しない）。utils 配下のみ既存どおり `tests/unit/utils/<name>.test.ts` | `webhookHandler.test.ts` / `health.test.ts` と同列に並ぶ方が grep / find しやすい |

## Design

### 変更対象ファイル

**新規:**

- `src/http/hmac.ts` — Web Crypto + `timingSafeEqual` による HMAC-SHA256 共通 helper（`hmacSha256Hex(secret, message)` と `timingSafeEqualHex(a, b)` を export）
- `src/utils/logFile.ts` — 回転ファイルライター（`createLogFileWriter({dir, maxBytes, env})` → `{ write, flush, close, getRecent }`）
- `src/utils/metrics.ts` — インメモリ累積カウンタ + snapshot（`metrics.increment(name)` / `metrics.snapshot()` / `metrics.attach({client, databasePath, logFileWriter})`）
- `src/http/adminAuth.ts` — `verifyAdminRequest(req, secret)` → `{ ok: true } | { ok: false, status, reason }`
- `src/http/adminEndpoints.ts` — `handleAdminLogs(req)` / `handleAdminMetrics(req)`
- `docs/admin-api.md` — 管理 API 仕様 + curl 例 + ローカル / 本番設定手順
- `tests/unit/hmac.test.ts` — HMAC helper 単体テスト
- `tests/unit/utils/logFile.test.ts` — tmpdir 上でローテ・getRecent・エラー封じ込めを検証
- `tests/unit/utils/metrics.test.ts` — increment / snapshot / dbBytes 集計 / logBytes 委譲
- `tests/unit/adminAuth.test.ts` — timestamp バリデーション / 署名検証 / canonicalQuery
- `tests/unit/adminEndpoints.test.ts` — GET 以外 405 / フィルタ動作 / 401・503 分岐

**修正:**

- `src/http/webhookHandler.ts` — `verifyGitHubSignature` の HMAC 計算 / 比較部分を `src/http/hmac.ts` 経由に置き換える。挙動・型・export 名は維持し、既存テスト (`tests/unit/webhookHandler.test.ts`) を変更せず緑通過
- `src/utils/logger.ts` — `console[level]()` 直後に遅延初期化された `logFileWriter.write(line)` を呼ぶ
- `src/health.ts` — `HttpServerOptions` に `adminApiSecret?: string` / `logFileWriter?: LogFileWriter` を追加。Bun.serve に `routes` プロパティを追加し、`/admin/logs` `/admin/metrics` をそれぞれ全 method 受けるハンドラとして登録（GET のみ処理、それ以外は 405 + `Allow: GET`）。既存 `fetch` 分岐（`/health` `/webhook/github`）はフォールバックとして温存
- `src/index.ts` — `metrics.attach({ client, databasePath: config.databasePath, logFileWriter })` を呼び、`startHttpServer` に `adminApiSecret` / `logFileWriter` を渡す。shutdown フックに `logFileWriter.flush(); close()` を追加
- `src/config/envVars.ts` — `ADMIN_API_SECRET` / `LOG_DIR` / `LOG_MAX_BYTES` を追加（README env vars は pre-commit hook で自動再生成）
- `src/config/index.ts` — Zod `configSchema` に `adminApiSecret: z.string().optional()` / `logDir: z.string().optional()` / `logMaxBytes: z.coerce.number().int().min(1024).default(10_485_760)` を追加し、`loadConfig()` に渡す
- `src/llm/openrouter.ts` — `chat()` / `chatStream()` の `isRateLimited()` チェックは `try` の外に置き、`fetch` 試行直前で `metrics.increment("openrouter.requests")`、その後の throw のみ outer catch で `metrics.increment("openrouter.errors")` の後 rethrow。`chatStream` は generator 内 try/catch + `throw` で同様
- `src/bot/events/interactionCreate.ts` — slash command 分岐の入口で `metrics.increment(\`command.${commandName}\`)`、`catch` で `metrics.increment("command.errors")`

### HMAC 共通 helper（`src/http/hmac.ts`）

```ts
export async function hmacSha256Hex(secret: string, message: string): Promise<string>;
export function timingSafeEqualHex(expectedHex: string, actualHex: string): boolean;
```

- `hmacSha256Hex`: `crypto.subtle.importKey` + `subtle.sign("HMAC", ...)` → hex 文字列。
- `timingSafeEqualHex`: 両辺を hex として `Buffer.from(..., "hex")` でパースし `node:crypto`'s `timingSafeEqual` を呼ぶ。長さ不一致は即 `false`。
- `webhookHandler.verifyGitHubSignature` は内部で `hmacSha256Hex` → `timingSafeEqualHex` を呼ぶ薄いラッパに変える。`tests/unit/webhookHandler.test.ts` は無修正で緑通過。

### `adminAuth.ts` の HMAC スキーム

ヘッダ:

- `X-Admin-Timestamp`: Unix epoch milliseconds（10 進文字列）
- `X-Admin-Signature`: `sha256=<hex>` 形式

正規化文字列（LF 区切り、末尾改行なし）:

```text
${METHOD}\n${path}\n${canonicalQuery}\n${timestamp}
```

`canonicalQuery` 生成手順（クライアント・サーバ共通）:

1. `new URL(req.url).searchParams` を `[key, value][]` に展開
2. `key` 昇順 → 同一 `key` 内は `value` 昇順で安定ソート（重複キー保持）
3. `key` / `value` を `encodeURIComponent` で個別エンコード
4. `${encodedKey}=${encodedValue}` を `&` で連結。query なしは空文字

`verifyAdminRequest`:

```ts
export type AdminAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; reason: string };

export async function verifyAdminRequest(
  req: Request,
  secret: string | undefined,
): Promise<AdminAuthResult>;
```

- `secret` が `undefined` または空文字 → `{ ok: false, status: 503, reason: "ADMIN_API_SECRET not configured" }`
- `X-Admin-Timestamp` 欠落 or `/^\d{1,15}$/` に不一致 or `Number.isSafeInteger` 失敗 or `<= 0` or `|now - ts| > 5 * 60_000` → `401`
- `X-Admin-Signature` 欠落 or `sha256=` プレフィックス無し → `401`
- HMAC 不一致 → `401`
- すべて OK → `{ ok: true }`

### `adminEndpoints.ts`

両ハンドラとも先頭で `verifyAdminRequest` を呼び、`{ ok: false }` ならそのまま `Response` を返す。`{ ok: true }` 後にビジネスロジック実行。

`handleAdminMetrics(req)`:

- `metrics.snapshot()` を JSON 化して 200 で返す。

`handleAdminLogs(req)`:

- query: `level` ∈ `{ debug, info, warn, error }` / `lines` ∈ `[1, 10_000]` / `since` ISO 8601。
- `logFileWriter.getRecent({ level, lines, since })` で `string[]` を取り、`\n` 連結して `text/plain; charset=utf-8` で返す。

### ログローテーション順序

`LOG_MAX_BYTES`（既定 10 MB）超過で:

Phase 1（アーカイブ維持、失敗しても writes は継続）:

1. `disqord.5.log` が存在すれば `unlinkSync`
2. `.4 → .5`, `.3 → .4`, `.2 → .3`, `.1 → .2` の順で `renameSync`

Phase 2（current ファイルの差し替え、失敗で writer を no-op 化）:

1. 現行 fd を close
2. `disqord.log → disqord.1.log` を `renameSync`
3. 新しい `disqord.log` を `openSync("a")` で再オープン

逆順（current → .1 を最初）にすると `.1` が上書きされて消える。
Phase 1 が失敗したら `writtenBytes` をリセットして次回 rotate まで writes を継続する（毎 write で rotate を試みて connsole.error を連発しない）。

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

- `discord.ping` は `client.ws.ping`。`-1` のときは `null` に正規化。
- `dbBytes` は `databasePath` + `databasePath + "-wal"` + `databasePath + "-shm"` の `statSync().size` 合計（存在しないファイルは 0）。
- `logBytes` は `LOG_DIR` 配下の `disqord*.log` ファイルサイズ合計（`LOG_DIR` 未設定 / 不在は 0）。

### 環境変数

| 名前 | 必須 | デフォルト | 説明 |
| ---- | ---- | --------- | ---- |
| `ADMIN_API_SECRET` | No | (未設定なら 503) | 管理 API HMAC 署名検証用 |
| `LOG_DIR` | No | 開発: 未設定（no-op） / 本番: `data/logs` | ログ保存ディレクトリ。`nodeEnv !== "production"` で未設定なら HMR fd リーク回避のため no-op |
| `LOG_MAX_BYTES` | No | `10485760` (10 MB) | ローテーション閾値 |

config 拡張イメージ（`src/config/index.ts`）:

```ts
const configSchema = z.object({
  // ...既存...
  adminApiSecret: z.string().optional(),
  logDir: z.string().optional(),
  logMaxBytes: z.coerce.number().int().min(1024).default(10_485_760),
});
```

### 検証用 curl 例

メトリクス取得（query なし）:

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

## Tasks

### Phase 1: HMAC helper 切り出し

- [x] `src/http/hmac.ts` 新規 + `tests/unit/hmac.test.ts`（既知ベクタ + 長さ不一致 + 正常系）
- [x] `src/http/webhookHandler.ts` を helper 経由にリファクタ。既存 `tests/unit/webhookHandler.test.ts` を無修正で緑通過

### Phase 2: ログ / メトリクス基盤

- [x] `src/utils/logFile.ts` 新規 + `tests/unit/utils/logFile.test.ts`（rotate / getRecent / `LOG_DIR` 未設定 no-op / 書込みエラー封じ込め）
- [x] `src/utils/metrics.ts` 新規 + `tests/unit/utils/metrics.test.ts`（increment / snapshot 形 / dbBytes 集計）
- [x] `src/utils/logger.ts` に `logFileWriter.write` 追記
- [x] `src/llm/openrouter.ts` / `src/bot/events/interactionCreate.ts` にカウンタ挿入

### Phase 3: HTTP エンドポイント

- [x] `src/config/envVars.ts` / `src/config/index.ts` に env var 追加
- [x] `src/http/adminAuth.ts` 新規 + `tests/unit/adminAuth.test.ts`
- [x] `src/http/adminEndpoints.ts` 新規 + `tests/unit/adminEndpoints.test.ts`
- [x] `src/health.ts` に `routes` で `/admin/*` 追加（全 method 受け、非 GET は明示 405 + `Allow: GET`）
- [x] `src/index.ts` で `metrics.attach` / DI / shutdown 配線

### Phase 4: ドキュメント / 仕上げ

- [x] `docs/admin-api.md` 作成（curl 例 / JSON shape / ローカル & 本番設定手順）
- [x] `bun test && bun typecheck && bun lint` パス
- [x] ローカル E2E（`bun dev` + 上記 curl で 200 / 405 / 503 を目視）
- [ ] `docs/changes/admin-endpoints/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **Bun.serve `routes` のバージョン差異**: 未定義 method の扱いがバージョンによって変わる既知 issue がある。Decisions に従い「全 method 受けてコード側で 405 化」を採用しているため、動作が壊れる方向の差異は出ない想定。CI で動いている Bun (`mise.toml` の `bun = "1.x"`) で起動確認だけは行う。
- **SQLite `-wal` / `-shm` の有無**: WAL 有効下でも書込みが暫く無いと `-shm` が無い瞬間がある。`statSync` が `ENOENT` を投げるケースを catch して 0 に正規化する。
- **`chatStream` 中の例外計上**: stream 途中での throw を outer catch で 1 回だけ拾えるよう、generator 全体を try/catch で囲う実装に統一する。SSE フレーム単位の `JSON.parse` 失敗は既存どおり個別 catch で握り、`openrouter.errors` には計上しない（"API エラー" の意味を保つ）。

## 参照

- HMAC 実装の範: `src/http/webhookHandler.ts:9-49`（`verifyGitHubSignature`）
- 既存 logger: `src/utils/logger.ts`
- 既存 HTTP サーバ: `src/health.ts`（`startHttpServer` と `fetch` 内の `/health` / `/webhook/github` 分岐）
- 既存 env var 定義: `src/config/envVars.ts` / Zod スキーマ: `src/config/index.ts`
- DB 接続パス: `src/db/index.ts`（`getDatabase()` が `DATABASE_PATH` を読む）
