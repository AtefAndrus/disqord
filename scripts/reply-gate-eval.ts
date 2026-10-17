/**
 * Runs the hand-written reply-gate cases through decision models and prints,
 * per model, how well the "should reply" probability separates the cases and
 * what the configured threshold would do with them.
 *
 * The state and question come from `src/services/replyGateService.ts`, so a
 * run measures what the bot would send. Run it before changing the model, the
 * question, or the default threshold; probabilities differ between models and
 * versions, so a new model needs its own threshold.
 *
 * Usage: bun scripts/reply-gate-eval.ts [--runs N] [model ...]
 * Defaults to `REPLY_GATE_MODEL` and 2 runs. Reads OPENROUTER_API_KEY and
 * REPLY_GATE_THRESHOLD (default 0.3) from the environment; Bun loads `.env`.
 * Costs about $0.004 per model at 2 runs on Jev.
 */
import { OpenRouterClient } from "../src/llm/openrouter";
import {
  buildReplyGateQuestion,
  buildReplyGateState,
  REPLY_GATE_MODEL,
  REPLY_GATE_TIMEOUT_MS,
} from "../src/services/replyGateService";
import { authorNames, type NormalizedMessage } from "../src/utils/discordMessageNormalizer";
import { BOT_NAME, type ReplyGateCase, replyGateCases } from "./reply-gate-cases";

interface Judgment {
  id: string;
  expect: boolean;
  noul?: number;
  ms: number;
  cost: number;
  error?: string;
}

function splitLine(line: string): { author: string; text: string } {
  const at = line.indexOf(": ");
  return at < 0
    ? { author: "", text: line }
    : { author: line.slice(0, at), text: line.slice(at + 2) };
}

const BOT_USER_ID = "1";

const usernames = new Map<string, string>();

/**
 * Names a case's speaker as production does, `<display name> (@<username>)`.
 * The cases give display names only, so each distinct one gets a stable
 * made-up username.
 */
function labelFor(displayName: string): string {
  let username = usernames.get(displayName);
  if (username === undefined) {
    username = `user${usernames.size + 2}`;
    usernames.set(displayName, username);
  }
  return authorNames({ id: username, username, global_name: displayName }).label;
}

/** Shapes a history line the way the conversation window does, where the bot's reply has author "assistant". */
function toNormalized(line: string, index: number): NormalizedMessage {
  const { author, text } = splitLine(line);
  const isBot = author === BOT_NAME;
  return {
    id: String(index + 1),
    channelId: "0",
    kind: isBot ? "assistant" : "user",
    author: isBot ? "assistant" : labelFor(author),
    time: "",
    timestampMs: index * 60_000,
    text,
    attachments: [],
    exchangeId: String(index + 1),
  };
}

function stateFor(c: ReplyGateCase): Record<string, unknown> {
  const messages = c.history.map(toNormalized);
  const targetIndex = c.replyTarget === undefined ? -1 : c.history.indexOf(c.replyTarget);
  if (c.replyTarget !== undefined && targetIndex < 0)
    throw new Error(`${c.id}: replyTarget is not one of its history lines`);
  const replyTarget = targetIndex < 0 ? undefined : messages[targetIndex];
  const current = splitLine(c.current);
  return buildReplyGateState({
    botName: BOT_NAME,
    botUserId: BOT_USER_ID,
    current: { ...current, author: labelFor(current.author), attachments: c.attachments ?? [] },
    conversation: { messages, ...(replyTarget && { replyTarget }) },
    isReplyToBot: replyTarget?.kind === "assistant",
  });
}

function auc(positive: number[], negative: number[]): number {
  let score = 0;
  for (const p of positive) for (const n of negative) score += p > n ? 1 : p === n ? 0.5 : 0;
  return score / (positive.length * negative.length);
}

