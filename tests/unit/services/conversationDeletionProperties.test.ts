import { afterEach, test } from "bun:test";
import type {
  IReplyRecordRepository,
  ReplyPage,
  ReplyRecord,
} from "../../../src/db/repositories/replyRecord";
import type { ToolLlmResult } from "../../../src/llm/tools/registry";
import type {
  BuildConversationWindowInput,
  ConversationWindowContext,
} from "../../../src/services/conversationWindow";
import {
  CONVERSATION_MAX_AGE_MS,
  CONVERSATION_REST_LIMIT,
  ConversationWindowService,
  READ_EARLIER_MAX_RESULT_BYTES,
  WINDOW_RAW_MESSAGE_LIMIT,
  WINDOW_SHRUNK_MESSAGE_LIMIT,
  WINDOW_SHRUNK_TOKEN_LIMIT,
} from "../../../src/services/conversationWindow";
import type {
  DiscordMessageFetchResult,
  DiscordMessageListResult,
  IDiscordMessageReader,
} from "../../../src/services/discordMessageReader";
import { DiscordRestBudget } from "../../../src/services/discordMessageReader";
import {
  estimateNormalizedMessageTokens,
  type RawDiscordMessage,
} from "../../../src/utils/discordMessageNormalizer";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const CURRENT_ID = "1000";
const TARGET_EXCHANGE = "target";
const HEALTHY_EXCHANGE = "healthy";
const TARGET_OUTPUT_EXCHANGE = "200";
const HEALTHY_OUTPUT_EXCHANGE = "300";
const ORIGINAL_FETCH = globalThis.fetch;

type RecordVariant =
  | "none"
  | "pending"
  | "failed"
  | "completed-before"
  | "completed-equal"
  | "completed-after"
  | "stopped-before"
  | "stopped-equal"
  | "stopped-after"
  | "completed-mismatch";
type MessageLocation = "known" | "fetch" | "absent";
type FetchStatus = "found" | "not-found" | "failed";

interface FetchScript {
  status: FetchStatus;
  message?: RawDiscordMessage;
  error?: unknown;
}

interface ListQuery {
  before?: string;
  after?: string;
  limit: number;
}

interface ListStep {
  label: string;
  matches: (query: ListQuery) => boolean;
  response: DiscordMessageListResult;
}

interface RecordStateSnapshot {
  records: Map<string, ReplyRecord>;
  pages: Map<string, ReplyPage[]>;
  afterListPages?: (triggerMsgId: string) => void;
}

function fail(message: string): never {
  throw new Error(message);
}

