---
title: "Renovate 移行"
status: planned
priority: medium
summary: "Dependabot を Renovate (Mend App) に置き換え、手動ピン更新を自動化"
---

# Renovate 移行

## Why

Dependabot のマルチエコシステムグループ PR には `@dependabot rebase` / `@dependabot recreate` が効かない既知バグがあり（[dependabot-core#12903](https://github.com/dependabot/dependabot-core/issues/12903)、2026-07 時点で Open）、PR が BEHIND になると、次回 weekly 実行を待つか PR ブランチへ手動で main をマージするしかない運用を強いられている。
また、Dependabot は action の `with:` 入力値（zizmor CLI 版、mise 本体版）や `run:` 内の Docker イメージ digest を走査しないため、CLAUDE.md に「手動ピン」として 3 箇所の定期 bump 運用が残っている。
Renovate は PR 本文の rebase チェックボックスや rebase label で任意タイミングの rebase を指示でき（[Updating and rebasing branches](https://docs.renovatebot.com/updating-rebasing/)）、customManagers（regex）でビルトイン非対応の箇所も更新対象にできる（[Custom Manager Support using Regex](https://docs.renovatebot.com/modules/manager/regex/)）ため、バグ回避と手動ピン削減の両方が見込める。

## 依存 / 関連 change

- 関連: [ci-pipeline](../ci-pipeline/design.md) — 手動ピン運用と bun drift-check はこの change で導入されたもの。drift-check は本 change 後も安全網として維持する。
  なお ci-pipeline の Non-Goals では「Mend hosted app への repo write 付与」を理由に Renovate を不採用としており、本 change はその判断を明示的に置き換える（理由は Decisions の「供給網リスクの受容」参照）

## Goals / Non-Goals

**Goals:**

- Dependabot（`.github/dependabot.yml`）を Renovate（Mend Renovate App）に置き換える
- 現行運用（週次月曜・全エコシステム 1 本のグループ PR・version 更新の 7 日クールダウン）を Renovate 設定で再現する（pin / digest 更新はクールダウン対象外とする。意図した差分、Decisions「クールダウン」参照）
- GitHub Actions の SHA ピン + バージョンコメント維持を Renovate に任せる（`helpers:pinGitHubActionDigests`）
- 手動ピン 3 箇所を自動更新対象にする。zizmor-action の `version` は標準の `github-actions` マネージャが `with:` 入力ごと対応済みのため Phase 1 で解消し（[Updating `with:` values](https://docs.renovatebot.com/modules/manager/github-actions/#updating-with-values-in-commonly-used-community-maintained-github-actions)）、actionlint イメージ digest / mise-action `version` の 2 箇所を Phase 2 の customManagers で対応する

**Non-Goals:**

- automerge の導入（サプライチェーンリスク増幅のため当面手動マージを維持。[Automerge configuration](https://docs.renovatebot.com/key-concepts/automerge/)）
- self-hosted Renovate（PAT 管理と workflow 保守が個人運用に見合わない。[Running Renovate](https://docs.renovatebot.com/getting-started/running/)）
- lockFileMaintenance の有効化（bun.lock を特定できない不具合 [renovate#38692](https://github.com/renovatebot/renovate/issues/38692) は 2025-10 に修正済みだが本リポジトリでは未検証。現行 Dependabot 運用に相当機能がなく、まずは 1 PR 運用の再現を優先するため当面無効。標準マネージャの安定稼働後に有効化を検討）
- CI ワークフロー自体の再設計（drift-check・zizmor・actionlint の構成は現状維持）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 実行基盤 | Mend Renovate App（無料ホステッド） | 個人リポジトリでコスト・運用負荷ゼロ。activated 状態で約 4 時間ごと実行（[Mend-hosted apps overview](https://docs.renovatebot.com/mend-hosted/overview/)、[Job scheduling](https://docs.renovatebot.com/mend-hosted/job-scheduling/)） |
| 供給網リスクの受容 | ci-pipeline で不採用とした「Mend App への repo write 付与」を受容する | Dependabot のグループ PR バグが 1 年近く未解決で、手動ピン 3 箇所の負担も恒常化したため再評価。App は Code / Workflows を含む read-write を要求する（[Security and permissions](https://docs.renovatebot.com/security-and-permissions/)）。脅威別に整理すると: ① 悪意ある上流リリースの混入 → automerge を使わずマージ前に workflow 差分を含む PR 内容を人間が確認することで緩和。② App token 侵害 → selected repositories でのインストールにより影響範囲を本リポジトリに限定。ただし Contents write があれば PR の merge API を叩けるため、「マージは常に人間」は設定上強制されていない。`required_approving_review_count: 1` を課せば bot PR への所有者承認を必須化でき token 単独のマージは防げるが、solo 運用では自分の PR を自己承認できず全ての通常 PR が admin bypass 頼みになるため採用しない。Workflows write と併せた不正マージは**残余リスクとして明示的に受容**する。Mend は ISO 27001 / SOC 2 取得済みでコードは実行後保持されない。代替の self-hosted は fine-grained PAT や自前 GitHub App token でも運用できる（[GitHub platform authentication](https://docs.renovatebot.com/modules/platform/github/)）が、credential とワークフローの保守が増え、1 人運用では App 1 つに絞る方が管理面を小さくできると判断 |
| ベースプリセット | `config:best-practices` | `config:recommended` + `docker:pinDigests` + `helpers:pinGitHubActionDigests` + `:configMigration` + `:pinDevDependencies` + `abandonments:recommended` + `security:minimumReleaseAgeNpm` + `:maintainLockFilesWeekly` の 8 プリセット（[Config presets](https://docs.renovatebot.com/presets-config/#configbest-practices)）。SHA ピン運用と方針が一致。`:maintainLockFilesWeekly` は Non-Goals の通り `lockFileMaintenance.enabled: false` で打ち消し、npm の 3 日制限はより厳しい 7 日設定で上書きする |
| グルーピング | `group:all` プリセット | 現行 Dependabot の multi-ecosystem-group と同じ 1 本運用を維持。`separateMajorMinor` は既定 `true` で packageRules のグループ指定より優先されるため、`groupName` 指定だけでは major が別 PR になる。`group:all` は `separateMajorMinor: false` を含む（[Group presets](https://docs.renovatebot.com/presets-group/#groupall)、[separateMajorMinor](https://docs.renovatebot.com/configuration-options/#separatemajorminor)） |
| スケジュール | `schedule: ["* 0-8 * * 1"]`（cron 構文、月曜 0-8 時台）+ `timezone: "Asia/Tokyo"`（activated 後に追加） | 現行の weekly monday を再現（[Scheduling](https://docs.renovatebot.com/key-concepts/scheduling/)）。`before 9am on monday` のような Later 構文は非推奨で、新規設定は cron 構文が推奨（[schedule](https://docs.renovatebot.com/configuration-options/#schedule)）。onboarding PR マージ直後は daily 実行（onboarded 状態）のため、狭い schedule を最初から入れると初回 pin 系 PR が窓を外す。初回 PR マージで activated（4 時間ごと）になってから schedule を追加する（[Job scheduling](https://docs.renovatebot.com/mend-hosted/job-scheduling/)） |
| schedule 外の既存 PR 更新 | `updateNotScheduled` は既定（`true`）のまま | 既存グループ PR への新バージョン取り込みや rebase は schedule 外でも行われる。これは Dependabot の「次回 weekly まで放置」と異なる挙動だが、BEHIND 滞留の解消こそが本移行の動機なので意図した差分として受け入れる（[updateNotScheduled](https://docs.renovatebot.com/configuration-options/#updatenotscheduled)） |
| クールダウン | `minimumReleaseAge: "7 days"`（major / minor / patch のみ） | 現行 `cooldown.default-days: 7` の再現。`internalChecksFilter` の既定 `strict` により、`minimumReleaseAge` を満たさない更新はブランチ自体が作られず PR も出ない。`prCreation` の追加設定は不要（かつては推奨されていたが Renovate 42.19.9 以降のドキュメントで撤回済み。[Minimum Release Age](https://docs.renovatebot.com/key-concepts/minimum-release-age/)）。pin / digest 更新はリリース年齢の概念が薄いため packageRules で対象を version 更新に限定する |
| customManagers の導入時期 | Phase 2（標準マネージャの安定稼働後） | regex 設定はミスしてもエラーにならず 0 件マッチになるだけでデバッグしにくいため、段階導入でリスクを分離 |
| zizmor-action `version` の扱い | 標準の `github-actions` マネージャに任せ、action 本体と CLI を専用グループ（`minimumGroupSize: 2`）にして `group:all` から分離する | zizmor-action の `version` 入力は community-maintained action の `with:` 対応リストに含まれ、依存 `ghcr.io/zizmorcore/zizmor` として標準更新される（[Updating `with:` values](https://docs.renovatebot.com/modules/manager/github-actions/#updating-with-values-in-commonly-used-community-maintained-github-actions)）。customManagers で `pypi` の zizmor を重ねると同じ行を二重抽出して更新が競合するため対象にしない。zizmor-action は新しい CLI コンテナに即応しないため、Renovate 本家の設定に倣い action と CLI が揃った時だけ更新する専用グループとする（[Renovate 自身の renovate.json](https://github.com/renovatebot/renovate/blob/main/renovate.json) の zizmor ルール、[minimumGroupSize](https://docs.renovatebot.com/configuration-options/#minimumgroupsize)）。zizmor だけ別 PR になるのは意図した差分。また GHCR は releaseTimestamp 非対応（[renovate#39064](https://github.com/renovatebot/renovate/issues/39064)）で、既定の `timestamp-required` では 7 日クールダウンが永久 pending になるため、このグループは `minimumReleaseAge: null` でクールダウン対象外にする |
| mise 版の regex 方式 | 対象行に `# renovate: datasource=... depName=...` コメントを付け、汎用 regex マネージャで拾う | 公式ドキュメント記載のパターン。`uses:` 行をアンカーにする方式より CI 構造変更に強い（[Custom Manager Support using Regex](https://docs.renovatebot.com/modules/manager/regex/)）。mise-action の `version` 入力は標準対応リストに含まれないため customManagers が必要 |
| `engines.bun` の扱い | packageRules で明示的に無効化する | bun マネージャは npm の `package.json` extractor を再利用しており（[bun/extract.ts](https://github.com/renovatebot/renovate/blob/main/lib/modules/manager/bun/extract.ts) が npm の extract を呼ぶ）、npm 側は `engines` を depType として扱うため（[npm manager dependency types](https://docs.renovatebot.com/modules/manager/npm/#dependency-types)）、`engines.bun` も検出されうる。値の形状（`>=1.3`）が range で自動更新の挙動が不確実なため対象外にし、bun minor 更新 PR のマージ時に手動同期する（drift-check が不整合を fail させるので事故にはならない）。実際の抽出結果と無効化ルールの一致は onboarding 後にジョブログで確認する（Tasks 参照） |
| 脆弱性対応 | GitHub の Dependabot **alerts** は維持し、Dependabot **security updates**（自動 PR）はリポジトリ設定で無効化。Renovate の `vulnerabilityAlerts` は既定（有効）のまま | alerts（検知）と security updates（自動 PR）は別機能で、`dependabot.yml` を削除しても後者のリポジトリ設定は残る。両方有効だと脆弱性修正 PR が重複する。Renovate の脆弱性 PR は schedule / group / minimumReleaseAge を適用せず即時の個別 PR になる点も現行と異なるが、修正は早いほど良いので受け入れる（[vulnerabilityAlerts](https://docs.renovatebot.com/configuration-options/#vulnerabilityalerts)） |
| Dependabot 廃止タイミング | `dependabot.yml` の削除を onboarding PR に含め、Dependabot security updates の無効化はマージ直前に行う | onboarding PR マージまで Renovate は更新 PR を作らないため、マージと同時に Dependabot version updates を止めれば重複期間が生じない（[Installing and onboarding](https://docs.renovatebot.com/getting-started/installing-onboarding/)）。security updates もマージ直前に無効化しておかないと、Renovate `vulnerabilityAlerts` との脆弱性 PR 重複期間が残る。ロールバックは `dependabot.yml` の復元 + security updates の再有効化 + App のアンインストール |
| コミットメッセージ形式 | `semanticCommits: "enabled"` + extends `":semanticCommitTypeAll(build)"` | 本リポジトリのコミット規約は `[type]` 形式で conventional commits ではないため、`semanticCommits` の既定 `auto` では接頭辞なしになりうる。また `config:recommended` は `:semanticPrefixFixDepsChoreOthers` を含み、packageRules で依存ごとに `fix(deps)` / `chore(deps)` を割り当てるため、トップレベルの `semanticCommitType` 指定では上書きされて効かない。全 PR の type を変えるには公式案内どおり `:semanticCommitTypeAll(build)` を extends の末尾に置く（[Changing the semantic commit type](https://docs.renovatebot.com/semantic-commits/#changing-the-semantic-commit-type)）。scope は既定が `deps` のため、`cliff.toml` の `^build\(deps` → Dependencies 分類と一致する |

## Design

### 変更対象ファイル

- 新規: `renovate.json5` — Renovate 設定（リポジトリルート）
- 削除: `.github/dependabot.yml` — onboarding PR に含める
- 修正: `.github/workflows/ci.yml` — Phase 2 で mise-action の `version:` 行に renovate コメントアノテーション追加
- 修正: `CLAUDE.md` — Notes の手動ピン運用メモを更新
- 修正: `.claude/skills/dependabot-pr/` — Renovate 運用向けに書き換え（または `renovate-pr` にリネーム）
- 修正: `cliff.toml` — `^build\(deps` 分類ルール直前の `# Dependabot` コメントを `# Dependency updates (Dependabot / Renovate)` 等に更新（分類ルール自体は変更不要）
- リポジトリ設定: Dependabot security updates を無効化（alerts は維持）

### Phase 1: 標準マネージャでの移行

`renovate.json5` 案（schedule の 1 行だけは activated 後に追加する。Decisions「スケジュール」参照）:

```json5
{
  $schema: "https://docs.renovatebot.com/renovate-schema.json",
  extends: [
    "config:best-practices",
    "group:all",
    ":semanticCommitTypeAll(build)", // 末尾に置き config:recommended の fix(deps)/chore(deps) 割り当てを上書き
  ],
  timezone: "Asia/Tokyo",
  // schedule: ["* 0-8 * * 1"],  // 月曜 0-8 時台 (JST)。activated 後に有効化
  lockFileMaintenance: { enabled: false },
  semanticCommits: "enabled",
  labels: ["dependencies"],
  packageRules: [
    // 現行 Dependabot の cooldown 7 日を version 更新に限って再現（pin / digest は対象外）
    {
      matchUpdateTypes: ["major", "minor", "patch"],
      minimumReleaseAge: "7 days",
    },
    // engines.bun は手動同期（Decisions 参照）
    {
      matchManagers: ["bun"],
      matchDepTypes: ["engines"],
      matchDepNames: ["bun"],
      enabled: false,
    },
    // zizmor は action と CLI コンテナが揃った時だけ専用 PR で更新（Decisions 参照）
    // GHCR は releaseTimestamp 非対応のためクールダウンも外す
    {
      groupName: "zizmor",
      groupSlug: "zizmor", // group:all の groupSlug: "all" を上書きしないとブランチ名が通常グループと衝突する
      matchPackageNames: ["ghcr.io/zizmorcore/zizmor", "zizmorcore/zizmor-action"],
      minimumGroupSize: 2,
      minimumReleaseAge: null,
    },
  ],
}
```

有効になるビルトインマネージャと対象:

| マネージャ | 対象ファイル | 現行 Dependabot との対応 |
| ---------- | ------------ | ------------------------ |
| `bun` | `package.json` + `bun.lock` | `package-ecosystem: bun` を代替。bun.lock テキスト形式対応済み（[Bun manager](https://docs.renovatebot.com/modules/manager/bun/)） |
| `github-actions` | `.github/workflows/*.yml` | `package-ecosystem: github-actions` を代替。`uses: <owner>/<repo>@<sha> # vX.Y.Z` のコメント付き SHA ピンを維持したまま更新。zizmor-action の `with.version` も依存 `ghcr.io/zizmorcore/zizmor` として標準更新され、手動ピン 3 箇所のうち 1 つがこの時点で解消する（[GitHub Actions manager](https://docs.renovatebot.com/modules/manager/github-actions/)） |
| `dockerfile` | `Dockerfile`（`oven/bun:1.3-slim@sha256:...`） | `package-ecosystem: docker` を代替。タグ + digest を追従（[Docker](https://docs.renovatebot.com/docker/)） |
| `mise` | `mise.toml`（`bun = "1.3"`） | 現行 Dependabot では対象外。新規に自動化（[mise manager](https://docs.renovatebot.com/modules/manager/mise/)） |

`config:best-practices` の `:pinDevDependencies` により、初回に devDependencies を exact version にピンする PR が作られる（受け入れる）。

### Phase 2: customManagers による手動ピン自動化

対象は actionlint イメージ digest と mise-action `version` の 2 箇所（zizmor-action `version` は Phase 1 の標準マネージャで解消済み。Decisions 参照）。

`ci.yml` の mise-action の `version:` 行にアノテーションを追加:

```yaml
version: "2026.6.1" # renovate: datasource=github-releases depName=jdx/mise
```

`renovate.json5` に追記する customManagers 案:

```json5
customManagers: [
  // (a) actionlint: run 内の docker イメージ（タグ + digest）
  {
    customType: "regex",
    managerFilePatterns: ["/^\\.github/workflows/.+\\.ya?ml$/"],
    matchStrings: [
      "docker\\.io/rhysd/actionlint:(?<currentValue>\\d+\\.\\d+\\.\\d+)@(?<currentDigest>sha256:[a-f0-9]{64})",
    ],
    depNameTemplate: "rhysd/actionlint",
    datasourceTemplate: "docker",
  },
  // (b) renovate コメントアノテーション付きの version: 行（mise）
  {
    customType: "regex",
    managerFilePatterns: ["/^\\.github/workflows/.+\\.ya?ml$/"],
    matchStrings: [
      "version: \"(?<currentValue>[^\"]+)\" # renovate: datasource=(?<datasource>[a-z-.]+?) depName=(?<depName>\\S+)",
    ],
    extractVersionTemplate: "^v?(?<version>.*)$",
  },
],
```

- `extractVersionTemplate` は jdx/mise の GitHub Release タグの `v` プレフィックスを除去するために付ける（versioning は regex マネージャ既定の `semver-coerced` で足りる）。
- 検証は 3 段階で行う: ① 構文は `renovate-config-validator`、② 抽出結果（regex が 0 件マッチに退化していないか）は Mend Developer Portal のジョブログ、③ 実際の置換結果は生成 PR の差分と CI 成功。Dependency Dashboard は抽出された全依存のインベントリではなく、依存が最新の場合は抽出成功でも表示されないため検証には使えない（[Dependency Dashboard](https://docs.renovatebot.com/key-concepts/dashboard/)）。
- ③ で自然な更新が来ない場合の手順: Renovate は既定でデフォルトブランチしか走査しないため（[baseBranchPatterns](https://docs.renovatebot.com/configuration-options/#basebranchpatterns)）、検証ブランチで値を下げるだけでは PR は生成されない。一時的に `baseBranchPatterns: ["$default", "renovate-validation"]` を設定し、weekly の `schedule` キーを一時削除して（schedule を外さないと Phase 2 時点の週次 schedule 外では新規ブランチが作られない。[updateNotScheduled](https://docs.renovatebot.com/configuration-options/#updatenotscheduled)）、`renovate-validation` ブランチで対象値を旧版に下げて Developer Portal からジョブを実行、そのブランチ向け PR の差分と CI を確認したら一時設定・PR・ブランチを削除する。mise は毎週リリースされるため、実際には自然な更新を待つ方が早いことが多い。

### 設計メモ

- bun バージョンの 3 ファイル同期（mise.toml / Dockerfile / package.json engines）のうち、mise.toml と Dockerfile は Renovate の管理下に入る。`engines.bun` のみ手動同期が残るが、CI の drift-check が不整合を fail させるため事故にはならない。
- Renovate は設定キーの破壊的変更（例: `fileMatch` → `managerFilePatterns` のリネーム）が数年単位で発生する。`config:best-practices` に含まれる `:configMigration` により、設定移行はボット自身が PR で提案してくる。
- Mend App の障害（実行遅延）は更新 PR が遅れるだけで、CI やデプロイには影響しない。
- PR ノイズは全依存 1 グループ + 週次 + `minimumReleaseAge` で現行水準に抑える（[Noise reduction](https://docs.renovatebot.com/noise-reduction/)）。

## Tasks

Phase 1:

- [ ] Mend Renovate App を selected repositories で本リポジトリのみにインストール（<https://github.com/apps/renovate>）
- [ ] 自動生成される onboarding PR（`renovate/configure` ブランチ）の作成を待つ。`renovate.json5` を先に main へ直接コミットしない（設定ファイルが main に存在すると onboarding PR は作られない。[Configuration overview](https://docs.renovatebot.com/config-overview/)）
- [ ] onboarding PR のブランチ上で、提案された `renovate.json` を本設計の `renovate.json5`（schedule なしの初期構成）に置き換え、`.github/dependabot.yml` の削除も積む。PR 本文のプレビュー（検出された依存・警告）を確認
- [ ] 未処理の Dependabot PR（グループ PR・security update PR とも）をマージまたはクローズ
- [ ] リポジトリ設定で Dependabot security updates を無効化（Dependabot alerts は維持）
- [ ] onboarding PR をマージ（ロールバック: `dependabot.yml` 復元 + security updates 再有効化 + App アンインストール）
- [ ] マージ後の最初の実行直後に、Mend Developer Portal のジョブログで `engines.bun` の抽出有無（manager=bun / depType=engines / depName=bun）と無効化ルールの一致を確認（生成 PR のマージより先に行う）
- [ ] 初回の pin 系 PR（devDependencies pin / digest pin）を確認・マージ（→ activated 状態になり 4 時間ごと実行へ）。コミット / PR タイトルが `build(deps)` 形式になっているかも確認
- [ ] `renovate.json5` に `schedule: ["* 0-8 * * 1"]` を追加
- [ ] 週次グループ PR を 2 サイクル確認（グルーピング・schedule・minimumReleaseAge の動作、および mise / docker の releaseTimestamp 取得可否）
- [ ] 2 サイクル中に `mise.toml` の bun が minor 線表記（`1.3`）のまま維持されることを確認する（bun は patch リリースが頻繁なため観測機会は十分ある）。3 要素版（例: `1.3.14`）への書き換え PR が出た場合は、適切な packageRule を追加するか mise の bun 更新を無効化して手動同期（現行運用）へ戻す。解決するまで Phase 1 を完了としない。なお「`1.4` リリース時に bump PR が出るか」「Dockerfile と同じ PR にまとまるか」は次の bun minor リリースまで検証できないため完了条件にしない（提案されなくても現行の手動 bump + drift-check と同等で退行はない）。先行検証したい場合は Phase 2 の `baseBranchPatterns` 手順を流用し、検証ブランチで 3 ファイルを旧 minor 線（Dockerfile は旧タグと対応する digest）に揃えて `1.2 → 1.3` の更新を合成できる
- [ ] CLAUDE.md の Notes（手動ピン運用メモ。zizmor-action `version` はこの時点で自動化済みになるため削除）とコミット規約表の `build(deps) | Dependabot auto-generated` 行、および `.claude/skills/dependabot-pr/` を Renovate 運用に更新（bun minor 更新 PR マージ時の `engines.bun` 手動同期手順を含める）。`cliff.toml` の `# Dependabot` コメントも更新

Phase 2:

- [ ] `ci.yml` の mise-action の `version:` 行に renovate コメントアノテーションを追加
- [ ] `renovate.json5` に customManagers（actionlint digest / mise version コメント）を追加し、`renovate-config-validator` で構文検証
- [ ] Mend Developer Portal のジョブログで customManagers の抽出件数・依存名を確認（0 件マッチになっていないか）。あわせて `rhysd/actionlint` / `jdx/mise` の version update に `releaseTimestamp` が設定されていることも確認
- [ ] customManagers による生成 PR の差分（digest / version の置換結果）と CI 成功を確認してから完了とする。自然な更新が来ない場合は Design「Phase 2」記載の `baseBranchPatterns` を使った一時検証手順で確認する
- [ ] CLAUDE.md の手動ピン運用メモから自動化済み項目を削除
- [ ] `docs/changes/renovate-migration/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- `mise` マネージャが `bun = "1.3"` のようなマイナー行表記をどう扱うか（1.4 リリース時に bump PR を出すか、range として維持するか）は公式ドキュメントに明記がなく、onboarding 後に実機確認する。維持されない場合のフォールバック（packageRule 追加または mise の bun 更新を無効化して手動同期へ戻す）を Phase 1 Tasks のゲートとして定義済み。
- `minimumReleaseAgeBehaviour` の既定は `timestamp-required` で、releaseTimestamp を返さない datasource の更新は stable 扱いされず `internalChecksFilter: "strict"`（既定）に落とされて PR が出なくなる（[minimumReleaseAgeBehaviour](https://docs.renovatebot.com/configuration-options/#minimumreleaseagebehaviour)）。GHCR の非対応は確定事項として zizmor グループを例外化済み（Decisions 参照）。Docker Hub と github-releases は対応見込みだが、実際に timestamp が取れているかは Phase 1 の依存（`oven/bun`、mise.toml の bun 等）は 2 サイクル確認のタスクで、Phase 2 で追加される依存（`rhysd/actionlint`、`jdx/mise`）は Phase 2 のジョブログ確認タスクで実測する。取れない依存が他にあれば該当 packageRule で `minimumReleaseAge` を外す。
- Renovate の bun マネージャは monorepo / workspace 構成で bun.lock の更新漏れ報告があるが、本リポジトリは単一 package.json のため影響を受けにくい見込み。
- `group:all` は major 更新も同一 PR に含める（現行 Dependabot と同じ）。major で壊れた際にグループ全体が滞留するようなら、major のみグループを分ける packageRules を後から足す。
- customManagers の regex は `ci.yml` の書式変更（クォート形式や空白の変更）で 0 件マッチに退化しうる。Phase 2 のジョブログ確認タスクで検知する。

## 参照

- [Renovate vs Dependabot 機能比較（公式）](https://docs.renovatebot.com/bot-comparison/)
- [Installing and onboarding](https://docs.renovatebot.com/getting-started/installing-onboarding/)
- [Configuration overview](https://docs.renovatebot.com/config-overview/)
- [Running Renovate](https://docs.renovatebot.com/getting-started/running/)
- [GitHub platform authentication](https://docs.renovatebot.com/modules/platform/github/)
- [Minimum Release Age](https://docs.renovatebot.com/key-concepts/minimum-release-age/)
- [Mend-hosted apps overview](https://docs.renovatebot.com/mend-hosted/overview/)
- [Mend-hosted apps: Job scheduling](https://docs.renovatebot.com/mend-hosted/job-scheduling/)
- [Security and permissions](https://docs.renovatebot.com/security-and-permissions/)
- [Config presets（config:best-practices の内訳）](https://docs.renovatebot.com/presets-config/)
- [Group presets（group:all）](https://docs.renovatebot.com/presets-group/)
- [Configuration options](https://docs.renovatebot.com/configuration-options/)
- [Updating and rebasing branches](https://docs.renovatebot.com/updating-rebasing/)
- [Semantic commit messages](https://docs.renovatebot.com/semantic-commits/)
- [Custom Manager Support using Regex](https://docs.renovatebot.com/modules/manager/regex/)
- [GitHub Actions manager](https://docs.renovatebot.com/modules/manager/github-actions/)
- [mise manager](https://docs.renovatebot.com/modules/manager/mise/)
- [Bun manager](https://docs.renovatebot.com/modules/manager/bun/)
- [Docker](https://docs.renovatebot.com/docker/)
- [Noise reduction](https://docs.renovatebot.com/noise-reduction/)
- [dependabot-core#12903: グループ PR の rebase/recreate 不能バグ](https://github.com/dependabot/dependabot-core/issues/12903)
