---
title: "Renovate 移行"
status: in-progress
priority: medium
summary: "Dependabot を Renovate (Mend App) に置き換え、手動ピン更新を自動化"
---

# Renovate 移行

## Why

Dependabot のマルチエコシステムグループ PR には `@dependabot rebase` / `@dependabot recreate` が効かない既知バグがあり（[dependabot-core#12903](https://github.com/dependabot/dependabot-core/issues/12903)、2026-07 時点で Open）、PR が BEHIND になると、次回 weekly 実行を待つか PR ブランチへ手動で main をマージするしかない運用を強いられている。
また、Dependabot は action の `with:` 入力値（zizmor CLI 版、mise 本体版）や `run:` 内の Docker イメージ digest を走査しないため、AGENTS.md に「手動ピン」として 3 箇所の定期 bump 運用が残っている。
Renovate は PR 本文の rebase チェックボックスや rebase label で任意タイミングの rebase を指示でき（[Updating and rebasing branches](https://docs.renovatebot.com/updating-rebasing/)）、customManagers（regex）でビルトイン非対応の箇所も更新対象にできる（[Custom Manager Support using Regex](https://docs.renovatebot.com/modules/manager/regex/)）ため、バグ回避と手動ピン削減の両方が見込める。

## 依存 / 関連 change

- 関連: [ci-pipeline](../ci-pipeline/design.md) — 手動ピン運用と bun drift-check はこの change で導入されたもの。drift-check は本 change 後も安全網として維持する。
  なお ci-pipeline の Non-Goals では「Mend hosted app への repo write 付与」を理由に Renovate を不採用としており、本 change はその判断を明示的に置き換える（理由は Decisions の「供給網リスクの受容」参照）

## Goals / Non-Goals

**Goals:**

- Dependabot（`.github/dependabot.yml`）を Renovate（Mend Renovate App）に置き換える
- 現行運用（週次月曜・エコシステム横断のグループ PR・更新のクールダウン）を Renovate 設定で再現する。クールダウンの長さは移行時の 7 日を引き継がず 3 日にした（Decisions「クールダウン」参照）。ただし major は non-major から隔離する（Decisions「グルーピング」参照。1 本の major が他の全依存を巻き込んで滞留するのを避けるための意図した差分）。`separateMajorMinor` が保証するのは major と non-major の分離であって、同じ `groupName` を持つ major 同士の分離ではない。また互換ペアを意図的に束ねる 2 つのグループ（bun toolchain / zizmor）は `separateMajorMinor: false` を持つので、この隔離の例外になる（pin / digest 更新はクールダウン対象外とする。意図した差分、Decisions「クールダウン」参照）
- GitHub Actions の SHA ピン + バージョンコメント維持を Renovate に任せる（`helpers:pinGitHubActionDigests`）
- 手動ピン 3 箇所を自動更新対象にする。zizmor-action と mise-action の `version` はいずれも標準の `github-actions` マネージャが `with:` 入力ごと対応済みのため Phase 1 で解消し（[Updating `with:` values](https://docs.renovatebot.com/modules/manager/github-actions/#updating-with-values-in-commonly-used-community-maintained-github-actions)）、actionlint イメージ digest の 1 箇所を Phase 2 の customManagers で対応する
- `biome.json` の `$schema` を `@biomejs/biome` の更新に追従させる（公式プリセット `customManagers:biomeVersions`）。手動ピン 3 箇所と同種の恒常作業でありながら現行では自動化対象になっていない

**Non-Goals:**

- automerge の導入（サプライチェーンリスク増幅のため当面手動マージを維持。[Automerge configuration](https://docs.renovatebot.com/key-concepts/automerge/)）
- self-hosted Renovate（PAT 管理と workflow 保守が個人運用に見合わない。[Running Renovate](https://docs.renovatebot.com/getting-started/running/)）
- lockFileMaintenance の有効化（bun.lock を特定できない不具合 [renovate#38692](https://github.com/renovatebot/renovate/issues/38692) は 2025-10 に修正済みだが本リポジトリでは未検証。現行 Dependabot 運用に相当機能がなく、まずは 1 PR 運用の再現を優先するため当面無効。標準マネージャの安定稼働後に有効化を検討）
- CI ワークフロー自体の再設計（drift-check・zizmor・actionlint の構成は現状維持）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 実行基盤 | Mend Renovate App（無料ホステッド） | 個人リポジトリでコスト・運用負荷ゼロ。activated 状態で約 4 時間ごと実行（[Mend-hosted apps overview](https://docs.renovatebot.com/mend-hosted/overview/)、[Job scheduling](https://docs.renovatebot.com/mend-hosted/job-scheduling/)）。ただし hosted が使う Renovate 本体はメンテナが手動更新しており、OSS 版から数時間〜1 週間遅れうる（major リリースはさらに保留される）。「hosted なので常に最新」を前提にせず、上流の新機能に依存する設定は導入時にジョブログの `renovateVersion` と実際の抽出結果で受け入れ確認する（[Mend-hosted Apps Configuration](https://docs.renovatebot.com/mend-hosted/hosted-apps-config/)） |
| 供給網リスクの受容 | ci-pipeline で不採用とした「Mend App への repo write 付与」を受容する | Dependabot のグループ PR バグが 1 年近く未解決で、手動ピン 3 箇所の負担も恒常化したため再評価。App は Code / Workflows を含む read-write を要求する（[Security and permissions](https://docs.renovatebot.com/security-and-permissions/)）。脅威別に整理すると: ① 悪意ある上流リリースの混入 → automerge を使わずマージ前に workflow 差分を含む PR 内容を人間が確認することで緩和。② App token 侵害 → selected repositories でのインストールにより影響範囲を本リポジトリに限定。ただし Contents write があれば PR の merge API を叩けるため、「マージは常に人間」は設定上強制されていない。`required_approving_review_count: 1` を課せば bot PR への所有者承認を必須化でき token 単独のマージは防げるが、solo 運用では自分の PR を自己承認できず全ての通常 PR が admin bypass 頼みになるため採用しない。Workflows write と併せた不正マージは**残余リスクとして明示的に受容**する。Mend は ISO 27001 / SOC 2 取得済みでコードは実行後保持されない。代替の self-hosted は fine-grained PAT や自前 GitHub App token でも運用できる（[GitHub platform authentication](https://docs.renovatebot.com/modules/platform/github/)）が、credential とワークフローの保守が増え、1 人運用では App 1 つに絞る方が管理面を小さくできると判断 |
| ベースプリセット | `config:best-practices` | `config:recommended` + `docker:pinDigests` + `helpers:pinGitHubActionDigests` + `:configMigration` + `:pinDevDependencies` + `abandonments:recommended` + `security:minimumReleaseAgeNpm` + `:maintainLockFilesWeekly` の 8 プリセット（[Config presets](https://docs.renovatebot.com/presets-config/#configbest-practices)）。SHA ピン運用と方針が一致。`:maintainLockFilesWeekly` は Non-Goals の通り `lockFileMaintenance.enabled: false` で打ち消す。`security:minimumReleaseAgeNpm` の 3 日はそのまま活かし、catch-all も同じ 3 日にして npm 以外の datasource へ広げる |
| グルーピング | `group:allNonMajor` + `group:allDigest` プリセット（`group:all` は使わない） | minor / patch を 1 本、digest を 1 本にまとめ、**major を non-major から隔離する**（bun toolchain / zizmor の 2 グループは互換ペアを 1 本に載せるため意図的に例外とする）。ただし「major が必ず依存ごとの個別 PR になる」わけではない。`config:best-practices` が取り込む `config:recommended` には `group:monorepos` と `group:recommended` が含まれ、これらが `groupName` を与える依存は major 同士がまとまる。`group:allNonMajor` / `group:allDigest` は major にマッチしないのでその指定が残る。本リポジトリの依存が該当するかは onboarding 後のジョブログで確認する（Tasks 参照）。現行 Dependabot は major も同一グループに入れており（`typescript` 6→7 を含む #70 など実績あり）、`group:all` はその挙動をそのまま再現するが、1 つの major が壊れるとその週の全依存が道連れで滞留する。major を無効化せず分離するのは、依存のうち大半が dev ツールで CI（typecheck / lint / test）が実質的なゲートになり、止めても更新債務が静かに溜まるだけだから。ランタイム依存で CI がゲートになりきらないのは `discord.js` のみで（19 ファイルが import する一方、`new Client(` を生成するテストが無く `fetch` も mock されているため gateway / REST の実挙動は未検証）、リスクが顕在化した場合は major 全体ではなくこの 1 件を `dependencyDashboardApproval: true` で絞る。`separateMajorMinor` は既定 `true` なので、`group:all`（`separateMajorMinor: false` を含む）を使わなければ major は自動的に分かれる（[Group presets](https://docs.renovatebot.com/presets-group/)、[separateMajorMinor](https://docs.renovatebot.com/configuration-options/#separatemajorminor)） |
| スケジュール | `schedule: ["* 0-8 * * 1"]`（cron 構文、月曜 0-8 時台）+ `timezone: "Asia/Tokyo"`（activated 後に追加） | 現行の weekly monday を再現（[Scheduling](https://docs.renovatebot.com/key-concepts/scheduling/)）。`before 9am on monday` のような Later 構文は非推奨で、新規設定は cron 構文が推奨（[schedule](https://docs.renovatebot.com/configuration-options/#schedule)）。onboarding PR マージ直後は daily 実行（onboarded 状態）のため、狭い schedule を最初から入れると初回 pin 系 PR が窓を外す。初回 PR マージで activated（4 時間ごと）になってから schedule を追加する（[Job scheduling](https://docs.renovatebot.com/mend-hosted/job-scheduling/)） |
| schedule 外の既存 PR 更新 | `updateNotScheduled` は既定（`true`）のまま | 既存グループ PR への新バージョン取り込みや rebase は schedule 外でも行われる。これは Dependabot の「次回 weekly まで放置」と異なる挙動だが、BEHIND 滞留の解消こそが本移行の動機なので意図した差分として受け入れる（[updateNotScheduled](https://docs.renovatebot.com/configuration-options/#updatenotscheduled)） |
| クールダウン | `minimumReleaseAge: "3 days"`（公式 preset と同じ更新タイプ）。パッケージマネージャ側には置かない | 移行時は Dependabot の `cooldown.default-days: 7` をそのまま引き継いだが、7 という値に根拠は無かった。ci-pipeline の design doc が記録しているのは「zizmor の `dependabot-cooldown` 監査が cooldown 不在を fail にするため必須」であって、長さの理由ではない（`dependabot.yml` 削除でこの監査自体が対象外になった）。3 日は Renovate 公式の `security:minimumReleaseAgeNpm` / `...Crate` / `...Pypi` が採る値で、プリセットの説明に「malware 研究者やスキャナが検知する短い猶予」と「npm / crates.io の 72 時間 unpublish・削除ウィンドウを跨がせない」という根拠が明記されている。7 日は週次スケジュールと噛み合って取り込み遅延をほぼ倍にする（火曜リリースが 3 日なら翌 Monday、7 日なら Monday を外してその次 = 最大 13 日）割に、追加の安全性は限定的。`internalChecksFilter` の既定 `strict` により、条件を満たさない更新はブランチ自体が作られず PR も出ない（[Minimum Release Age](https://docs.renovatebot.com/key-concepts/minimum-release-age/)）。pin / digest 更新は releaseTimestamp を持たず永久 pending になるため packageRules で対象を version 更新に限定する（公式プリセットも同じ理由で `lockFileMaintenance` / `replacement` / `pin` を除外している）。公式は「パッケージマネージャ側にも同じ値を置く」ことを推奨しており一度 `bunfig.toml` の `[install] minimumReleaseAge` を入れたが、**撤回した**。bun の install 時ゲートには Renovate のような脆弱性修正の例外が無く、公開 3 日未満の修正版を exact 指定でも拒否する（黙って古い版に落とさずエラーで停止することを実測）。その結果 `bun.lock` を再生成できず CI が赤のまま残り、「脆弱性修正は即時」という設計を満たせない。同じ理由で `pin` 更新も詰まり（`pin` は Renovate のクールダウン対象外なので公開間もない版が提案されうる）、実際に初回の pin PR が公開 1.0 日の `bun-types@1.4.0` で赤くなった。守れるのは手動 `bun install` の経路だけで、詰まる場所が最も時間の惜しい脆弱性経路である以上、割に合わない。Renovate 経由の更新には Renovate 自身のゲートが効いたまま残る |
| パッケージ取得元 | `.npmrc` でレジストリを Takumi Guard (`https://npm.flatt.tech/`) に固定し、Renovate には `hostRules` でトークンを渡す | 固定前は取得元が「誰がどの環境で `bun install` したか」で決まっていた。開発者の手元は各自のグローバル `~/.npmrc`、CI と Renovate の sidecar は既定の registry.npmjs.org で、リポジトリからは何も分からない。さらに `bun.lock` には 2026-04 のローカル解決時に焼き込まれた絶対 URL が 119 件残っており、`bun install --frozen-lockfile` はこれをそのまま使う（URL を到達不能ホストに書き換えると `FailedToOpenSocket` で失敗することを実測）。つまり CI と Docker ビルドは設定が無いまま Takumi Guard へ依存していた。`.npmrc` で明示する。なお `bun.lock` の URL 欄を空にして `.npmrc` を単一の情報源にしようとしたが、これは達成できない。リポジトリ内 `.npmrc` を置くと `bun install` が tarball URL を記録し直すため（空に保とうとすると install のたびに差分が出る）。記録されること自体は害がなく、`.npmrc` と一致し全経路で揃うので受け入れる。重要なのは混在しないことで、`.npmrc` 導入後は Renovate の生成分も同じ Takumi Guard の URL になる（実測: 導入前は Renovate 生成分が空欄 = 既定レジストリだった）。認証は経路ごとに異なり、ローカルと GitHub Actions runner は IP ベースの anonymous quota で通るが、Mend hosted の sidecar は対象外で 401 になるため `hostRules` で Mend Portal の Secret を注入する（`matchHost` は scheme と末尾スラッシュを含めること。省略すると matcher に hit しない） |
| **自前 regex** customManager の導入時期 | Phase 2（標準マネージャの安定稼働後） | regex 設定はミスしてもエラーにならず 0 件マッチになるだけでデバッグしにくいため、段階導入でリスクを分離する。この判断が対象とするのは自分で書く regex であって、customManager 一般ではない。公式プリセット `customManagers:biomeVersions`（実体は JSONata の customManager）は上流がメンテしており、対象も単一の固定ファイルで検証が容易なため Phase 1 に入れる |
| zizmor-action `version` の扱い | 標準の `github-actions` マネージャに任せ、action 本体と CLI を専用グループ（`minimumGroupSize: 2`）にして通常グループから分離する | zizmor-action の `version` 入力は community-maintained action の `with:` 対応リストに含まれ、依存 `ghcr.io/zizmorcore/zizmor` として標準更新される（[Updating `with:` values](https://docs.renovatebot.com/modules/manager/github-actions/#updating-with-values-in-commonly-used-community-maintained-github-actions)）。customManagers で `pypi` の zizmor を重ねると同じ行を二重抽出して更新が競合するため対象にしない。zizmor-action は新しい CLI コンテナに即応しないため、Renovate 本家の設定に倣い action と CLI が揃った時だけ更新する専用グループとする（[Renovate 自身の renovate.json](https://github.com/renovatebot/renovate/blob/main/renovate.json) の zizmor ルール、[minimumGroupSize](https://docs.renovatebot.com/configuration-options/#minimumgroupsize)）。zizmor だけ別 PR になるのは意図した差分。また GHCR は releaseTimestamp 非対応（[renovate#39064](https://github.com/renovatebot/renovate/issues/39064)）で、既定の `timestamp-required` では 7 日クールダウンが永久 pending になるため、クールダウンを外す。ただし外すのは `ghcr.io/zizmorcore/zizmor` だけで、グループ全体には掛けない。action 側の `zizmorcore/zizmor-action` は `github-tags` datasource（`releaseTimestampSupport = true`）なので待機が成立し、これをグループごと外すと Goals のクールダウン方針を迂回してしまう。CLI だけ外して action に待機を残せば、`minimumGroupSize: 2` により「2 件揃うまでブランチを作らない」が働き、結果としてグループ全体が action の 7 日待機にゲートされる。加えてこのグループには `separateMajorMinor: false` を置く。`group:all` をやめたことで既定の `true` に戻り、同じ `groupName` でも major と non-major が別ブランチに割れるため、CLI と action の片方だけが major に振れると各ブランチの更新が 1 件になり `minimumGroupSize: 2` を満たさず、どちらの PR も出ないまま止まる |
| mise-action `version` の扱い | 標準の `github-actions` マネージャに任せる（customManagers は使わない） | `jdx/mise-action` は community-maintained action の `with:` 対応リストに登録済みで、`version`（と任意の `sha256`）を `jdx/mise` として抽出する（`lib/modules/manager/github-actions/community.ts` の `jdx/mise-action` エントリ、datasource は `github-release-attachments`）。本リポジトリの `ci.yml` とほぼ同一の入力（`uses: jdx/mise-action@<sha> # v4.2.0` + `with.version` + `install_args`）を使う抽出テストが上流にある。したがって `# renovate:` アノテーションの付与も customManagers も不要で、手動ピン 3 箇所のうち 2 箇所（zizmor / mise）が Phase 1 で解消する |
| `biome.json` の `$schema` | 公式プリセット `customManagers:biomeVersions` を `extends` に足す（自前 regex は書かない） | `@biomejs/biome` の bump に `$schema` URL が追従しないため手で同期しており、グループ PR 運用に切り替えた 2026-06 以降の 6 本中 3 本（#63 / #65 / #70）で発生している。手動ピン 3 箇所より頻度が高い。プリセットは `customType: "jsonata"` + `fileFormat: "json"` で JSON をパースして `$schema` をスラッシュ分割するため、regex と違って空白・インデント・キー順の変化で壊れない。上流がメンテするので URL 形式の変更にも追従が期待できる（自動的な互換性が保証されるわけではなく、`/` 区切りの後ろから 2 番目を version とみなす URL 構造への依存は残る）。プリセットは `versioningTemplate` を設定しないが、versioning は datasource の既定にフォールバックする（`lib/workers/repository/process/lookup/index.ts` の `config.versioning ??= getDefaultVersioning(config.datasource)`）。プリセットの datasource は `npm` で、npm datasource の `defaultVersioning` は npm（`lib/modules/datasource/npm/index.ts`）なので、`package.json` 側と同じ npm versioning になる。挙動差が生じないので `versioning` の上書きは足さない。なお自動化されるのは `$schema` URL の置換だけで `biome migrate` は走らないため、Biome の設定構文が変わる更新では CI が落ちて手動 migration が要る |
| `package.json` の `engines.bun` | フィールドごと削除し、bun のバージョンを持つファイルを `mise.toml` と `Dockerfile` の 2 つにする | 消費者が存在しなかった。bun は `engines` を強制しない（`engines.bun: ">=99.0.0"` を bun 1.3.14 で `bun install` / 実行しても exit 0。bunfig.toml の `[install]` に npm の `engine-strict` 相当も無い）。`main` / `module` / `exports` / `files` がいずれも未設定のアプリケーションで Docker イメージとしてデプロイされるため、`engines` が意味を持つレジストリ経由の install 経路も無い（あわせて `private: true` を付与して publish 経路を塞いだ）。リポジトリ全文検索でも実参照は drift-check 自身だけで、チェック対象を維持するためにチェックがある循環になっていた。由来は INITIAL COMMIT の scaffold で、ci-pipeline の design doc も「値は据え置きだが drift-check の対象として」と記録している。効果は整理に留まらない: Renovate が原理的に更新できないファイル（`unknown-engines` でスキップされる）が無くなり、bun のツールチェイン更新が Renovate 単独で完結するようになるため、導出生成の仕組みが不要になる |
| `bun-types` の指定形式 | レンジをやめ、解決済みの版で exact 固定する（`^1.3.14` → `1.3.14`） | レンジのままだと 1.4.0 への移動が `pin` 更新に分類され、#80 で `pin` を既定の "Pin Dependencies" へ回した結果 bun toolchain グループから外れる。その状態では pin PR（`bun-types` だけ 1.4.0）と toolchain PR（ランタイムだけ 1.4.0）に割れ、**どちらの PR も単独では 3 経路を揃えられず drift-check で落ちる**（実際に #73 と #77 が正反対の理由で同時に fail した）。exact にすれば以降の更新は `minor` になり、`bun` / `oven/bun` と同じグループ・同じ PR に載る。`:pinDevDependencies` が固定する先は最新版（1.4.0）であってロックファイルの解決版ではないため、この初回変換だけは手で行う |
| bun の版指定 | `mise.toml` と `Dockerfile` の両方を exact patch に固定し、drift-check を完全一致比較にする | Renovate は mise の bun を `oven-sh/bun` / `github-releases` datasource として扱い（`lib/modules/manager/mise/upgradeable-tooling.ts`）、3 要素版を書く。これは表記の変更ではなく**意味の変更**で、`bun = "1.3"` は 1.3 系の最新へ解決する fuzzy 指定、`bun = "1.3.10"` は exact pin（`mise ls --current` で実測）。片側だけが exact になると、`Dockerfile` の可変 minor タグ（`1.3-slim`）は digest 更新でその線の最新 patch へ浮動し続けるため、同じ minor 線の中で本番と開発 / CI の版が静かにずれる。major.minor しか見ない drift-check ではこれを検出できない。したがって Dockerfile も `oven/bun:<x.y.z>-slim@sha256:...` の exact patch に揃え、drift-check を patch まで含めた完全一致にする。両側の更新は下記の bun 専用グループで 1 本の PR に載る。bun の patch ごとに 1 行増えるが週次グループに吸収される。結果として検査は移行前より厳密になる（移行前は `Dockerfile` が digest で固定される一方 `mise.toml` の fuzzy 指定だけが浮動しており、実際に乖離しうる状態だった。Dockerfile の digest は導入以来一度も更新されていない）。あわせて bun 専用の packageRule を置き、`separateMajorMinor: false` で major も含めて 1 本の PR に載せる。mise 側は depName `bun`、Dockerfile 側は depName `oven/bun` と別物なので、`group:allNonMajor`（minor / patch のみ）だけでは major 更新が 2 本に割れ、どちらも drift-check で落ちるため。このグループには `bun-types` も含める。`tsconfig.json` の `types` が `["bun-types"]` なので typecheck における Bun API 型の唯一の供給源であり、ランタイムから独立して先行すると「型は通るが実行時に存在しない API」を受け入れてしまう。実際に初回の pin PR (#73) が、ランタイムが 1.3.14 のまま `bun-types` を 1.4.0 へ固定しようとしていた。drift-check は `mise.toml` と `Dockerfile` しか見ないためこの skew を検出できない |
| 脆弱性対応 | GitHub の Dependabot **alerts** は維持し、Dependabot **security updates**（自動 PR）はリポジトリ設定で無効化。Renovate の `vulnerabilityAlerts` は有効のまま使い、`minimumGroupSize: 1` だけ明示する | alerts（検知）と security updates（自動 PR）は別機能で、`dependabot.yml` を削除しても後者のリポジトリ設定は残る。両方有効だと脆弱性修正 PR が重複する。Renovate の脆弱性 PR は schedule / group / minimumReleaseAge を適用せず即時の個別 PR になる点も現行と異なるが、修正は早いほど良いので受け入れる（[vulnerabilityAlerts](https://docs.renovatebot.com/configuration-options/#vulnerabilityalerts)）。ただし `vulnerabilityAlerts` の既定が上書きするのは `groupName` / `schedule` / `minimumReleaseAge` などに限られ、**`minimumGroupSize` は上書きしない**。グループに `minimumGroupSize` を設定していると、そのグループ内の単独の脆弱性修正は更新 1 件でブランチ作成が延期され、PR が出ないまま黙って落ちる。これを避けるため `vulnerabilityAlerts: { minimumGroupSize: 1 }` を明示する。なおこの設定が実際に効くのは npm 依存（`discord.js` / `zod` / devDependencies）の経路であって、zizmor の 2 依存ではない。本リポジトリは全 action を SHA 固定しており、GitHub は SHA 参照の action に Dependabot alert を生成しない（semantic version 参照のみ）ため、action 側にはそもそも alert が来ない。生成される脆弱性 packageRule は `force: { ...config.vulnerabilityAlerts }` を持つ（`lib/workers/repository/init/vulnerability.ts`）ため、この指定は packageRules 側の値を確実に上書きする |
| Dependabot 廃止タイミング | `dependabot.yml` の削除を onboarding PR に含め、Dependabot security updates の無効化はマージ直前に行う | onboarding PR マージまで Renovate は更新 PR を作らないため、マージと同時に Dependabot version updates を止めれば重複期間が生じない（[Installing and onboarding](https://docs.renovatebot.com/getting-started/installing-onboarding/)）。security updates もマージ直前に無効化しておかないと、Renovate `vulnerabilityAlerts` との脆弱性 PR 重複期間が残る。ロールバックは `dependabot.yml` の復元 + security updates の再有効化 + App のアンインストール |
| コミットメッセージ形式 | `semanticCommits: "enabled"` + extends `":semanticCommitTypeAll(build)"` | 本リポジトリのコミット規約は `[type]` 形式で conventional commits ではないため、`semanticCommits` の既定 `auto` では接頭辞なしになりうる。また `config:recommended` は `:semanticPrefixFixDepsChoreOthers` を含み、packageRules で依存ごとに `fix(deps)` / `chore(deps)` を割り当てるため、トップレベルの `semanticCommitType` 指定では上書きされて効かない。全 PR の type を変えるには公式案内どおり `:semanticCommitTypeAll(build)` を extends の末尾に置く（[Changing the semantic commit type](https://docs.renovatebot.com/semantic-commits/#changing-the-semantic-commit-type)）。scope は既定が `deps` のため、`cliff.toml` の `^build\(deps` → Dependencies 分類と一致する |

## Design

### 変更対象ファイル

- 新規: `renovate.json5` — Renovate 設定（リポジトリルート）
- 削除: `.github/dependabot.yml` — onboarding PR に含める
- 修正: `package.json` — `engines.bun` を削除し `private: true` を付与（Phase 1）
- 新規: `.npmrc` — パッケージ取得元を Takumi Guard に固定（Phase 1）
- 修正: `Dockerfile` — install ステージへ `.npmrc` をコピー（本番イメージのビルドも同じ取得元を通すため）
- 修正: `mise.toml` / `Dockerfile` — bun を exact patch に固定（`bun = "1.3.14"` / `oven/bun:1.3.14-slim@sha256:...`）（Phase 1）
- 修正: `.github/workflows/ci.yml` — biome schema drift check の追加と bun drift check の 2 値化（Phase 1）。actionlint イメージ行は Phase 2 の customManager が更新するが、`ci.yml` 側の記述変更は不要
- 修正: `AGENTS.md` — Notes の手動ピン運用メモを更新
- 修正: `.agents/skills/dependabot-pr/` — Renovate 運用向けに書き換え（または `renovate-pr` にリネーム）
- 修正: `cliff.toml` — `^build\(deps` 分類ルール直前の `# Dependabot` コメントを `# Dependency updates (Dependabot / Renovate)` 等に更新（分類ルール自体は変更不要）
- リポジトリ設定: Dependabot security updates を無効化（alerts は維持）

### Phase 1: 標準マネージャでの移行

`renovate.json5` 案（schedule の 1 行だけは activated 後に追加する。Decisions「スケジュール」参照）:

```json5
{
  $schema: "https://docs.renovatebot.com/renovate-schema.json",
  extends: [
    "config:best-practices",
    "group:allNonMajor", // minor / patch を 1 本に。major は non-major から分離される
    "group:allDigest", // digest 更新も 1 本にまとめる
    "customManagers:biomeVersions", // biome.json の $schema を @biomejs/biome に追従させる公式プリセット
    ":semanticCommitTypeAll(build)", // 末尾に置き config:recommended の fix(deps)/chore(deps) 割り当てを上書き
  ],
  timezone: "Asia/Tokyo",
  // .npmrc でパッケージ取得元を Takumi Guard に固定しているため、sidecar にも認証を渡す。
  // anonymous quota はローカルと GitHub Actions runner の IP にしか適用されず、
  // Mend hosted の sidecar は 401 になって lockfile 再生成が失敗する。
  // matchHost は scheme と末尾スラッシュを含めること (省略すると Mend hosted の matcher に hit しない)。
  // hostType は npm 固定 (bun manager は内部で npm datasource を使う)。
  // token は Mend Portal の Credentials に登録した Secret を展開する記法
  hostRules: [
    {
      matchHost: "https://npm.flatt.tech/",
      hostType: "npm",
      token: "{{ secrets.TAKUMI_GUARD_TOKEN }}",
    },
  ],
  // schedule: ["* 0-8 * * 1"],  // 月曜 0-8 時台 (JST)。activated 後に有効化
  lockFileMaintenance: { enabled: false },
  // 脆弱性 PR が zizmor グループの minimumGroupSize: 2 に引っかかって出なくなるのを防ぐ（Decisions 参照）
  vulnerabilityAlerts: { minimumGroupSize: 1 },
  semanticCommits: "enabled",
  labels: ["dependencies"],
  packageRules: [
    // 供給網対策のクールダウン。対象の更新タイプは公式の security:minimumReleaseAge* に合わせる。
    // 公式が除外しているのは pin / replacement / lockFileMaintenance / bump / lockfileUpdate /
    // rollback で、digest と pinDigest は除外されていない。digest 更新はタグを変えないまま
    // 実イメージの中身を差し替えるので、むしろクールダウンを掛ける価値が高い。
    // releaseTimestamp を返さない datasource では永久 pending になるため、
    // 該当するものは個別に例外化する（現状 GHCR の zizmor CLI のみ）。
    // パッケージマネージャ側 (bunfig.toml) には同じゲートを置かない。bun の install 時ゲートには
    // 脆弱性修正の例外が無く、公開間もない修正版を拒否して lockfile 再生成を止めるため（Decisions 参照）
    {
      matchUpdateTypes: ["major", "minor", "patch", "digest", "pinDigest"],
      minimumReleaseAge: "3 days",
    },
    // bun は mise 側 (depName: bun / packageName: oven-sh/bun) と Dockerfile 側 (depName: oven/bun) で
    // depName が異なるため、group:allNonMajor は minor / patch しか束ねない。major は対象外なので
    // 放置すると bun 1.x -> 2.x が 2 本の PR に割れ、どちらも drift-check で落ちる。
    // 専用グループに入れ separateMajorMinor: false を置いて、更新タイプによらず 1 本に載せる。
    // bun-types も同じグループに入れる。tsconfig.json の types が ["bun-types"] なので
    // これが typecheck における Bun API 型の唯一の供給源で、ランタイムから独立して先行すると
    // 「型は通るが実行時に存在しない API」を受け入れてしまう。drift-check は mise/Dockerfile しか
    // 見ないためこの skew を捕まえられない。同じ PR に載せて版がずれないようにする。
    //
    {
      groupName: "bun toolchain",
      groupSlug: "bun-toolchain",
      matchDepNames: ["bun", "oven/bun", "bun-types"],
      separateMajorMinor: false,
    },
    // bun-types の pin だけは既定の "Pin Dependencies" へ戻す。
    // :pinDevDependencies による range -> exact の一度きりの変換で、版を動かす更新ではない。
    // 上のグループに残すと pin と minor が同じ groupName から同じ branchName に解決されて衝突し、
    // pin 側が勝ってランタイム (mise / Dockerfile) の更新がブランチごと消える（実際に発生した）。
    // なお matchUpdateTypes は separateMajorMinor と同一ルール内で併用できないため、
    // 上のグループを絞るのではなく後続ルールで上書きする形にしている。
    // 固定後の bun-types は minor / patch になり、上のグループに戻る
    {
      matchDepNames: ["bun-types"],
      matchUpdateTypes: ["pin"],
      groupName: "Pin Dependencies",
      groupSlug: "pin-dependencies",
    },
    // zizmor は action と CLI コンテナが揃った時だけ専用 PR で更新（Decisions 参照）
    {
      groupName: "zizmor",
      groupSlug: "zizmor", // groupName から自動生成される値と同じだが、ブランチ名を設定上明示するために置く
      matchPackageNames: ["ghcr.io/zizmorcore/zizmor", "zizmorcore/zizmor-action"],
      minimumGroupSize: 2,
      // group:all をやめて separateMajorMinor が既定の true に戻ったため、このグループ内でも
      // major と non-major が別ブランチに割れる。片側だけが major に振れると各ブランチの更新は
      // 1 件になり minimumGroupSize: 2 を満たさず、どちらの PR も出ないまま黙って止まる。
      // このグループに限って false に戻し、action と CLI が 1 本に載るようにする
      separateMajorMinor: false,
    },
    // クールダウンを外すのは GHCR の CLI だけ。action 側 (github-tags) は releaseTimestamp を
    // 返すので待機が成立し、minimumGroupSize: 2 と合わさってグループ全体がその待機にゲートされる。
    //
    // digest 固定もこの依存には行わない。zizmor-action の version 入力は
    // `latest` か厳密な X.Y.Z しか受け付けず (action.sh の version_regex)、
    // `1.29.0@sha256:...` を書き込まれると "'version' must be 'latest' or an exact X.Y.Z version"
    // で即死する。そもそも action 自身が version -> digest の対応表を internal に持ち
    // `ghcr.io/zizmorcore/zizmor:<version>@<digest>` を組み立てて pull するので、
    // 外から digest を固定する意味も無い
    {
      matchPackageNames: ["ghcr.io/zizmorcore/zizmor"],
      minimumReleaseAge: null,
      pinDigests: false,
    },
  ],
}
```

有効になるビルトインマネージャと対象:

| マネージャ | 対象ファイル | 現行 Dependabot との対応 |
| ---------- | ------------ | ------------------------ |
| `bun` | `package.json` + `bun.lock` | `package-ecosystem: bun` を代替。bun.lock テキスト形式対応済み（[Bun manager](https://docs.renovatebot.com/modules/manager/bun/)） |
| `github-actions` | `.github/workflows/*.yml` | `package-ecosystem: github-actions` を代替。`uses: <owner>/<repo>@<sha> # vX.Y.Z` のコメント付き SHA ピンを維持したまま更新。zizmor-action の `with.version`（→ `ghcr.io/zizmorcore/zizmor`）と mise-action の `with.version`（→ `jdx/mise`）も依存として標準更新され、手動ピン 3 箇所のうち 2 つがこの時点で解消する（[GitHub Actions manager](https://docs.renovatebot.com/modules/manager/github-actions/)） |
| `dockerfile` | `Dockerfile`（`oven/bun:1.3.14-slim@sha256:...`） | `package-ecosystem: docker` を代替。タグ + digest を追従（[Docker](https://docs.renovatebot.com/docker/)） |
| `mise` | `mise.toml`（`bun = "1.3.14"`） | 現行 Dependabot では対象外。新規に自動化（[mise manager](https://docs.renovatebot.com/modules/manager/mise/)） |
| `custom.jsonata`（`customManagers:biomeVersions`） | `biome.json` の `$schema` | 現行 Dependabot では対象外。`@biomejs/biome` と同一 depName / 同一 datasource で抽出されるため、同じ更新タイプのグループに入り同じ PR に載る |

`github-actions` マネージャは action 本体の SHA に加えて、community-maintained action の `with:` 入力も依存として抽出する。
本リポジトリでは zizmor-action の `version`（→ `ghcr.io/zizmorcore/zizmor`）と mise-action の `version`（→ `jdx/mise`）が該当し、手動ピン 3 箇所のうち 2 箇所がこの時点で解消する。

`config:best-practices` の `:pinDevDependencies` により、初回に devDependencies を exact version にピンする PR が作られる（受け入れる）。
`@biomejs/biome` は既に exact なので追加の pin 差分は生じない。

### Phase 1: biome schema drift check

`biome.json` の `$schema` と `package.json` の `@biomejs/biome` が一致するかを `ci.yml` の `quality` ジョブで検証する。
既存の bun version drift check と同じく、bun を必要としない純テキスト（`jq`）で書く。

```yaml
- name: biome schema drift check
  run: |
    pkg_v=$(jq -er '.devDependencies["@biomejs/biome"]
                    | select(type == "string" and test("\\A[0-9]+\\.[0-9]+\\.[0-9]+\\z"))' package.json) || {
      echo "::error::@biomejs/biome must be pinned to an exact stable version like 2.5.3"; exit 1
    }
    expected="https://biomejs.dev/schemas/${pkg_v}/schema.json"
    echo "expected=$expected actual=$(jq -r '."$schema"' biome.json)"
    jq -e --arg expected "$expected" '."$schema" == $expected' biome.json > /dev/null || {
      echo "::error::biome schema drift (expected=$expected)"; exit 1
    }
```

`$schema` から版を抽出して比べるのではなく、期待 URL を組み立てて値全体と文字列比較する。
版だけを正規表現で抜くと、`https://garbage.example/other/schemas/2.5.3/schema.json` のようにホストやパス形状が壊れた値からも版が抽出でき、版が一致していれば通過してしまう。

`package.json` 側の版検証を shell の `grep` ではなく `jq` の `test("\A...\z")` で行うのにも理由がある。
`grep` は入力を行単位で照合するため、`2.5.3\njunk` のような多行の値でも 1 行目が一致すれば通過する（実測で確認）。
`\A` / `\z` は行頭・行末ではなく文字列全体の先頭・末尾にアンカーするので、多行の値をまとめて弾ける。
レンジ（`^2.5.3` / `~2.5.3`）、prerelease、キー欠落、末尾改行付きの値も同じ検証で落ちる。

`$schema` 側の比較も同じ理由で `jq -e --arg` を使い jq 内で行う。
シェルのコマンド置換は末尾の改行をすべて落とすため、値を取り出してから比べると
`https://biomejs.dev/schemas/2.5.3/schema.json\n` のように末尾に改行が付いた値が通過してしまう（実測で確認）。
jq 内で比較すれば、末尾改行・先頭空白・多行・非文字列型のいずれも一致しないものとして扱われる。

**この check が追加するのは検出ではなく強制である。**
Biome 自身が `$schema` の版ずれを検出し `The configuration schema version does not match the CLI version` を出す。
ただし severity は `info` で終了コードは 0 なので、`bun lint` も CI も緑のまま通る（2.5.3 でローカル実測）。
実際に PR #70 の CI ログ（run 29763071057）にはこの info が記録されており、それでも `quality` ジョブは success になっていた。
`$schema` の手動 bump が 6 本中 3 本で必要になったのは、情報が出ていなかったからではなく、出ていた情報が何もゲートしていなかったためである。

bun drift-check とは守る対象が違う。
bun の不整合は宣言と異なるランタイムで build / 実行される実害があるが、`$schema` の版ずれで壊れるのは Biome の挙動ではなくエディタ / LSP が古いスキーマで補完・検証することだけである。
`biome migrate` への案内は版ずれ時の診断そのものが出しているので失われていない。
この check がしているのは、その既存の案内を CI の失敗へ昇格させることである。
したがってこの check は lint / build の正しさを守るものではなく、次の 2 点を担う:

1. 「Biome パッケージと `$schema` を同期させる」というリポジトリの継続的な invariant を機械化する
2. **Renovate 側の自動化が黙って止まったことを検知するカナリアにする**。JSONata マネージャは抽出 0 件でもエラーにならず debug ログを出すだけで、更新自体は続く。`$schema` の欠落・URL 形式の変更・上流の regression で 0 件抽出に退化しても、Renovate は何も言わない。この沈黙は Phase 2 の actionlint customManager にも共通する性質で、drift-check があれば次の Biome bump PR で必ず気付ける。Biome 自身の info では 6 本中 3 本を実際に見逃しており、ゲートしない通知はカナリアとして機能しないことが実績で示されている

グルーピングは同一実行で更新対象になった依存を 1 本のブランチにまとめるノイズ削減策であって、異なるマネージャ由来の依存を原子的に束ねる同期保証ではない。
ただし脆弱性 PR がグループを迂回すること自体は片側更新の理由にならない。
生成される脆弱性 packageRule は `matchDatasources` と `matchPackageNames` だけで対象を決めて manager やファイルを限定しないため（`lib/workers/repository/init/vulnerability.ts`）、`$schema` 側も同じ npm / `@biomejs/biome` として抽出されていれば同じルールが当たり、両方が一緒に更新される。
片側更新が起きるのは JSONata 抽出が欠落・退行して `$schema` 側が依存として見えていない場合であり、それはまさにこの check が検知したい状態そのものである。

### Phase 2: customManagers による手動ピン自動化

対象は actionlint イメージ digest の 1 箇所のみ（zizmor-action / mise-action の `version` はいずれも Phase 1 の標準マネージャで解消済み。Decisions 参照）。

`customManagers` は `mergeable: true` の配列オプションで、プリセット由来の定義とローカル定義は連結される（`lib/config/options/index.ts` の `customManagers` 定義と `lib/config/utils.ts` の `mergeChildConfig`）。
したがって以下を足しても `customManagers:biomeVersions` の定義は消えない。

`renovate.json5` に追記する customManagers 案:

```json5
customManagers: [
  // actionlint: run 内の docker イメージ（タグ + digest）
  {
    customType: "regex",
    managerFilePatterns: ["/^\\.github/workflows/.+\\.ya?ml$/"],
    matchStrings: [
      "docker\\.io/rhysd/actionlint:(?<currentValue>\\d+\\.\\d+\\.\\d+)@(?<currentDigest>sha256:[a-f0-9]{64})",
    ],
    depNameTemplate: "rhysd/actionlint",
    datasourceTemplate: "docker",
  },
],
```

- 検証は 3 段階で行う: ① 構文は `renovate-config-validator`、② 抽出結果（regex が 0 件マッチに退化していないか）は Mend Developer Portal のジョブログ、③ 実際の置換結果は生成 PR の差分と CI 成功。
- `renovate-config-validator` が見るのは構文とオプション名 / 型までで、**`extends` に書いたプリセット名の実在は検証しない**（存在しないプリセット名を混ぜても `Config validated successfully` になることを実測）。プリセット名の綴りは②のジョブログで確認する。ローカル実行時は prebuilt の `re2` が Node の ABI と合わずに落ちることがあるので、その場合は `RENOVATE_X_IGNORE_RE2=true` を付ける。Dependency Dashboard は抽出された全依存のインベントリではなく、依存が最新の場合は抽出成功でも表示されないため検証には使えない（[Dependency Dashboard](https://docs.renovatebot.com/key-concepts/dashboard/)）。
- ③ で自然な更新が来ない場合の手順: Renovate は既定でデフォルトブランチしか走査しないため（[baseBranchPatterns](https://docs.renovatebot.com/configuration-options/#basebranchpatterns)）、検証ブランチで値を下げるだけでは PR は生成されない。一時的に `baseBranchPatterns: ["$default", "renovate-validation"]` を設定し、weekly の `schedule` キーを一時削除して（schedule を外さないと Phase 2 時点の週次 schedule 外では新規ブランチが作られない。[updateNotScheduled](https://docs.renovatebot.com/configuration-options/#updatenotscheduled)）、`renovate-validation` ブランチで対象値を旧版に下げて Developer Portal からジョブを実行、そのブランチ向け PR の差分と CI を確認したら一時設定・PR・ブランチを削除する。actionlint のリリース間隔は不定なので、自然な更新を待つか一時検証手順を使うかは状況で選ぶ。

### 設計メモ

- bun バージョンは `engines.bun` の削除により `mise.toml` と `Dockerfile` の 2 ファイルになり、どちらも Renovate の管理下に入る。したがって bun の更新は Renovate 単独で完結し、人手の同期コミットは要らない。CI の drift-check はこの 2 経路に加えて `bun.lock` が解決した `bun-types` の版も比較する（3 者の patch 一致を要求）。グループ化が保証するのは「同時に更新可能なものを 1 本の PR に載せる」ことだけで版の一致までは保証せず、`pin` だけ別グループへ回る経路もあるため、機械検査で担保する。ただし Dockerfile についてはタグ文字列しか見ておらず、別バージョンの有効な digest を付けた場合は検出できない（タグと digest の対応検証にはレジストリ照会が要る）。
- Renovate は設定キーの破壊的変更（例: `fileMatch` → `managerFilePatterns` のリネーム）が数年単位で発生する。`config:best-practices` に含まれる `:configMigration` により、設定移行はボット自身が PR で提案してくる。
- Mend App の障害（実行遅延）は更新 PR が遅れるだけで、CI やデプロイには影響しない。
- PR ノイズは non-major 1 本 + digest 1 本 + 週次 + `minimumReleaseAge` で抑える。major と zizmor は別 PR になるため本数は現行 Dependabot より増えるが、これは「1 つの major が他の全依存を巻き込まない」ことと引き換えの意図した差分（[Noise reduction](https://docs.renovatebot.com/noise-reduction/)）。

## Tasks

Phase 1:

- [x] `package.json` から `engines.bun` を削除し `private: true` を付与、`ci.yml` の bun drift check を `mise.toml` / `Dockerfile` の 2 値比較に簡略化（App インストール前に単独でマージ可能）
- [x] `ci.yml` に biome schema drift check を追加（App インストール前に単独でマージ可能。移行前でも成立する invariant であり、Renovate 導入後は自動化のカナリアになる）
- [x] Mend Renovate App を selected repositories で本リポジトリのみにインストール（<https://github.com/apps/renovate>）
- [x] 自動生成される onboarding PR（`renovate/configure` ブランチ）の作成を待つ。`renovate.json5` を先に main へ直接コミットしない（設定ファイルが main に存在すると onboarding PR は作られない。[Configuration overview](https://docs.renovatebot.com/config-overview/)）
- [x] onboarding PR のブランチ上で、提案された `renovate.json` を本設計の `renovate.json5`（schedule なしの初期構成）に置き換え、`.github/dependabot.yml` の削除も積む
- [x] 上記を push したあと、Renovate が設定を読み込んで更新した PR 本文のプレビューを確認した。予告 PR は 8 本から 4 本に減り、以下が確認できた（警告・エラーの記載なし）
  - `group:allNonMajor` が `renovate/all-minor-patch` として機能（biome / actions-checkout / jdx/mise / mise-action が 1 本）
  - **bun toolchain グループが機能**。`renovate/bun-toolchain` に `bun`（→ 1.4.0）と `oven/bun`（digest）が同居し、depName が異なる 2 経路を束ねられている
  - **zizmor グループが機能**。`renovate/zizmor` に CLI と action の 2 依存が入り `minimumGroupSize: 2` を満たしている
  - `customManagers:biomeVersions` が Configuration Summary に出ており、プリセット名が実在することを確認（`renovate-config-validator` では検証できない項目）
  - `:semanticCommitTypeAll(build)` が効き、全 PR タイトルが `build(deps):` 形式
  - `pin` 更新は既定の "Pin Dependencies" グループで 1 本にまとまる（個別 PR 乱立の懸念は誤りだった）
  - クールダウンが効いている。既定設定時のプレビューでは `jdx/mise` が `2026.8.10` だったが、本設定では `2026.8.5` が選ばれている（この観測時点の設定は 7 日。後に 3 日へ変更した）
  - なお `prHourlyLimit`（既定 2）により 4 本は 1 時間あたり 2 本ずつ作られる
  - ここで確認できたのはグルーピングと抽出までで、**実ファイルの置換が正しいか（Dockerfile のタグが `1.4.0-slim` になるか、`biome.json` の `$schema` が実際に書き換わるか）は生成 PR の差分で別途確認する**（後続タスク）
- [x] 未処理の Dependabot PR（グループ PR・security update PR とも）をマージまたはクローズ
- [x] リポジトリ設定で Dependabot security updates を無効化（`automated-security-fixes` が `enabled: false`、`vulnerability-alerts` は 204 のまま維持）
- [x] onboarding PR をマージ（#71）。ロールバックは `dependabot.yml` 復元 + security updates 再有効化 + App アンインストール
- [x] `config:recommended` の `group:monorepos` / `group:recommended` は本リポジトリの依存に `groupName` を与えていないことを確認した。生成された 4 本の PR（`all-minor-patch` / `bun-toolchain` / `zizmor` / `pin-dependencies`）はすべて本設計の packageRules 由来のグループで、curated preset 由来のグループは現れなかった。したがって major は依存ごとの個別 PR になる見込みだが、実際の major 更新が出るまでは未確認
- [x] マージ後の最初の実行のジョブログで確認した。`renovateVersion: 44.39.0`。`jdx/mise` / `ghcr.io/zizmorcore/zizmor` / `biome.json` の `$schema` はいずれも期待どおり抽出され、生成 PR に反映されている
- [ ] 初回の pin 系 PR（devDependencies pin / digest pin）を確認・マージ（→ activated 状態になり 4 時間ごと実行へ）。コミット / PR タイトルが `build(deps)` 形式になっているかも確認
- [ ] `renovate.json5` に `schedule: ["* 0-8 * * 1"]` を追加
- [x] zizmor-action と mise-action の `with.version` が実際に置換されることを生成 PR の差分で確認した。mise-action は #74 で `"2026.6.1"` → `"2026.8.5"`、#81 でさらに `"2026.8.8"`。zizmor は #79 で `"1.25.2"` → `"1.29.0"` と action 側 SHA / バージョンコメントが同一 PR。いずれも CI 成功後にマージ済み。手動ピン 3 箇所のうち 2 箇所が実際に自動化された
  - mise: 通常グループには `minimumGroupSize` の制約がないため、2 サイクル中に更新が来なければ Design「Phase 2」記載の `baseBranchPatterns` 手順で検証ブランチの `version:` だけを旧版に下げれば PR が出る
  - zizmor: 専用グループに `minimumGroupSize: 2` を設定しているため、**`with.version` だけを下げても更新が 1 件にしかならずブランチ作成が延期され、PR が出ない**（`minimumGroupSize` は「x 件以上の更新が揃うまでブランチ作成を延期する」オプション）。合成する場合は `uses: zizmorcore/zizmor-action@<sha> # vX.Y.Z` の SHA とバージョンコメント、および `with.version` の両方を、既知の互換な旧ペアまで下げて更新を 2 件にする。そもそも action と CLI が揃った時だけ更新するのがこのグループの狙いなので、自然な更新を待てば両方が同じ PR に載る
- [x] `biome.json` の `$schema` が `@biomejs/biome` と**同じ PR** で置換されることを確認した。#74 で `2.5.3` → `2.5.8`、#81 で `2.5.8` → `2.5.9`。いずれも `package.json` / `bun.lock` と同一 PR で整合しており、懸念していた別ブランチ分裂は起きなかった
- [ ] 週次グループ PR を 2 サイクル確認（グルーピング・schedule・minimumReleaseAge の動作、および releaseTimestamp の取得可否）。releaseTimestamp は datasource ごとに確認する: `mise.toml` の bun（mise マネージャ）、`oven/bun`（docker）、mise-action の `jdx/mise`（github-release-attachments）、zizmor-action の `ghcr.io/zizmorcore/zizmor`（docker / GHCR）。`mise.toml` の bun と mise-action の `jdx/mise` は datasource が異なるので、まとめて「mise」と扱わず個別に見る
- [x] bun の更新 PR で `mise.toml` と `Dockerfile` が同じ PR で同じ patch へ揃うことを #77 で確認した（`bun = "1.3.14"` → `"1.4.0"` と `oven/bun:1.3.14-slim@sha256:d56a...` → `oven/bun:1.4.0-slim@sha256:e0ee...`）。Renovate が可変タグではなく exact patch タグを書くことも確認。drift-check も完全一致で PASS。マージ自体は bun 1.4.0 のクールダウン明けを待つ
- [ ] AGENTS.md の Notes（手動ピン運用メモ。zizmor-action と mise-action の `version` はこの時点で自動化済みになるため削除し、残るのは actionlint イメージ digest のみ）とコミット規約表の `build(deps) | Dependabot auto-generated` 行、および `.agents/skills/dependabot-pr/` を Renovate 運用に書き換え（bun の同期は Renovate が完結するので手動同期手順は不要。biome `$schema` も自動化済みなので Known Issues 4 と Special Cases も削除する）。onboarding PR のマージ時点では暫定の注記だけ入れてあり、本文の書き換えは実際の Renovate PR を観測してから行う。注記では biome `$schema` の自動化を「見込み」として書く。`customManagers:biomeVersions` が保証するのは抽出と置換であって npm 依存との同一 PR 化ではなく、それ自体が Phase 1 の確認ゲートだから。`cliff.toml` の `# Dependabot` コメントと、`ci.yml` の mise-action `version:` 行に付いた「Dependabot は更新しないため手動 bump」コメントも更新（この 2 つは Renovate が実際に更新するようになってから直す。先に書き換えると移行完了までの間だけ記述が誤りになる）

Phase 2:

- [ ] `renovate.json5` に customManagers（actionlint digest）を追加し、`renovate-config-validator` で構文検証
- [ ] Mend Developer Portal のジョブログで customManagers の抽出件数・依存名を確認（0 件マッチになっていないか）。あわせて `rhysd/actionlint` の version update に `releaseTimestamp` が設定されていることも確認
- [ ] customManagers による生成 PR の差分（タグ / digest の置換結果）と CI 成功を確認してから完了とする。自然な更新が来ない場合は Design「Phase 2」記載の `baseBranchPatterns` を使った一時検証手順で確認する
- [ ] AGENTS.md の手動ピン運用メモから自動化済み項目を削除
- [ ] `docs/changes/renovate-migration/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- bun を exact patch に固定したことで、patch リリースのたびに `mise.toml` の更新 PR が立つ。移行前に自動追従していたのは `mise.toml` の fuzzy 指定だけで、`Dockerfile` は digest 固定なので元から更新 PR が必要だった（実際には導入以来 digest が更新された履歴が無い）。したがって増えるのは mise 側の 1 経路分で、bun toolchain グループにより Dockerfile 側の変更と同じ PR に載る。週次グループ + クールダウンで週 1 本の中に収まる想定だが、実際の頻度は 2 サイクル確認で見る。
- 両側の patch 更新が同一 PR にまとまるかは実機未確認（Phase 1 Tasks のゲート）。割れた場合も drift-check が落ちるので silent な乖離にはならない。
- **Dashboard に `Could not re-extract the packageFile after updating it` が出るが、これは上流の構造的な制約で対処不要**。この警告は `checkForPendingVersions`（`lib/workers/repository/update/branch/get-updated.ts`）から出る。`minimumReleaseAge` で保留中の新しい版がある依存について、lockfile 更新の結果が Renovate の想定と食い違っていないかを検証する安全確認で、汎用の `extractPackageFile` を呼ぶ。しかし `bun` マネージャは `extractAllPackageFiles` だけを export していて `extractPackageFile` を持たない（`lib/modules/manager/bun/index.ts`。`npm` マネージャも同じ）ため、再抽出が必ず null を返し警告になる。設定側で回避する手段はない（上流 [renovate#41624](https://github.com/renovatebot/renovate/issues/41624) が対応対象）。
  - 実害は「lockfile が想定と違う版を引いていないかの検証が効かない」ことに限られる。本リポジトリの devDependencies は `:pinDevDependencies` で exact に固定されるため `bun install` に選択の余地がなく、リスクは実質的に runtime 依存（`discord.js` / `zod`）のレンジ解決に限定される。
  - 実際、初回の `renovate/all-minor-patch` では `@biomejs/biome` が 2.5.8（2.5.9 はクールダウンで保留）で lockfile と一致していた。
- **`@skyra/discord-components-core` が abandoned として Dashboard に表示される**（最終リリース 2025-06-18、`abandonments:recommended` の閾値 1 年）。`scripts/preview/` の UI プレビュー描画にのみ使う devDependency で、Bot のランタイムには入らない。代替も存在しない（[ui-preview](../ui-preview/design.md) の Decisions 参照: 公式の描画ツールが無く、discord.js 公式ガイドも本パッケージを採用している）。表示は検知であって障害ではないので、当面は放置し、プレビュー機能自体を見直す際に再評価する。
- `minimumReleaseAgeBehaviour` の既定は `timestamp-required` で、releaseTimestamp を返さない datasource の更新は stable 扱いされず `internalChecksFilter: "strict"`（既定）に落とされて PR が出なくなる（[minimumReleaseAgeBehaviour](https://docs.renovatebot.com/configuration-options/#minimumreleaseagebehaviour)）。GHCR の非対応は確定事項として `ghcr.io/zizmorcore/zizmor`（CLI）のみを例外化済み。action 側の `zizmorcore/zizmor-action` には catch-all の 7 日が残る（Decisions 参照）。Docker Hub と github-releases は対応見込みだが、実際に timestamp が取れているかは Phase 1 の依存（`oven/bun`、mise.toml の bun 等）は 2 サイクル確認のタスクで、Phase 1 で新たに拾われる `jdx/mise`（github-release-attachments）と `ghcr.io/zizmorcore/zizmor`（GHCR）は 2 サイクル確認のタスクで datasource ごとに個別に見る（`mise.toml` の bun とは datasource が別）。Phase 2 で追加される `rhysd/actionlint` は Phase 2 のジョブログ確認タスクで実測する。取れない依存が他にあれば該当 packageRule で `minimumReleaseAge` を外す。
- Renovate の bun マネージャは monorepo / workspace 構成で bun.lock の更新漏れ報告があるが、本リポジトリは単一 package.json のため影響を受けにくい見込み。
- `pin` / `pinDigest` は `group:allNonMajor` にも `group:allDigest` にも含まれないが、Renovate の既定でどちらも `groupName: "Pin Dependencies"` / `groupSlug: "pin-dependencies"` を持つため、通常は 1 本の pin PR にまとまる。個別 PR が乱立する想定はしなくてよい。
- customManagers の regex は `ci.yml` の書式変更（クォート形式や空白の変更）で 0 件マッチに退化しうる。Phase 2 のジョブログ確認タスクで検知する。
- `pin` 更新は同じ `groupName` を持つ他の更新タイプと同じ branchName に解決されて衝突する。bun toolchain グループに `bun-types` を入れた直後、`bun-types` の pin がブランチを取り、`mise.toml` / `Dockerfile` の minor 更新が Dashboard からも PR からも消えた（検出はされているのにブランチが無い状態になる）。後続 packageRule で pin を既定の "Pin Dependencies" へ戻して解消した。`matchUpdateTypes` と `separateMajorMinor` は同一ルール内で併用できない（`packageRules cannot combine both matchUpdateTypes and separateMajorMinor`）ため、グループ側を絞る形は取れない。
- `bun-types` の版を drift-check の比較対象に加えることは見送った。グループ化で同一 PR に載れば版がずれる余地は実質的に無く、一方で bun のあらゆる patch に対応する `bun-types` が必ず公開される保証はないため、完全一致を強制すると公開されない patch で更新が止まる。グループ化が破れた場合に備えるなら major.minor 比較で足りるが、まずはグループ化の実効を 2 サイクル観測してから判断する。
- `pin` 更新は Renovate の `minimumReleaseAge` の対象外（公式プリセットも本リポジトリの catch-all も除外。`pin` には releaseTimestamp が渡らず永久 pending になるため）。したがって公開間もない版への固定が提案されうる。`bunfig.toml` を入れていた間はこれが install 時ゲートと衝突して artifact 更新を壊したが、撤回により解消した。
- `bunfig.toml` の install 時ゲートは脆弱性修正にも掛かるため撤回した（Decisions「クールダウン」参照）。クールダウンは Renovate 側だけで掛ける。手動 `bun install` は保護対象外になるが、依存更新の主経路が Renovate である以上、脆弱性経路を詰まらせる代償に見合わないと判断した。
- **`ghcr.io/zizmorcore/zizmor` に digest 固定を行ってはいけない**。zizmor-action の `version` 入力は `latest` か厳密な `X.Y.Z` しか受け付けず（`action.sh` の `version_regex='^v?[0-9]+\.[0-9]+\.[0-9]+$'`）、`1.29.0@sha256:...` を書き込まれると `'version' must be 'latest' or an exact X.Y.Z version` で即座に失敗する。`docker:pinDigests`（`config:best-practices` 由来）が有効なため放置すると digest 固定 PR が立つので、packageRule で `pinDigests: false` を明示している。そもそも action 自身が version → digest の対応表を internal に持ち `ghcr.io/zizmorcore/zizmor:<version>@<digest>` を組み立てて pull するので、外から固定する必要も無い。
- `TAKUMI_GUARD_TOKEN` は GitHub Actions Secret と Mend Portal の Credentials の 2 箇所で管理される。Mend hosted の制約で自動同期できないため、rotate 時は両方を更新すること。
- `bun.lock` の URL 欄の書き換えでは、版を変えないために `rm bun.lock && bun install` による再生成を使わなかった。レンジ指定の依存がゼロから解決され直し、実際に `discord.js` が `^14.26.5` の範囲内で 14.26.5 → 14.27.0 へ上がってしまうため（レジストリ設定の変更に依存更新を混ぜない）。
- 上記に関連して、**レンジ内の更新は現在どの経路でも適用されない**。Renovate の既定 `rangeStrategy` はレンジを満たす新版を更新対象にせず、それを拾う `lockFileMaintenance` は無効化してある。`discord.js` が 14.26.5 に留まり 14.27.0 が提案されないのはこのため。意図した状態か再評価の余地がある。
- **SHA 固定した GitHub Actions には Dependabot alert が来ない**。GitHub は action の脆弱性を version メタデータで管理しており、alert を生成するのは semantic version 参照の場合だけで、SHA 参照には生成しない（[About Dependabot alerts](https://docs.github.com/code-security/dependabot/dependabot-alerts/about-dependabot-alerts)）。本リポジトリは `helpers:pinGitHubActionDigests` で全 action を SHA 固定するため、action の脆弱性は即時 PR ではなく通常の version 更新で拾うことになる（GitHub 自身も SHA 固定時の代替として version updates の有効化を案内している）。供給網の不変性と alert 網羅性のトレードオフとして受容する。
- `vulnerabilityAlerts: { minimumGroupSize: 1 }` が実際に効くかは、本物の脆弱性 alert が出るまで実測できない（合成手段がない）。設定の根拠はソース（`vulnerability.ts` の `force: { ...config.vulnerabilityAlerts }`）と `vulnerabilityAlerts` の既定値一覧に `minimumGroupSize` が含まれないことまで。効く対象は alert が生成される npm 依存の経路に限られる。
- `customManagers:biomeVersions` の JSONata 式も `$schema` の欠落や URL 形式の変更で 0 件抽出になりうる。抽出 0 件は debug ログになるだけでエラーにならないため、biome schema drift check をカナリアとして置く（Design「Phase 1: biome schema drift check」参照）。

## 参照

- [biosig-match/eeg-server](https://github.com/biosig-match/eeg-server) — 同一構成の先行実装。とくに `CONTRIBUTING.md` の「Renovate 運用」節に、Mend hosted sidecar が Takumi Guard の anonymous quota 対象外で 401 になる件と `hostRules` による対処が記録されている。本 change の削除時は、この参照を skill 側（Renovate 運用へ書き換える `dependabot-pr`）へ移すこと
- [Renovate vs Dependabot 機能比較（公式）](https://docs.renovatebot.com/bot-comparison/)
- [Installing and onboarding](https://docs.renovatebot.com/getting-started/installing-onboarding/)
- [Configuration overview](https://docs.renovatebot.com/config-overview/)
- [Running Renovate](https://docs.renovatebot.com/getting-started/running/)
- [GitHub platform authentication](https://docs.renovatebot.com/modules/platform/github/)
- [Minimum Release Age](https://docs.renovatebot.com/key-concepts/minimum-release-age/)
- [Mend-hosted apps overview](https://docs.renovatebot.com/mend-hosted/overview/)
- [Mend-hosted apps: Job scheduling](https://docs.renovatebot.com/mend-hosted/job-scheduling/)
- [Mend-hosted Apps Configuration（hosted の Renovate 本体バージョンと lag）](https://docs.renovatebot.com/mend-hosted/hosted-apps-config/)
- [Security and permissions](https://docs.renovatebot.com/security-and-permissions/)
- [Config presets（config:best-practices の内訳）](https://docs.renovatebot.com/presets-config/)
- [Group presets（group:allNonMajor / group:allDigest）](https://docs.renovatebot.com/presets-group/)
- [Configuration options](https://docs.renovatebot.com/configuration-options/)
- [Updating and rebasing branches](https://docs.renovatebot.com/updating-rebasing/)
- [Semantic commit messages](https://docs.renovatebot.com/semantic-commits/)
- [Custom Manager Support using Regex](https://docs.renovatebot.com/modules/manager/regex/)
- [customManagers プリセット一覧（`customManagers:biomeVersions`）](https://docs.renovatebot.com/presets-customManagers/)
- [JSONata custom manager](https://docs.renovatebot.com/modules/manager/jsonata/)
- [GitHub Actions manager](https://docs.renovatebot.com/modules/manager/github-actions/)
- [mise manager](https://docs.renovatebot.com/modules/manager/mise/)
- [Bun manager](https://docs.renovatebot.com/modules/manager/bun/)
- [Docker](https://docs.renovatebot.com/docker/)
- [Noise reduction](https://docs.renovatebot.com/noise-reduction/)
- [dependabot-core#12903: グループ PR の rebase/recreate 不能バグ](https://github.com/dependabot/dependabot-core/issues/12903)
