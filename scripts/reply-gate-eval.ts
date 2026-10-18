/**
 * Runs reply-gate cases through decision models and prints, per model and per
 * case set, how well the "should reply" probability separates the cases and
 * what each threshold would do with them, in the terms of the pass criterion
 * in docs/changes/reply-gate-tuning/design.md (採否の基準).
 *
 * The state and question come from `src/services/replyGateService.ts`, so a
 * run measures what the bot would send. A bot reply is marked as an
 * auto-reply unless the line before it mentions the bot, standing in for the
 * gate's memory of which messages it answered. Judgments time out at the
 * production `REPLY_GATE_TIMEOUT_MS`, and a timed-out or failed judgment
 * counts as a reply, as it does in production.
 *
 * Usage:
 *   bun scripts/reply-gate-eval.ts [--runs N] [--thresholds 0.3,0.4,0.5]
 *     [--originals <file>] [--sets hand,production,original] [--only id,id]
 *     [--per-case] [model ...]
 *
 * - `--originals` reads the original lines of the production thread from a
 *   JSON array of `<author>: <text>` strings kept outside the repository; they
 *   use the judgments of `scripts/reply-gate-thread-cases.ts`.
 * - `--per-case` prints each case's judgments, for comparing a paraphrase
 *   with its original; `--only` limits a run to the listed case IDs.
 *
 * Defaults to `REPLY_GATE_MODEL`, 3 runs, and REPLY_GATE_THRESHOLD (0.4).
 * Reads OPENROUTER_API_KEY from the environment; Bun loads `.env`. Costs
 * about $0.002 per 100 judgments on Jev.
 */
import { readFileSync } from "node:fs";
import { envVarDefinitions } from "../src/config/envVars";
import { OpenRouterClient } from "../src/llm/openrouter";
import {
  buildReplyGateQuestion,
  buildReplyGateState,
  REPLY_GATE_MODEL,
  REPLY_GATE_TIMEOUT_MS,
} from "../src/services/replyGateService";
import { authorNames, type NormalizedMessage } from "../src/utils/discordMessageNormalizer";
import { BOT_NAME, casesFromThread, type ReplyGateCase, replyGateCases } from "./reply-gate-cases";
import { productionThread } from "./reply-gate-thread-cases";

type SetName = "hand" | "production" | "original";

