---
title: "リリース更新通知のポーリング化"
status: planned
priority: medium
summary: ""
---

# リリース更新通知のポーリング化

## Why

push（GitHub Webhook）方式は、リポジトリの Webhook 設定権限を持つオーナー（AtefAndrus）の単一インスタンスでしか機能しない。
セルフホスターは upstream リポの Settings → Webhooks にアクセスできず、自分の inbound エンドポイントを立てても GitHub 側が配信先として登録できないため、更新通知を原理的に受け取れない。
各インスタンスが GitHub Releases API を outbound で取得する定期ポーリングに切り替えることで、オーナー・セルフホスターが同一コードパスで更新通知を受け取れるようにする。あわせてリリース通知のための公開 inbound エンドポイント / 署名検証への依存を解消する。

## 依存 / 関連 change

- 関連: [admin-endpoints](../admin-endpoints/design.md) — 公開 inbound 経路（現状は Cloudflare Tunnel）を別途前提にしている。Webhook 廃止で「リリース通知のための inbound 依存」は消えるが、admin-endpoints を実装する場合は別理由で inbound 経路が残る。inbound 経路の完全撤去可否は admin-endpoints の採否に従属し、本 change のスコープ外。
- 関連: admin-endpoints は HMAC 検証で `verifyGitHubSignature` の Web Crypto + `timingSafeEqual` パターンを範として参照している。本 change で Webhook 検証を削除する際は、HMAC 検証ロジックを汎用 helper（`src/http/hmac.ts`）へ先に切り出し、admin-endpoints の前提を壊さないこと（Decisions 参照）。

## Goals / Non-Goals

**Goals:**

- 定期ポーリングで upstream の GitHub Releases を取得し、新しい正式リリースを各ギルドの release_channel へ通知する
- オーナー / セルフホスターが同一コードパスで動作（push のオーナー権限依存を解消）
- GitHub トークン不要で動作（未認証 REST。任意でトークン設定可）
- 冪等化により再起動・重複ポーリング・初回起動・latest の巻き戻り・prerelease 昇格・リリース削除での誤通知/二重通知を防止
- 既存 `ReleaseNotificationService.notify()` を再利用（引数型は `notify()` が実際に使う最小フィールドへリファクタし、Webhook 専用の `sender` / `repository.id` 依存を外す）
- Webhook 受信経路（`/webhook/github` + 署名検証）を削除し、リリース通知を 100% outbound 化

**Non-Goals:**

- prerelease / draft の通知（現行と同じく正式リリースのみ。prerelease→正式昇格時は昇格後に通知）
- per-guild の確実な配信保証（best-effort 配送を採用。後述）
- admin-endpoints / inbound 経路の撤去判断（別 change に従属）

**将来別 change 候補:**

