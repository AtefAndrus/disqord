/**
 * End-to-end check against real Discord and the real LLM API.
 *
 * A second bot account (the "tester") posts into a dedicated channel over
 * REST, mentioning the bot under test, and the replies are read back over
 * REST and asserted on. Nothing here automates a user account: Discord
 * forbids that, and a bot can do everything these scenarios need except
 * clicking a button (see `stop`, which waits for a human to click).
 *
 * Usage:
 *   bun run e2e                 run the default scenarios (chat, long, image, pdf)
 *   bun run e2e chat pdf        run the named scenarios
 *   bun run e2e stop            post a long request and wait for someone to press 停止
 *   bun run e2e --no-spawn ...  use a bot that is already running instead of starting one
 *
 * The channel must be used by nothing else while this runs. Reply pages
 * carry no reference to the message that triggered them, so replies are
 * attributed by author and position alone; after a scenario errors or times
 * out the rest are skipped, because its late pages would be read as theirs.
 *
 * Not part of CI on purpose: it needs two bot tokens and an LLM key, costs
 * money per run, and its failures are as often the network or the model as
 * the code. The run ends by printing what it cost (see `cost.ts`).
 */
import { loadConfig } from "../../src/config";
import { formatCostSummary, readKeyUsage, type ScenarioCost, settledUsage } from "./cost";
import { createStopper, DeadlineError, waitForReply } from "./runner";
import {
  costOf,
  type DiscordMessage,
  modelOf,
  type Reply,
  SCENARIOS,
  type Scenario,
  toReply,
} from "./scenarios";

const API = "https://discord.com/api/v10";
const POLL_INTERVAL_MS = 2_500;
const REPLY_TIMEOUT_MS = 180_000;
const BOT_READY_TIMEOUT_MS = 30_000;
const BOT_EXIT_TIMEOUT_MS = 5_000;
const USAGE_POLL_INTERVAL_MS = 3_000;

const config = loadConfig();
const testerToken = process.env.E2E_TESTER_BOT_TOKEN;
const channelId = process.env.E2E_CHANNEL_ID;
const botId = config.applicationId;

function requireEnv(): void {
  const missing = [
    ["E2E_TESTER_BOT_TOKEN", testerToken],
    ["E2E_TESTER_BOT_ID", config.e2eTesterBotId],
    ["E2E_CHANNEL_ID", channelId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(", ")}. With NODE_ENV=production E2E_TESTER_BOT_ID is ignored.`,
    );
  }
}

function remaining(deadline: number): number {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new DeadlineError("the scenario deadline passed");
  return ms;
}

/** One Discord request. Rate-limit waits and the request itself count against `deadline`. */
async function discord(path: string, deadline: number, init: RequestInit = {}): Promise<Response> {
  while (true) {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bot ${testerToken}`, ...init.headers },
      signal: AbortSignal.timeout(remaining(deadline)),
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new DeadlineError("the scenario deadline passed during a Discord request");
      }
      throw error;
    });
    if (response.status !== 429) return response;
    const body = (await response.json().catch(() => ({}))) as { retry_after?: number };
    const waitMs = Math.ceil((body.retry_after ?? 1) * 1000);
    if (waitMs >= remaining(deadline)) {
      throw new DeadlineError("rate limited past the scenario deadline");
    }
    await Bun.sleep(waitMs);
  }
}

