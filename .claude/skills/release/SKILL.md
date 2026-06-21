---
name: release
description: Run the DisQord release process. Use when cutting a new version (e.g. `/release 1.5.0`) — bumps the version, regenerates CHANGELOG.md, prunes released change docs, commits, tags, pushes, and publishes a GitHub release with hand-crafted Japanese notes.
disable-model-invocation: true
argument-hint: "[version e.g. 1.5.0]"
---

# Release Workflow

Create a new release for DisQord version v$ARGUMENTS.

## Pre-flight Checks

1. Confirm the working tree is clean: `git status`
2. Confirm all tests pass: `bun test`
3. Determine the previous version tag: `git describe --tags --abbrev=0`

## Step 1: Update package.json

Edit `package.json` to set `"version": "$ARGUMENTS"`.

## Step 2: Update CHANGELOG.md

Run `bun run changelog` to regenerate CHANGELOG.md from git history.

## Step 3: Update progress.md

Read `docs/progress.md` and remove any backlog items that were completed in this release.

## Step 4: Markdown Lint

Run `bun run format:md` to auto-fix any markdown formatting issues.

## Step 5: Commit and Tag

```bash
git add package.json CHANGELOG.md docs/progress.md
git commit -m "[release] bump version to v$ARGUMENTS"
git tag v$ARGUMENTS
git push && git push --tags
```

## Step 6: Create GitHub Release

Write release notes following these rules:

1. **Read the diff** to understand all changes since the previous tag:
   - `git log --oneline $(git describe --tags --abbrev=0 HEAD~1)..HEAD`
   - `git diff $(git describe --tags --abbrev=0 HEAD~1)..HEAD -- src/`
2. **Read existing releases** for style reference:
   - `gh release list --limit 3` then `gh release view <tag>` for recent examples
3. **Write notes in Japanese** with detailed, user-friendly descriptions:
   - Group by feature area with headers (e.g., `## UX改善`, `## 新機能`, `## バグ修正`)
   - Explain each change from the user's perspective, not the developer's
   - Include command syntax examples where relevant (e.g., `/config auto-reply add <channel>`)
   - Only include user-facing changes: new features, bug fixes, UX improvements
   - Exclude: test changes, refactoring, documentation, dependency updates, internal technical changes
4. **End with**: `**Full Changelog**: https://github.com/AtefAndrus/disqord/compare/v{previous}...v$ARGUMENTS`
5. **Create the release**:

```bash
gh release create v$ARGUMENTS --title "v$ARGUMENTS" --notes "..."
```

## Step 7: Verify

1. Confirm the release is published: `gh release view v$ARGUMENTS`
2. Report the release URL to the user
