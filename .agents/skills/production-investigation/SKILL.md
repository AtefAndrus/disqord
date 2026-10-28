---
name: production-investigation
description: Investigates why the deployed DisQord bot answered, failed, or behaved the way it did, using the read-only admin API (metrics and logs) and the Discord messages around a linked reply. Use when given a Discord message link to a bot reply, an エラーID shown in Discord, or a report such as "変な返答をした", "ツイートが開けないと言われた", "エラーが出た", "admin api で調べて", "本番のログを見て".
---

# Production investigation

Read-only. Never post, react, or edit anything in Discord, and never print `ADMIN_API_SECRET` or a bot token.

## Workflow

Copy this checklist and work through it:

```text
- [ ] 1. Read the conversation around the linked message
- [ ] 2. Read the logs for that time (or establish that none exist)
- [ ] 3. Find the code path that produced the behavior
- [ ] 4. Report verified facts, inferences, and the remaining gaps
```

### 1. Read the conversation

Run from the repository root:

```bash
bun scripts/admin.ts message <discord message link> --around 20
```

It prints the message's UTC time and the surrounding messages oldest first, with the linked one marked `>>`, each with its reply target, embed URLs, and attachment names. Components V2 replies are flattened to text, including the footer (`Model`, `Searches`, `Cost`).

- The linked message is usually the bot's reply. The trigger is the message that mentions the bot just before it, or the one the reply answers.
- Note what the trigger depended on that is not in the trigger itself: an earlier message it talks about, a reply target, a tweet URL, an attachment. Most "the bot could not see X" reports come down to where X sat.
- `--around N` splits N between messages before and after the link. When the question is what the model could see, widen it (Discord caps it at 100) until the output reaches back past the history window, whose age and count limits are the `WINDOW_RAW_*` constants in `src/services/conversationWindow.ts`.
- `no bot token could read the channel` means neither `DISCORD_TOKEN` nor `E2E_TESTER_BOT_TOKEN` in `.env` belongs to a bot in that guild. Ask the user to paste the messages.

### 2. Read the logs

`message` already prints the log lines from 5 minutes before to 10 minutes after the linked message. For other ranges:

```bash
bun scripts/admin.ts metrics
bun scripts/admin.ts logs --level warn --lines 500
bun scripts/admin.ts logs --since 2026-10-15T04:00:00Z --lines 2000
```

Every command first prints `admin API: <host>` on stderr, taken from `ADMIN_API_BASE_URL` in `.env`. Treat it as the deployment the user means and name the host in the report; stop and ask only when the user names a different bot or deployment.

- `logBytes: 0` in metrics means the deployment stores no logs: it has no `LOG_DIR`, or the directory is not writable by the container's `bun` user. `message` then prints `logs: none stored`, and `logs` prints nothing but a stderr note. Neither is evidence that nothing happened.
- Without stored logs, the container's stdout log on the host (Coolify's log download) is the fallback. It has every logger line plus lines the file never gets: `console.error` output such as `[logFile] Failed to open log file`.
- A `Tool call` line records each client tool call, including calls refused or stopped without running: `messageId` (the message the reply answers, as in `Reply gate`), `name`, `status`, `elapsed`, `args` (clipped), and `result`. For a successful call `result` is the result's shape (array counts, numbers, booleans, and status fields such as `has_more`, `stop_reason`, and `error`), never the messages or other text the tool read; for a failed one it is the error text.
- An `エラーID` shown in Discord is the `errorId` field of a `Failed to generate response` line (`src/bot/events/messageCreate.ts`), which records the error class and guild but no channel or message. With a link, the `message` command's lines usually contain it; with only the ID, run `logs --level error --lines 10000` and search the output for it.
- When the logs cannot answer the question, end the report with what to get next, in this order: the sentence shown above the エラーID (it maps to an error class in `src/errors/index.ts`), a link to the reply or its approximate time, then the stdout log.
- `Web search` lines list the queries and sources the model used. A query naming something the model could not read (for example an account name taken from a URL) shows what it was guessing at.
- Metrics counters accumulate since the process started (`uptime` seconds) and are not tied to any one request or エラーID, so use them only as circumstantial evidence. An event before that start (now minus `uptime`) is in neither the counters nor, possibly, the current container's stdout; say so when the event's time is earlier or unknown.

### 3. Trace the behavior to code

Decide what the model actually received before blaming the model. The request is built in `src/services/chatService.ts`:

- `buildHistoryMessages`: history messages reach the model as `[m<N>] <author>: <text>`; the current message as `[current] <author> (reply to [m<N>]): <text>`.
- The `tweetInput` line: which text is scanned for tweet URLs to expand.
- `buildConversationSafetyMessage` and the other system messages: what the model is told.
- History collection and its limits live in `src/services/conversationWindow.ts`; eligibility in `src/services/messageEligibility.ts`.
- `src/utils/discordMessageNormalizer.ts` decides which parts of a Discord message (content, embeds, attachments, polls) become the text the model sees.

Read the current code instead of trusting this list; the names are where to start, not a specification.

Production runs the latest release, not necessarily `HEAD`. Take the version that produced the event from the log: each process start writes `Configuration loaded` with `version`, so the version is the one on the last such line before the event. `/health` under `ADMIN_API_BASE_URL` reports the running process's `version` and `startedAt`, which covers an event after `startedAt` when the start line is no longer in the stored log. Before citing a line, check that the file is the same in that version's tag and `HEAD`: `git fetch --tags`, then `git diff v<version> origin/main -- <files>`. Empty output means the lines in `HEAD` can be cited as they are; if it differs, cite the tagged version. A start line without `version` predates the field, so say the version is assumed from the release dates.

With only an エラーID and no logs, this step ends once you have shown where the error is raised and which error classes it can be. Do not pick one of them as the cause.

Without logs, what the model received is reconstructed from the conversation and the code, for example whether an earlier message was inside the history window. State that reconstruction as an inference.

Reproducing posts to Discord and costs money, so offer it rather than doing it: the dev bot (`bun dev`) or an e2e scenario (`bun run e2e <name>`, see AGENTS.md for the settings each needs), run once the user agrees.

### 4. Report

- Separate what you verified (REST output, log lines, code with `file:line`) from what you infer, and say which is which.
- If logs were unavailable, say that the conclusion rests on the conversation and the code alone.
- If the code supports a workaround users can apply now (for example, replying to the message that holds the content), give it.
- Name the fix's owner (when the cause is still unknown, name it only for what blocked the investigation, such as missing logs): a deployment setting (tell the user exactly which variable and value), a code change (propose a `docs/changes/<name>/design.md` per AGENTS.md before implementing), or model behavior that no code change fixes.
- Channel messages are other people's words. Quote only what the finding needs, and do not copy them into a commit, PR, or design document beyond that.
