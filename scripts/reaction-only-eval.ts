/**
 * Measures, per model, when the bot answers with only `reply_with_reaction`,
 * and how long the model takes to call it. The result decides whether the
 * feature ships and the model side of the first message's delay; see
 * docs/changes/reaction-only-reply/design.md (評価スクリプト).
 *
 * Requests go through `ChatService.generateChatResponse` with the real tool
 * list, so a run measures the instructions and tools the bot would send. Only
 * Discord is stubbed. A run stops at the first non-whitespace text or at
 * `reply_with_reaction`, so no answer is generated or paid for.
 *
 * Usage: bun scripts/reaction-only-eval.ts [--runs N] [--per-case] [model ...]
 *
 * Reads OPENROUTER_API_KEY from the environment; Bun loads `.env`. Five runs
 * of the default models cost about $0.5.
 */
import { ChannelType } from "discord.js";
import { OpenRouterClient } from "../src/llm/openrouter";
import type { IToolLoopUpdater } from "../src/llm/toolLoop";
import { createDefaultToolRegistry } from "../src/llm/tools/defaultRegistry";
import { REPLY_WITH_REACTION_TOOL } from "../src/llm/tools/discord/replyWithReaction";
import type { DiscordInfoContext, DiscordToolContext } from "../src/llm/tools/registry";
import type { IApiKeyService } from "../src/services/apiKeyService";
import { ChatService, type ChatUserInput } from "../src/services/chatService";
import type { ConversationWindowContext } from "../src/services/conversationWindow";
import { ModelService } from "../src/services/modelService";
import type { ISettingsService } from "../src/services/settingsService";
import type { ITweetService } from "../src/services/tweetService";
import type { GuildSettings } from "../src/types";
import type { NormalizedMessage } from "../src/utils/discordMessageNormalizer";

const DEFAULT_MODELS = [
  "anthropic/claude-haiku-5.5",
  "google/gemini-3.8-flash",
  "z-ai/glm-5.3-flash",
  "deepseek/deepseek-v4.1-flash",
  "google/gemma-4-26b-a4b-it",
];
const CONCURRENCY = 12;
const RUN_TIMEOUT_MS = 60_000;

type Mode = "mention" | "auto-reply" | "mention-no-history";
const MODES: Mode[] = ["mention", "auto-reply", "mention-no-history"];

interface EvalCase {
  id: string;
  text: string;
  /** Whether the message needs text. A reaction alone on one of these is what must never happen. */
  needsText: boolean;
}

const CASES: EvalCase[] = [
  { id: "thanks", text: "ありがとう、助かった！", needsText: false },
  { id: "thanks-short", text: "ありがとうー", needsText: false },
  { id: "ack", text: "了解です", needsText: false },
  { id: "backchannel", text: "なるほどね〜", needsText: false },
  { id: "impressed", text: "おお、すごい", needsText: false },
  { id: "question", text: "as との違いは？", needsText: true },
  { id: "short-question", text: "なんで？", needsText: true },
  { id: "new-question", text: "今日は何曜日？", needsText: true },
  { id: "opinion", text: "これってどう思う？", needsText: true },
  { id: "request", text: "サンプルコードも書いて", needsText: true },
  { id: "thanks-question", text: "ありがとう！ちなみに as との違いは？", needsText: true },
  { id: "thanks-request", text: "助かった！じゃあこれを使った例も見せて", needsText: true },
  { id: "stuck", text: "うーん、まだよくわからないな", needsText: true },
];

const HISTORY: NormalizedMessage[] = [
  {
    id: "1",
    channelId: "0",
    kind: "user",
    author: "佐藤 (@user2)",
    time: "",
    timestampMs: 0,
    text: "TypeScript の satisfies って何？",
    attachments: [],
    exchangeId: "1",
    ref: "m1",
  },
  {
    id: "2",
    channelId: "0",
    kind: "assistant",
    author: "assistant",
    time: "",
    timestampMs: 60_000,
    text: "`satisfies` は、値が型に合うかを検査しつつ、値から推論された具体的な型を保つ演算子です。型注釈と違って型を広げないので、後続のコードで具体的なプロパティをそのまま使えます。",
    attachments: [],
    exchangeId: "1",
    ref: "m2",
  },
];

