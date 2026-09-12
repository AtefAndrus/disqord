# DisQord

Discord bot that answers in a channel by relaying the conversation to an LLM through OpenRouter.

Read [docs/progress.md](docs/progress.md) first for the active backlog.
The command list and environment variables are in [README.md](README.md), management API operations in [docs/admin-api.md](docs/admin-api.md), and per-feature designs in `docs/changes/<name>/design.md`.

## Commands

```bash
mise run setup     # bun install and create .env from .env.example
bun dev            # watch mode
bun start          # production start
bun run test       # typecheck, then the test suite
bun run lint       # biome check
bun run format     # biome format --write
bun run lint:md    # markdownlint-cli2
bun run preview    # render the bot's UI to PNG under .preview/
```

- `bun test` runs bun's built-in runner and skips the typecheck. `bun run test` is the one that does both.
- `bun run preview` renders what `embedBuilder` / `statusMessage` / `buttonBuilder` actually produce, so a UI change can be reviewed by reading the PNGs instead of by starting the bot.

## Conventions that differ from defaults

- File names are camelCase (`chatService.ts`), classes PascalCase, interfaces are `I` + PascalCase (`IChatService`), constants UPPER_SNAKE_CASE.
- Data access goes through a repository, business logic through a service, and dependencies are passed by constructor injection.
- Give functions explicit return types, use `import type` for type-only imports, and do not use `any`.
- Biome owns formatting and import order. Do not hand-tune either.
- Replies longer than a Discord message must go through the splitter in `src/utils/message.ts` rather than a new length check.

## Generated files

`bun scripts/generate-readme.ts` fills the `<!-- AUTO:*:START/END -->` sections of README.md, this file, `.env.example`, and docs/progress.md from `src/bot/commands/` and `src/config/envVars.ts`.
The pre-commit hook runs it and stages the results, so edit the source instead of the generated block.

Deleting an AUTO marker breaks every commit in the repository: the generator throws `Marker not found` and the hook fails before anything else runs.

## docs/changes (per-feature design docs)

- One folder per change, `docs/changes/<kebab-case-name>/design.md`, copied from [TEMPLATE.md](docs/changes/TEMPLATE.md). The template owns the frontmatter schema and the section list; the title heading is the Japanese feature name.
- `status` moves `investigating` (design under discussion) → `planned` (design settled) → `in-progress` (implementation started) → `implemented` (merged to main).
- The backlog in docs/progress.md is generated from that frontmatter and lists every unreleased folder, so a change that is implemented but not yet released still appears there.
- The folder is the unit of backlog item, release, and deletion, so split by release unit rather than by document size. Sub-features that ship together stay in one folder, separated by `---` in the Design section, or move to `design.<subfeature>.md` with `design.md` as the index when they are large and share a core. Split a sub-feature into its own folder only when it will ship separately.
- Delete the folder at release, as the last item in Tasks. Git history is the archive.

## Testing

- `bun:test`, with tests under `tests/`.
- Replace `fetch` globally with `mock()`, open SQLite as `:memory:`, implement repository and service interfaces with `mock()`, and assert console output with `spyOn()`.

## Git

- Commit subjects are English, in the form `[type] short description`.
- PR titles and bodies are Japanese, and the title carries the same `[type]` prefix. Squash merge turns the PR title into the commit subject, and `cliff.toml` lists no catch-all parser, so a subject without a prefix matches no CHANGELOG group.
- `[feat]` → Added, `[fix]` → Fixed, `[docs]` → Documentation, `[refactor]` → Refactoring, `[test]` → Testing, `[perf]` → Performance. `[chore]` and `[release]` are skipped, and Renovate's `build(deps...)` goes to Dependencies. `cliff.toml` is the source of truth.
- Direct commits to `main` are blocked by lefthook (`00_guard-branch`). Work on a branch and open a PR.

## Release

Run the `/release` skill with the target version, for example `/release 1.5.0`.
It owns the whole procedure, including the one intentional `LEFTHOOK=0` commit on `main`.
GitHub Releases use GitHub's automatically generated notes; the workflow does not manually curate Japanese notes or deliver them to Discord.

## Gotchas

- `mise.toml` pins bun and is the source of truth. The `Dockerfile` tag and `bun.lock`'s `bun-types` must be the same exact patch, or CI's drift check fails. Neither side may use a floating spec: `1.3` in mise resolves to the newest 1.3.x with no file edit, and a tag such as `1.3-slim` can move when only its digest changes.
- `biome.json`'s `$schema` must match the exact `@biomejs/biome` version in `package.json`. Biome reports the mismatch as info and exits 0, so CI promotes it to a failure.
- SQLite runs in WAL mode.
- Dependencies update through Renovate (`renovate.json5`); there is no `dependabot.yml`. Dependabot security updates are off, so vulnerability PRs come from Renovate as well. GitHub raises no alert for SHA-pinned actions, so those move on version updates rather than alerts.
<!-- AUTO:DEFAULT_MODEL:START -->
- Default model: `google/gemma-4-26b-a4b-it:free`
<!-- AUTO:DEFAULT_MODEL:END -->