- 複数リポジトリ同時監視 → 別 change（本 change は単一リポを基本にしつつ、状態を repo 単位で持って拡張余地を残す）
- per-guild の配信状態管理（`release_delivery_state(repo, release_id, guild_id)`）→ 別 change
- リリース総数が数千規模になった場合の id セット圧縮（cutoff / ページング）→ 別 change
- Atom feed フォールバック（トークン不可 × 多数リポ × 共有 IP レート枯渇が現実化した場合）→ 別 change

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| push（Webhook）の扱い | 廃止しポーリングに一本化 | push を残す唯一の理由＝即時性はリリース通知に不要。併存は同一リリースの二重通知を生み、防止には両経路での冪等状態共有が必要で複雑化する。一本化で冪等状態が 1 箇所に完結し、オーナー / セルフホスターが同一挙動になる |
| 取得方式 | REST `GET /repos/{owner}/{repo}/releases?per_page=100`（未認証 + ETag）。`/releases/latest` は使わない | `/releases/latest` は「`created_at` で見た最新の非 prerelease・非 draft」で公開日基準でなく、`make_latest=false` や latest 削除で巻き戻る。一覧を取り `draft=false && prerelease=false` で除外する方が堅牢。`per_page=100` で Bot ダウン中に積み上がった複数リリースも 100 件まで拾える |
| 取得方式 Atom feed を使わない | 不採用 | `releases.atom` は prerelease をフィード上で区別できず「正式リリースのみ」を満たせない。XML パースと巨大 HTML 本文で実装コスト増。トークン不可 × 多数リポ × 共有 IP 枯渇が現実化した時のみ別 change で再検討 |
| 通知判定 / 冪等キー | 不変の `release.id`。**通知済み id セット**（`notified_release_ids`）に無い正式リリースを通知。初回 seed で全ページ走査して既存正式リリース id を全記録し、以後も保持（trim しない） | `published_at` 高水位だと latest 巻き戻り（過去 id 再通知）・prerelease→正式昇格（昇格後 `published_at` が古く漏れる）・同一秒複数リリース（取りこぼし）で破綻する。不変 id の集合差で「未通知」を厳密判定する。新しいリリースの削除で 101 件目以降が 1 ページ目へ繰り上がっても、seed で全既存を記録済みなら誤通知しない。id セットはリリース総数規模（disqord は当面数十〜数百で数 KB、肥大化時は別 change） |
| 通知順序 | 未通知リリースを `published_at` 昇順（古い順）に送信 | 複数未通知時に時系列で届ける。順序付けにのみ `published_at` を使い、冪等判定には使わない |
| 初回シード | `seeded` フラグを持つ state 行を作る。初回 `200` 時は全ページ走査でフィルタ結果の**全 id を通知済みとして記録**し通知しない（空でも `seeded=true`） | 初回に既存の全リリースを新規誤認して一斉通知するのを防ぐ。`seeded` と id セットを分離し、リリースが無い初回（`200 []`）でも `seeded=true, notified=[]` を記録して、後日の初リリースを通知できるようにする |
| 配信セマンティクス | best-effort 配送 + リリース単位の at-least-once 再試行。判定軸は `failed` の有無。`failed === 0` なら id を進める（全成功・送信先ゼロ・全 skip を含む）。`failed > 0 && success > 0`（部分成功）も id を進める（失敗ギルドは再送しない）。`failed > 0 && success === 0`（全ギルド失敗）は id を進めず次回再試行。`notify()` の throw も id を進めない | `notify()` は個別ギルド失敗を内部捕捉し `NotificationResult.failed` に積んで throw しない。また「released だが送信先ギルドなし」は `success=failed=skipped=0` で返る（`releaseNotificationService.ts:35`）。`failed` 有無を主軸にすることで送信先ゼロを「処理済み」として前進させ、全失敗時のみリリース単位で再試行する。部分失敗ギルドの確実配信には `release_delivery_state` が要るが個人 Bot 規模に過剰 |
| id セットの永続化粒度 | `notify()` が返ったリリースごとに `notified_release_ids` を DB へ永続化（リリース単位コミット）。ETag は全リリース処理後に保存 | まとめて保存すると、A 成功後に B の `notify()` が throw した際 A も永続化されず A が重複通知される。リリース単位で永続化すれば重複はプロセスクラッシュ時のみに限定される |
| ETag の更新 | `200` を正常処理し終えたら（seed・通知あり・通知なしのいずれでも）`etag` を保存。`notify()` の throw で中断した場合は保存しない | ETag を「通知時のみ」保存だと、未通知 id が無い回や draft/prerelease 変更で一覧が変わるたび `If-None-Match` 無しで 200 を引き続ける。正常処理完了で保存すれば次回 304 で済む。throw 中断時は未通知が残るため保存しない |
| poll の直列化 | `isPolling` ガード（または `setTimeout` 再帰）。fetch には `AbortController` で timeout（15 秒）を設け、`finally` で必ずガード解除 / 次回予約 | `setInterval` は前回完了を待たず並行実行され二重通知し得る。fetch がハングすると `isPolling` が戻らず polling が永久停止するため、timeout と `finally` 解除が必須 |
| 起動時 / 定期 poll の例外 | poll 全体を try/catch で握りログ化。`bootstrap()` や interval へ例外を伝播させない | 起動時 poll の throw が `bootstrap().catch()`（index.ts:90）を発火させると、GitHub 一時障害や DNS 失敗で Bot 全体が起動失敗する |
| HTTP ステータス処理 | `200`/`304` に加え `401`/`403`/`404`/`429`/`5xx` を分岐（下記） | エラー時に通常 interval で叩き続けると統合 ban のリスク。一覧 API では「リリース無し」は `200 []`、`404` はリポ不存在/不可視/権限 |
| 認証トークン | 任意。`trim()` して空文字は未認証扱い。設定時のみ `Authorization: Bearer ${token}` を付与 | 空文字・無効トークンで「認証済み」と誤認しない。304 のレート非消費は `Authorization` 付き認証成功時のみ有効 |
| request ヘッダ | `Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28`、`User-Agent: disqord-bot`、（トークン時）`Authorization: Bearer ${token}` を付与 | GitHub API はバージョン固定と `User-Agent` を推奨（`User-Agent` 不在は `403` 要因）。API 仕様変更の影響を抑える |
| 監視リポの検証 | `GITHUB_RELEASE_REPO` を zod で `^[^/\s]+/[^/\s]+$` 検証。URL 構築時に owner/repo を個別に `encodeURIComponent` | 手入力 env のため `owner/repo/extra` や空白混入を早期に落とす |
| 状態保存先 | 新テーブル `release_polling_state`（repo 単位） | `guild_settings` はギルド単位で粒度が異なる。将来の複数リポ監視に備え repo 単位で分離する |
| ポーリング間隔 | env 既定 600 秒（10 分）。zod で下限 60 秒を強制 | 即時性不要。1 リポ 6 req/h で未認証 60 req/h 枠内。`0`/負数/極小値は枠や二次レート制限に即抵触するため下限を設ける |

