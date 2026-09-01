---
name: dependabot-pr
description: Handle this repository's legacy Dependabot dependency-update pull requests when explicitly invoked.
disable-model-invocation: true
allowed-tools: Bash(gh pr view *), Bash(gh pr list *), Bash(gh pr checks *), Bash(gh pr diff *), Bash(gh api *), Bash(git fetch *), Bash(git checkout *), Bash(git merge *), Bash(git status *), Bash(git log *), Bash(git diff *), Bash(git branch *), Bash(bun install), Bash(bun test), Bash(bun lint), Bash(bun typecheck), Bash(bunx biome *), Read, Edit
---

Read and follow `../../../.agents/skills/dependabot-pr/SKILL.md`.
Forward any pull-request number or other invocation arguments to the shared workflow.
