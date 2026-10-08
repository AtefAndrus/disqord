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
import {
  formatCostSummary,
  observeUsage,
  readKeyUsage,
  type ScenarioCost,
  type UsageState,
} from "./cost";
import { cleanupLateCronProposals, type ScenarioEnv } from "./cron";
import {
  BOT_CONTEXT_PREFIX,
  checkInput,
  type InputEvidence,
  type InputObservation,
  parseInputLine,
  selectInput,
} from "./input";
import { createStopper, DeadlineError, waitForReply, waitForStreaming } from "./runner";
import {
  costOf,
  type DiscordMessage,
  modelOf,
  type Reply,
  SCENARIOS,
  type Scenario,
  type ScenarioPost,
  toReply,
} from "./scenarios";
import { messagePayload, sendScenario } from "./send";

const API = "https://discord.com/api/v10";
const FAILURE_DIR = ".e2e-failures";

/**
 * The one-line `reply:` summary flattens whitespace and component
 * boundaries, so it cannot tell a model that wrote something unexpected from
 * a renderer that mishandled it. The saved pages keep both.
 */
async function saveFailedReply(name: string, reply: Reply): Promise<string> {
  const path = `${FAILURE_DIR}/${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  try {
    await Bun.write(path, `${JSON.stringify(reply.messages, null, 2)}\n`);
    return path;
  } catch (error) {
    return `not saved (${error instanceof Error ? error.message : error})`;
  }
}

async function saveFailedInput(name: string, evidence: InputEvidence): Promise<string> {
  const path = `${FAILURE_DIR}/${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.input.json`;
  try {
    await Bun.write(
      path,
      `${JSON.stringify(
        {
          marker: evidence.marker,
          testerHistoryExemptionDisabled: evidence.botContextMarkers?.has(evidence.marker) ?? false,
          initialRequest: selectInput(evidence) ?? null,
          observations: evidence.observations ?? null,
        },
        null,
        2,
      )}\n`,
    );
    return path;
  } catch (error) {
    return `not saved (${error instanceof Error ? error.message : error})`;
  }
}
const POLL_INTERVAL_MS = 2_500;
const REPLY_TIMEOUT_MS = 180_000;
const BOT_READY_TIMEOUT_MS = 30_000;
const BOT_EXIT_TIMEOUT_MS = 15_000;
/** docker stop's default grace period, which the bot's shutdown wait is sized to fit. */
const SHUTDOWN_EXIT_LIMIT_S = 10;
const USAGE_POLL_INTERVAL_MS = 3_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const INTERRUPT_CLEANUP_TIMEOUT_MS = 10_000;

const config = loadConfig();
const testerToken = process.env.E2E_TESTER_BOT_TOKEN;
const channelId = process.env.E2E_CHANNEL_ID;
const botId = config.applicationId;
const interruption = new AbortController();
const env: ScenarioEnv = {
  databasePath: config.databasePath,
  testerBotId: config.e2eTesterBotId ?? "",
  interrupted: interruption.signal,
};

/**
 * What an interrupt undoes before the process exits: first the running
 * scenario's cleanup, since rows it inserted into the bot's database would
 * otherwise stay and run later, then the bot this script started. The
 * scenario keeps running meanwhile, so it is told through `env.interrupted`
 * not to insert anything more.
 */
const interrupt: { cleanup?: () => Promise<unknown>; stopBot?: () => Promise<void> } = {};

/** Run after the bot is stopped, whichever way the run ends; see `cleanupLateCronProposals`. */
function lateCleanup(): void {
  for (const problem of cleanupLateCronProposals(env)) console.log(`     cleanup: ${problem}`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    interruption.abort();
    void (async (): Promise<void> => {
      console.log(`${signal}: cleaning up before exit`);
      await Promise.race([
        interrupt.cleanup?.().catch(() => undefined),
        Bun.sleep(INTERRUPT_CLEANUP_TIMEOUT_MS),
      ]);
      await interrupt.stopBot?.();
      lateCleanup();
      process.exit(130);
    })();
  });
}

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

async function post(
  message: ScenarioPost,
  deadline: number,
  replyTo?: string,
): Promise<DiscordMessage> {
  const payload = messagePayload(message, botId, replyTo);
  const form = new FormData();
  form.set("payload_json", JSON.stringify(payload));
  for (const [index, file] of (message.files ?? []).entries()) {
    form.set(`files[${index}]`, new Blob([file.data], { type: file.type }), file.name);
  }
  const response = await discord(`/channels/${channelId}/messages`, deadline, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(`send failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as DiscordMessage;
}

async function repliesAfter(
  messageId: string,
  deadline: number,
  exclude: Scenario["excludeFromReply"],
): Promise<Reply> {
  const response = await discord(
    `/channels/${channelId}/messages?after=${messageId}&limit=50`,
    deadline,
  );
  if (!response.ok) throw new Error(`read failed: HTTP ${response.status}`);
  const messages = ((await response.json()) as DiscordMessage[])
    .filter((message) => message.author.id === botId && ((message.flags ?? 0) & (1 << 15)) !== 0)
    .filter((message) => !exclude?.(message))
    .reverse();
  return toReply(messages);
}

interface RunningBot {
  stop: () => Promise<void>;
  /** How the child ended; both null while it is still running. */
  exitStatus: () => { exitCode: number | null; signalCode: string | null };
  toolCalls: Set<string>;
  inputs: InputObservation[];
  botContextMarkers: Set<string>;
}

async function startBot(): Promise<RunningBot> {
  const child = Bun.spawn(["bun", "--preload", "./scripts/e2e/preload.ts", "./src/index.ts"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const stop = createStopper(child, BOT_EXIT_TIMEOUT_MS, (ms) => Bun.sleep(ms));
  // Set before waiting for readiness: an interrupt during startup
  // must not leave a bot connected to Discord for the next run to collide with.
  interrupt.stopBot = stop;

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Set<string>();
  const inputs: InputObservation[] = [];
  const botContextMarkers = new Set<string>();
  let pending = "";
  let output = "";
  const inspect = (chunk: string): void => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const input = parseInputLine(line);
      if (input) inputs.push(input);
      if (line.startsWith(BOT_CONTEXT_PREFIX))
        botContextMarkers.add(line.slice(BOT_CONTEXT_PREFIX.length));
      for (const match of line.matchAll(/client tool invoked.*?name["']?[:=]\s*["']?([\w-]+)/g)) {
        const name = match[1];
        if (name) toolCalls.add(name);
      }
    }
  };
  const loggedIn = (async (): Promise<boolean> => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      const chunk = decoder.decode(value, { stream: true });
      output += chunk;
      inspect(chunk);
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
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      inspect(decoder.decode(value, { stream: true }));
    }
  });
  return {
    stop,
    exitStatus: () => ({ exitCode: child.exitCode, signalCode: child.signalCode }),
    toolCalls,
    inputs,
    botContextMarkers,
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const spawn = !args.includes("--no-spawn");
  const names = args.filter((arg) => !arg.startsWith("--"));
  const unknown = names.filter((name) => !SCENARIOS.some((scenario) => scenario.name === name));
  if (unknown.length > 0) throw new Error(`unknown scenario: ${unknown.join(", ")}`);
  const selected = SCENARIOS.filter((scenario) =>
    names.length > 0 ? names.includes(scenario.name) : !scenario.manual,
  );
  const shutdownScenario = selected.find((scenario) => scenario.stopBotWhileStreaming);
  if (shutdownScenario && (!spawn || selected.length !== 1)) {
    console.log(
      `FAIL ${shutdownScenario.name}: requires a spawned bot and must run alone (no --no-spawn or other scenarios)`,
    );
    return 1;
  }
  requireEnv();

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
      bot?.toolCalls.clear();
      if (bot) bot.inputs.length = 0;
      bot?.botContextMarkers.clear();
      const evidence: InputEvidence = {
        marker: "",
        observations: bot?.inputs,
        botContextMarkers: bot?.botContextMarkers,
      };
      const startedAt = Date.now();
      const shutdownProblems: string[] = [];
      const deadline = startedAt + (scenario.timeoutMs ?? REPLY_TIMEOUT_MS);
      try {
        if (scenario.input && !bot) {
          failures++;
          costs.push({ name: scenario.name, cost: undefined });
          console.log(
            `FAIL ${scenario.name}: cannot verify LLM input under --no-spawn; run with the E2E child preload`,
          );
          continue;
        }
        let triggerId: string | undefined;
        // Run by both an interrupt and the normal path, not once for both: the
        // scenario can still write rows after an interrupt's cleanup started.
        const cleanup = (): Promise<string[]> =>
          (async (): Promise<string[]> => {
            if (!scenario.cleanup || !channelId) return [];
            const found: string[] = [];
            try {
              const cleanupDeadline = Date.now() + CLEANUP_TIMEOUT_MS;
              found.push(
                ...(await scenario.cleanup(
                  triggerId,
                  channelId,
                  (path, init) => discord(path, cleanupDeadline, init),
                  env,
                  startedAt,
                )),
              );
            } catch (error) {
              found.push(`cleanup failed: ${error instanceof Error ? error.message : error}`);
            }
            for (const problem of found) console.log(`     cleanup: ${problem}`);
            return found;
          })();
        interrupt.cleanup = cleanup;
        if (scenario.before && channelId) {
          let blockers: string[];
          try {
            blockers = await scenario.before(
              channelId,
              (path, init) => discord(path, deadline, init),
              env,
            );
          } catch (error) {
            await cleanup();
            throw error;
          }
          if (blockers.length > 0) {
            await cleanup();
            failures++;
            costs.push({ name: scenario.name, cost: undefined });
            console.log(`FAIL ${scenario.name}: not run`);
            for (const blocker of blockers) console.log(`     - ${blocker}`);
            continue;
          }
        }
        const cleanupProblems: string[] = [];
        const { reply, problems, toolWasInvoked } = await (async () => {
          try {
            // Inside the cleanup's reach: Discord can accept the post and the
            // bot can answer it even when reading the response fails.
            const sent = await sendScenario(
              scenario,
              (message, replyTo) => post(message, deadline, replyTo),
              () => Bun.sleep(250),
            );
            const messageId = sent.triggerId;
            evidence.marker = sent.marker;
            triggerId = messageId;
            if (scenario.userAction) console.log(`  ${scenario.name}: ${scenario.userAction}…`);
            if (scenario.stopBotWhileStreaming) {
              await waitForStreaming({
                read: () => repliesAfter(messageId, deadline, scenario.excludeFromReply),
                pause: () => Bun.sleep(Math.min(POLL_INTERVAL_MS, remaining(deadline))),
                log: console.log,
              });
              const stopStartedAt = Date.now();
              await bot?.stop();
              const stopSeconds = (Date.now() - stopStartedAt) / 1000;
              const status = bot?.exitStatus();
              // The footer alone would pass a bot that hung after editing the reply
              // and was SIGKILLed, or one that outlived docker stop's 10s default.
              if (status?.exitCode !== 0) {
                shutdownProblems.push(
                  `the bot did not exit cleanly after SIGTERM (exit code ${status?.exitCode}, signal ${status?.signalCode})`,
                );
              }
              if (stopSeconds > SHUTDOWN_EXIT_LIMIT_S) {
                shutdownProblems.push(
                  `the bot took ${stopSeconds.toFixed(1)}s to exit after SIGTERM (limit ${SHUTDOWN_EXIT_LIMIT_S}s)`,
                );
              }
            }
            const reply = await waitForReply({
              read: () => repliesAfter(messageId, deadline, scenario.excludeFromReply),
              pause: () => Bun.sleep(Math.min(POLL_INTERVAL_MS, remaining(deadline))),
              log: console.log,
            });
            const toolWasInvoked = scenario.toolName
              ? spawn && bot?.toolCalls.has(scenario.toolName) === true
              : true;
            const problems = [...shutdownProblems, ...scenario.check(reply)];
            if (scenario.input) problems.push(...checkInput(scenario.input, evidence));
            if (scenario.verify && channelId) {
              problems.push(
                ...(await scenario.verify(
                  messageId,
                  channelId,
                  (path, init) => discord(path, deadline, init),
                  botId,
                  env,
                )),
              );
            }
            return { reply, problems, toolWasInvoked };
          } finally {
            cleanupProblems.push(...(await cleanup()));
          }
        })();
        problems.push(...cleanupProblems);
        if (scenario.toolName && !spawn) {
          problems.push(
            `cannot verify ${scenario.toolName} invocation without --spawn: bot log is unavailable under --no-spawn`,
          );
        } else if (scenario.toolName && !toolWasInvoked) {
          problems.push(`the bot log has no ${scenario.toolName} invocation`);
        }
        bot?.toolCalls.clear();
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        const cost = costOf(reply);
        costs.push({ name: scenario.name, cost });
        if (problems.length === 0) {
          console.log(
            `PASS ${scenario.name} (${seconds}s, ${reply.messages.length} message(s), model ${modelOf(reply) ?? "unknown"}, cost ${cost === undefined ? "unknown" : `$${cost.toFixed(6)}`})`,
          );
        } else {
          failures++;
          console.log(`FAIL ${scenario.name} (${seconds}s, model ${modelOf(reply) ?? "unknown"})`);
          for (const problem of problems) console.log(`     - ${problem}`);
          console.log(`     reply: ${reply.body.replace(/\s+/g, " ").slice(0, 300)}`);
          console.log(`     footers: ${reply.footers.join(" / ").slice(0, 300)}`);
          console.log(`     components: ${await saveFailedReply(scenario.name, reply)}`);
          if (scenario.input)
            console.log(`     input: ${await saveFailedInput(scenario.name, evidence)}`);
        }
      } catch (error) {
        failures++;
        costs.push({ name: scenario.name, cost: undefined });
        console.log(`FAIL ${scenario.name}: ${error instanceof Error ? error.message : error}`);
        if (scenario.input)
          console.log(`     input: ${await saveFailedInput(scenario.name, evidence)}`);
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
      } finally {
        interrupt.cleanup = undefined;
      }
    }
  } finally {
    await bot?.stop();
    lateCleanup();
  }
  for (const line of formatCostSummary(costs, await usageDelta(usageBefore, costs))) {
    console.log(line);
  }
  return failures === 0 ? 0 : 1;
}

/** The change in the key's usage since `before`, as observed when polling stopped. Never fails the run. */
async function usageDelta(
  before: number | undefined,
  costs: ScenarioCost[],
): Promise<{ amount: number; state: UsageState } | undefined> {
  if (before === undefined) return undefined;
  const reported = costs.reduce((sum, { cost }) => sum + (cost ?? 0), 0);
  try {
    const { usage, state } = await observeUsage(
      {
        read: () => readKeyUsage(config.openRouterApiKey),
        pause: () => Bun.sleep(USAGE_POLL_INTERVAL_MS),
      },
      before + reported,
      costs.filter(({ cost }) => cost !== undefined).length,
    );
    return { amount: usage - before, state };
  } catch (error) {
    console.log(
      `  cost: could not read the OpenRouter key's usage: ${error instanceof Error ? error.message : error}`,
    );
    return undefined;
  }
}

process.exit(await main());