## Design

### 変更対象ファイル

**新規:**

- `src/services/releasePollingService.ts` — GitHub Releases 取得 → フィルタ/id 差分判定 → DTO 変換 → `notify()` 呼び出し
- `src/db/repositories/releasePollingState.ts` — ポーリング状態の永続化（repo 単位、`IReleasePollingStateRepository` 実装）
- `src/http/hmac.ts` — `verifyGitHubSignature` から切り出す汎用 HMAC-SHA256 検証（Web Crypto + `timingSafeEqual`）
- `tests/unit/services/releasePollingService.test.ts` — fetch を mock。200/304/404/401/403/429/5xx/timeout、初回 seed（空含む）、latest 巻き戻り、prerelease 昇格、リリース削除繰り上げ、同一秒複数、全ギルド失敗で id 据え置き、二重通知なし、ETag 順序を検証
- `tests/unit/db/repositories/releasePollingState.test.ts` — インメモリ DB で get/set/seeded/id セット追記を検証

**修正:**

- `src/db/schema.ts` — `release_polling_state` テーブルの `CREATE TABLE` マイグレーション追加
- `src/index.ts` — `releasePollingService` の DI、起動時 1 回 poll（try/catch で握り起動継続）、直列化タイマー登録、shutdown フックでタイマー停止
- `src/config/envVars.ts` — `GITHUB_RELEASE_REPO` / `GITHUB_POLL_INTERVAL_SECONDS` / `GITHUB_TOKEN` の定義追加、`GITHUB_WEBHOOK_SECRET` 削除
- `src/config/index.ts` — `Config` 型と `loadConfig()`（zod）に上記を反映。repo は `^[^/\s]+/[^/\s]+$`、interval は `int().min(60)`、token は `trim()` 後に空文字を未設定扱い
- `src/health.ts` — `/webhook/github` 経路と `handleGitHubWebhook()` を削除。`/health` と `startHttpServer()` は温存。`HttpServerOptions` から `githubWebhookSecret` / `releaseNotificationService` を除去
- `src/services/releaseNotificationService.ts` — `notify()` の引数型を最小 DTO（`action` + `release` + `repository.{name,full_name,html_url}`）へリファクタし、Webhook 専用の `sender` / `repository.id` 依存を外す
- `.env.example` — `GITHUB_WEBHOOK_SECRET` を削除し、新 env を追加

