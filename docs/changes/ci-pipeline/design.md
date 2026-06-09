# CI パイプライン整備 + Actions サプライチェーン対策 + mise SSOT

## Why

本リポジトリには品質ゲートとしての CI が無く、PR/push 時に `bun test` / `typecheck` / `lint` / `lint:md` が自動実行されない。
ローカルの lefthook も pre-commit で README 自動生成しか行わず、テスト・型・lint の回帰はマージ後まで検知できない。
同時に、GitHub Actions を悪用したサプライチェーン攻撃（compromised action による secret 窃取、`pull_request_target` のトークン漏洩、tag 書き換えによる挙動すり替え等）が増えており、CI を足す以上は導入時点で hardening 済みにしておく必要がある。
さらに bun のバージョンが mise.toml / Dockerfile / package.json / CI に分散しており、同期事故の温床になっている。Dependabot PR もエコシステム毎に分かれて煩雑。

本 change では「品質 CI の新設」「自前 workflow の供給網 hardening」「workflow 静的解析（actionlint + zizmor）」「main ブランチ保護で CI をゲート化」「mise.toml を bun バージョンの SSOT 化」「Dependabot を全エコシステム1 PR 集約化」をまとめて行う。

## Goals / Non-Goals

**Goals:**

- PR と main への push で `lint` / `typecheck` / `test` / `lint:md` を自動実行する CI を新設する
- CI で `docker build`（push なし）を行い Dockerfile 破損を検知する
- 自前 workflow を hardening する: 全 action を full-length commit SHA で固定、`permissions` を最小化（既定 `contents: read`、不要 job はトークン剥奪）、`persist-credentials: false`、`concurrency` でキャンセル
- workflow 静的解析を CI に組み込む: actionlint（構文/誤用）+ zizmor（供給網/権限/injection）
- repo 設定で `sha_pinning_required=true` を有効化し action SHA 固定をポリシー強制する
- main ブランチ保護を有効化し CI ジョブを必須ステータスチェックにする（admin bypass 許可。ただし後述の break-glass の含意を明記）
- **mise.toml を bun の minor 線（`1.x`）の SSOT にする**: CI は `jdx/mise-action` で mise から bun を取得、Dockerfile / package.json は CI の drift-check で minor 線の一致を強制
- **Dependabot を全エコシステム1 PR 集約化**: `multi-ecosystem-groups` で bun依存 + docker + github-actions を週次1 PR にまとめる（scheduled version updates の範囲）
- Dockerfile の base image を digest 固定し、action と同じ「tag 書き換え」脅威モデルに揃える
- 既存 `deploy.yml` を最小 hardening（不要なトークン権限の剥奪）

**Non-Goals:**

