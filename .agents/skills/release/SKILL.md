---
name: release
description: Run the DisQord release process. Use when cutting a new version (e.g. `/release 1.5.0`) — bumps the version, generates a versioned CHANGELOG.md, prunes released change docs, commits, tags, pushes, and publishes a GitHub release with automatically generated notes.
---

# Release Workflow

Create a new release for DisQord version v<version>.

## Pre-flight Checks

1. Confirm the working tree is clean: `git status`
2. Confirm lint passes: `bun run lint`
3. Confirm typecheck and the test suite pass: `bun run test`

## Step 1: Update package.json

Edit `package.json` to set `"version": "<version>"`.

## Step 2: Update CHANGELOG.md

Generate CHANGELOG.md before creating the tag, and assign the unreleased commits to the target version explicitly:

```bash
git-cliff --tag v<version> --output CHANGELOG.md
```

Confirm the first release heading is `## [<version>]` rather than `## [Unreleased]`.

## Step 3: Prune released change docs

Delete every `docs/changes/<name>/` folder whose `design.md` has `status: implemented`.
`docs/progress.md` is generated from the remaining folders' frontmatter, so do not edit it by hand.
Step 5 commits with `LEFTHOOK=0`, which skips the pre-commit generator, so regenerate it explicitly:

```bash
bun run generate:readme
```

## Step 4: Format and Validate Markdown

Format Markdown, then confirm no Markdown lint errors remain:

```bash
bun run format:md
bun run lint:md
```

## Step 5: Commit and Tag

リリースコミットは main 上で作る（この手順に限り意図的）。
pre-commit のブランチガードが main への直コミットを止めるので `LEFTHOOK=0` で明示的にバイパスする。
対象は `package.json` / `CHANGELOG.md` / `docs/progress.md` と `docs/changes/` 配下の削除に限定する。
lint / typecheck / test は pre-flight で完了しているため、リリースコミットでは再実行しない。

```bash
git add package.json CHANGELOG.md docs/progress.md docs/changes
LEFTHOOK=0 git commit -m "[release] bump version to v<version>"
git tag v<version>
git push && git push --tags
```

## Step 6: Create GitHub Release

Create the GitHub Release from the pushed tag and let GitHub generate its notes:

```bash
gh release create v<version> --title "v<version>" --generate-notes --verify-tag
```

`--verify-tag` must remain enabled so the command fails instead of creating a tag from another revision.

## Step 7: Verify

1. Confirm the release is published: `gh release view v<version>`
2. Report the release URL to the user