async function judgeAll(
  client: OpenRouterClient,
  model: string,
  runs: number,
): Promise<Judgment[]> {
  const judgments: Judgment[] = [];
  for (let run = 0; run < runs; run++) {
    // Sequential per model: Perplexity's decision models answered 429 to a few requests a second.
    for (const c of replyGateCases) {
      const started = performance.now();
      try {
        const result = await client.decideNoul(
          {
            model,
            state: stateFor(c),
            questions: { should_reply: buildReplyGateQuestion(BOT_NAME) },
          },
          "should_reply",
          AbortSignal.timeout(REPLY_GATE_TIMEOUT_MS * 10),
        );
        judgments.push({
          id: c.id,
          expect: c.expect,
          noul: result.noul,
          ms: performance.now() - started,
          cost: result.cost ?? 0,
        });
      } catch (error) {
        judgments.push({
          id: c.id,
          expect: c.expect,
          ms: performance.now() - started,
          cost: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return judgments;
}

function report(model: string, judgments: Judgment[], threshold: number): void {
  const byCase = new Map<string, { expect: boolean; values: number[] }>();
  for (const j of judgments) {
    if (j.noul === undefined) continue;
    const entry = byCase.get(j.id) ?? { expect: j.expect, values: [] };
    entry.values.push(j.noul);
    byCase.set(j.id, entry);
  }
  const mean = [...byCase].map(([id, { expect, values }]) => ({
    id,
    expect,
    noul: values.reduce((sum, v) => sum + v, 0) / values.length,
    spread: Math.max(...values) - Math.min(...values),
  }));
  const positive = mean.filter((m) => m.expect).map((m) => m.noul);
  const negative = mean.filter((m) => !m.expect).map((m) => m.noul);
  const missed = mean.filter((m) => m.expect && m.noul < threshold);
  const intruded = mean.filter((m) => !m.expect && m.noul >= threshold);
  // The bot decides on a single judgment, so the per-judgment figures are the ones the
  // threshold has to hold for; the per-case means hide a run that dipped below it.
  const answered = judgments.filter((j) => j.noul !== undefined) as (Judgment & { noul: number })[];
  const replyJudgments = answered.filter((j) => j.expect);
  const singleMissed = replyJudgments.filter((j) => j.noul < threshold).length;
  const singleIntruded = answered.filter((j) => !j.expect && j.noul >= threshold).length;
  const ms = judgments
    .filter((j) => j.noul !== undefined)
    .map((j) => j.ms)
    .sort((a, b) => a - b);
  const errors = judgments.filter((j) => j.error !== undefined);
  const cost = judgments.reduce((sum, j) => sum + j.cost, 0);

  console.log(`\n## ${model}`);
  if (positive.length === 0 || negative.length === 0) {
    console.log(`no usable answers (${errors.length} errors): ${errors[0]?.error ?? ""}`);
    return;
  }
  console.log(
    [
      `AUC ${auc(positive, negative).toFixed(3)}`,
      `at threshold ${threshold}, single judgments: missed ${singleMissed}/${replyJudgments.length} reply judgments, answered ${singleIntruded}/${answered.length - replyJudgments.length} silent judgments`,
      `lowest single reply judgment ${Math.min(...replyJudgments.map((j) => j.noul)).toFixed(2)}`,
      `at threshold ${threshold}, case means: missed ${missed.length}/${positive.length} reply cases, answered ${intruded.length}/${negative.length} silent cases`,
      `lowest reply case mean ${Math.min(...positive).toFixed(2)}, highest silent case mean ${Math.max(...negative).toFixed(2)}`,
      `max spread between runs ${Math.max(...mean.map((m) => m.spread)).toFixed(2)}`,
      `latency median ${Math.round(ms[Math.floor(ms.length / 2)])}ms p90 ${Math.round(ms[Math.floor(ms.length * 0.9)])}ms`,
      `errors ${errors.length}/${judgments.length}`,
      `cost $${cost.toFixed(6)}`,
    ].join("\n"),
  );
  // Listed by single judgment, the figure the threshold is judged on, with every crossing value.
  const crossings = new Map<string, number[]>();
  for (const j of answered)
    if (j.expect ? j.noul < threshold : j.noul >= threshold)
      crossings.set(j.id, [...(crossings.get(j.id) ?? []), j.noul]);
  for (const [id, values] of crossings) {
    const expect = replyGateCases.find((c) => c.id === id)?.expect;
    console.log(
      `  ${expect ? "MISSED  " : "ANSWERED"} ${id} ${values.map((v) => v.toFixed(2)).join(" ")}`,
    );
  }
}

const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const runs = runsAt < 0 ? 2 : Number(args[runsAt + 1]);
const models = args.filter((_, i) => runsAt < 0 || (i !== runsAt && i !== runsAt + 1));
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs takes a positive integer");
const threshold = Number(process.env.REPLY_GATE_THRESHOLD || "0.3");
const client = new OpenRouterClient(apiKey);

const targets = models.length > 0 ? models : [REPLY_GATE_MODEL];
const results = await Promise.all(targets.map((model) => judgeAll(client, model, runs)));
for (const [i, model] of targets.entries()) report(model, results[i], threshold);