- CI からレジストリ（GHCR 等）へのイメージ push（デプロイは従来通り Coolify がビルド。CI は破損検知のみ）
- harden-runner（StepSecurity）等の実行時 egress 監視の導入（第三者 action かつ外部 telemetry を伴うため不採用。SHA/digest 固定 + 最小権限 + 静的解析で守る）
- OpenSSF Scorecard ワークフローの追加（今回スコープ外）
- Renovate の採用（mise の bun 自動 bump も可能だが、Mend hosted app への repo write 付与か self-hosted workflow が必要で供給網面が増える。今回の方針と逆行するため不採用。bun の手動 bump で許容）
- mise から Dockerfile/package.json を **自動生成**する generator（今回は drift-check で一致検証に留める。真の単一ソース化は将来 change）
- bun の **patch** レベルの厳密固定（mise `1.3` は 1.3.x の最新を解決。bot 用途では minor 線の固定で十分とする）
- `allowed_actions` を `selected` へ絞る運用（SHA 固定強制で代替）
- 必須レビュアーの設定（solo 運用のため required reviews は付けない）
- カバレッジ閾値の強制

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| CI トリガ | `pull_request` + `push: [main]` | PR で事前検知。`push: [main]` は admin が bypass で直 push したコードを **事後** 検知する保険（merge ゲートではない）。`pull_request_target` は使わない（fork PR にトークン/secret を渡さない） |
| Docker の扱い | `docker build` のみ（push なし） | デプロイは Coolify がビルドするため push は冗長。第三者 build action を増やさず runner 同梱 docker で `docker build .` |
| action のバージョン固定 | full-length commit SHA + バージョンコメント | tag は書き換え可能でサプライチェーン攻撃の主経路。SHA 固定し更新は Dependabot に委ねる |
| SHA 固定の強制範囲 | repo 設定 `sha_pinning_required=true`（`uses:` のみ） | action 参照を強制固定。docker image/base/DL バイナリには効かないため、それらは digest/version pin で別途固定（後述） |
| GITHUB_TOKEN 権限 | workflow 既定 `contents: read`、job 単位で必要分のみ | 最小権限。token 不要 job は剥奪 |
| `persist-credentials` | checkout で `false` | runner に credential を残さない（CI は push しない） |
| workflow 静的解析 | actionlint + zizmor の 2 本立て | actionlint=構文/シェル誤用/式誤り、zizmor=供給網/権限過多/injection。役割が補完的。いずれもローカル実行で外部送信なし（zizmor は `online-audits: false`） |
| actionlint の実行方式 | 作者公式 docker image を **digest 固定** | `rhysd/actionlint` は `action.yml` 無し（`uses:` 不可、確認済み）。wrapper action（第三者）より作者公式イメージの digest pin が供給網が短い。`curl \| bash` は避ける |
| zizmor の実行方式 | 公式 `zizmorcore/zizmor-action` を SHA 固定 + `advanced-security: false` / `online-audits: false` / `version` 固定 | 既定の SARIF アップロード（`security-events: write` 要求）を無効化し `contents: read` のまま CI fail で運用。zizmor CLI の版も固定し findings を再現可能に |
| ブランチ保護 | 必須ステータスチェック有効 + `enforce_admins=false` | CI 通過を merge 必須にしつつ solo 運用で緊急時に admin が直 push できる落とし所。**ただし admin 直 push は未検証コードを main に載せ得る break-glass であり、push トリガ CI は事後検知に過ぎない**（真のゲートにするなら `enforce_admins: true`） |
| 必須チェックの定義方法 | branch protection API の `checks`（`{context, app_id}`） | 旧 `contexts` は緩い。`checks` で GitHub Actions app（`app_id: 15368`）に束縛し、同名 context の他アプリ偽装を防ぐ。job 名がそのまま context（リネームは保護を壊す） |
| **bun の SSOT 粒度** | **`mise.toml` の `[tools] bun` = minor 線（`1.3`）** | dev が既に mise 使用。CI も mise-action で同値参照。patch は mise が 1.3.x 最新を解決（exact patch 固定はしない＝過剰主張を避ける） |
| **CI の bun セットアップ** | `setup-bun` → **`jdx/mise-action`（`install_args: bun`）** | setup-bun は mise.toml を読めない。mise-action なら SSOT 成立。`install_args: bun` で bun のみ入れ、`git-cliff = "latest"` を CI に持ち込まない |
| **Dockerfile / package.json の同期** | **CI drift-check（生成はしない、minor 線で比較）** | mise.toml を正とし、Dockerfile の `oven/bun` タグ major.minor と package.json `engines.bun` の floor major.minor が mise と一致しなければ fail。jq + アンカー grep で構造化パース |
| **Dockerfile base image** | **`oven/bun:1.3-slim@sha256:<digest>` の digest 固定** | action と同じ tag 書き換え脅威に揃える。可読タグ（`1.3-slim`）は drift-check 対象、digest は不変性担保 |
| **Dependabot の docker `oven/bun`** | **ignore せず digest 更新を任せる** | digest 更新はタグ（`1.3-slim`）を変えないため drift-check は緑のまま → 集約 PR に安全に同梱。base のセキュリティパッチを自動追従 |
| **bun minor の更新主体** | **手動（mise.toml を編集）。自動ナッジは Dependabot に依存しない** | Dependabot は mise 非対応。minor タグ上げ（1.3→1.4）を Dependabot が提案する保証はなく（digest のみ更新の可能性）、「赤 PR をナッジに」は **未検証**。bun リリース監視は手動 or 別途 scheduled チェックで補う |
| Dependabot 集約 | `multi-ecosystem-groups`（bun依存 + docker + github-actions を1 PR、scheduled version updates） | 「全部まとめて1 PR」。週次。security updates は別 PR で来得る点は許容 |
| Dependabot エコシステム | bun/github-actions/docker のまま（追加なし） | 既に全て稼働中 |
| commit prefix | `build(deps)` のまま | `cliff.toml`（`^build\(deps` → Dependencies）が既に分類済み |
| deploy.yml | `permissions: {}` を明示追加 | curl で Coolify を叩くだけで GITHUB_TOKEN を使わない。完全剥奪 |
| カバレッジ | gate にしない | 閾値強制は別 change |

