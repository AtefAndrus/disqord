/**
 * Runs `scripts/reaction-gate-cases.ts` through the reaction gate and prints,
 * per case set, how often it chose a reaction where text was needed (`wrong`)
 * and text where a reaction was enough (`lost`), at the production thresholds
 * and at others for `accepts`. The questions and state come from the bot's own
 * code, so a run measures what the bot would send.
 *
 * Usage: bun scripts/reaction-gate-eval.ts [--runs N] [--per-case]
 *
 * Reads OPENROUTER_API_KEY from the environment; Bun loads `.env`. Three runs
 * cost about $0.05.
 */
import { OpenRouterClient } from "../src/llm/openrouter";
import {
  ACCEPTS_THRESHOLD,
  buildReactionGateQuestions,
  NEEDS_TEXT_THRESHOLD,
  withBotMessageEnd,
} from "../src/services/reactionGateService";
import { buildReplyGateState, REPLY_GATE_MODEL } from "../src/services/replyGateService";
import type { NormalizedMessage } from "../src/utils/discordMessageNormalizer";
import { QUESTION, REACTION_GATE_SETS, type ReactionGateCase } from "./reaction-gate-cases";

const CONCURRENCY = 6;
const BOT_NAME = "Bot";
const BOT_USER_ID = "1";
const AUTHOR = "佐藤 (@user2)";

function message(id: number, kind: "user" | "assistant", text: string): NormalizedMessage {
  return {
    id: String(id),
    channelId: "0",
    kind,
    author: kind === "assistant" ? "assistant" : AUTHOR,
    time: "",
    timestampMs: id * 60_000,
    text,
    attachments: [],
    exchangeId: "1",
  };
}

interface Run {
  set: string;
  c: ReactionGateCase;
  needsText: number;
  accepts: number;
  emoji: string;
  ms: number;
  cost: number;
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
const client = new OpenRouterClient(apiKey);
const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const runs = runsAt >= 0 ? Number(args[runsAt + 1]) : 3;
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs takes a positive integer");
const questions = buildReactionGateQuestions(BOT_NAME, []);

async function judge(set: string, c: ReactionGateCase): Promise<Run> {
  const conversation = {
    messages: [message(1, "user", QUESTION), message(2, "assistant", c.bot)],
  };
  const state = withBotMessageEnd(
    buildReplyGateState({
      botName: BOT_NAME,
      botUserId: BOT_USER_ID,
      current: {
        author: AUTHOR,
        text: `<@${BOT_USER_ID}> ${c.text}`,
        attachments: c.attachments ?? [],
      },
      conversation,
      isReplyToBot: false,
    }),
    conversation,
  );
  const startedAt = Date.now();
  const { answers, cost } = await client.decide({ model: REPLY_GATE_MODEL, state, questions });
  const value = (key: string, field: string): unknown =>
    (answers[key] as Record<string, unknown> | undefined)?.[field];
  return {
    set,
    c,
    needsText: value("needs_text", "noul") as number,
    accepts: value("accepts", "noul") as number,
    emoji: value("emoji", "choice") as string,
    ms: Date.now() - startedAt,
    cost: cost ?? 0,
  };
}

const jobs = Object.entries(REACTION_GATE_SETS).flatMap(([set, cases]) =>
  cases.flatMap((c) => Array.from({ length: runs }, () => ({ set, c }))),
);
const results: Run[] = [];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) results.push(await judge(job.set, job.c));
  }),
);

function report(name: string, rows: Run[], acceptsBelow: number): void {
  const reacts = (run: Run): boolean =>
    run.needsText < NEEDS_TEXT_THRESHOLD && run.accepts < acceptsBelow;
  const needText = rows.filter((run) => run.c.label === "text");
  const enough = rows.filter((run) => run.c.label === "reaction");
  const wrong = needText.filter(reacts);
  const lost = enough.filter((run) => !reacts(run));
  const ids = (list: Run[]): string => [...new Set(list.map((run) => run.c.id))].join(",");
  console.log(
    `${name}: wrong ${wrong.length}/${needText.length} ${ids(wrong)} | lost ${lost.length}/${enough.length} ${ids(lost)}`,
  );
}

for (const set of Object.keys(REACTION_GATE_SETS))
  report(
    set,
    results.filter((run) => run.set === set),
    ACCEPTS_THRESHOLD,
  );
report("all", results, ACCEPTS_THRESHOLD);
for (const threshold of [0.3, 0.4, 0.5, 0.55, 0.6])
  report(`accepts < ${threshold}`, results, threshold);
if (args.includes("--per-case")) {
  for (const run of results.filter(
    (item, index, all) => all.findIndex((other) => other.c === item.c) === index,
  ))
    console.log(
      `${run.c.label.padEnd(8)} ${run.c.id.padEnd(18)} needs ${run.needsText.toFixed(2)} accepts ${run.accepts.toFixed(2)} ${run.emoji}`,
    );
}
const times = results.map((run) => run.ms).sort((a, b) => a - b);
console.log(
  `latency p50 ${times[Math.floor(times.length / 2)]}ms, p90 ${times[Math.floor(times.length * 0.9)]}ms; cost $${results.reduce((sum, run) => sum + run.cost, 0).toFixed(4)}`,
);