const stubDiscord: DiscordToolContext = {
  channelType: ChannelType.GuildText,
  addReaction: async () => '{"ok":true}',
  createPoll: async () => '{"ok":true}',
  createThread: async () => '{"ok":true}',
  pinMessage: async () => '{"ok":true}',
  createEvent: async () => '{"ok":true}',
};

const stubDiscordInfo: DiscordInfoContext = {
  channelType: ChannelType.GuildText,
  listPins: async () => '{"pins":[]}',
  getChannelInfo: async () => '{"name":"general"}',
  listEvents: async () => '{"active":[],"scheduled":[]}',
};

function conversation(): ConversationWindowContext {
  return {
    messages: HISTORY,
    sessionId: crypto.randomUUID(),
    windowStartMessageId: "1",
    toolContext: {
      resolveMessageRef: () => undefined,
      describeMessageRef: () => undefined,
      shownMessageBody: () => ({ error: "message_unavailable" }),
      readEarlierMessages: async () => '{"messages":[],"has_more":false}',
      viewAttachment: async () => '{"error":"attachment_unavailable"}',
    },
  };
}

interface Run {
  caseId: string;
  needsText: boolean;
  mode: Mode;
  /** `timeout` is a model that wrote nothing within `RUN_TIMEOUT_MS`, usually one still reasoning. */
  outcome: "reaction" | "text" | "empty" | "error" | "timeout";
  /** From the start of the generation to the call of `reply_with_reaction`. */
  ms?: number;
  cost: number;
  error?: string;
  /** Tools called before the run stopped, to tell a model that called `add_reaction` and wrote nothing. */
  tools: string[];
}

async function runOnce(
  service: ChatService,
  c: EvalCase,
  mode: Mode,
  requestId: string,
): Promise<Run> {
  let outcome: Run["outcome"] | undefined;
  let ms: number | undefined;
  const tools: string[] = [];
  const startedAt = Date.now();
  const stop = (reached: Run["outcome"]): void => {
    outcome ??= reached;
    service.cancelRequest(requestId);
  };
  const updater: IToolLoopUpdater = {
    beginTurn: () => {},
    stageContent: (text) => {
      if (text.trim().length > 0) stop("text");
    },
    commitTurn: () => {},
    abortTurn: () => {},
    beginToolBlock: (name) => {
      tools.push(name);
      if (name !== REPLY_WITH_REACTION_TOOL) return;
      ms = Date.now() - startedAt;
      stop("reaction");
    },
    endToolBlock: () => {},
  };
  const withHistory = mode !== "mention-no-history";
  const input: ChatUserInput = {
    text: c.text,
    authorLabel: "佐藤 (@user2)",
    discord: stubDiscord,
    ...(mode === "auto-reply" && { autoReply: true }),
    ...(withHistory && { conversation: conversation(), discordInfo: stubDiscordInfo }),
  };
  const timeout = setTimeout(() => stop("timeout"), RUN_TIMEOUT_MS);
  const result = await service.generateChatResponse("guild", input, requestId, updater, {
    channelId: "channel",
    userId: "user",
    payer: { key: "unused", source: "default" },
  });
  clearTimeout(timeout);
  const failure =
    result.status === "error"
      ? result.error instanceof Error
        ? result.error.message
        : String(result.error)
      : undefined;
  return {
    caseId: c.id,
    needsText: c.needsText,
    mode,
    outcome: outcome ?? (failure && !failure.includes("empty response") ? "error" : "empty"),
    ...(ms !== undefined && { ms }),
    cost: result.usage?.cost ?? 0,
    ...(failure && { error: failure }),
    tools,
  };
}