## Design

### 現状と前提

- デプロイ自動化は既存。`.github/workflows/deploy.yml` が `release: published` で Coolify webhook を叩く。無いのは品質ゲートだけ。
- Dependabot は `bun` / `github-actions` / `docker` の 3 エコシステムを設定済みで稼働中。github-actions の PR が出ないのは `deploy.yml` が第三者 `uses:` を使わず `run: curl` のみのため、docker の PR が出ないのは `oven/bun:1.3-slim` に対し bun の新タグが未リリースのため。
- 既存セキュリティ設定: 公開リポジトリ、Actions `default_workflow_permissions=read`、`can_approve_pull_request_reviews=false`、secret scanning + push protection 有効、Dependabot security updates 有効。
- 残る穴: ① Actions `allowed_actions=all` ② `sha_pinning_required=false` ③ main にブランチ保護が無い。
- bun バージョンが `mise.toml`（`bun = "1.3"`）/ `Dockerfile`（`FROM oven/bun:1.3-slim`）/ `package.json`（`engines.bun = ">=1.3"`）に分散。
- テスト規模: `tests/` 16 ファイル、`src/` 33 ファイル。`bun test` で完結（外部サービス不要、SQLite はインメモリ）。

### 技術メモ

- Dependabot は `multi-ecosystem-groups`（2025-07 GA）で複数エコシステムを 1 PR に集約できる。Renovate 乗り換えは不要。
- `oven-sh/setup-bun` は `mise.toml` を読めない（`bun-version-file` は `package.json` / `.bun-version` / `.tool-versions` のみ）。mise SSOT にするなら `jdx/mise-action` を使う。
- `jdx/mise-action` は `install_args` で対象ツールを限定できる（`install_args: bun` で bun のみ）。
- `zizmorcore/zizmor-action` の既定は `advanced-security: true`（SARIF を GHAS にアップロードするため `security-events: write` を要求）/ `online-audits: true` / `version: latest`。CI fail のみで運用するには入力で無効化する。
- Dependabot は mise 非対応。`mise.toml` の `bun` バージョンは手動 bump。
- `rhysd/actionlint` は `action.yml` を持たず `uses:` 不可（docker image / バイナリ実行）。`zizmorcore/zizmor-action` は `action.yml` あり（SHA 固定可）。
- `sha_pinning_required` は `uses:` の action 参照にのみ効く。docker イメージ / Dockerfile base / DL バイナリ / mise tool には効かない。

### 変更対象ファイル

**新規:**

- `.github/workflows/ci.yml` — 品質 CI（bun version drift-check 含む）+ workflow 静的解析 + docker build

**修正:**

- `.github/dependabot.yml` — `multi-ecosystem-groups` で1 PR 集約
- `.github/workflows/deploy.yml` — `permissions: {}` を追加
- `Dockerfile` — base image を `oven/bun:1.3-slim@sha256:<digest>` に digest 固定。加えて `bun install --production` に `--ignore-scripts` を追加（未リリースの `prepare: lefthook install` が production install で実行され exit 127 になる破損を CI 実装中の `docker build` 検証で検出・修正）
- `package.json` の `engines.bun` — 値は据え置きだが drift-check の対象として mise の minor 線と一致を維持

**repo 設定（git 管理外。実装時に `gh api`）:**

- `actions/permissions` の `sha_pinning_required=true`
- `branches/main/protection` の有効化

### CI workflow スケルトン（`.github/workflows/ci.yml`）

