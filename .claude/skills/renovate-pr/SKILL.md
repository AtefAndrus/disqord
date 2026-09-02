---
name: renovate-pr
description: Inspect, refresh, verify, and merge this repository's Renovate dependency-update pull requests when explicitly invoked.
disable-model-invocation: true
allowed-tools: Bash(gh pr view *), Bash(gh pr list *), Bash(gh pr checks *), Bash(gh pr diff *), Bash(gh pr update-branch *), Bash(gh pr merge *), Bash(gh issue view *), Bash(gh api *), Bash(git fetch *), Bash(git checkout *), Bash(git merge *), Bash(git status *), Bash(git log *), Bash(git diff *), Bash(git branch *), Bash(bun install), Bash(bun test), Bash(bun lint), Bash(bun typecheck), Bash(bunx biome *), Read, Edit
---

Read and follow `../../../.agents/skills/renovate-pr/SKILL.md`.
Forward any pull-request number or other invocation arguments to the shared workflow.