**削除（HMAC は先に切り出し）:**

- `src/http/webhookHandler.ts` — HMAC 検証を `src/http/hmac.ts` へ切り出した後、Webhook 固有部分（`parseReleasePayload` / GitHub 署名ラッパ）を削除。admin-endpoints はこの汎用 helper を範として参照できる
- `tests/unit/webhookHandler.test.ts` — HMAC helper のテストへ移設
- `docs/infrastructure-setup.md` — Webhook + Cloudflare Tunnel 手順。admin-endpoints が inbound 経路を残すか否かに応じて、全削除またはポーリング設定ガイドへ刷新

### DB スキーマ変更

`release_polling_state`:

| 列 | 型 | 説明 |
| -- | -- | ---- |
| `repo` | TEXT PRIMARY KEY | `"owner/repo"` |
| `notified_release_ids` | TEXT NULL | 通知済み正式リリース id の JSON 配列。初回 seed で既存全件を記録し、以後の通知 id を追記（trim しない。リリース総数規模） |
| `etag` | TEXT NULL | 直近レスポンスの ETag（`If-None-Match` 用）。`200` 正常処理後に保存 |
| `seeded` | INTEGER NOT NULL DEFAULT 0 | 初回観測済みフラグ（0/1） |
| `last_checked_at` | TEXT NULL | 最終ポーリング時刻（観測性） |
| `last_error` | TEXT NULL | 直近エラー（観測性） |
| `updated_at` | TEXT NOT NULL | 最終更新時刻（ISO） |

### poll フロー

1. `GET /repos/{owner}/{repo}/releases?per_page=100` を発行（`Accept` / `X-GitHub-Api-Version` / `User-Agent`、トークン時は `Authorization: Bearer <token>`、保存済み `etag` があれば `If-None-Match`、`AbortController` で 15 秒 timeout）。`last_checked_at` を更新
2. ステータス分岐:
   - `304` → 変化なし。終了
   - `200` → 続行
   - `401` → 認証設定エラー。`last_error` 記録 + 警告ログ。トークンを直さない限り解決しないため次回予約をバックオフ（無駄打ち抑制）
   - `403` / `429` → `retry-after` があれば従う。無ければ `x-ratelimit-remaining: 0` のとき `x-ratelimit-reset` まで待つ。どちらも無ければ最低 60 秒 + 指数バックオフ。`last_error` 記録
   - `404` → リポ不存在/不可視/権限。エラーログ + `last_error`。**seed しない**
   - `5xx` / timeout / ネットワーク例外 → `last_error` 記録、次回 interval でリトライ
3. `200` 本文を `draft=false && prerelease=false` でフィルタ
4. `seeded=false`（初回）→ `Link` ヘッダで**全ページを走査**し、既存正式リリースの**全 id** を `notified_release_ids` に記録（空なら `[]`）、`seeded=true` にして**通知しない**（シード）。完了後に `etag`（1 ページ目）を保存して終了
5. `seeded=true` → フィルタ結果のうち `notified_release_ids` に**含まれない** id を `published_at` 昇順（古い順）に `notify()`
6. 各リリースを `notify()` した後、配信結果で id 前進を判定し、進める場合は id を `notified_release_ids` へ追加して**リリース単位で DB に永続化**:
   - `failed === 0` → id を追加（全成功・送信先ゼロ・全 skip を含む）
   - `failed > 0 && success > 0`（部分成功）→ id を追加（失敗ギルドは再送しない、best-effort）
   - `failed > 0 && success === 0`（全ギルド失敗）→ id を追加せず**中断**（次回再試行）
   - `notify()` 自体が throw → id を追加せず中断（次回リトライ）
   全リリースを中断なく処理し終えたら（通知有無を問わず）`etag` を保存

