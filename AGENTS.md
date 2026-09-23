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
bun run e2e        # drive the real bot through Discord with a tester bot (not in CI)
```

- `bun test` runs bun's built-in runner and skips the typecheck. `bun run test` is the one that does both.
- `bun run preview` renders what `embedBuilder` / `statusMessage` / `buttonBuilder` / `chatContainerBuilder` actually produce, so a UI change can be reviewed by reading the PNGs instead of by starting the bot. `scripts/` is in `tsconfig.json`'s `include`, so `bun run typecheck` fails when a preview fixture imports a symbol a UI module no longer exports.

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
- Work to be picked up later is written here, not opened as a GitHub Issue: the backlog lives in these folders, and the Issue templates under `.github/ISSUE_TEMPLATE/` are for reports from outside.
- `status` moves `investigating` (design under discussion) → `planned` (design settled) → `in-progress` (implementation started) → `implemented` (merged to main).
- The backlog in docs/progress.md is generated from that frontmatter and lists every unreleased folder, so a change that is implemented but not yet released still appears there.
- The folder is the unit of backlog item, release, and deletion, so split by release unit rather than by document size. Sub-features that ship together stay in one folder, separated by `---` in the Design section, or move to `design.<subfeature>.md` with `design.md` as the index when they are large and share a core. Split a sub-feature into its own folder only when it will ship separately.
- Delete the folder at release, as the last item in Tasks. Git history is the archive.

## Testing

- `bun:test`, with tests under `tests/`.
- Replace `fetch` globally with `mock()`, open SQLite as `:memory:`, implement repository and service interfaces with `mock()`, and assert console output with `spyOn()`.
- `src/config/index.ts` loads `.env` when it is imported, so locally every test runs with your `.env` while CI has none, and `bun test` sets `NODE_ENV=test`, which the config schema rejects. A test that calls `loadConfig()` sets every variable it depends on, `NODE_ENV` included. Move `.env` aside and run `bun run test` to reproduce CI.

### End-to-end (`bun run e2e`)

- A second bot account posts into a dedicated channel over REST and the replies are read back over REST. Nothing else may use that channel during a run: reply pages carry no reference to their trigger, so replies are attributed by author and position. It starts the bot itself, so stop any running dev bot first or pass `--no-spawn`. It needs `E2E_TESTER_BOT_TOKEN`, `E2E_TESTER_BOT_ID`, and `E2E_CHANNEL_ID` in `.env`, and the tester bot needs the Message Content intent.
- The guild under test must have `/config llm-details` on: the usage footer is how the script recognises a finished reply, and without it every scenario times out.
- It runs on whatever model the development guild has set with `/model set`; nothing in the script pins one. Use `google/gemini-3.5-flash-lite` by default (cheap, and it takes text, tools, images, and PDFs). Switching to something temporarily cheaper is fine, but avoid `:free` models, whose upstream 429s fail the run for reasons unrelated to the code. Each PASS line prints the model that actually answered and its cost, and the run ends with a `COST` line; `scripts/e2e/cost.ts` says what each figure covers.
- Run it before merging a PR that touches `src/llm/`, `src/bot/`, or `src/services/`, and put the result in the PR body.
- `bun run e2e search` runs only when named: it needs `/config web-search on` in the guild under test (turn it off afterwards) and pays for each search. Run it, in addition to the default scenarios, before merging a PR that changes web search: `src/llm/tools/webSearch.ts`, how `openrouter.ts` or `toolLoop.ts` handle server tools, or how search results are shown. It stays out of the default run because the default run cannot switch the guild setting and every PR would pay for searches. It checks the date of a fixed past release, so a model that already knows the date still passes. It also looks for the result links under the answer, because `Searches: N` in the footer counts search calls, including ones that were refused or returned nothing; that check matches text, so it catches links missing from the reply rather than proving the bot appended them. `google/gemini-3.5-flash-lite` sometimes gets the year wrong even after searching.
- `bun run e2e history-set history-recall history-window read-earlier view-attachment view-image` runs only when named, and `history-set` and `history-recall` must be named in the same run. The history scenarios need `/config history on` in the guild under test (turn it off afterwards). `history-set` posts a passphrase and `history-recall` asks for it back through the Discord window, `history-window` checks that an unmentioned tester message is included, `read-earlier` checks an older message through the client tool, and `view-attachment` and `view-image` check that a previously posted PDF and image are opened through the client tool. `view-image` fails on a model that silently drops images returned by a tool (`openai/gpt-6-luna` did on 2026-09-23), so its FAIL line names the model that answered: rerun on a model known to read tool-returned images (`google/gemini-3.8-flash` did) before treating a failure as a code regression. Run the named scenarios, in addition to the default scenarios, before merging a PR that changes history reading or eligibility (`src/services/conversationWindow.ts`, `src/services/messageEligibility.ts`, `src/services/replyRecordService.ts`, `src/llm/tools/readEarlierMessages.ts`, `src/llm/tools/viewAttachment.ts`, or the history paths in `chatService.ts` and `messageCreate.ts`).
- It is deliberately not in CI: it needs two bot tokens and an LLM key in Actions, costs money per run, and fails as often from the network or the model as from the code.
- Do not automate a user account (Playwright against the web client, self-bots). Discord forbids it and terminates accounts for it. A bot can do everything except click a component.
- The bot answers another bot only when its ID equals `E2E_TESTER_BOT_ID` and the message mentions the bot with non-empty text, and the config loader drops that setting when `NODE_ENV=production`.

### Manual checks

- What only a human can do (clicking a button in a real client, judging how something looks) never blocks a merge. Record it in the design's Tasks as `- [ ] 手動確認: ...`, keep the design's `status` at `in-progress`, and carry on.
- A change with no design folder that still leaves a manual check gets a new `docs/changes/<kebab-name>/design.md` whose Tasks hold that check (`status: in-progress`). `/release` finds manual checks only under `docs/changes/`, so a check written only in a PR body is never listed.
- Manual checks gate the release instead: `/release` lists every open `手動確認` task and stops until the user has done them. `deploy.yml` runs on a published Release, so a merge alone never reaches production. Its `workflow_dispatch` trigger deploys without going through `/release`; whoever runs it by hand owns checking the open `手動確認` tasks first.
- Make the check one action for the user. `bun run e2e stop` posts a long request and waits up to ten minutes for someone to press 停止, then verifies the stopped state itself.

## Git

- Commit subjects are English, in the form `[type] short description`.
- PR titles and bodies are Japanese, and the title carries the same `[type]` prefix. Squash merge turns the PR title into the commit subject, and `cliff.toml` lists no catch-all parser, so a subject without a prefix matches no CHANGELOG group.
- `[feat]` → Added, `[fix]` → Fixed, `[docs]` → Documentation, `[refactor]` → Refactoring, `[test]` → Testing, `[perf]` → Performance. `[chore]` and `[release]` are skipped, and Renovate's `build(deps...)` goes to Dependencies. `cliff.toml` is the source of truth.
- Direct commits to `main` are blocked by lefthook (`00_guard-branch`). Work on a branch and open a PR.

## Release

Run the `/release` skill with the target version, for example `/release 1.5.0`.
It owns the whole procedure, including the one intentional `LEFTHOOK=0` commit on `main`.
A GitHub Release's notes are that version's CHANGELOG section from git-cliff, so the notes and CHANGELOG.md say the same thing, grouped by the `[type]` prefix. They therefore carry CHANGELOG's filtering: `[chore]` and `[release]` commits are left out, and there is no contributor attribution. GitHub's generated notes, as this repository had them (no labels, no `.github/release.yml`), listed every merged PR in merge order with no grouping. The workflow does not curate notes by hand or deliver them to Discord.
The group order in `cliff.toml` comes from the `<!-- n -->` prefix on each group name, which the template strips.

## Gotchas

- `mise.toml` pins bun and is the source of truth. The `Dockerfile` tag and `bun.lock`'s `bun-types` must be the same exact patch, or CI's drift check fails. Neither side may use a floating spec: `1.3` in mise resolves to the newest 1.3.x with no file edit, and a tag such as `1.3-slim` can move when only its digest changes.
- `biome.json`'s `$schema` must match the exact `@biomejs/biome` version in `package.json`. Biome reports the mismatch as info and exits 0, so CI promotes it to a failure.
- SQLite runs in WAL mode.
- CI's `lock-age` job warns, without failing, about any version a PR adds to `bun.lock` (transitive ones included) that was published under three days ago. Renovate's cooldown covers only the direct dependency it picks, so the warning is where a fresh transitive version shows up. Read it before merging any PR that changes `bun.lock`; the `renovate-pr` skill's merge procedure includes this step.
- Dependencies update through Renovate (`renovate.json5`); there is no `dependabot.yml`. Dependabot security updates are off, so vulnerability PRs come from Renovate as well. GitHub raises no alert for SHA-pinned actions, so those move on version updates rather than alerts.
- OpenRouter's guide pages and its OpenAPI definition disagree in places, and the definition is the one that matches the live API. Take field names, enums, and defaults from `https://openrouter.ai/openapi.json`; use the guide pages for semantics. Observed 2026-09-18: the server-tools guide reports consumption under `usage.server_tool_use` while `ChatUsage` defines `server_tool_use_details` (the API returns the latter), `max_tool_calls` is documented as a top-level Chat Completions field but is absent from `ChatRequest`, and the `tools` / `max_tool_calls` parameters the advisor guide lists do not exist in `AdvisorServerToolConfig`.
- `https://openrouter.ai/docs/llms.txt` indexes the doc pages. Resolve a page URL there rather than guessing one.
- Pick OpenRouter models for a live check from `GET https://openrouter.ai/api/v1/models`, not from memory: read `description`, `architecture.input_modalities`, and `supported_parameters`, and take each provider's current general-purpose model. Model ids recalled from training are usually a generation or more old, and filtering by price alone returns coding-agent or preview variants.
<!-- AUTO:DEFAULT_MODEL:START -->
- Default model: `google/gemma-4-26b-a4b-it:free`
<!-- AUTO:DEFAULT_MODEL:END -->