function ensure(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

function requireContext(
  context: ConversationWindowContext | null,
  messageText: string,
): ConversationWindowContext {
  if (!context) fail(messageText);
  return context;
}

function requireString(value: string | undefined, messageText: string): string {
  if (value === undefined) fail(messageText);
  return value;
}

function requireValue<T>(value: T | undefined, messageText: string): T {
  if (value === undefined) fail(messageText);
  return value;
}

function message(
  id: string,
  exchangeId: string,
  timestamp = new Date(NOW - 10 * 60 * 1000).toISOString(),
  overrides: Partial<RawDiscordMessage> = {},
): RawDiscordMessage {
  return {
    id,
    channel_id: "channel",
    guild_id: "guild",
    content: `exchange=${exchangeId}|body=${id}`,
    timestamp,
    author: { id: `user-${id}`, username: `user-${id}`, bot: false },
    components: [],
    attachments: [],
    ...overrides,
  };
}

function attachmentFor(exchangeId: string): NonNullable<RawDiscordMessage["attachments"]>[number] {
  return {
    id: `attachment-${exchangeId}`,
    filename: `${exchangeId}.png`,
    url: `https://cdn.discordapp.com/attachments/1/${exchangeId}.png`,
    content_type: "image/png",
    size: 3,
  };
}

function botPage(
  id: string,
  exchangeId: string,
  seq: number,
  timestamp = new Date(NOW - 9 * 60 * 1000).toISOString(),
): RawDiscordMessage {
  const children = [
    ...(seq === 0 ? [{ type: 10, content: "**Model:** property-test" }] : []),
    { type: 10, content: `exchange=${exchangeId}|reply=${seq}` },
    { type: 14, divider: false },
    { type: 10, content: `footer=${exchangeId}|page=${seq}` },
  ];
  return message(id, exchangeId, timestamp, {
    content: "",
    author: { id: "bot", username: "bot", bot: true },
    components: [{ type: 17, components: children }],
  });
}

function currentMessage(reference?: string, id = CURRENT_ID): RawDiscordMessage {
  return message(id, "current", new Date(NOW).toISOString(), {
    content: "current question",
    message_reference: reference ? { channel_id: "channel", message_id: reference } : undefined,
  });
}

function exactQuery(query: Partial<ListQuery>): (actual: ListQuery) => boolean {
  return (actual) =>
    actual.limit === (query.limit ?? 100) &&
    actual.before === query.before &&
    actual.after === query.after;
}

function anyBeforeQuery(): (actual: ListQuery) => boolean {
  return (actual) => actual.limit === 100 && actual.before !== undefined;
}

function okList(messages: RawDiscordMessage[]): DiscordMessageListResult {
  return { status: "ok", messages };
}

class ScenarioRecords implements IReplyRecordRepository {
  constructor(readonly state: RecordStateSnapshot) {}

  createPending(): boolean {
    return true;
  }

  appendPage(): boolean {
    return true;
  }

  removePage(): boolean {
    return true;
  }

  finalize(): boolean {
    return true;
  }

  findByTrigger(triggerMsgId: string): ReplyRecord | null {
    return this.state.records.get(triggerMsgId) ?? null;
  }

  findByPage(pageMsgId: string): ReplyRecord | null {
    for (const [triggerMsgId, pages] of this.state.pages) {
      if (pages.some((page) => page.pageMsgId === pageMsgId)) {
        return this.state.records.get(triggerMsgId) ?? null;
      }
    }
    return null;
  }

  listPages(triggerMsgId: string): ReplyPage[] {
    const pages = [...(this.state.pages.get(triggerMsgId) ?? [])];
    this.state.afterListPages?.(triggerMsgId);
    this.state.afterListPages = undefined;
    return pages;
  }

  markPendingFailed(): number {
    return 0;
  }

  deleteExpired(): number {
    return 0;
  }

  recordForTrigger(triggerMsgId: string): ReplyRecord | undefined {
    return this.state.records.get(triggerMsgId);
  }

  pagesForTrigger(triggerMsgId: string): ReplyPage[] {
    return [...(this.state.pages.get(triggerMsgId) ?? [])];
  }
}

/**
 * This is deliberately separate from MessageEligibilityService.classifyNotFoundMessage.
 * It observes only scripted 404s and the mutable fixture record state.
 */
class DeletionOracle {
  readonly observed404Ids: string[] = [];
  readonly deletedExchanges = new Set<string>();

  constructor(
    private readonly records: ScenarioRecords,
    private readonly messageExchanges: ReadonlyMap<string, string>,
    private readonly botMessageIds: ReadonlySet<string>,
  ) {}

  observeNotFound(messageId: string): void {
    this.observed404Ids.push(messageId);
    const record = this.records.findByPage(messageId) ?? this.records.recordForTrigger(messageId);
    if (!record) {
      if (!this.botMessageIds.has(messageId)) {
        this.deletedExchanges.add(this.messageExchanges.get(messageId) ?? messageId);
      }
      return;
    }
    const registered =
      messageId === record.triggerMsgId ||
      this.records
        .pagesForTrigger(record.triggerMsgId)
        .some((page) => page.pageMsgId === messageId);
    if (registered) this.deletedExchanges.add(record.triggerMsgId);
  }

  snapshot(): Set<string> {
    return new Set(this.deletedExchanges);
  }
}

class ScriptedReader implements IDiscordMessageReader {
  readonly listQueries: ListQuery[] = [];
  readonly fetchQueries: string[] = [];
  readonly unexpectedLists: string[] = [];
  readonly unexpectedFetches: string[] = [];
  readonly budgetExhaustions: string[] = [];
  private readonly fetchScripts: Map<string, FetchScript[]>;
  private readonly listSteps: ListStep[];
  private readonly exhaustBeforeFetchIds = new Set<string>();

  constructor(
    private readonly messages: ReadonlyMap<string, RawDiscordMessage>,
    private readonly oracle: DeletionOracle,
    fetchScripts: ReadonlyMap<string, FetchScript[]>,
    listSteps: ListStep[],
  ) {
    this.fetchScripts = new Map(
      [...fetchScripts].map(([id, scripts]) => [id, scripts.map((script) => ({ ...script }))]),
    );
    this.listSteps = [...listSteps];
  }

  addFetchScript(messageId: string, script: FetchScript): void {
    const scripts = this.fetchScripts.get(messageId) ?? [];
    scripts.push(script);
    this.fetchScripts.set(messageId, scripts);
  }

  exhaustBeforeFetch(messageId: string): void {
    this.exhaustBeforeFetchIds.add(messageId);
  }

  addListStep(step: ListStep): void {
    this.listSteps.push(step);
  }

  snapshotFetchScripts(): Array<{ id: string; scripts: FetchScript[] }> {
    return [...this.fetchScripts].map(([id, scripts]) => ({
      id,
      scripts: scripts.map((script) => ({ ...script })),
    }));
  }

  async list(
    _channelId: string,
    query: ListQuery,
    budget: DiscordRestBudget,
  ): Promise<DiscordMessageListResult> {
    const step = this.listSteps.shift();
    this.listQueries.push({ ...query });
    if (!step?.matches(query)) {
      const actual = JSON.stringify(query);
      this.unexpectedLists.push(`${step?.label ?? "missing step"}: ${actual}`);
      throw new Error(`un-scripted list request ${actual}`);
    }
    if (!budget.consume()) {
      this.budgetExhaustions.push(`list:${step.label}`);
      return { status: "failed", messages: [] };
    }
    return { ...step.response, messages: [...step.response.messages] };
  }

  async fetch(
    _channelId: string,
    messageId: string,
    budget: DiscordRestBudget,
  ): Promise<DiscordMessageFetchResult> {
    this.fetchQueries.push(messageId);
    const scripts = this.fetchScripts.get(messageId);
    if (!scripts || scripts.length === 0) {
      this.unexpectedFetches.push(messageId);
      throw new Error(`un-scripted fetch request for ${messageId}`);
    }
    if (this.exhaustBeforeFetchIds.has(messageId)) {
      while (budget.consume()) {
        // Deliberately consume the shared production budget before this request.
      }
      this.exhaustBeforeFetchIds.delete(messageId);
    }
    const script = scripts.shift();
    if (!script) {
      this.unexpectedFetches.push(messageId);
      throw new Error(`empty fetch script for ${messageId}`);
    }
    if (!budget.consume()) {
      this.budgetExhaustions.push(`fetch:${messageId}`);
      return { status: "failed", error: new Error("REST budget exhausted") };
    }
    if (script.status === "not-found") {
      this.oracle.observeNotFound(messageId);
      return { status: "not-found" };
    }
    if (script.status === "failed") {
      return { status: "failed", error: script.error ?? new Error("scripted failure") };
    }
    const found = script.message ?? this.messages.get(messageId);
    if (!found) {
      this.unexpectedFetches.push(`found message missing for ${messageId}`);
      throw new Error(`found fetch script has no message for ${messageId}`);
    }
    return { status: "found", message: found };
  }
}

interface FixtureOptions {
  name: string;
  seed: number | string;
  pageCount: number;
  recordVariant: RecordVariant;
  triggerLocation?: MessageLocation;
  pageLocations?: MessageLocation[];
  fetchOutcomes?: ReadonlyMap<string, FetchScript>;
  initialMessages?: RawDiscordMessage[];
  currentReference?: string;
  targetAttachment?: boolean;
  shuffleInitialMessages?: boolean;
}

interface ScenarioHarness {
  readonly name: string;
  readonly seed: number | string;
  readonly targetTrigger: RawDiscordMessage;
  readonly targetPages: RawDiscordMessage[];
  readonly healthy: RawDiscordMessage;
  current: RawDiscordMessage;
  readonly records: ScenarioRecords;
  readonly oracle: DeletionOracle;
  readonly reader: ScriptedReader;
  readonly service: ConversationWindowService;
  readonly calls: string[];
}

function makeRecord(
  triggerMsgId: string,
  pageCount: number,
  variant: RecordVariant,
): ReplyRecord | null {
  if (variant === "none") return null;
  if (variant === "pending") {
    return {
      triggerMsgId,
      channelId: "channel",
      guildId: "guild",
      status: "pending",
      pageCount: null,
      finalizedAt: null,
      createdAt: NOW - 2_000,
    };
  }
  if (variant === "failed") {
    return {
      triggerMsgId,
      channelId: "channel",
      guildId: "guild",
      status: "failed",
      pageCount,
      finalizedAt: null,
      createdAt: NOW - 2_000,
    };
  }
  const status = variant.startsWith("stopped") ? "stopped" : "completed";
  const finalizedAt = variant.endsWith("equal")
    ? NOW
    : variant.endsWith("after")
      ? NOW + 1_000
      : NOW - 1_000;
  return {
    triggerMsgId,
    channelId: "channel",
    guildId: "guild",
    status,
    pageCount: variant === "completed-mismatch" ? pageCount + 1 : pageCount,
    finalizedAt,
    createdAt: NOW - 2_000,
  };
}

function createHarness(options: FixtureOptions): ScenarioHarness {
  const targetTrigger = message(
    "200",
    TARGET_EXCHANGE,
    new Date(NOW - 20 * 60 * 1000).toISOString(),
    options.targetAttachment ? { attachments: [attachmentFor(TARGET_EXCHANGE)] } : {},
  );
  const targetPages = Array.from({ length: options.pageCount }, (_, index) =>
    botPage(String(201 + index), TARGET_EXCHANGE, index),
  );
  const healthy = message("300", HEALTHY_EXCHANGE, new Date(NOW - 10 * 60 * 1000).toISOString());
  const current = currentMessage(options.currentReference);
  const record = makeRecord(targetTrigger.id, targetPages.length, options.recordVariant);
  const recordPages = record
    ? targetPages.map((page, seq) => ({ pageMsgId: page.id, triggerMsgId: targetTrigger.id, seq }))
    : [];
  const records = new ScenarioRecords({
    records: record ? new Map([[targetTrigger.id, record]]) : new Map(),
    pages: record ? new Map([[targetTrigger.id, recordPages]]) : new Map(),
  });
  const allMessages = new Map<string, RawDiscordMessage>([
    [targetTrigger.id, targetTrigger],
    ...targetPages.map((page) => [page.id, page] as const),
    [healthy.id, healthy],
  ]);
  const messageExchanges = new Map<string, string>([
    [targetTrigger.id, TARGET_OUTPUT_EXCHANGE],
    ...targetPages.map((page) => [page.id, TARGET_OUTPUT_EXCHANGE] as const),
    [healthy.id, HEALTHY_OUTPUT_EXCHANGE],
  ]);
  const botMessageIds = new Set(targetPages.map((page) => page.id));
  const oracle = new DeletionOracle(records, messageExchanges, botMessageIds);
  const triggerLocation = options.triggerLocation ?? "known";
  const pageLocations = options.pageLocations ?? targetPages.map(() => "known");
  const knownMessages = [
    healthy,
    ...(triggerLocation === "known" ? [targetTrigger] : []),
    ...targetPages.filter((_, index) => pageLocations[index] === "known"),
  ];
  const initialMessages = options.initialMessages
    ? options.initialMessages
    : options.shuffleInitialMessages
      ? [...knownMessages].sort(
          (left, right) =>
            placementScore(`${options.seed}:${left.id}`) -
            placementScore(`${options.seed}:${right.id}`),
        )
      : knownMessages;
  const fetchScripts = new Map<string, FetchScript[]>();
  const addFetchScript = (id: string, script: FetchScript): void => {
    const scripts = fetchScripts.get(id) ?? [];
    scripts.push(script);
    fetchScripts.set(id, scripts);
  };
  const defaultOutcome = (id: string): FetchScript =>
    options.fetchOutcomes?.get(id) ?? { status: "found" };
  if (triggerLocation !== "known") {
    const outcome = defaultOutcome(targetTrigger.id);
    addFetchScript(targetTrigger.id, outcome);
    const repeatedTriggerChecks =
      (outcome.status === "failed" && targetPages.length > 1 ? 1 : 0) +
      (options.currentReference === targetTrigger.id ? 1 : 0);
    for (let repeat = 0; repeat < repeatedTriggerChecks; repeat++) {
      addFetchScript(targetTrigger.id, { ...outcome });
    }
  }
  targetPages.forEach((page, index) => {
    if (pageLocations[index] === "fetch") {
      const outcome = defaultOutcome(page.id);
      addFetchScript(page.id, outcome);
      if (
        outcome.status === "failed" &&
        targetPages.length > 1 &&
        pageLocations.some((location, otherIndex) => otherIndex !== index && location === "known")
      ) {
        addFetchScript(page.id, { ...outcome });
      }
    }
  });
  const listSteps: ListStep[] = [
    {
      label: "initial window",
      matches: exactQuery({ before: CURRENT_ID }),
      response: okList(initialMessages),
    },
  ];
  const reader = new ScriptedReader(allMessages, oracle, fetchScripts, listSteps);
  const service = new ConversationWindowService(reader, records, () => NOW);
  return {
    name: options.name,
    seed: options.seed,
    targetTrigger,
    targetPages,
    healthy,
    current,
    records,
    oracle,
    reader,
    service,
    calls: [],
  };
}

function placementScore(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function buildInput(harness: ScenarioHarness): BuildConversationWindowInput {
  return {
    current: harness.current,
    guildId: "guild",
    userId: "user-current",
    botUserId: "bot",
    botUser: {},
    channel: {},
    historyEnabled: true,
    authorize: async () => true,
  };
}

function dumpScenario(harness: ScenarioHarness): string {
  const records = [...harness.records.state.records].map(([id, record]) => ({ id, record }));
  const pages = [...harness.records.state.pages].map(([id, value]) => ({ id, pages: value }));
  return JSON.stringify(
    {
      seed: harness.seed,
      name: harness.name,
      recordState: { records, pages },
      scriptedFetchResults: harness.reader.snapshotFetchScripts(),
      observed404Ids: harness.oracle.observed404Ids,
      oracleDeletedExchanges: [...harness.oracle.deletedExchanges],
      fetchCallOrder: harness.reader.fetchQueries,
      listCallOrder: harness.reader.listQueries,
      calls: harness.calls,
      unexpectedFetches: harness.reader.unexpectedFetches,
      unexpectedLists: harness.reader.unexpectedLists,
      budgetExhaustions: harness.reader.budgetExhaustions,
    },
    null,
    2,
  );
}

function scenarioError(harness: ScenarioHarness, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(`${reason}\nseed=${harness.seed}\nscenario=${dumpScenario(harness)}`);
}

async function execute<T>(
  harness: ScenarioHarness,
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  harness.calls.push(label);
  try {
    const result = await action();
    ensure(
      harness.reader.unexpectedFetches.length === 0,
      `reader received an un-scripted fetch: ${harness.reader.unexpectedFetches.join(", ")}`,
    );
    ensure(
      harness.reader.unexpectedLists.length === 0,
      `reader received an un-scripted list: ${harness.reader.unexpectedLists.join(", ")}`,
    );
    return result;
  } catch (error) {
    throw scenarioError(harness, error);
  }
}

interface ToolMessageFixture {
  ref?: string;
  text?: string;
  kind?: string;
}

interface ToolResponseFixture {
  messages?: ToolMessageFixture[];
}

function exchangeFromText(text: string): string | undefined {
  return /^exchange=([^|]+)/u.exec(text)?.[1];
}

function outputExchangeFromContent(exchangeId: string | undefined): string | undefined {
  if (exchangeId === TARGET_EXCHANGE) return TARGET_OUTPUT_EXCHANGE;
  if (exchangeId === HEALTHY_EXCHANGE) return HEALTHY_OUTPUT_EXCHANGE;
  return exchangeId;
}

class OutputTracker {
  private readonly refs = new Map<string, string>();
  healthySeen = false;

  constructor(
    private readonly healthyExchange: string,
    private readonly targetExchange: string,
  ) {}

  refForExchange(exchangeId: string): string | undefined {
    return [...this.refs].find(([, exchange]) => exchange === exchangeId)?.[0];
  }

  observeContext(
    context: ConversationWindowContext | null,
    deletedExchanges: ReadonlySet<string>,
    label: string,
  ): void {
    if (!context) return;
    for (const candidate of [
      ...context.messages,
      ...(context.replyTarget ? [context.replyTarget] : []),
    ]) {
      const contentExchange = outputExchangeFromContent(exchangeFromText(candidate.text));
      const outputExchange = contentExchange ?? candidate.exchangeId;
      ensure(
        !deletedExchanges.has(outputExchange),
        `${label} returned deleted exchange ${outputExchange}`,
      );
      if (candidate.ref) this.refs.set(candidate.ref, outputExchange);
      if (outputExchange === this.healthyExchange) this.healthySeen = true;
    }
  }

  observeTool(
    result: ToolLlmResult,
    deletedExchanges: ReadonlySet<string>,
    label: string,
  ): ToolResponseFixture {
    const serialized = JSON.stringify(result);
    for (const exchangeId of deletedExchanges) {
      const contentLabels =
        exchangeId === TARGET_OUTPUT_EXCHANGE
          ? [TARGET_EXCHANGE]
          : exchangeId === HEALTHY_OUTPUT_EXCHANGE
            ? [HEALTHY_EXCHANGE]
            : [exchangeId];
      ensure(
        !contentLabels.some((value) => serialized.includes(`exchange=${value}|`)),
        `${label} returned deleted body content for ${exchangeId}`,
      );
    }
    if (typeof result !== "string") return { messages: [] };
    let parsed: ToolResponseFixture;
    try {
      parsed = JSON.parse(result) as ToolResponseFixture;
    } catch {
      return { messages: [] };
    }
    for (const item of parsed.messages ?? []) {
      if (item.text) {
        const contentExchange = exchangeFromText(item.text);
        const exchangeId = outputExchangeFromContent(contentExchange);
        if (exchangeId && item.ref) this.refs.set(item.ref, exchangeId);
        ensure(
          exchangeId === undefined || !deletedExchanges.has(exchangeId),
          `${label} returned deleted tool message ${exchangeId ?? "unknown"}`,
        );
        if (exchangeId === this.healthyExchange) this.healthySeen = true;
        continue;
      }
      if (item.ref) {
        const exchangeId = this.refs.get(item.ref);
        ensure(
          exchangeId === undefined || !deletedExchanges.has(exchangeId),
          `${label} returned a reference to deleted exchange ${exchangeId ?? "unknown"}`,
        );
        if (exchangeId === this.healthyExchange) this.healthySeen = true;
      }
    }
    return parsed;
  }

  observeAttachment(
    result: ToolLlmResult,
    exchangeId: string,
    deletedExchanges: ReadonlySet<string>,
    label: string,
  ): void {
    const serialized = JSON.stringify(result);
    for (const deletedExchange of deletedExchanges) {
      ensure(
        !serialized.includes(Buffer.from(`attachment=${deletedExchange}`).toString("base64")),
        `${label} returned deleted attachment content for ${deletedExchange}`,
      );
    }
    if (Array.isArray(result)) {
      ensure(
        !deletedExchanges.has(exchangeId),
        `${label} returned attachment parts for deleted exchange ${exchangeId === this.targetExchange ? "target" : exchangeId}`,
      );
      if (exchangeId === this.healthyExchange) this.healthySeen = true;
    }
  }
}

function fetchFound(messageValue?: RawDiscordMessage): FetchScript {
  return { status: "found", message: messageValue };
}

function makeEnumerationCases(): FixtureOptions[] {
  const cases: FixtureOptions[] = [];
  for (const pageCount of [0, 1, 2]) {
    const locationValues: MessageLocation[] = ["known", "fetch"];
    const locationCombinations = (prefix: MessageLocation[]): MessageLocation[][] => {
      if (prefix.length === pageCount + 1) return [prefix];
      return locationValues.flatMap((location) => locationCombinations([...prefix, location]));
    };
    for (const locations of locationCombinations([])) {
      const ids = ["200", ...Array.from({ length: pageCount }, (_, index) => String(201 + index))];
      const fetchable = ids.filter((_, index) => locations[index] === "fetch");
      const outcomes = new Map<string, FetchScript>();
      for (const id of fetchable) outcomes.set(id, fetchFound());
      cases.push({
        name: `enumerated-${pageCount}-${locations.join("-")}-all-found`,
        seed: cases.length,
        pageCount,
        recordVariant: "completed-before",
        triggerLocation: locations[0],
        pageLocations: locations.slice(1),
        fetchOutcomes: outcomes,
      });
      for (const id of fetchable) {
        for (const status of ["found", "not-found", "failed"] as const) {
          const selected = new Map<string, FetchScript>(outcomes);
          selected.set(
            id,
            status === "found"
              ? fetchFound()
              : status === "not-found"
                ? { status }
                : { status, error: new Error("enumerated 5xx") },
          );
          cases.push({
            name: `enumerated-${pageCount}-${locations.join("-")}-${id}-${status}`,
            seed: cases.length,
            pageCount,
            recordVariant: "completed-before",
            triggerLocation: locations[0],
            pageLocations: locations.slice(1),
            fetchOutcomes: selected,
          });
        }
      }
    }
  }
  return cases;
}

function addToolList(harness: ScenarioHarness, messages: RawDiscordMessage[], label: string): void {
  harness.reader.addListStep({ label, matches: anyBeforeQuery(), response: okList(messages) });
}

async function buildAndTrack(
  harness: ScenarioHarness,
  tracker: OutputTracker,
  label = "build",
): Promise<ConversationWindowContext | null> {
  const context = await execute(harness, label, () => harness.service.build(buildInput(harness)));
  tracker.observeContext(context, harness.oracle.snapshot(), label);
  return context;
}

async function readAndTrack(
  harness: ScenarioHarness,
  tracker: OutputTracker,
  context: ConversationWindowContext,
  count: number,
  signal: AbortSignal,
  label: string,
): Promise<ToolLlmResult> {
  const result = await execute(harness, label, () =>
    context.toolContext.readEarlierMessages(count, signal),
  );
  tracker.observeTool(result, harness.oracle.snapshot(), label);
  return result;
}

async function attachmentAndTrack(
  harness: ScenarioHarness,
  tracker: OutputTracker,
  context: ConversationWindowContext,
  exchangeId: string,
  messageRef: string,
  label: string,
): Promise<ToolLlmResult> {
  const result = await execute(harness, label, () =>
    context.toolContext.viewAttachment(
      messageRef,
      1,
      "property-test-model",
      new AbortController().signal,
    ),
  );
  tracker.observeAttachment(result, exchangeId, harness.oracle.snapshot(), label);
  return result;
}

test("property: no public call newly returns content from the oracle-deleted exchange", async () => {
  for (const options of makeEnumerationCases()) {
    const harness = createHarness(options);
    const tracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
    await buildAndTrack(harness, tracker);
    ensure(tracker.healthySeen, "enumerated case did not return its healthy exchange");
  }

  const pathCases: Array<{
    name: string;
    make: () => ScenarioHarness;
    target404Id: string;
  }> = [
    {
      name: "eligibility-window-page-404",
      make: () =>
        createHarness({
          name: "eligibility-window-page-404",
          seed: "path-window-page",
          pageCount: 1,
          recordVariant: "completed-before",
          triggerLocation: "known",
          pageLocations: ["fetch"],
          fetchOutcomes: new Map([["201", { status: "not-found" }]]),
        }),
      target404Id: "201",
    },
    {
      name: "eligibility-window-trigger-404",
      make: () =>
        createHarness({
          name: "eligibility-window-trigger-404",
          seed: "path-window-trigger",
          pageCount: 1,
          recordVariant: "completed-before",
          triggerLocation: "fetch",
          pageLocations: ["known"],
          fetchOutcomes: new Map([["200", { status: "not-found" }]]),
        }),
      target404Id: "200",
    },
    {
      name: "reply-target-404",
      make: () =>
        createHarness({
          name: "reply-target-404",
          seed: "path-reply-target",
          pageCount: 1,
          recordVariant: "completed-before",
          triggerLocation: "absent",
          pageLocations: ["absent"],
          currentReference: "200",
          fetchOutcomes: new Map([["200", { status: "not-found" }]]),
        }),
      target404Id: "200",
    },
  ];
  for (const pathCase of pathCases) {
    const harness = pathCase.make();
    const tracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
    const context = await buildAndTrack(harness, tracker, pathCase.name);
    ensure(context?.replyTarget === undefined, `${pathCase.name} kept a deleted reply target`);
    ensure(
      harness.oracle.observed404Ids.includes(pathCase.target404Id),
      `${pathCase.name} did not observe its scripted 404`,
    );
    ensure(
      harness.oracle.deletedExchanges.has(TARGET_OUTPUT_EXCHANGE),
      `${pathCase.name} oracle did not delete target exchange`,
    );
    ensure(tracker.healthySeen, `${pathCase.name} lost the unrelated healthy exchange`);
  }

  const extendHarness = createHarness({
    name: "extend-anchor-404",
    seed: "path-extend-anchor",
    pageCount: 1,
    recordVariant: "completed-before",
    triggerLocation: "known",
    pageLocations: ["known"],
  });
  const extendTracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
  const firstExtendContext = await buildAndTrack(
    extendHarness,
    extendTracker,
    "extend-first-build",
  );
  const extendAnchor = requireString(
    firstExtendContext?.windowStartMessageId,
    "extend-anchor fixture did not establish a window anchor",
  );
  extendHarness.reader.addFetchScript(extendAnchor, { status: "not-found" });
  extendHarness.reader.addListStep({
    label: "extend-after-anchor",
    matches: exactQuery({ after: extendAnchor }),
    response: okList([extendHarness.healthy]),
  });
  extendHarness.current = currentMessage(undefined, "1100");
  const secondExtendContext = await buildAndTrack(
    extendHarness,
    extendTracker,
    "extend-anchor-404-build",
  );
  ensure(
    secondExtendContext?.replyTarget === undefined,
    "deleted extend anchor became a reply target",
  );
  ensure(
    extendHarness.oracle.deletedExchanges.has(TARGET_OUTPUT_EXCHANGE),
    "extend anchor 404 did not delete the target exchange",
  );
  ensure(extendTracker.healthySeen, "extend-anchor fixture lost the unrelated healthy exchange");

  const toolHarness = createHarness({
    name: "tool-body-page-404",
    seed: "surface-tool-body",
    pageCount: 1,
    recordVariant: "completed-before",
    triggerLocation: "absent",
    pageLocations: ["absent"],
  });
  toolHarness.reader.addFetchScript("201", { status: "not-found" });
  const toolTracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
  const toolContext = requireContext(
    await buildAndTrack(toolHarness, toolTracker, "tool-build"),
    "tool-body fixture did not build",
  );
  addToolList(toolHarness, [toolHarness.targetTrigger], "tool-body-page");
  const toolResult = await readAndTrack(
    toolHarness,
    toolTracker,
    toolContext,
    1,
    new AbortController().signal,
    "tool-body",
  );
  ensure(
    typeof toolResult === "string" && toolResult.includes('"messages":[]'),
    "deleted tool body was returned",
  );
  ensure(toolTracker.healthySeen, "tool-body fixture lost the healthy exchange");

  const referenceHarness = createHarness({
    name: "already-shown-reply-reference",
    seed: "surface-reference",
    pageCount: 1,
    recordVariant: "completed-before",
    triggerLocation: "absent",
    pageLocations: ["absent"],
    currentReference: "201",
    fetchOutcomes: new Map([
      ["200", fetchFound()],
      ["201", fetchFound()],
    ]),
  });
  referenceHarness.reader.addFetchScript("201", fetchFound(referenceHarness.targetPages[0]));
  const referenceTracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
  const referenceContext = requireContext(
    await buildAndTrack(referenceHarness, referenceTracker, "reference-build"),
    "reference fixture did not build",
  );
  const shownReplyRef = requireString(
    referenceContext.replyTarget?.ref,
    "reference fixture did not show its reply target",
  );
  addToolList(
    referenceHarness,
    [referenceHarness.targetPages[0] ?? referenceHarness.targetTrigger],
    "reference-page",
  );
  const referenceResult = await readAndTrack(
    referenceHarness,
    referenceTracker,
    referenceContext,
    1,
    new AbortController().signal,
    "already-shown-reply-reference",
  );
  ensure(
    typeof referenceResult === "string" && referenceResult.includes(`"ref":"${shownReplyRef}"`),
    "an already-shown reply was not returned as a reference",
  );
  ensure(referenceTracker.healthySeen, "reference fixture lost healthy content");

  const bufferHarness = createHarness({
    name: "carried-buffer-after-deletion",
    seed: "surface-buffer",
    pageCount: 1,
    recordVariant: "completed-before",
    triggerLocation: "absent",
    pageLocations: ["absent"],
    initialMessages: [],
  });
  bufferHarness.reader.addFetchScript("201", { status: "not-found" });
  const bufferTracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
  const bufferContext = requireContext(
    await buildAndTrack(bufferHarness, bufferTracker, "buffer-build"),
    "buffer fixture did not build",
  );
  const firstPage = [
    ...Array.from({ length: 2 }, (_, index) =>
      message(String(300 + index), HEALTHY_EXCHANGE, new Date(NOW - index * 1_000).toISOString()),
    ),
    ...Array.from({ length: 98 }, (_, index) =>
      message(
        String(302 + index),
        `other-bot-${index}`,
        new Date(NOW - index * 1_000).toISOString(),
        {
          author: { id: `other-bot-${index}`, username: `other-bot-${index}`, bot: true },
        },
      ),
    ),
  ];
  addToolList(bufferHarness, firstPage, "buffer-first-page");
  addToolList(bufferHarness, [bufferHarness.targetTrigger], "buffer-deleted-page");
  for (let index = 0; index < 2; index++) {
    await readAndTrack(
      bufferHarness,
      bufferTracker,
      bufferContext,
      1,
      new AbortController().signal,
      index === 0 ? "buffer-first-read" : `buffer-drain-${index}`,
    );
  }
  await readAndTrack(
    bufferHarness,
    bufferTracker,
    bufferContext,
    1,
    new AbortController().signal,
    "buffer-after-deletion",
  );
  ensure(
    bufferHarness.oracle.deletedExchanges.has(TARGET_OUTPUT_EXCHANGE),
    "buffer fixture did not establish the deletion",
  );
  ensure(bufferTracker.healthySeen, "buffer fixture lost the healthy buffered message");

  const attachmentHarness = createHarness({
    name: "attachment-ref-after-deletion",
    seed: "surface-attachment-ref",
    pageCount: 0,
    recordVariant: "none",
    targetAttachment: true,
  });
  const attachmentTracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
  const attachmentContext = requireContext(
    await buildAndTrack(attachmentHarness, attachmentTracker, "attachment-build"),
    "attachment-ref fixture did not build",
  );
  const targetRef = requireString(
    attachmentTracker.refForExchange(TARGET_OUTPUT_EXCHANGE),
    "attachment-ref fixture did not show target ref",
  );
  attachmentHarness.reader.addFetchScript("200", { status: "not-found" });
  const attachmentResult = await attachmentAndTrack(
    attachmentHarness,
    attachmentTracker,
    attachmentContext,
    TARGET_OUTPUT_EXCHANGE,
    targetRef,
    "attachment-ref-after-404",
  );
  ensure(
    attachmentResult === '{"error":"attachment_unavailable"}',
    "deleted attachment did not return unavailable",
  );
  ensure(attachmentTracker.healthySeen, "attachment-ref fixture lost healthy content");

  const attachmentFollowupHarness = createHarness({
    name: "attachment-ref-404-followup",
    seed: "surface-attachment-followup",
    pageCount: 0,
    recordVariant: "completed-before",
    currentReference: "200",
    initialMessages: [
      message("300", HEALTHY_EXCHANGE, new Date(NOW - 10 * 60 * 1000).toISOString()),
    ],
    targetAttachment: true,
  });
  attachmentFollowupHarness.reader.addFetchScript(
    "200",
    fetchFound(attachmentFollowupHarness.targetTrigger),
  );
  const attachmentFollowupTracker = new OutputTracker(
    HEALTHY_OUTPUT_EXCHANGE,
    TARGET_OUTPUT_EXCHANGE,
  );
  const attachmentFollowupContext = requireContext(
    await buildAndTrack(
      attachmentFollowupHarness,
      attachmentFollowupTracker,
      "attachment-followup-build",
    ),
    "attachment followup fixture did not build",
  );
  const attachmentFollowupRef = requireString(
    attachmentFollowupTracker.refForExchange(TARGET_OUTPUT_EXCHANGE),
    "attachment followup fixture did not show target ref",
  );
  attachmentFollowupHarness.reader.addFetchScript("200", { status: "not-found" });
  const followupAttachmentResult = await attachmentAndTrack(
    attachmentFollowupHarness,
    attachmentFollowupTracker,
    attachmentFollowupContext,
    TARGET_OUTPUT_EXCHANGE,
    attachmentFollowupRef,
    "attachment-followup-404",
  );
  ensure(
    followupAttachmentResult === '{"error":"attachment_unavailable"}',
    "attachment followup did not return unavailable",
  );
  addToolList(
    attachmentFollowupHarness,
    [attachmentFollowupHarness.targetTrigger],
    "attachment-followup-page",
  );
  const attachmentFollowupResult = await readAndTrack(
    attachmentFollowupHarness,
    attachmentFollowupTracker,
    attachmentFollowupContext,
    1,
    new AbortController().signal,
    "attachment-followup-read",
  );
  ensure(
    typeof attachmentFollowupResult === "string" &&
      !attachmentFollowupResult.includes("exchange=target|"),
    "attachment followup returned deleted target content",
  );
  ensure(
    attachmentFollowupHarness.oracle.observed404Ids.includes("200"),
    "attachment followup did not observe its scripted 404",
  );
  ensure(
    attachmentFollowupHarness.oracle.deletedExchanges.has(TARGET_OUTPUT_EXCHANGE),
    "attachment followup oracle did not delete target exchange",
  );
  ensure(attachmentFollowupTracker.healthySeen, "attachment followup fixture lost healthy content");

  const replyTargetNoRecordHarness = createHarness({
    name: "reply-target-404-no-record-followup",
    seed: "surface-reply-target-no-record",
    pageCount: 0,
    recordVariant: "none",
    triggerLocation: "absent",
    currentReference: "200",
    fetchOutcomes: new Map([["200", { status: "not-found" }]]),
  });
  const replyTargetNoRecordTracker = new OutputTracker(
    HEALTHY_OUTPUT_EXCHANGE,
    TARGET_OUTPUT_EXCHANGE,
  );
  const replyTargetNoRecordContext = requireContext(
    await buildAndTrack(
      replyTargetNoRecordHarness,
      replyTargetNoRecordTracker,
      "reply-target-no-record-build",
    ),
    "reply-target no-record fixture did not build",
  );
  ensure(
    replyTargetNoRecordContext.replyTarget === undefined,
    "reply-target no-record fixture kept a deleted reply target",
  );
  addToolList(
    replyTargetNoRecordHarness,
    [replyTargetNoRecordHarness.targetTrigger],
    "reply-target-no-record-page",
  );
  const replyTargetNoRecordResult = await readAndTrack(
    replyTargetNoRecordHarness,
    replyTargetNoRecordTracker,
    replyTargetNoRecordContext,
    1,
    new AbortController().signal,
    "reply-target-no-record-followup",
  );
  ensure(
    typeof replyTargetNoRecordResult === "string" &&
      !replyTargetNoRecordResult.includes("exchange=target|"),
    "reply-target no-record followup returned deleted target content",
  );
  ensure(
    replyTargetNoRecordHarness.oracle.observed404Ids.includes("200"),
    "reply-target no-record fixture did not observe its scripted 404",
  );
  ensure(
    replyTargetNoRecordHarness.oracle.deletedExchanges.has(TARGET_OUTPUT_EXCHANGE),
    "reply-target no-record oracle did not delete target exchange",
  );
  ensure(
    replyTargetNoRecordTracker.healthySeen,
    "reply-target no-record fixture lost healthy content",
  );

  const extendNoRecordHarness = createHarness({
    name: "extend-anchor-404-no-record-followup",
    seed: "surface-extend-anchor-no-record",
    pageCount: 0,
    recordVariant: "none",
  });
  const extendNoRecordTracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
  const firstExtendNoRecordContext = requireContext(
    await buildAndTrack(
      extendNoRecordHarness,
      extendNoRecordTracker,
      "extend-no-record-first-build",
    ),
    "extend no-record fixture did not build its initial window",
  );
  ensure(
    firstExtendNoRecordContext.windowStartMessageId === extendNoRecordHarness.targetTrigger.id,
    "extend no-record fixture did not anchor at the unrecorded trigger",
  );
  extendNoRecordHarness.reader.addFetchScript("200", { status: "not-found" });
  extendNoRecordHarness.reader.addListStep({
    label: "extend-no-record-after-anchor",
    matches: exactQuery({ after: extendNoRecordHarness.targetTrigger.id }),
    response: okList([extendNoRecordHarness.healthy]),
  });
  extendNoRecordHarness.current = currentMessage(undefined, "1100");
  const secondExtendNoRecordContext = requireContext(
    await buildAndTrack(
      extendNoRecordHarness,
      extendNoRecordTracker,
      "extend-no-record-anchor-404-build",
    ),
    "extend no-record anchor deletion returned no context",
  );
  addToolList(
    extendNoRecordHarness,
    [extendNoRecordHarness.targetTrigger],
    "extend-no-record-followup-page",
  );
  const extendNoRecordResult = await readAndTrack(
    extendNoRecordHarness,
    extendNoRecordTracker,
    secondExtendNoRecordContext,
    1,
    new AbortController().signal,
    "extend-no-record-followup",
  );
  ensure(
    typeof extendNoRecordResult === "string" && !extendNoRecordResult.includes("exchange=target|"),
    "extend no-record followup returned deleted target content",
  );
  ensure(
    extendNoRecordHarness.oracle.observed404Ids.includes("200"),
    "extend no-record fixture did not observe its scripted 404",
  );
  ensure(
    extendNoRecordHarness.oracle.deletedExchanges.has(TARGET_OUTPUT_EXCHANGE),
    "extend no-record oracle did not delete target exchange",
  );
  ensure(extendNoRecordTracker.healthySeen, "extend no-record fixture lost healthy content");
});

test("property: a 404 exclusion is monotonic across failures, aborts, and later tools", async () => {
  const successfulThenDeleted = createHarness({
    name: "verified-then-attachment-404",
    seed: "monotonic-verified",
    pageCount: 1,
    recordVariant: "completed-before",
    targetAttachment: true,
  });
  const tracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
  const context = requireContext(
    await buildAndTrack(successfulThenDeleted, tracker, "verified-build"),
    "verified-then-deleted fixture did not build",
  );
  const targetRef = requireString(
    tracker.refForExchange(TARGET_OUTPUT_EXCHANGE),
    "verified-then-deleted fixture lacks target ref",
  );
  successfulThenDeleted.reader.addFetchScript("200", { status: "not-found" });
  await attachmentAndTrack(
    successfulThenDeleted,
    tracker,
    context,
    TARGET_OUTPUT_EXCHANGE,
    targetRef,
    "404-after-verification",
  );
  const aborted = new AbortController();
  aborted.abort();
  addToolList(successfulThenDeleted, [successfulThenDeleted.targetTrigger], "later-tool-page");
  await readAndTrack(successfulThenDeleted, tracker, context, 1, aborted.signal, "abort-after-404");
  await readAndTrack(
    successfulThenDeleted,
    tracker,
    context,
    1,
    new AbortController().signal,
    "later-tool-after-abort",
  );
  ensure(
    successfulThenDeleted.oracle.deletedExchanges.has(TARGET_OUTPUT_EXCHANGE),
    "404 exclusion was lost after abort",
  );
  ensure(tracker.healthySeen, "monotonic verified fixture lost healthy content");

  const failedThenRetried = createHarness({
    name: "failed-then-retried",
    seed: "monotonic-retry",
    pageCount: 1,
    recordVariant: "completed-before",
    triggerLocation: "known",
    pageLocations: ["fetch"],
    fetchOutcomes: new Map([["201", { status: "failed", error: new Error("temporary 5xx") }]]),
  });
  const retryTracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
  const retryContext = requireContext(
    await buildAndTrack(failedThenRetried, retryTracker, "failed-first"),
    "failed-then-retried fixture did not build",
  );
  failedThenRetried.reader.addFetchScript("200", fetchFound(failedThenRetried.targetTrigger));
  addToolList(
    failedThenRetried,
    [requireValue(failedThenRetried.targetPages[0], "retry fixture page is missing")],
    "retry-page",
  );
  const retryResult = await readAndTrack(
    failedThenRetried,
    retryTracker,
    retryContext,
    1,
    new AbortController().signal,
    "retry-after-failure",
  );
  ensure(
    JSON.stringify(retryResult).includes("exchange=target|reply=0"),
    "a failed verification was not retried successfully",
  );
  ensure(
    failedThenRetried.oracle.deletedExchanges.size === 0,
    "retry case observed an unexpected 404",
  );
  ensure(retryTracker.healthySeen, "retry fixture lost healthy content");

  const failedThenDeleted = createHarness({
    name: "failed-one-page-404-another",
    seed: "monotonic-mixed-pages",
    pageCount: 2,
    recordVariant: "completed-before",
    triggerLocation: "known",
    pageLocations: ["fetch", "fetch"],
    fetchOutcomes: new Map([
      ["201", { status: "failed", error: new Error("temporary page failure") }],
      ["202", { status: "not-found" }],
    ]),
  });
  const mixedTracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
  await buildAndTrack(failedThenDeleted, mixedTracker, "mixed-failure-build");
  ensure(
    failedThenDeleted.oracle.deletedExchanges.has(TARGET_OUTPUT_EXCHANGE),
    "404 after a transient page failure did not establish deletion",
  );
  ensure(mixedTracker.healthySeen, "mixed-failure fixture lost healthy content");
});

test("property: transient failures alone never remove a human message", async () => {
  const transientCases: Array<{ name: string; script: FetchScript; exhaust: boolean }> = [
    { name: "5xx", script: { status: "failed", error: new Error("5xx") }, exhaust: false },
    {
      name: "abort",
      script: { status: "failed", error: new DOMException("operation aborted", "AbortError") },
      exhaust: false,
    },
    {
      name: "budget-exhaustion",
      script: { status: "failed", error: new Error("unused") },
      exhaust: true,
    },
  ];
  for (const transientCase of transientCases) {
    const harness = createHarness({
      name: `transient-${transientCase.name}`,
      seed: `transient-${transientCase.name}`,
      pageCount: 1,
      recordVariant: "completed-before",
      triggerLocation: "known",
      pageLocations: ["fetch"],
      fetchOutcomes: new Map([["201", transientCase.script]]),
    });
    if (transientCase.exhaust) harness.reader.exhaustBeforeFetch("201");
    const tracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
    const context = requireContext(
      await buildAndTrack(harness, tracker, transientCase.name),
      `${transientCase.name} made the whole build unavailable`,
    );
    ensure(
      context.messages.some((candidate) => candidate.exchangeId === TARGET_OUTPUT_EXCHANGE),
      `${transientCase.name} dropped the human trigger`,
    );
    ensure(harness.oracle.observed404Ids.length === 0, `${transientCase.name} observed a 404`);
    ensure(harness.oracle.deletedExchanges.size === 0, `${transientCase.name} deleted an exchange`);
    ensure(tracker.healthySeen, `${transientCase.name} lost the healthy exchange`);
  }
});

function installCdnFetch(status: number): void {
  globalThis.fetch = (async () =>
    new Response("attachment-body", {
      status,
      headers: { "content-type": "image/png" },
    })) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

test("property: with no deletions, eligible window, tool, and attachment content is returned", async () => {
  const harness = createHarness({
    name: "no-deletion-all-public-calls",
    seed: "no-deletion",
    pageCount: 0,
    recordVariant: "none",
    targetAttachment: true,
  });
  const tracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
  const context = requireContext(
    await buildAndTrack(harness, tracker),
    "no-deletion fixture returned no window",
  );
  ensure(
    context.messages.some((candidate) => candidate.exchangeId === TARGET_OUTPUT_EXCHANGE),
    "no-deletion fixture did not return the target human message",
  );
  ensure(
    context.messages.some((candidate) => candidate.exchangeId === HEALTHY_OUTPUT_EXCHANGE),
    "no-deletion fixture did not return the healthy human message",
  );

  const older = message("100", HEALTHY_EXCHANGE, new Date(NOW - 15 * 60 * 1000).toISOString());
  addToolList(harness, [older], "no-deletion-tool");
  const toolResult = await readAndTrack(
    harness,
    tracker,
    context,
    1,
    new AbortController().signal,
    "no-deletion-tool-call",
  );
  ensure(
    JSON.stringify(toolResult).includes("exchange=healthy|body=100"),
    "no-deletion fixture returned no eligible tool message",
  );

  const targetRef = requireString(
    tracker.refForExchange(TARGET_OUTPUT_EXCHANGE),
    "no-deletion fixture did not expose attachment ref",
  );
  harness.reader.addFetchScript("200", fetchFound(harness.targetTrigger));
  installCdnFetch(200);
  const attachmentResult = await attachmentAndTrack(
    harness,
    tracker,
    context,
    TARGET_OUTPUT_EXCHANGE,
    targetRef,
    "no-deletion-attachment",
  );
  ensure(Array.isArray(attachmentResult), "no-deletion fixture returned no attachment content");
  ensure(harness.oracle.observed404Ids.length === 0, "no-deletion fixture observed a 404");
  ensure(harness.oracle.deletedExchanges.size === 0, "no-deletion fixture deleted an exchange");
  ensure(tracker.healthySeen, "no-deletion fixture lost healthy content");
});

test("enumerated record, attachment, budget, pagination, and limit boundaries retain the same invariants", async () => {
  const recordVariants: RecordVariant[] = [
    "none",
    "pending",
    "failed",
    "completed-before",
    "completed-equal",
    "completed-after",
    "stopped-before",
    "stopped-equal",
    "stopped-after",
    "completed-mismatch",
  ];
  for (const recordVariant of recordVariants) {
    const harness = createHarness({
      name: `record-${recordVariant}`,
      seed: `record-${recordVariant}`,
      pageCount: recordVariant === "none" ? 0 : 1,
      recordVariant,
      triggerLocation: "known",
      pageLocations: recordVariant === "none" ? [] : ["fetch"],
      fetchOutcomes:
        recordVariant === "none" ? undefined : new Map([["201", { status: "not-found" }]]),
    });
    const tracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
    await buildAndTrack(harness, tracker, recordVariant);
    ensure(tracker.healthySeen, `${recordVariant} lost healthy content`);
    if (recordVariant !== "none") {
      ensure(
        harness.oracle.deletedExchanges.has(TARGET_OUTPUT_EXCHANGE),
        `${recordVariant} did not delete on a registered page 404`,
      );
    } else {
      ensure(
        harness.oracle.deletedExchanges.size === 0,
        "none record unexpectedly deleted content",
      );
    }
  }

  const attachmentCases: Array<{
    name: string;
    fetch: FetchScript;
    cdnStatus?: number;
    expectedDeletion: boolean;
    expectedParts: boolean;
  }> = [
    {
      name: "message-404",
      fetch: { status: "not-found" },
      expectedDeletion: true,
      expectedParts: false,
    },
    {
      name: "pinned-attachment-gone",
      fetch: { status: "found", message: message("200", TARGET_EXCHANGE) },
      expectedDeletion: false,
      expectedParts: false,
    },
    {
      name: "cdn-404",
      fetch: { status: "found" },
      cdnStatus: 404,
      expectedDeletion: false,
      expectedParts: false,
    },
    {
      name: "normal-fetch",
      fetch: { status: "found" },
      cdnStatus: 200,
      expectedDeletion: false,
      expectedParts: true,
    },
  ];
  for (const attachmentCase of attachmentCases) {
    const harness = createHarness({
      name: `attachment-${attachmentCase.name}`,
      seed: `attachment-${attachmentCase.name}`,
      pageCount: 0,
      recordVariant: "none",
      targetAttachment: true,
    });
    const tracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
    const context = requireContext(
      await buildAndTrack(harness, tracker, "attachment-case-build"),
      `${attachmentCase.name} did not build`,
    );
    const targetRef = requireString(
      tracker.refForExchange(TARGET_OUTPUT_EXCHANGE),
      `${attachmentCase.name} did not show an attachment ref`,
    );
    harness.reader.addFetchScript("200", attachmentCase.fetch);
    if (attachmentCase.cdnStatus !== undefined) installCdnFetch(attachmentCase.cdnStatus);
    const result = await attachmentAndTrack(
      harness,
      tracker,
      context,
      TARGET_OUTPUT_EXCHANGE,
      targetRef,
      `attachment-${attachmentCase.name}`,
    );
    ensure(
      harness.oracle.deletedExchanges.has(TARGET_OUTPUT_EXCHANGE) ===
        attachmentCase.expectedDeletion,
      `${attachmentCase.name} produced the wrong oracle deletion set`,
    );
    ensure(
      Array.isArray(result) === attachmentCase.expectedParts,
      `${attachmentCase.name} produced the wrong attachment result kind`,
    );
    ensure(tracker.healthySeen, `${attachmentCase.name} lost healthy content`);
  }

  for (const remaining of [0, 1, CONVERSATION_REST_LIMIT - 1]) {
    const budget = new DiscordRestBudget(remaining);
    ensure(budget.used === 0, `budget ${remaining} was not initially empty`);
    for (let call = 0; call < remaining; call++) {
      ensure(budget.consume(), `budget ${remaining} rejected call ${call}`);
    }
    ensure(budget.used === remaining, `budget ${remaining} consumed the wrong number of calls`);
    ensure(!budget.consume(), `budget ${remaining} accepted a call beyond its limit`);
  }

  const budgetBoundaryCases = [
    { name: "zero", limit: 0, expectedList: "failed", expectedFetch: "failed" },
    { name: "exactly-enough", limit: 2, expectedList: "ok", expectedFetch: "found" },
    { name: "one-short", limit: 1, expectedList: "ok", expectedFetch: "failed" },
  ] as const;
  for (const boundary of budgetBoundaryCases) {
    const harness = createHarness({
      name: `budget-${boundary.name}`,
      seed: `budget-${boundary.name}`,
      pageCount: 0,
      recordVariant: "none",
      initialMessages: [],
    });
    harness.reader.addFetchScript("200", fetchFound(harness.targetTrigger));
    const budget = new DiscordRestBudget(boundary.limit);
    const listResult = await execute(harness, `budget-${boundary.name}-list`, () =>
      harness.reader.list("channel", { before: CURRENT_ID, limit: 100 }, budget),
    );
    const fetchResult = await execute(harness, `budget-${boundary.name}-fetch`, () =>
      harness.reader.fetch("channel", "200", budget),
    );
    ensure(
      listResult.status === boundary.expectedList,
      `${boundary.name} had the wrong list result`,
    );
    ensure(
      fetchResult.status === boundary.expectedFetch,
      `${boundary.name} had the wrong fetch result`,
    );
    ensure(
      harness.oracle.deletedExchanges.size === 0,
      `${boundary.name} unexpectedly deleted content`,
    );
  }

  const listBoundarySizes = [99, 100, 101];
  for (const size of listBoundarySizes) {
    const isStraddled = size === 101;
    const firstPage = isStraddled
      ? [
          ...Array.from({ length: 98 }, (_, index) =>
            message(String(index + 1), `other-bot-${index}`, undefined, {
              author: { id: `other-bot-${index}`, username: `other-bot-${index}`, bot: true },
            }),
          ),
          message("99", HEALTHY_EXCHANGE),
          message("200", TARGET_EXCHANGE),
        ]
      : [
          ...Array.from({ length: size - 2 }, (_, index) =>
            message(String(index + 1), HEALTHY_EXCHANGE),
          ),
          message("200", TARGET_EXCHANGE),
          botPage("201", TARGET_EXCHANGE, 0),
        ];
    const harness = createHarness({
      name: `list-size-${size}`,
      seed: `list-size-${size}`,
      pageCount: 1,
      recordVariant: "completed-before",
      triggerLocation: "known",
      pageLocations: [isStraddled ? "fetch" : "known"],
      fetchOutcomes: isStraddled ? new Map([["201", fetchFound()]]) : undefined,
      initialMessages: firstPage,
    });
    if (isStraddled) {
      harness.reader.addListStep({
        label: "list-size-101-second-page",
        matches: exactQuery({ before: "1" }),
        response: okList([
          requireValue(harness.targetPages[0], "list-size fixture page is missing"),
        ]),
      });
    }
    const tracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
    const context = requireContext(
      await buildAndTrack(harness, tracker, `list-size-${size}`),
      `list size ${size} returned no context`,
    );
    ensure(
      harness.reader.listQueries.length === (isStraddled ? 2 : 1),
      `list size ${size} made the wrong number of page calls`,
    );
    ensure(
      context.messages.some((candidate) => candidate.exchangeId === TARGET_OUTPUT_EXCHANGE),
      `list size ${size} lost the trigger/reply exchange`,
    );
    ensure(tracker.healthySeen, `list size ${size} lost healthy content`);
  }

  for (const count of [
    WINDOW_SHRUNK_MESSAGE_LIMIT - 1,
    WINDOW_SHRUNK_MESSAGE_LIMIT,
    WINDOW_RAW_MESSAGE_LIMIT + 1,
  ]) {
    const messages = Array.from({ length: count }, (_, index) =>
      message(String(400 + index), HEALTHY_EXCHANGE),
    );
    const harness = createHarness({
      name: `entry-limit-${count}`,
      seed: `entry-limit-${count}`,
      pageCount: 0,
      recordVariant: "none",
      initialMessages: messages,
    });
    const tracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
    const context = requireContext(
      await buildAndTrack(harness, tracker, `entry-limit-${count}`),
      `entry limit ${count} returned no context`,
    );
    ensure(
      context.messages.length <= WINDOW_SHRUNK_MESSAGE_LIMIT,
      `entry limit ${count} exceeded compact message limit`,
    );
    ensure(tracker.healthySeen, `entry limit ${count} lost healthy content`);
  }

  for (const targetTokens of [
    WINDOW_SHRUNK_TOKEN_LIMIT - 1,
    WINDOW_SHRUNK_TOKEN_LIMIT,
    WINDOW_SHRUNK_TOKEN_LIMIT + 1,
  ]) {
    const buildPair = (fillerLength: number): RawDiscordMessage[] => [
      message("400", HEALTHY_EXCHANGE, undefined, {
        content: `exchange=${HEALTHY_EXCHANGE}|short`,
      }),
      message("401", HEALTHY_EXCHANGE, undefined, {
        content: `exchange=${HEALTHY_EXCHANGE}|${"x".repeat(fillerLength)}`,
      }),
    ];
    const tokensOf = (candidates: RawDiscordMessage[]): number =>
      candidates.reduce(
        (total, candidate, index) =>
          total +
          estimateNormalizedMessageTokens(
            {
              id: candidate.id,
              channelId: candidate.channel_id,
              kind: "user",
              author: candidate.author.username,
              time: candidate.timestamp,
              timestampMs: Date.parse(candidate.timestamp),
              text: candidate.content,
              attachments: [],
              exchangeId: candidate.id,
            },
            `m${index + 1}`,
          ),
        0,
      );
    // 概算は ASCII 4 文字で 1 トークンなので、詰め物の長さを二分探索して狙った合計に一致させる。
    let low = 0;
    let high = targetTokens * 4 + 64;
    let fillerLength = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const tokens = tokensOf(buildPair(mid));
      if (tokens <= targetTokens) {
        fillerLength = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const tokenMessages = buildPair(fillerLength);
    const actualTokens = tokensOf(tokenMessages);
    ensure(
      actualTokens === targetTokens,
      `token boundary ${targetTokens} could not be hit exactly (got ${actualTokens})`,
    );
    const harness = createHarness({
      name: `token-limit-${targetTokens}`,
      seed: `token-limit-${targetTokens}`,
      pageCount: 0,
      recordVariant: "none",
      initialMessages: tokenMessages,
    });
    const tracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
    const context = requireContext(
      await buildAndTrack(harness, tracker, `token-limit-${targetTokens}`),
      `token limit ${targetTokens} returned no context`,
    );
    const keptTokens = tokensOf(
      tokenMessages.filter((candidate) =>
        context.messages.some((kept) => kept.id === candidate.id),
      ),
    );
    ensure(
      keptTokens <= WINDOW_SHRUNK_TOKEN_LIMIT,
      `token limit ${targetTokens} kept ${keptTokens} tokens, over the compact limit`,
    );
    ensure(
      actualTokens > WINDOW_SHRUNK_TOKEN_LIMIT
        ? context.messages.length < tokenMessages.length
        : context.messages.length === tokenMessages.length,
      `token limit ${targetTokens} shrank the window incorrectly (kept ${context.messages.length} of ${tokenMessages.length})`,
    );
    ensure(
      context.messages.length <= WINDOW_SHRUNK_MESSAGE_LIMIT,
      `token limit ${targetTokens} exceeded compact message limit`,
    );
    ensure(tracker.healthySeen, `token limit ${targetTokens} lost healthy content`);
  }

  for (const offset of [1, 0, -1]) {
    const older = message(
      "100",
      HEALTHY_EXCHANGE,
      new Date(NOW - CONVERSATION_MAX_AGE_MS + offset).toISOString(),
    );
    const harness = createHarness({
      name: `age-limit-${offset}`,
      seed: `age-limit-${offset}`,
      pageCount: 0,
      recordVariant: "none",
    });
    const tracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
    const context = requireContext(
      await buildAndTrack(harness, tracker, `age-limit-build-${offset}`),
      `age limit ${offset} returned no context`,
    );
    addToolList(harness, [older], `age-limit-page-${offset}`);
    const result = await readAndTrack(
      harness,
      tracker,
      context,
      1,
      new AbortController().signal,
      `age-limit-${offset}`,
    );
    const returned = typeof result === "string" && result.includes("exchange=healthy|body=100");
    ensure(returned === offset >= 0, `24-hour boundary ${offset} returned the wrong content`);
    ensure(tracker.healthySeen, `24-hour boundary ${offset} lost healthy content`);
  }

  const replyLimitHarness = createHarness({
    name: "reply-target-deletion-over-limit",
    seed: "reply-target-deletion-over-limit",
    pageCount: 0,
    recordVariant: "none",
    initialMessages: Array.from({ length: 20 }, (_, index) =>
      message(String(400 + index), HEALTHY_EXCHANGE),
    ),
  });
  const replyLimitTracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
  const replyLimitFirstContext = requireContext(
    await buildAndTrack(replyLimitHarness, replyLimitTracker, "reply-limit-first-build"),
    "reply-limit fixture did not build its initial window",
  );
  const replyLimitAnchor = requireString(
    replyLimitFirstContext.windowStartMessageId,
    "reply-limit fixture did not establish its initial anchor",
  );
  replyLimitHarness.reader.addFetchScript(
    replyLimitAnchor,
    fetchFound(message(replyLimitAnchor, HEALTHY_EXCHANGE)),
  );
  replyLimitHarness.reader.addFetchScript("200", { status: "not-found" });
  replyLimitHarness.reader.addListStep({
    label: "reply-limit-extension",
    matches: exactQuery({ after: replyLimitAnchor }),
    response: okList(
      Array.from({ length: 40 }, (_, index) => message(String(401 + index), HEALTHY_EXCHANGE)),
    ),
  });
  replyLimitHarness.current = currentMessage("200", "1100");
  const replyLimitContext = requireContext(
    await buildAndTrack(replyLimitHarness, replyLimitTracker, "reply-limit-deletion-build"),
    "reply-limit deletion returned no context",
  );
  ensure(replyLimitContext.replyTarget === undefined, "deleted reply target crossed the limit");
  ensure(
    replyLimitContext.messages.length <= WINDOW_SHRUNK_MESSAGE_LIMIT,
    "reply-target deletion left the window over its compact limit",
  );
  ensure(
    replyLimitHarness.oracle.deletedExchanges.has(TARGET_OUTPUT_EXCHANGE),
    "reply-target deletion did not establish the oracle deletion",
  );
  ensure(replyLimitTracker.healthySeen, "reply-target deletion lost healthy content");

  for (const bytes of [
    READ_EARLIER_MAX_RESULT_BYTES - 64,
    READ_EARLIER_MAX_RESULT_BYTES,
    READ_EARLIER_MAX_RESULT_BYTES + 64,
  ]) {
    const older = message("100", HEALTHY_EXCHANGE, new Date(NOW - 10 * 60 * 1000).toISOString(), {
      content: `exchange=${HEALTHY_EXCHANGE}|${"x".repeat(Math.max(1, bytes))}`,
    });
    const harness = createHarness({
      name: `tool-bytes-${bytes}`,
      seed: `tool-bytes-${bytes}`,
      pageCount: 0,
      recordVariant: "none",
      initialMessages: [],
    });
    const tracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
    const context = requireContext(
      await buildAndTrack(harness, tracker, `tool-bytes-build-${bytes}`),
      `tool byte boundary ${bytes} did not build`,
    );
    addToolList(harness, [older], `tool-bytes-page-${bytes}`);
    const result = await readAndTrack(
      harness,
      tracker,
      context,
      1,
      new AbortController().signal,
      `tool-bytes-${bytes}`,
    );
    const resultBytes =
      typeof result === "string"
        ? new TextEncoder().encode(result).byteLength
        : new TextEncoder().encode(JSON.stringify(result)).byteLength;
    ensure(
      resultBytes <= READ_EARLIER_MAX_RESULT_BYTES,
      `tool byte boundary ${bytes} exceeded the result limit`,
    );
    ensure(tracker.healthySeen, `tool byte boundary ${bytes} lost healthy content`);
  }

  const ownDelete = createHarness({
    name: "bot-own-delete-interleaving",
    seed: "own-delete",
    pageCount: 1,
    recordVariant: "completed-before",
    triggerLocation: "known",
    pageLocations: ["fetch"],
    fetchOutcomes: new Map([["201", { status: "not-found" }]]),
  });
  ownDelete.records.state.afterListPages = (triggerMsgId) => {
    if (triggerMsgId === ownDelete.targetTrigger.id)
      ownDelete.records.state.pages.set(triggerMsgId, []);
  };
  const ownDeleteTracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
  const ownDeleteContext = requireContext(
    await buildAndTrack(ownDelete, ownDeleteTracker, "own-delete"),
    "bot-own-delete fixture returned no context",
  );
  ensure(ownDelete.oracle.deletedExchanges.size === 0, "bot-own-delete was treated as external");
  ensure(
    ownDeleteContext.messages.some((candidate) => candidate.exchangeId === TARGET_OUTPUT_EXCHANGE),
    "bot-own-delete removed the human trigger",
  );
  ensure(ownDeleteTracker.healthySeen, "bot-own-delete lost healthy content");
});

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(values: readonly T[]): T {
    const value = values[this.int(values.length)];
    if (value === undefined) fail("random picker received an empty array");
    return value;
  }

  bool(): boolean {
    return this.next() < 0.5;
  }
}

const RANDOM_SEED = 0x5eed_2026;
const RANDOM_CASE_COUNT = 48;

test("property: seeded random deletion scenarios are reproducible and preserve the oracle invariant", async () => {
  const random = new SeededRandom(RANDOM_SEED);
  for (let caseIndex = 0; caseIndex < RANDOM_CASE_COUNT; caseIndex++) {
    const caseSeed = Math.floor(random.next() * 4_294_967_296);
    const pageCount = random.int(3);
    const recordVariant = random.pick<RecordVariant>([
      "none",
      "pending",
      "failed",
      "completed-before",
      "completed-after",
      "stopped-before",
      "completed-mismatch",
    ]);
    const triggerLocation = random.pick<MessageLocation>(["known", "fetch", "absent"]);
    const pageLocations = Array.from({ length: recordVariant === "none" ? 0 : pageCount }, () =>
      random.pick<MessageLocation>(["known", "fetch"]),
    );
    const fetchOutcomes = new Map<string, FetchScript>();
    if (triggerLocation === "fetch") {
      fetchOutcomes.set(
        "200",
        random.bool()
          ? { status: "not-found" }
          : { status: "failed", error: new Error("random 5xx") },
      );
    }
    pageLocations.forEach((location, index) => {
      if (location === "fetch") {
        fetchOutcomes.set(
          String(201 + index),
          random.bool()
            ? { status: "not-found" }
            : { status: "failed", error: new Error("random page failure") },
        );
      }
    });
    const hasAttachment = random.bool() && triggerLocation === "known" && pageCount === 0;
    const harness = createHarness({
      name: `random-${caseIndex}`,
      seed: caseSeed,
      pageCount,
      recordVariant,
      triggerLocation,
      pageLocations,
      fetchOutcomes,
      targetAttachment: hasAttachment,
      currentReference: random.bool() ? "200" : undefined,
      shuffleInitialMessages: random.bool(),
    });
    const tracker = new OutputTracker(HEALTHY_OUTPUT_EXCHANGE, TARGET_OUTPUT_EXCHANGE);
    try {
      const context = await buildAndTrack(harness, tracker, "random-build");
      if (context) {
        const toolCount = 1 + random.int(3);
        for (let callIndex = 0; callIndex < toolCount; callIndex++) {
          const useAttachment =
            hasAttachment &&
            random.bool() &&
            tracker.refForExchange(TARGET_OUTPUT_EXCHANGE) !== undefined &&
            harness.reader.fetchQueries.length < CONVERSATION_REST_LIMIT;
          if (useAttachment) {
            const ref = tracker.refForExchange(TARGET_OUTPUT_EXCHANGE);
            if (!ref) fail("random attachment selected without a target ref");
            harness.reader.addFetchScript("200", {
              status: random.bool() ? "not-found" : "found",
              message: harness.targetTrigger,
            });
            installCdnFetch(random.bool() ? 200 : 404);
            await attachmentAndTrack(
              harness,
              tracker,
              context,
              TARGET_OUTPUT_EXCHANGE,
              ref,
              `random-attachment-${callIndex}`,
            );
          } else {
            const older = message(
              String(100 - callIndex),
              HEALTHY_EXCHANGE,
              new Date(NOW - (20 + callIndex) * 60 * 1000).toISOString(),
            );
            addToolList(harness, random.bool() ? [older] : [], `random-tool-${callIndex}`);
            await readAndTrack(
              harness,
              tracker,
              context,
              1 + random.int(3),
              random.bool() ? new AbortController().signal : alreadyAbortedSignal(),
              `random-read-${callIndex}`,
            );
          }
        }
      }
      ensure(tracker.healthySeen, "random scenario lost the unrelated healthy exchange");
    } catch (error) {
      throw scenarioError(harness, new Error(`random case ${caseIndex}: ${String(error)}`));
    }
  }
});

function alreadyAbortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}
