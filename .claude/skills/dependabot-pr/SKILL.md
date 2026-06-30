---
name: dependabot-pr
description: Handle this repo's Dependabot dependency-update PRs (one multi-ecosystem grouped PR). Use when merging a Dependabot PR, unblocking a PR that is BEHIND or stuck because `@dependabot rebase`/`recreate` does nothing, resolving dependency-update conflicts, or bumping `@biomejs/biome` (and its schema). Covers strict branch-protection status-check gating and pre-merge verification.
allowed-tools: Bash(gh pr view *), Bash(gh pr list *), Bash(gh pr checks *), Bash(gh pr diff *), Bash(gh api *), Bash(git fetch *), Bash(git checkout *), Bash(git merge *), Bash(git status *), Bash(git log *), Bash(git diff *), Bash(git branch *), Bash(bun install), Bash(bun test), Bash(bun lint), Bash(bun typecheck), Bash(bunx biome *), Read, Edit
---

# Dependabot PR Handler

## Overview

このリポジトリの Dependabot は `multi-ecosystem-groups`（`all-dependencies`: bun / github-actions / docker、cooldown 7日）構成で、通常は **1 本のグループPR** にまとまる。
グループPRが作られるのは weekly（月曜）実行と `dependabot.yml` 変更時の即時実行のみ。UI の「Check for updates」は単一エコシステムのジョブで走り、グループPRは作られない。

## 前提（このリポジトリの事実）

- **マージ方式**: merge / squash / rebase すべて有効。既定は `gh pr merge <N> --merge`。linear history 不要。
- **main のブランチ保護**: 必須ステータスチェック = `quality` / `actions-security` / `docker-build`、`strict=true`（= マージ前に main へ最新追従が必須）。`allow_force_pushes=false` は main のみ（`dependabot/*` ブランチへの push / force-push は可）。`enforce_admins=false`（= 管理者は保護をバイパスして main へ直push でき、その場合 **必須CIはスキップされる**）。PR必須ルールは無し。
- 個別の単一エコシステムPRが複数並ぶこともある（その場合は手順B / Cを使う）。

## Known Issues

1. **グループPRで `@dependabot rebase` / `recreate` が効かない**（dependabot-core#12903）。本文に「Dependabot is rebasing this PR」バナーが出たまま完了しない。**コマンドでは直らない**ので手動追従（手順A）か weekly 実行待ち。
2. **BEHIND × strict status check でマージ不可**。最新でないとブロックされる。→ 手順Aで追従。
3. **手動でブランチを触ると Dependabot は以後そのPRの自動メンテ（自動rebase）を止める**（公式挙動: 自分の変更が優先される旨が本文に明記）。即マージ目的なら無害。バグで自動rebaseが効いていない以上、手動で引き取って失うものはない。
4. **biome 更新時、`biome.json` の `$schema` は自動更新されない**。`bunx biome migrate --write` でも "no migration needed" となり `$schema` が据え置かれることがあるので、**新バージョンへ手動で書き換える**。設定構文の変更があれば migrate が適用する。
5. **連鎖コンフリクト**（個別PRが複数ある場合）: 各PRが `package.json` / `bun.lock` を変更するため、1つマージすると残りで衝突。
6. コンフリクト解決して push しても、状態次第で Dependabot がPRを自動クローズすることがある（その場合は手順Cの最後を参照）。

## 手順A: BEHIND のグループPRを追従してマージ（最頻・推奨）

`@dependabot rebase` が効かない／strict check で BEHIND ブロックされた1本を、手動で追従してマージする。

```bash
# 1. 状態確認（BEHIND かつ MERGEABLE、変更ファイルを把握）
gh pr view <N> --json mergeStateStatus,mergeable,headRefName,files

# 2. PRブランチを取得して main を取り込む（merge方式。force-push不要）
git fetch origin
git checkout -B <headRefName> origin/<headRefName>
git merge origin/main --no-edit        # コンフリクト時は手順Cの解決手順へ

# 3. 依存を入れて検証
bun install
bun typecheck && bun lint && bun test

# 4. biome を含む場合は $schema を手当て（Known Issues 4 / Special Cases 参照）

# 5. push（必要なら $schema 等の追加コミットも）
git push origin <headRefName>

# 6. CIの完了を待ち、全green（quality / actions-security / docker-build）かつ mergeState CLEAN を確認してマージ
gh pr checks <N> --watch       # 必須チェックの完了をブロッキングで待つ
gh pr view <N> --json mergeStateStatus,statusCheckRollup
gh pr merge <N> --merge

# 7. 後片付け
git checkout main && git pull origin main
git branch -D <headRefName>
```

