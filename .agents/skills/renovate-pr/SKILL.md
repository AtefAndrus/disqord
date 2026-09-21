---
name: renovate-pr
description: Inspect, refresh, verify, and merge this repository's Renovate dependency-update PRs. Use for Renovate PR review, BEHIND branches, dependency-update conflicts, or grouped Bun, Biome, GitHub Actions, and zizmor updates.
---

# Renovate PR Handler

## Repository invariants

- `main` requires the `quality`, `actions-security`, and `docker-build` checks with strict base-branch freshness.
- Use merge commits with `gh pr merge <N> --merge` unless the user requests another supported method.
- Renovate groups non-major updates, digests, the Bun toolchain, and the zizmor action/CLI pair according to `renovate.json5`.
- Renovate updates Biome's package and `biome.json` schema together, but configuration migrations can still require a manual change when CI reports one.
- The Bun toolchain PR must keep the exact patch aligned across `mise.toml`, the Dockerfile tag, `bun-types`, and the resolved lockfile entry; CI enforces this invariant.

## Review and merge

1. Confirm that the author is `app/renovate`, inspect every changed file, and read the Dependency Dashboard for pending or grouped updates.
2. Check that dependency changes are limited to the declared manifests, lockfile, paired schema, and expected workflow pins.
3. For GitHub Actions, require a full commit SHA with the matching version comment and inspect changes to `with.version` inputs.
4. For Biome, require the package version and `biome.json` schema URL to match.
5. For Bun, require `mise.toml`, `Dockerfile`, `package.json`, and `bun.lock` to move as one compatible group.
6. If the PR is `BEHIND`, run `gh pr update-branch <N>` or request a Renovate rebase from the Dependency Dashboard.
7. Read the `lock-age` job's summary or its warnings for the current head. Resolve every added version published under three days ago or marked as not checked before merging; the job never fails, so a green check does not mean the lock was reviewed.
8. Wait for checks on the current head, then confirm that the head SHA has not changed and `mergeStateStatus` is `CLEAN` before merging.
9. Merge with `gh pr merge <N> --merge` and verify the post-merge `main` CI.

Renovate can force-push an updated dependency set between verification and merge.
If GitHub rejects a merge as out of date, read the branch ref and current head again, wait for checks attached to that exact commit, and retry only after the PR becomes `CLEAN`.

## Commands

```bash
gh pr view <N> --json author,files,headRefOid,mergeable,mergeStateStatus,statusCheckRollup
gh pr diff <N>
gh issue view 75
gh pr update-branch <N>
gh pr checks <N> --watch
gh pr merge <N> --merge
```

## Checking a `renovate.json5` change locally

Run a lookup against a copy of the working tree, never the tree itself:

```bash
RENOVATE_X_IGNORE_RE2=true LOG_LEVEL=debug LOG_FORMAT=json GITHUB_COM_TOKEN=$(gh auth token) \
  npx --yes renovate@<version> --platform=local --dry-run=lookup > lookup.json
```

- Delete the `hostRules` entry from the copy's `renovate.json5`. Its `{{ secrets.TAKUMI_GUARD_TOKEN }}` exists only in the Mend Portal, and a local run stops with `Unknown secrets name`. The registry proxy accepts anonymous requests from a local IP.
- Commit the copy's changes; the local platform reads files through git.
- Read the `packageFiles with updates` entry: each dependency's `updates[]` gives `updateType`, `newValue`, and `pendingChecks`.
- To see whether the cooldown applies to an update, raise `minimumReleaseAge` on the copy and check that a version younger than the new value turns `pendingChecks: true`.

Do not push dependency edits directly to `main` or bypass required checks.