> action の SHA・zizmor/mise の tool 版・actionlint の docker digest は固定値（actionlint digest は `docker.io/rhysd/actionlint:1.7.12` の **multi-arch OCI image index**、amd64/arm64 両対応）。Dockerfile base image の digest は `docker buildx imagetools inspect oven/bun:1.3-slim` で解決済み（`sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04` = multi-arch index）。

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false
      # bun の minor 線が mise.toml(SSOT) / Dockerfile / package.json で一致するか検証（bun 不要・純テキスト）
      - name: bun version drift check (mise SSOT)
        run: |
          mise_v=$(sed -nE 's/^bun[[:space:]]*=[[:space:]]*"([0-9]+\.[0-9]+).*/\1/p' mise.toml)
          docker_v=$(sed -nE 's#^FROM oven/bun:([0-9]+\.[0-9]+).*#\1#p' Dockerfile | head -n1)
          eng_v=$(jq -r '.engines.bun' package.json | sed -E 's/[^0-9]*([0-9]+\.[0-9]+).*/\1/')
          echo "mise=$mise_v dockerfile=$docker_v engines=$eng_v"
          if [ -z "$mise_v" ] || [ "$mise_v" != "$docker_v" ] || [ "$mise_v" != "$eng_v" ]; then
            echo "::error::bun version drift (mise=$mise_v dockerfile=$docker_v engines=$eng_v)"; exit 1
          fi
      # mise.toml を SSOT に bun のみ取得（setup-bun は使わない。git-cliff は入れない）
      - uses: jdx/mise-action@dba19683ed58901619b14f395a24841710cb4925 # v4.1.0
        with:
          version: "2026.6.1"  # mise 本体を固定（既定 latest=可変。Dependabot は更新しないため手動 bump）
          install_args: bun     # bun のみ。git-cliff は CI に入れない
      - run: bun install --frozen-lockfile
      - run: bun run lint        # biome check .
      - run: bun run typecheck   # tsc --noEmit
      - run: bun test            # bun built-in test runner
      - run: bun run lint:md     # markdownlint-cli2

  actions-security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false
      - name: actionlint
        run: |
          docker run --rm -v "$PWD:/repo" --workdir /repo \
            docker.io/rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 -color
      - uses: zizmorcore/zizmor-action@5f14fd08f7cf1cb1609c1e344975f152c7ee938d # v0.5.6
        with:
          version: "1.25.2"          # zizmor CLI 版を固定（既定 latest=可変）
          advanced-security: false   # SARIF/GHAS アップロード無効化（security-events: write 昇格を回避）
          online-audits: false       # 外部 API 参照を無効化（offline 運用）

  docker-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false
      - run: docker build -t disqord:ci .
```

設計メモ:

- drift-check は bun 不要なので checkout 直後に置き、専用 job を増やさず `quality` の 1 ステップにする（必須 context を増やさない）。`jq` は ubuntu-latest に既定で入っている。
- `bun test` と `bun run typecheck` を別ステップに分け、型エラーとテスト失敗を切り分ける。
- fork からの `pull_request` は **未信頼コードを実行する**（`bun run lint`/`typecheck`/`test` は PR 制御下のコードを動かす）。緩和の主体は secret 非注入 + read-only token + `persist-credentials: false`。bun が依存の lifecycle script を既定実行しない（`trustedDependencies` 許可制）点は二次的な低減に過ぎない。
- zizmor は `advanced-security: false` 時 findings で step を非ゼロ終了し CI を fail する想定（実装時に確認）。自前 workflow は SHA 固定・`contents: read`・`persist-credentials: false`・式 injection 無しで pass する想定。

### mise SSOT の成立条件

- **SSOT の粒度**: `mise.toml` の `bun = "1.3"` は **minor 線**（1.3.x）の権威。patch は mise が最新を解決。exact patch までは固定しない。
- **CI**: `jdx/mise-action`（`install_args: bun`）が mise.toml の bun を解決してインストール。CI と dev が同じ minor 線を見る。
- **Dockerfile / package.json**: drift-check で `oven/bun:<major.minor>` と `engines.bun` の floor major.minor が mise と一致することを強制。
- **base image の不変性**: Dockerfile は `oven/bun:1.3-slim@sha256:<digest>`。digest 更新は **タグ（`1.3-slim`）を変えない**ため drift-check は緑のまま通り、集約 PR に安全に同梱できる（base のセキュリティパッチを自動追従）。
- **更新フロー（bun minor を上げる）**: 手動。`mise.toml` を編集 → `Dockerfile` の tag/digest と `package.json` を同 PR で揃える → drift-check 緑で merge。Dependabot が minor タグ上げ（1.3→1.4）を提案するかは保証されない（digest のみ更新の可能性）ため、minor の検知は Dependabot に依存せず bun リリース監視（または別途 scheduled チェック）で補う。

### Dependabot 改善（`.github/dependabot.yml`）

全エコシステムを scheduled version updates として1 PR に集約する。`oven/bun` は ignore せず digest/patch を追従させる（digest 更新はタグを変えず drift-check 緑のまま）。

```yaml
version: 2