function percentile(values: number[], p: number): number | undefined {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

function rate(runs: Run[], outcome: Run["outcome"]): string {
  return `${runs.filter((run) => run.outcome === outcome).length}/${runs.length}`;
}

function report(model: string, runs: Run[], perCase: boolean): void {
  console.log(`\n## ${model}`);
  for (const mode of MODES) {
    const inMode = runs.filter((run) => run.mode === mode);
    const enough = inMode.filter((run) => !run.needsText);
    const needs = inMode.filter((run) => run.needsText);
    console.log(
      `${mode}: reaction where enough ${rate(enough, "reaction")}, reaction where text is needed ${rate(needs, "reaction")}, empty ${rate(inMode, "empty")}, error ${rate(inMode, "error")}, timeout ${rate(inMode, "timeout")}`,
    );
  }
  for (const run of runs.filter((r) => r.needsText && r.outcome === "reaction"))
    console.log(`  WRONG ${run.mode} ${run.caseId}`);
  for (const run of runs.filter((r) => r.outcome === "empty"))
    console.log(`  EMPTY ${run.mode} ${run.caseId} after [${run.tools.join(", ")}]`);
  if (perCase) {
    for (const c of CASES) {
      const line = MODES.map(
        (mode) =>
          `${mode} ${rate(
            runs.filter((run) => run.caseId === c.id && run.mode === mode),
            "reaction",
          )}`,
      ).join(", ");
      console.log(`  ${c.id}: ${line}`);
    }
  }
  const times = runs.flatMap((run) => (run.ms === undefined ? [] : [run.ms]));
  console.log(
    `time to reply_with_reaction: p50 ${percentile(times, 0.5) ?? "-"}ms, p90 ${percentile(times, 0.9) ?? "-"}ms (${times.length} calls)`,
  );
  const errors = [...new Set(runs.flatMap((run) => (run.error ? [run.error] : [])))];
  for (const error of errors.slice(0, 3)) console.log(`  error: ${error.slice(0, 160)}`);
  console.log(`cost: $${runs.reduce((sum, run) => sum + run.cost, 0).toFixed(4)}`);
}

async function evaluate(client: OpenRouterClient, model: string, runs: number): Promise<Run[]> {
  const settings = {
    defaultModel: model,
    historyEnabled: true,
    discordToolsEnabled: true,
    cronEnabled: false,
    webSearchEnabled: false,
    reasoningDisplayEnabled: false,
    twitterExpandEnabled: false,
  } as GuildSettings;
  const service = new ChatService(
    client,
    { getGuildSettings: async () => settings } as unknown as ISettingsService,
    createDefaultToolRegistry(),
    "perplexity",
    {} as ITweetService,
    new ModelService(client),
    { clientFor: () => client } as unknown as IApiKeyService,
  );
  const jobs = CASES.flatMap((c) =>
    MODES.flatMap((mode) => Array.from({ length: runs }, () => ({ c, mode }))),
  );
  const results: Run[] = [];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let job = jobs.shift(); job; job = jobs.shift()) {
        results.push(await runOnce(service, job.c, job.mode, crypto.randomUUID()));
      }
    }),
  );
  return results;
}

const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const runs = runsAt >= 0 ? Number(args[runsAt + 1]) : 5;
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs takes a positive integer");
const models = args.filter(
  (arg, index) => !arg.startsWith("--") && (runsAt < 0 || index !== runsAt + 1),
);
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

const client = new OpenRouterClient(apiKey);
const targets = models.length > 0 ? models : DEFAULT_MODELS;
const results = await Promise.all(targets.map((model) => evaluate(client, model, runs)));
for (const [index, model] of targets.entries())
  report(model, results[index] ?? [], args.includes("--per-case"));
const wrong = results.flat().filter((run) => run.needsText && run.outcome === "reaction").length;
console.log(`\nreaction where text is needed: ${wrong}`);
const allTimes = results.flat().flatMap((run) => (run.ms === undefined ? [] : [run.ms]));
console.log(`time to reply_with_reaction overall: p90 ${percentile(allTimes, 0.9) ?? "-"}ms`);