### `notify()` の型と変換

- `notify()` / `createReleaseEmbed` が実際に参照するのは `action`・`release.*`・`repository.{name,full_name,html_url}` のみで、`sender` と `repository.id` は未使用（`github.ts:29-38` / `releaseNotificationService.ts` で確認済み）。
- 対応: `notify()` の引数型を上記の最小 DTO へリファクタし、Webhook 由来の `sender` / `repository.id` 依存を外す。これにより polling 層は `/releases` レスポンス（`repository` を含まない）から `repository` の 3 フィールドを config から組み立てるだけで渡せる。
- `repository.name` / `full_name` は `GITHUB_RELEASE_REPO`（`owner/repo`）から導出、`html_url` は `https://github.com/{owner}/{repo}`。`action: "released"` を付与（`notify()` の `released` フィルタを通すため）。

### 環境変数

| 名前 | 必須 | デフォルト | 説明 |
| ---- | ---- | --------- | ---- |
| `GITHUB_RELEASE_REPO` | No | `AtefAndrus/disqord` | 監視対象 `owner/repo`。zod で `^[^/\s]+/[^/\s]+$` 検証。セルフホスターは fork 元（upstream）を指定 |
| `GITHUB_POLL_INTERVAL_SECONDS` | No | `600` | ポーリング間隔（秒）。zod で下限 60。極小値は未認証 60 req/h・二次レート制限に抵触 |
| `GITHUB_TOKEN` | No | (未設定) | 任意。`trim()` 後の空文字は未認証扱い。設定時は `Authorization: Bearer` で認証し、レート 5,000 req/h、304 がレート非消費 |

`GITHUB_WEBHOOK_SECRET` は `envVars.ts` / `.env.example` の双方から削除する。README の環境変数自動生成セクションは `envVars.ts` から再生成されるため、commit 時に自動反映される。

### 起動 / 停止

- `bootstrap()` で `releasePollingService` を組み立て、起動直後に 1 回 poll を実行（**try/catch で握り、失敗しても起動継続**）。
- 直列化タイマー: `setTimeout` 再帰で「前回 poll 完了後に次回を予約」、または `setInterval` + `isPolling` ガード。fetch は `AbortController` で timeout し、`finally` で必ずガード解除 / 次回予約。
- SIGINT/SIGTERM ハンドラでタイマーを停止（`clearTimeout`/`clearInterval`）。既存の `httpServer.stop()` / `client.destroy()` / `db.close()` に追加。

## Tasks

### Phase 1: ポーリング基盤

- [ ] `release_polling_state` マイグレーション（`schema.ts`）+ `ReleasePollingStateRepository` + テスト（seeded / id セット追記 / null）
- [ ] `src/config` に env 追加（repo 正規表現、interval `min(60)`、token `trim`）、`GITHUB_WEBHOOK_SECRET` 削除、`.env.example` 更新
- [ ] `notify()` を最小 DTO 引数へリファクタ + 既存 Webhook 呼び出し側/テストの追従
- [ ] `releasePollingService` 作成（取得 + ヘッダ/AbortController + 全ページ seed + フィルタ + id 差分判定 + 配信結果での id 前進 + リリース単位永続化 + ETag + ステータス分岐 + 例外握り）+ テスト（fetch `mock()`: 200/304/404/401/403/429/5xx/timeout、初回 seed（空含む）、latest 巻き戻り、prerelease 昇格、削除繰り上げ、同一秒複数、全ギルド失敗で id 据え置き、二重通知なし）
- [ ] `src/index.ts` に DI / 起動時 poll（握り）/ 直列化タイマー / shutdown 停止を配線

