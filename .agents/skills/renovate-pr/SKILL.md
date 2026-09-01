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
7. Wait for checks on the current head, then confirm that the head SHA has not changed and `mergeStateStatus` is `CLEAN` before merging.
8. Merge with `gh pr merge <N> --merge` and verify the post-merge `main` CI.

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

Do not push dependency edits directly to `main` or bypass required checks.