multi-ecosystem-groups:
  all-dependencies:
    schedule:
      interval: "weekly"
      day: "monday"
    open-pull-requests-limit: 5

updates:
  - package-ecosystem: "bun"
    directory: "/"
    patterns: ["*"]
    multi-ecosystem-group: "all-dependencies"
    cooldown:
      default-days: 7
  - package-ecosystem: "github-actions"
    directory: "/"
    patterns: ["*"]
    multi-ecosystem-group: "all-dependencies"
    cooldown:
      default-days: 7
  - package-ecosystem: "docker"
    directory: "/"
    patterns: ["*"]
    multi-ecosystem-group: "all-dependencies"
    cooldown:
      default-days: 7
```

- ci.yml に実 action（checkout / mise-action / zizmor-action）が入ることで github-actions エコシステムが SHA 追従の bump を出すようになり、`all-dependencies` グループに合流する。Dependabot は SHA 固定 + バージョンコメント形式を維持するため `sha_pinning_required` と矛盾しない。
- 各 update に `cooldown: default-days: 7` を設定する。zizmor の `dependabot-cooldown` 監査（medium）が cooldown 不在を fail にするため必須（実 CI で検出済み）。リリース直後の compromised version を即取り込まないための供給網対策で、本 change の方針とも整合する。
- `open-pull-requests-limit` は multi-ecosystem-group 配下の update には置けず、グループ側に置く（Dependabot の config 検証チェックが update 側指定を invalid として fail する。実検証済み）。
- `multi-ecosystem-groups` で `bun` エコシステムが参加可能かは公式例（npm/docker/actions）に明示が無いため、実装時に PR が実際に集約されるか確認する（参加不可なら bun だけ別グループにフォールバック）。
- 通常の `oven/bun` digest 更新はタグを変えないため drift-check は緑で、集約 PR に安全に同梱される。drift-check が赤になるのは「mise を上げずに Dockerfile の minor だけ変わった」場合に限られ、Dependabot の通常運用では起きにくい（万一その経路が煩雑なら docker を別グループに分離）。
- **Dependabot が更新しない pin がある**: actionlint の docker image（`run:` 文字列内）、zizmor CLI の `version` 入力、mise の `version` 入力は Dependabot の管理外。これらは手動更新（下記 Tasks）。Dependabot が追うのは `uses:` action / Dockerfile の base image / bun パッケージのみ。

### deploy.yml の hardening

`deploy.yml` は curl で Coolify を叩くだけで GITHUB_TOKEN を使わない。`permissions: {}` でトークンを完全剥奪する（curl ステップは現状維持）。

```yaml
name: Deploy to Coolify

on:
  release:
    types: [published]