メモ: 手順2の代わりに `gh pr update-branch <N>`（既定で merge 取り込み、force-push不要）でも追従できる。ただし `biome.json` の `$schema` など追加修正が要る場合はローカル作業（手順A）の方が一括で済む。

## 手順B: 複数の個別PRを main で一括処理

個別PRが複数あり連鎖コンフリクトが見込まれる場合、main 側でまとめて更新する方が速い。

```bash
gh pr list --state open --json number,title,headRefName     # 対象把握
git checkout main && git pull origin main
# package.json を直接編集して対象依存をまとめて更新
bun install
bun typecheck && bun lint && bun test
git add package.json bun.lock
git commit -m "build(deps): bump dependencies"
git push origin main          # 残ったPRは Dependabot が自動クローズ
```

注意: main への直push が通るのは `enforce_admins=false` による管理者バイパスのためで、その場合 **必須CI（quality / actions-security / docker-build）はスキップされる**。push前のローカル検証（typecheck / lint / test）が事実上の品質ゲートになる。CIを通したい／管理者でない場合は、統合した編集を別ブランチに載せて1本のPRを開き、green確認後に `gh pr merge --merge`（残りPRは自動クローズ）。

## 手順C: 順次マージ（個別対応・コンフリクト解決）

```bash
# PRブランチで検証 → 問題なければマージ
git checkout -B <headRefName> origin/<headRefName>
bun install && bun typecheck && bun lint && bun test
gh pr merge <N> --merge

# 次PRでコンフリクトが出たら、main を取り込んで解決
git checkout -B <next-headRefName> origin/<next-headRefName>
git merge origin/main --no-edit
#   package.json: 両方の変更を取り込む
#   bun.lock: 削除して再生成
rm bun.lock && bun install
git add package.json bun.lock
git commit -m "[chore] resolve merge conflict with main"
git push origin <next-headRefName>
gh pr merge <N> --merge
```

## Special Cases

### biome 更新時

`biome.json` の `$schema` を新バージョンへ手動更新する（`migrate` は構文変更のみ適用、`$schema` は据え置きのことがある）。

```bash
# 例: 2.4.x -> 2.5.0
# biome.json の "$schema": "https://biomejs.dev/schemas/<new-version>/schema.json" に書き換え
bunx biome migrate --write      # 設定構文の変更があれば適用（無ければ "no migration needed"）
bun lint                        # 新バージョンのルール昇格/追加で落ちないか確認
git add biome.json
git commit -m "[chore] bump biome.json \$schema to <new-version>"
```

### PRが自動クローズされた場合

Dependabot がコンフリクト状態と判断してクローズしたら、main で直接対応する（手順B と同じ要領）。

```bash
git checkout main && git pull origin main
# package.json を編集
bun install && bun typecheck && bun lint && bun test
git add package.json bun.lock
git commit -m "build(deps-dev): bump <PACKAGE> from X to Y"
git push origin main
```

## Verification Checklist

- [ ] `bun install` が成功する
- [ ] `bun typecheck` がエラーなし
- [ ] `bun lint` がエラーなし（警告のみ許容。biome 更新時は新ルールで落ちないか特に確認）
- [ ] `bun test` が全パス
- [ ] biome 更新時は `biome.json` の `$schema` も新バージョンへ更新
- [ ] マージ前に CI（quality / actions-security / docker-build）全green、`mergeState: CLEAN`（`gh pr checks <N> --watch` で完了をブロッキング待ち）

## Merge Method

merge / squash / rebase すべて有効。既定は通常の merge を使う。

```bash
gh pr merge <N> --merge
```