interface Judgment {
  set: SetName;
  id: string;
  expect: boolean;
  restraint: boolean;
  /** Absent when the judgment timed out or failed, which production answers as a reply. */
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
    isAutoReply: (reply) => {
      const previous = c.history[Number(reply.id) - 2] ?? "";
      return !previous.includes(`<@${BOT_USER_ID}>`);
    },
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
  cases: { set: SetName; c: ReplyGateCase }[],
  runs: number,
): Promise<Judgment[]> {
  const judgments: Judgment[] = [];
  for (let run = 0; run < runs; run++) {
    // Sequential per model: Perplexity's decision models answered 429 to a few requests a second.
    for (const { set, c } of cases) {
      const started = performance.now();
      const base = { set, id: c.id, expect: c.expect, restraint: c.restraint === true };
      try {
        const result = await client.decideNoul(
          {
            model,
            state: stateFor(c),
            questions: { should_reply: buildReplyGateQuestion(BOT_NAME) },
          },
          "should_reply",
          AbortSignal.timeout(REPLY_GATE_TIMEOUT_MS),
        );
        judgments.push({
          ...base,
          noul: result.noul,
          ms: performance.now() - started,
          cost: result.cost ?? 0,
        });
      } catch (error) {
        judgments.push({
          ...base,
          ms: performance.now() - started,
          cost: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return judgments;
}

/** Whether production replies on this judgment at this threshold; a failed judgment replies. */
function replies(j: Judgment, threshold: number): boolean {
  return j.noul === undefined || j.noul >= threshold;
}

function percentile(sorted: number[], p: number): number {
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
}

function reportSet(
  set: SetName,
  judgments: Judgment[],
  thresholds: number[],
  perCase: boolean,
): void {
  const ofSet = judgments.filter((j) => j.set === set);
  if (ofSet.length === 0) return;
  const byCase = new Map<string, Judgment[]>();
  for (const j of ofSet) byCase.set(j.id, [...(byCase.get(j.id) ?? []), j]);
  const mean = (values: Judgment[]): number | undefined => {
    const numbers = values.flatMap((j) => (j.noul === undefined ? [] : [j.noul]));
    return numbers.length === 0 ? undefined : numbers.reduce((a, b) => a + b, 0) / numbers.length;
  };
  const means = [...byCase].map(([id, values]) => ({
    id,
    expect: values[0]?.expect ?? false,
    restraint: values[0]?.restraint ?? false,
    mean: mean(values),
    values,
  }));
  const positive = means.flatMap((m) => (m.expect && m.mean !== undefined ? [m.mean] : []));
  const negative = means.flatMap((m) => (!m.expect && m.mean !== undefined ? [m.mean] : []));
  const ms = ofSet.map((j) => j.ms).sort((a, b) => a - b);
  const failed = ofSet.filter((j) => j.noul === undefined);
  const reply = ofSet.filter((j) => j.expect);
  const silent = ofSet.filter((j) => !j.expect);
  const silentCases = means.filter((m) => !m.expect);

  console.log(`\n### ${set} (${byCase.size} cases, ${ofSet.length} judgments)`);
  console.log(
    [
      positive.length > 0 && negative.length > 0
        ? `AUC ${auc(positive, negative).toFixed(3)}`
        : "AUC n/a",
      `lowest single reply judgment ${Math.min(...reply.flatMap((j) => (j.noul === undefined ? [] : [j.noul]))).toFixed(2)}`,
      `failed (timeout or error, counted as replies) ${failed.length}/${ofSet.length}${failed[0] ? `: ${failed[0].error}` : ""}`,
      `latency median ${percentile(ms, 0.5)}ms p90 ${percentile(ms, 0.9)}ms`,
      `cost $${ofSet.reduce((sum, j) => sum + j.cost, 0).toFixed(6)}`,
    ].join("\n"),
  );
  for (const threshold of thresholds) {
    const missed = reply.filter((j) => !replies(j, threshold)).length;
    const answered = silent.filter((j) => replies(j, threshold)).length;
    const restraintAnswered = silent.filter((j) => j.restraint && replies(j, threshold)).length;
    const silencedCases = silentCases.filter((m) => m.values.every((j) => !replies(j, threshold)));
    console.log(
      `  threshold ${threshold}: missed ${missed}/${reply.length} reply judgments, answered ${answered}/${silent.length} silent judgments, restraint answered ${restraintAnswered}, silent cases silenced every run ${silencedCases.length}/${silentCases.length}`,
    );
    for (const m of means) {
      const crossing = m.values.filter((j) =>
        m.expect ? !replies(j, threshold) : replies(j, threshold),
      );
      if (crossing.length === 0) continue;
      console.log(
        `    ${m.expect ? "MISSED  " : "ANSWERED"} ${m.id}${m.restraint ? " (restraint)" : ""} ${crossing.map((j) => (j.noul === undefined ? "fail" : j.noul.toFixed(2))).join(" ")}`,
      );
    }
  }
  if (perCase) {
    for (const m of means) {
      console.log(
        `  ${m.id} expect=${m.expect ? "reply" : "silent"} mean=${m.mean?.toFixed(3) ?? "n/a"} [${m.values.map((j) => (j.noul === undefined ? "fail" : j.noul.toFixed(2))).join(" ")}]`,
      );
    }
  }
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

const args = process.argv.slice(2);
const valued = new Set(["--runs", "--thresholds", "--originals", "--sets", "--only"]);
const models = args.filter((arg, i) => !arg.startsWith("--") && !valued.has(args[i - 1] ?? ""));
const runs = Number(option(args, "--runs") ?? "3");
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs takes a positive integer");
const defaultThreshold = envVarDefinitions.find((v) => v.name === "REPLY_GATE_THRESHOLD")?.default;
const thresholds = (
  option(args, "--thresholds") ??
  (process.env.REPLY_GATE_THRESHOLD || defaultThreshold || "")
)
  .split(",")
  .map(Number);
if (thresholds.some((t) => !Number.isFinite(t) || t < 0 || t > 1))
  throw new Error("--thresholds takes numbers from 0 to 1, comma-separated");
const originalsPath = option(args, "--originals");
const sets = (
  option(args, "--sets") ?? (originalsPath ? "hand,production,original" : "hand,production")
).split(",") as SetName[];
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

const cases: { set: SetName; c: ReplyGateCase }[] = [];
if (sets.includes("hand")) cases.push(...replyGateCases.map((c) => ({ set: "hand" as const, c })));
if (sets.includes("production"))
  cases.push(
    ...casesFromThread(productionThread, "p").map((c) => ({ set: "production" as const, c })),
  );
if (sets.includes("original")) {
  if (!originalsPath) throw new Error("--sets original needs --originals <file>");
  const lines: unknown = JSON.parse(readFileSync(originalsPath, "utf8"));
  if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string"))
    throw new Error(`${originalsPath}: expected a JSON array of "<author>: <text>" strings`);
  if (lines.length !== productionThread.lines.length)
    throw new Error(
      `${originalsPath}: expected ${productionThread.lines.length} lines, got ${lines.length}`,
    );
  const originals = casesFromThread({ lines, judgments: productionThread.judgments }, "p");
  cases.push(...originals.map((c) => ({ set: "original" as const, c })));
}
const only = option(args, "--only")?.split(",");
if (only) cases.splice(0, cases.length, ...cases.filter(({ c }) => only.includes(c.id)));

const client = new OpenRouterClient(apiKey);
const targets = models.length > 0 ? models : [REPLY_GATE_MODEL];
console.log(`runs ${runs}, timeout ${REPLY_GATE_TIMEOUT_MS}ms`);
const results = await Promise.all(targets.map((model) => judgeAll(client, model, cases, runs)));
for (const [i, model] of targets.entries()) {
  console.log(`\n## ${model}`);
  for (const set of sets) reportSet(set, results[i] ?? [], thresholds, args.includes("--per-case"));
}