permissions: {}

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      # 既存の curl ステップそのまま
```

### repo 設定の適用（実装時に `gh api`）

SHA 固定の強制（`uses:` のみに効く点に留意）:

```bash
gh api -X PUT repos/AtefAndrus/disqord/actions/permissions \
  --input - <<'JSON'
{"enabled": true, "allowed_actions": "all", "sha_pinning_required": true}
JSON
```

main ブランチ保護（必須チェック + admin bypass 可、`checks` で GitHub Actions app に束縛）:

```bash
gh api -X PUT repos/AtefAndrus/disqord/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [],
    "checks": [
      {"context": "quality", "app_id": 15368},
      {"context": "actions-security", "app_id": 15368},
      {"context": "docker-build", "app_id": 15368}
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

- `app_id: 15368` は GitHub Actions の app id（一般値）だが brittle。CI 初回 run 後に実値を確認してから設定する: `gh api repos/AtefAndrus/disqord/commits/main/check-runs --jq '.check_runs[]|select(.name=="quality")|.app.id'`。確信が無ければ `app_id` を省略し provider 自動選択に委ねる（`contexts: []` は必須スキーマ回避のため残す）。
- `required_linear_history` は今回の Goal 外かつ squash/rebase merge 設定に依存するため入れない（必要なら repo の merge 設定を確認のうえ別途）。
- `strict: true`（branch 最新化必須）は Dependabot PR が積むと再 push が増えるが、1 PR 集約で PR 数自体を抑えるため両立しやすい。煩雑なら `false` に緩める。
- 必須チェックの context は **CI が一度実行され GitHub に登録された後** でないと設定に現れない。`ci.yml` を main にマージ → 1 回 run させてから protection を適用する。

### 適用順序

1. `ci.yml` を追加（PR ベースで作成し、自分自身の CI が緑になることを確認）。Dockerfile を digest 固定し、drift-check が既存値（mise=Dockerfile=engines=1.3）で緑になることを確認
2. `dependabot.yml` を `multi-ecosystem-groups` 化、`deploy.yml` に `permissions: {}` を同 PR か別 PR で
3. PR を main にマージ → CI が main 上で 1 回 run し status context が登録される
4. `sha_pinning_required=true` を適用（自前 workflow は SHA 固定済みなので影響なし）
5. ブランチ保護を適用（context 名が登録済みであることを確認してから `checks` で設定）
6. 動作確認: 故意に lint/型エラーや bun 版不一致を含む PR を立て merge がブロックされることを確認 → 破棄

## Tasks

- [x] `.github/workflows/ci.yml` を新規作成（quality（drift-check ステップ含む）/ actions-security / docker-build、SHA 固定・最小権限・persist-credentials:false・concurrency）
- [x] CI の bun を `jdx/mise-action`（`install_args: bun`）で取得（setup-bun は使わない、git-cliff を CI に入れない）。mise 本体は v2026.6.1 に固定（実装時の latest）
- [x] zizmor-action に `advanced-security: false` / `online-audits: false` / `version` 固定を設定。findings で CI が fail する挙動は実証済み（dependabot.yml の cooldown 不在を medium 3 件として検出し exit 13 で fail → cooldown 追加で解消）
- [x] actionlint docker image の digest を固定（`sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667` = `docker.io/rhysd/actionlint:1.7.12` の multi-arch OCI image index。`docker run` がこの index を解決し amd64/arm64 どちらの runner でも動く）
- [x] Dockerfile base を `oven/bun:1.3-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04` に digest 固定（multi-arch index digest。`docker build` 成功確認済み。副産物として `--ignore-scripts` 追加で prepare スクリプト破損を修正）
- [x] bun version drift-check を実 mise.toml / Dockerfile / package.json で検証（jq + アンカー grep、minor 線比較、空値ガード。ローカル実行で mise=dockerfile=engines=1.3 の緑を確認。Dockerfile 側は `head -n1` で先頭 FROM のみ参照）
- [x] `[settings] env_file = ".env"` 不在時の挙動: mise v2026.6.0 では `.env` 欠落は警告なく無視され exit 0。`install_args: bun` の install は env を要求しないため、空 `.env` 作成ガードは不要
- [ ] CI を PR で走らせ、quality / actions-security / docker-build が全て緑になることを確認
- [x] `.github/dependabot.yml` を `multi-ecosystem-groups` 化（`oven/bun` は ignore しない）
- [ ] bun エコシステムが multi-ecosystem-group に参加できるか実 PR で確認（不可なら別グループにフォールバック）
- [x] `.github/workflows/deploy.yml` に `permissions: {}` を追加
- [ ] PR を main にマージ → CI を main 上で 1 回実行し status context を登録
- [ ] `gh api` で `sha_pinning_required=true` を適用
- [ ] branch protection 適用前に `gh api repos/AtefAndrus/disqord/commits/main/check-runs` で各 job の `app.id` を実値確認（`app_id` を確定 or 省略）
- [ ] `gh api` で main ブランチ保護を `required_status_checks.checks`（`contexts: []` 併記）で適用（context 名一致を確認）
- [ ] 手動更新対象（Dependabot 管理外）を運用メモ化し定期 bump: actionlint image digest / zizmor CLI `version` / mise `version`
- [ ] 故意にエラー/版不一致を含む PR で merge ブロックを確認し破棄
- [ ] ドキュメント編集後は `bun run format:md` を流す運用を徹底（CI は `lint:md` のまま auto-fix はしない）
- [ ] （任意）README に CI バッジ追加
- [ ] docs/changes/ci-pipeline/ 削除（リリース完了時）

## Open Questions / Risks

- **「赤 PR をナッジに」は未検証**: bun minor 上げを Dependabot が minor タグ bump として提案するか（=drift-check を赤にしてナッジになるか）は Dependabot の保証された挙動ではない。digest のみ更新でタグ据え置きの可能性があり、その場合ナッジは発生しない。bun minor の検知は手動監視 or 別途 scheduled チェックを前提に置く。fixture/実 PR で挙動を確認するまで設計の前提にしない。
- **base image digest 追従の検証**: digest 固定した `oven/bun` を Dependabot が digest 更新できるか（tag+digest 併記時の挙動）を実装時に確認。追従しないなら手動 digest 更新 or digest 固定を外して理由を明記。
- **Dependabot 管理外の pin が stale 化する**: actionlint image digest（`run:` 文字列内）・zizmor CLI `version`・mise `version` は Dependabot が更新しない。手動 bump を怠ると古い tool に固定され続ける。運用メモ + 定期確認で補う。
- **mise-action と `env_file = ".env"`**: mise v2026.6.0 では `.env` 欠落時も警告なく exit 0 で正常終了するため、空 `.env` 作成ガードは不要（`install_args: bun` の install は env を要求しない）。
- **multi-ecosystem-groups の bun 参加可否**: 公式例は npm/docker/actions。bun エコシステムが同グループに合流できるか未確認。不可なら bun を単独グループにフォールバック（「完全1 PR」が崩れる）。
- **Dependabot security updates は別 PR で来得る**: 「全部1 PR」は scheduled version updates の範囲。脆弱性駆動の security update は grouping/cadence に従わず単独 PR で来る場合がある。
- **`sha_pinning_required` の適用範囲**: `uses:` の action 参照のみ強制。actionlint の docker image / Dockerfile base / DL バイナリ / mise tool は対象外で、digest/version pin の自前規律に依存する。
- **enforce_admins=false の含意**: admin 直 push は未検証コードを main に載せ得る break-glass。`push: [main]` トリガ CI は事後検知に過ぎず merge ゲートではない。厳格化するなら `enforce_admins: true`。
- **SSOT は minor 線まで**: bun の patch は mise が解決するため厳密固定されない。exact patch まで固定したい場合は mise を patch 指定にし digest も同期する別設計が必要。
- **drift-check の脆弱性**: jq + アンカー grep に堅牢化したが、(a) mise 側は `[tools]` テーブル外の `bun =` を誤って拾い得る（table スコープ未限定）、(b) Dockerfile 側は `FROM --platform=...`・`docker.io/oven/bun`・ARG 化等の変種に対応しない。canonical 形の維持を前提に固定するか、将来 generator 化（真の単一ソース）する。
- **actionlint の実行方式**: docker digest 固定を第一候補とするが `docker pull` で起動が遅い。バイナリ download（版 pin + checksum）への切替も可。wrapper action は第三者増加のため非推奨。
- **zizmor の online audit**: `online-audits: false` で外部送信を断つが既知悪性 action 照合等の検出力が下がる。必要なら token を絞って有効化。
- **git-cliff `latest`**: `mise.toml` の `"github:orhun/git-cliff" = "latest"` は可変。CI は `install_args: bun` で取り込まないため CI 上の懸念は解消するが、release フロー（ローカル/手動）では可変のまま。版 pin が望ましい（別 change の quick-win）。
- **Coolify ビルドとの乖離**: CI の `docker build` は Dockerfile 破損を捕まえるが Coolify 側の build 引数/コンテキスト差異までは保証しない。
- **branch protection API vs rulesets（将来検討）**: 本 change は旧 branch-protection API（`required_status_checks.checks`）を使う。これは 2026-06 時点で非推奨ではない（`contexts` フィールドのみ段階的廃止予定で、本 change は既に `checks` を使用）。ただし新規設定は **repository rulesets** が推奨されつつある（複数ルールの同時適用・bypass actor 設定・audit log 統合が可能、`app_id` 相当は rulesets では `integration_id`）。solo 運用の公開リポジトリでは今すぐ移行する実益は薄いため旧 API で着手し、必要が出たら rulesets へ移行する。
- **GitHub 2026 Actions セキュリティ機能（GA 後に再評価）**: 2026-03 発表のロードマップに以下が含まれる。いずれも本 change の方針の上位互換になり得るため、GA 後に採用を検討する。①**Workflow lockfile**（`dependencies:` で workflow 依存を SHA+hash ロック＝`sha_pinning_required` の上位互換）②**Scoped secrets**（secret を workflow/branch/repo 粒度にバインド＝`COOLIFY_WEBHOOK` 等の scope 絞り）③**Native egress firewall**（hosted runner の L7 egress 制御＝不採用とした harden-runner の代替候補）④**Immutable actions publishing**（tag 不変化）。

## 参照

- 既存 workflow: `.github/workflows/deploy.yml`（release → Coolify webhook）
- 既存 Dependabot: `.github/dependabot.yml`（bun/github-actions/docker、稼働中）
- 参照バージョン（2026-06-05 時点）:
  - actions/checkout v6.0.3 (`df4cb1c069e1874edd31b4311f1884172cec0e10`)
  - jdx/mise-action v4.1.0 (`dba19683ed58901619b14f395a24841710cb4925`) / mise 本体 v2026.6.1（2026-06-10 再検証時の latest）
  - zizmorcore/zizmor-action v0.5.6 (`5f14fd08f7cf1cb1609c1e344975f152c7ee938d`) / zizmor CLI v1.25.2
  - rhysd/actionlint v1.7.12 (`914e7df21a07ef503a81201c76d2b11c789d3fca`、docker digest `sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667` = `docker.io/rhysd/actionlint:1.7.12` の multi-arch OCI image index、amd64/arm64 両対応)
  - GitHub Actions app_id: `15368`（実値は CI 初回 run 後に確認）
  - oven/bun:1.3-slim digest: `sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04`（multi-arch index、2026-06-10 解決）
- Dependabot multi-ecosystem: <https://docs.github.com/en/code-security/dependabot/working-with-dependabot/configuring-multi-ecosystem-updates>
- Dependabot multi-ecosystem GA 告知: <https://github.blog/changelog/2025-07-01-single-pull-request-for-dependabot-multi-ecosystem-support/>
- Branch protection API: <https://docs.github.com/en/rest/branches/branch-protection>
- Renovate mise manager（不採用だが参考）: <https://docs.renovatebot.com/modules/manager/mise/>
- zizmor: <https://github.com/zizmorcore/zizmor>
- actionlint: <https://github.com/rhysd/actionlint>
- GitHub Actions security hardening: <https://docs.github.com/actions/security-guides/security-hardening-for-github-actions>
- tj-actions/changed-files サプライチェーン事件（CVE-2025-30066、2025-03。tag 書き換えで全タグが汚染され secret を CI ログに流出＝SHA 固定が唯一の有効策だった実証例）: <https://www.cve.org/CVERecord?id=CVE-2025-30066>
- GitHub Actions セキュリティ 2026 ロードマップ（Workflow lockfile / Scoped secrets / Native egress firewall / Immutable actions）: <https://github.blog/news-insights/product-news/>
