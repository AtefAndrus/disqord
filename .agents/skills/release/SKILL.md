---
name: release
description: Run the DisQord release process. Use when cutting a new version (e.g. `/release 1.5.0`) — bumps the version, generates a versioned CHANGELOG.md, prunes released change docs, commits, tags, pushes, and publishes a GitHub release whose notes are that version's CHANGELOG section.
---

# Release Workflow

Create a new release for DisQord version v<version>.

## Pre-flight Checks

1. Confirm the working tree is clean: `git status`
2. Confirm lint passes: `bun run lint`
3. Confirm typecheck and the test suite pass: `bun run test`
4. Run the end-to-end scenarios against the real bot: `bun run e2e`. A failure caused by the model or the network (a 429 from a free model, for example) is not a release blocker by itself; rerun, and report what failed.
5. List the open manual checks of implemented-but-unreleased work, which lives in `status: in-progress` designs: `grep -l '^status: in-progress' docs/changes/*/design.md | xargs -r grep -n -- '- \[ \] 手動確認'`. A `planned` or `investigating` design's manual checks belong to work that is not in this release. If any exist, stop and ask the user to do them (each task says how; `bun run e2e stop` covers the stop button). Tick the task and move the design to `status: implemented` once its other tasks are done. Do not release past an open manual check unless the user says to.

## Step 1: Update package.json

Edit `package.json` to set `"version": "<version>"`.

## Step 2: Update CHANGELOG.md

Generate CHANGELOG.md before creating the tag, and assign the unreleased commits to the target version explicitly:

```bash
mise exec -- git-cliff --tag v<version> --output CHANGELOG.md
```

`mise exec` を通すのは、シェルの PATH に別の backend や版の git-cliff が残っていても `mise.toml` で固定した版を使うため。

Confirm the first release heading is `## [<version>]` rather than `## [Unreleased]`.

Validate that the target version has exactly one valid section using the same parser as the startup announcement; stop if this command fails:

```bash
bun scripts/checkReleaseNotes.ts <version>
```

## Step 3: Prune released change docs

Delete every `docs/changes/<name>/` folder whose `design.md` has `status: implemented`, rewriting the links other documents make into those folders to permalinks at the current commit:

```bash
bun scripts/prune-released-changes.ts
```

The permalinks point at HEAD, so the script refuses to run when a folder to delete holds a file HEAD does not have (untracked, ignored, or only staged). Uncommitted edits to files already in HEAD, such as a manual check ticked in pre-flight, are fine: the link then shows the committed version.
It rewrites Markdown anywhere in the repository except `CHANGELOG.md`, which git-cliff regenerates.
If a line still names a folder to delete in a form it does not rewrite, it lists those lines and stops without changing anything; replace them with a permalink by hand and rerun.
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
対象は `package.json` / `CHANGELOG.md` / `docs/progress.md`、`docs/changes/` 配下の削除、Step 3 のスクリプトがリンクを書き換えた Markdown に限定する。
pre-flight で作業ツリーがクリーンなことを確かめているので、`git add -u` で追跡済みファイルの変更と削除をまとめて入れれば、この範囲に収まる。コミット前に `git status` で想定外のファイルが無いことを確かめる。
lint / typecheck / test は pre-flight で完了しているため、リリースコミットでは再実行しない。

```bash
git add -u
LEFTHOOK=0 git commit -m "[release] bump version to v<version>"
git tag v<version>
git push && git push --tags
```

## Step 6: Create GitHub Release

Create the GitHub Release from the pushed tag, using this version's CHANGELOG section as its notes.
`--strip header` keeps the footer, whose link definition makes the version heading link to the compare view.
Publishing triggers the production deploy, so the commands are chained: if git-cliff fails or the notes lack this version's heading, nothing is published.

```bash
notes=$(mktemp) &&
  mise exec -- git-cliff --latest --strip header --output "$notes" &&
  grep -q '^## \[<version>\]' "$notes" &&
  gh release create v<version> --title "v<version>" --notes-file "$notes" --verify-tag
```

`--verify-tag` must remain enabled so the command fails instead of creating a tag from another revision.

## Step 7: Verify

1. Confirm the release is published: `gh release view v<version>`
2. Confirm that the image publish run for this release succeeded. Find the run for the release commit with `gh run list --workflow publish-image.yml --commit "$(git rev-parse "v<version>^{commit}")" --json databaseId,status,conclusion` (it can take a few seconds to appear after publishing; an empty list means it has not started yet, not that it succeeded), then wait for it with `gh run watch <databaseId> --exit-status`. If only the `attest` job failed, re-run the failed jobs; the image is already pushed. If `publish` failed, check whether `ghcr.io/atefandrus/disqord:v<version>` exists before acting, because a run can fail after an earlier run already pushed it (a full re-run stops at the existing-tag check): `docker manifest inspect ghcr.io/atefandrus/disqord:v<version>`. If the tag exists, Flux will deploy it; do not publish again. If it does not, production stays on the previous version, because Flux only picks up tags in the registry; fix the cause and re-run the workflow.
3. Production picks the image up through Flux (README's 本番へのデプロイ section): the image automation in `AtefAndrus/k8s-tenant-personal` writes the new tag and digest into `apps/disqord/statefulset.yaml` and the StatefulSet restarts `disqord-0`. The registry scan and the write-back each run every 30 minutes, so the restart can come tens of minutes after the run finishes. Do not wait for it inside this skill. Read `/health` at `ADMIN_API_BASE_URL` from `.env` once. The rollout is confirmed when it answers HTTP 200 with `version` `<version>`; no response means the new Pod is not Ready yet (the HTTP server starts after the Discord login, and the readiness probe keeps the Service from routing to it until then), and 503 with the same `version` means the running process has lost its Discord connection. Otherwise tell the user the rollout is pending and that this response confirms it.
4. Report the release URL to the user