async function send(scenario: Scenario, deadline: number): Promise<string> {
  const payload = {
    content: `<@${botId}> ${scenario.prompt}`,
    allowed_mentions: { users: [botId] },
    attachments: (scenario.files ?? []).map((file, id) => ({ id, filename: file.name })),
  };
  const form = new FormData();
  form.set("payload_json", JSON.stringify(payload));
  for (const [index, file] of (scenario.files ?? []).entries()) {
    form.set(`files[${index}]`, new Blob([file.data], { type: file.type }), file.name);
  }
  const response = await discord(`/channels/${channelId}/messages`, deadline, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(`send failed: HTTP ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as DiscordMessage).id;
}

async function repliesAfter(messageId: string, deadline: number): Promise<Reply> {
  const response = await discord(
    `/channels/${channelId}/messages?after=${messageId}&limit=50`,
    deadline,
  );
  if (!response.ok) throw new Error(`read failed: HTTP ${response.status}`);
  const messages = ((await response.json()) as DiscordMessage[])
    .filter((message) => message.author.id === botId)
    .reverse();
  return toReply(messages);
}

interface RunningBot {
  stop: () => Promise<void>;
}

async function startBot(): Promise<RunningBot> {
  const child = Bun.spawn(["bun", "run", "src/index.ts"], { stdout: "pipe", stderr: "inherit" });
  const stop = createStopper(child, BOT_EXIT_TIMEOUT_MS, (ms) => Bun.sleep(ms));
  // Registered before waiting for readiness: an interrupt during startup
  // must not leave a bot connected to Discord for the next run to collide with.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stop().finally(() => process.exit(130));
    });
  }

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const loggedIn = (async (): Promise<boolean> => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      output += decoder.decode(value, { stream: true });
      if (output.includes("logged in")) return true;
    }
  })();
  // Raced against a timer: a bot that stalls without printing anything would
  // otherwise keep `reader.read()` pending forever, deadline or not.
  const ready = await Promise.race([
    loggedIn,
    child.exited.then(() => false),
    Bun.sleep(BOT_READY_TIMEOUT_MS).then(() => false),
  ]);
  if (!ready) {
    await stop();
    throw new Error(`the bot did not log in within ${BOT_READY_TIMEOUT_MS / 1000}s:\n${output}`);
  }
  // Keep draining so the child never blocks on a full stdout pipe.
  void loggedIn.then(async () => {
    while (!(await reader.read()).done) {
      // discard
    }
  });
  return { stop };
}

async function main(): Promise<number> {
  requireEnv();
  const args = process.argv.slice(2);
  const spawn = !args.includes("--no-spawn");
  const names = args.filter((arg) => !arg.startsWith("--"));
  const unknown = names.filter((name) => !SCENARIOS.some((scenario) => scenario.name === name));
  if (unknown.length > 0) throw new Error(`unknown scenario: ${unknown.join(", ")}`);
  const selected = SCENARIOS.filter((scenario) =>
    names.length > 0 ? names.includes(scenario.name) : !scenario.manual,
  );

  const usageBefore = await readKeyUsage(config.openRouterApiKey).catch((error: unknown) => {
    console.log(
      `  cost: could not read the OpenRouter key's usage: ${error instanceof Error ? error.message : error}`,
    );
    return undefined;
  });
  const costs: ScenarioCost[] = [];
  const bot = spawn ? await startBot() : undefined;
  let failures = 0;
  try {
    for (const [index, scenario] of selected.entries()) {
      const startedAt = Date.now();
      const deadline = startedAt + (scenario.timeoutMs ?? REPLY_TIMEOUT_MS);
      try {
        const messageId = await send(scenario, deadline);
        if (scenario.manual) console.log(`  ${scenario.name}: waiting for a manual action…`);
        const reply = await waitForReply({
          read: () => repliesAfter(messageId, deadline),
          pause: () => Bun.sleep(Math.min(POLL_INTERVAL_MS, remaining(deadline))),
          log: console.log,
        });
        const problems = scenario.check(reply);
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        const cost = costOf(reply);
        costs.push({ name: scenario.name, cost });
        if (problems.length === 0) {
          console.log(
            `PASS ${scenario.name} (${seconds}s, ${reply.messages.length} message(s), model ${modelOf(reply) ?? "unknown"}, cost ${cost === undefined ? "unknown" : `$${cost.toFixed(6)}`})`,
          );
        } else {
          failures++;
          console.log(`FAIL ${scenario.name} (${seconds}s)`);
          for (const problem of problems) console.log(`     - ${problem}`);
          console.log(`     reply: ${reply.body.replace(/\s+/g, " ").slice(0, 300)}`);
          console.log(`     footers: ${reply.footers.join(" / ").slice(0, 300)}`);
        }
      } catch (error) {
        failures++;
        costs.push({ name: scenario.name, cost: undefined });
        console.log(`FAIL ${scenario.name}: ${error instanceof Error ? error.message : error}`);
        // Whatever went wrong, the state of this scenario's reply is unknown
        // (even a failed POST may have been accepted), so nothing after it
        // can be attributed safely.
        const skipped = selected.slice(index + 1).map((s) => s.name);
        if (skipped.length > 0) {
          failures += skipped.length;
          console.log(
            `SKIP ${skipped.join(", ")}: late pages of "${scenario.name}" could be read as theirs`,
          );
          break;
        }
      }
    }
  } finally {
    await bot?.stop();
  }
  for (const line of formatCostSummary(costs, await usageDelta(usageBefore, costs))) {
    console.log(line);
  }
  return failures === 0 ? 0 : 1;
}

/** The change in the key's usage since `before`, once it has settled. Never fails the run. */
async function usageDelta(
  before: number | undefined,
  costs: ScenarioCost[],
): Promise<{ amount: number; settled: boolean } | undefined> {
  if (before === undefined) return undefined;
  const reported = costs.reduce((sum, { cost }) => sum + (cost ?? 0), 0);
  try {
    const { usage, settled } = await settledUsage(
      {
        read: () => readKeyUsage(config.openRouterApiKey),
        pause: () => Bun.sleep(USAGE_POLL_INTERVAL_MS),
      },
      before + reported,
      costs.filter(({ cost }) => cost !== undefined).length,
    );
    return { amount: usage - before, settled };
  } catch (error) {
    console.log(
      `  cost: could not read the OpenRouter key's usage: ${error instanceof Error ? error.message : error}`,
    );
    return undefined;
  }
}

process.exit(await main());