### Phase 2: Webhook 撤去

- [ ] HMAC 検証を `src/http/hmac.ts` へ切り出し + テスト（admin-endpoints の範を保つ）
- [ ] `src/health.ts` から `/webhook/github` と `handleGitHubWebhook()` を削除、`/health` 温存、`HttpServerOptions` 整理
- [ ] `src/http/webhookHandler.ts` の Webhook 固有部分を削除
- [ ] `tests/unit/webhookHandler.test.ts` を HMAC helper テストへ移設、polling テストを追加
- [ ] `docs/infrastructure-setup.md` を刷新（Tunnel 手順削除 or ポーリング設定へ。admin-endpoints の inbound 依存に注意）

### Phase 3: 仕上げ

- [ ] `bun test && bun typecheck && bun lint` パス
- [ ] ローカル E2E（初回はシードで通知しない → 新リリースで通知 → 同一リリースで二重通知なし → latest 巻き戻りで再通知なし）
- [ ] README 自動生成セクション（環境変数）の反映確認、`.env.example` 反映確認
- [ ] `docs/changes/release-polling/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **配信セマンティクス**: best-effort 配送（個別ギルド失敗は再送しない）+ リリース単位の at-least-once 再試行（全ギルド失敗時のみ）。確実な per-guild 配信が要るなら `release_delivery_state(repo, release_id, guild_id)` を別 change で（Non-Goals 連動）。重複はプロセスクラッシュ（送信成功〜id 永続化の間）時のみ。
- **id セットの肥大化**: `notified_release_ids` をリリース総数規模で保持する。disqord は当面数十〜数百で数 KB。数千規模になったら cutoff / ページング圧縮を別 change で。
- **100 件を超える同時リリース**: 通常 poll は 1 ページ目（最新 100 件）のみ見るため、Bot 長期停止中に 100 件超の正式リリースが積み上がると最古側を取りこぼす。リリース頻度的に許容。必要なら通常 poll もページングする別 change。
- **最新 100 件外の変化は検知しない**: 初回 seed では全ページを記録するが、以後の通常 poll は 1 ページ目（最新 100 件）の ETag のみ見る。よって 101 件目以降にある prerelease の正式昇格や古いリリースの編集は検知しない（「100 件超の同時リリース」とは別の取りこぼし）。disqord のリリース規模では実害なし。厳密に拾うなら通常 poll もページングする別 change。
- **draft の作成/編集で一覧 ETag が変わる**: 200 を引くがフィルタで除外し、id 差分で再通知しないため二重通知はしない（無駄な取得が増えるのみ。ETag 更新で次回 304）。
- **未認証時の 304 もレート消費する**（実測）。1 リポ・10 分間隔なら 6 req/h で問題ないが、将来の複数リポ拡張時は枯渇に注意。`GITHUB_TOKEN` 設定で回避。
- **GitHub のポーリング非推奨スタンス**: 公式は webhook を推奨するが、本件は webhook が構造的に使えないセルフホスト要件のためポーリングが妥当。

## 参照

- GitHub REST Releases API（`List releases` の `200`/`404`、`/releases/latest` の `created_at` 基準・prerelease/draft 除外、`make_latest`）: <https://docs.github.com/en/rest/releases/releases>
- REST レート制限（未認証 60/時、PAT 5,000/時）: <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
- REST ベストプラクティス（条件付きリクエスト・304 免除条件・ポーリング非推奨・直列化・`retry-after`/`x-ratelimit-reset`・指数バックオフ・`User-Agent`）: <https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api>
- ページネーション（`Link` ヘッダ）: <https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api>
- 既存通知ロジック: `src/services/releaseNotificationService.ts`
- 既存型定義: `src/types/github.ts`
- 廃止対象: `src/health.ts:50-148`、`src/http/webhookHandler.ts`
