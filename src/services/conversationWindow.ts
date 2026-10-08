import type { IReplyRecordRepository } from "../db/repositories/replyRecord";
import { estimateToolResultTokens } from "../llm/contextBudget";
import { READ_EARLIER_MAX_COUNT } from "../llm/tools/readEarlierMessages";
import type { ConversationToolContext, ToolLlmResult } from "../llm/tools/registry";
import type { NormalizedMessage, RawDiscordMessage } from "../utils/discordMessageNormalizer";
import {
  buildConversationUntrustedDataSystemMessage,
  estimateNormalizedMessageTokens,
  extractComponentsV2ReplyBody,
  formatMessageForTool,
  normalizeBotPoll,
  normalizeBotReply,
  normalizeExternalBotMessage,
  normalizeHumanMessage,
  normalizePollResultNotice,
} from "../utils/discordMessageNormalizer";
import { estimateTextTokens } from "../utils/tokenEstimate";
import type {
  DiscordMessageFetchResult,
  DiscordRestBudget,
  IDiscordMessageReader,
} from "./discordMessageReader";
import { DiscordRestBudget as RestBudget } from "./discordMessageReader";
import {
  type AuthorizationChannelLike,
  type AuthorizationMessageLike,
  type ConversationAccess,
  canReadConversation,
  checkConversationAccess,
} from "./messageAuthorization";
import {
  classifyNotFoundMessage,
  type MessageEligibilityCache,
  type MessageEligibilityExternalDeletionSet,
  type MessageEligibilityFetchedMessages,
  type MessageEligibilityResult,
  MessageEligibilityService,
} from "./messageEligibility";

export const WINDOW_RAW_TOKEN_LIMIT = 8_000;
export const WINDOW_RAW_MESSAGE_LIMIT = 40;
export const WINDOW_RAW_AGE_MS = 60 * 60 * 1000;
export const WINDOW_SHRUNK_TOKEN_LIMIT = 4_000;
export const WINDOW_SHRUNK_MESSAGE_LIMIT = 20;
export const WINDOW_SHRUNK_AGE_MS = 30 * 60 * 1000;
export const WINDOW_REBUILD_AFTER_MS = 60 * 60 * 1000;
/** Discord REST calls the window may make while it is built. */
export const CONVERSATION_REST_LIMIT = 12;
export const WINDOW_FETCH_TIMEOUT_MS = 5_000;
/**
 * Discord REST calls every tool call of one response shares: paging and reply
 * checks of `read_earlier_messages`, the refetch in `view_attachment`, and
 * authorization. One budget for the response rather than one per call,
 * because a response can run up to 32 tool calls one after another, and with
 * no age limit on history each could otherwise page far back and crowd the
 * rate limit other responses share.
 */
export const TOOL_REST_LIMIT = 40;
/**
 * `read_earlier_messages` stops paging here and returns what it has, well
 * before the dispatcher's 30-second timeout would discard all of it. Rate
 * limits and retries make the time a REST call takes unpredictable, so the
 * call count alone cannot bound it.
 */
export const READ_EARLIER_DEADLINE_MS = 20_000;
/** Below this many tokens beyond the empty result, not even one truncated message fits. */
const READ_EARLIER_MIN_MESSAGE_TOKENS = 64;

export type ConversationStopReason =
  | "fetch_deadline"
  | "rest_budget_exhausted"
  | "result_budget_exhausted"
  | "no_permission"
  | "fetch_failed"
  | null;

/** Once returned, every later call of the response returns it again without REST. */
type StickyStopReason = "rest_budget_exhausted" | "result_budget_exhausted";

/** The longest `stop_reason`, used to size a result before its reason is known. */
const LONGEST_STOP_REASON: ConversationStopReason = "result_budget_exhausted";

type ReadEarlierToolMessage = ReturnType<typeof formatMessageForTool> | { ref: string };

export interface ReadEarlierMessageResult {
  messages: ReadEarlierToolMessage[];
  has_more: boolean;
  stop_reason: ConversationStopReason;
}

interface WindowState {
  startMessageId: string;
  sessionId: string;
  lastUsedAt: number;
}

interface ResponseState {
  current: RawDiscordMessage;
  botUserId: string;
  e2eTesterBotId?: string;
  nodeEnv?: string;
  userId: string;
  channel: AuthorizationChannelLike;
  checkAccess: () => Promise<ConversationAccess>;
  checkAttachmentAccess: () => Promise<ConversationAccess>;
  toolBudget: DiscordRestBudget;
  /** Oldest message ID whose page has been fully checked. Moves only a whole page at a time. */
  cursor: string;
  replyTarget?: NormalizedMessage;
  buffer: NormalizedMessage[];
  shown: Map<string, NormalizedMessage>;
  pinShown: Map<string, NormalizedMessage>;
  seenReplies: Set<string>;
  knownMessages: Map<string, RawDiscordMessage>;
  refCounter: number;
  exhausted: boolean;
  reachedReplyTarget: boolean;
  stickyStop?: StickyStopReason;
  openedAttachments: Set<string>;
  attachmentResults: Map<string, ToolLlmResult>;
  verificationCache: MessageEligibilityCache;
  externalDeletions: MessageEligibilityExternalDeletionSet;
  fetchedMessages: MessageEligibilityFetchedMessages;
}

export interface ConversationWindowContext {
  messages: NormalizedMessage[];
  replyTarget?: NormalizedMessage;
  replyTargetRef?: string;
  sessionId: string;
  windowStartMessageId: string;
  toolContext: ConversationToolContext;
  toolRestBudget?: DiscordRestBudget;
  readPins?: (
    fetch: (signal: AbortSignal) => Promise<IPinsPage>,
    signal: AbortSignal,
    budgetTokens?: number,
  ) => Promise<string>;
}

export interface IPinsPage {
  items: { message: RawDiscordMessage; pinnedAt: string }[];
  hasMore: boolean;
  error?: string;
}

export interface BuildConversationWindowInput {
  current: RawDiscordMessage;
  guildId: string;
  userId: string;
  botUserId: string;
  botUser: unknown;
  channel: AuthorizationChannelLike;
  authorizationMessage?: AuthorizationMessageLike;
  authorize?: () => Promise<boolean>;
  reauthorize?: (budget: DiscordRestBudget) => Promise<ConversationAccess>;
  historyEnabled: boolean;
  e2eTesterBotId?: string;
  nodeEnv?: string;
}

function compareMessageIds(left: string, right: string): number {
  try {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  } catch {
    return left.localeCompare(right);
  }
}

function minMessageId(left: string, right: string): string {
  return compareMessageIds(left, right) <= 0 ? left : right;
}

function messageTime(message: RawDiscordMessage): number {
  const parsed = Date.parse(message.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortedMessages(messages: readonly RawDiscordMessage[]): RawDiscordMessage[] {
  return [...messages].sort((left, right) => compareMessageIds(left.id, right.id));
}

function uniqueMessages(messages: readonly RawDiscordMessage[]): RawDiscordMessage[] {
  const seen = new Set<string>();
  return sortedMessages(messages).filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

function rawLimitExceeded(messages: readonly NormalizedMessage[], now: number): boolean {
  const tokenCount = messages.reduce(
    (total, message, index) => total + estimateNormalizedMessageTokens(message, `m${index + 1}`),
    0,
  );
  const oldest = messages[0];
  return (
    tokenCount > WINDOW_RAW_TOKEN_LIMIT ||
    messages.length > WINDOW_RAW_MESSAGE_LIMIT ||
    (oldest !== undefined && now - oldest.timestampMs > WINDOW_RAW_AGE_MS)
  );
}

interface ShrunkMeasurements {
  count: number;
  tokens: number;
  oldestAgeMs: number | undefined;
}

function measureShrunkLimits(
  messages: readonly NormalizedMessage[],
  now: number,
): ShrunkMeasurements {
  const oldest = messages[0];
  return {
    count: messages.length,
    tokens: messages.reduce(
      (total, message, index) => total + estimateNormalizedMessageTokens(message, `m${index + 1}`),
      0,
    ),
    oldestAgeMs: oldest === undefined ? undefined : now - oldest.timestampMs,
  };
}

function fitsShrunkLimits(messages: readonly NormalizedMessage[], now: number): boolean {
  const measurements = measureShrunkLimits(messages, now);
  return (
    measurements.count <= WINDOW_SHRUNK_MESSAGE_LIMIT &&
    measurements.tokens <= WINDOW_SHRUNK_TOKEN_LIMIT &&
    (measurements.oldestAgeMs === undefined || measurements.oldestAgeMs <= WINDOW_SHRUNK_AGE_MS)
  );
}

function reachesShrunkBoundary(messages: readonly NormalizedMessage[], now: number): boolean {
  const measurements = measureShrunkLimits(messages, now);
  return (
    measurements.count >= WINDOW_SHRUNK_MESSAGE_LIMIT ||
    measurements.tokens >= WINDOW_SHRUNK_TOKEN_LIMIT ||
    (measurements.oldestAgeMs !== undefined && measurements.oldestAgeMs >= WINDOW_SHRUNK_AGE_MS)
  );
}

// 同じミリ秒の発言はページ境界で取得順が入れ替わるので、message ID で順位を決める。
function byChronology(left: NormalizedMessage, right: NormalizedMessage): number {
  if (left.timestampMs !== right.timestampMs) return left.timestampMs - right.timestampMs;
  return compareMessageIds(left.id, right.id);
}

function entryPositionId(message: NormalizedMessage): string {
  return message.kind === "assistant" ? (message.pageIds?.[0] ?? message.id) : message.id;
}

function selectEntries(
  messages: readonly NormalizedMessage[],
  startMessageId: string,
): NormalizedMessage[] {
  return messages.filter((message) => {
    if (message.kind === "assistant") {
      return (message.pageIds ?? [message.id]).every(
        (pageId) => compareMessageIds(pageId, startMessageId) >= 0,
      );
    }
    return compareMessageIds(message.id, startMessageId) >= 0;
  });
}

interface ShrinkResult {
  messages: NormalizedMessage[];
  startMessageId: string;
}

function shrinkToLimits(
  messages: readonly NormalizedMessage[],
  now: number,
  fallbackStartMessageId: string,
): ShrinkResult {
  const candidates = [...new Set(messages.map(entryPositionId))].sort(compareMessageIds);
  for (const candidate of candidates) {
    const selected = selectEntries(messages, candidate);
    if (fitsShrunkLimits(selected, now)) {
      return { messages: selected, startMessageId: candidate };
    }
  }
  return { messages: [], startMessageId: fallbackStartMessageId };
}

function estimateFormattedMessageTokens(message: NormalizedMessage, ref: string): number {
  // The trailing comma separates entries in the array; counting it for every
  // entry keeps the sum an upper bound of the serialized whole.
  return estimateTextTokens(`${JSON.stringify(formatMessageForTool({ ...message, ref }))},`);
}

export function truncateTextByBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  let end = Math.max(0, Math.min(bytes.byteLength, Math.trunc(maxBytes)));
  while (end > 0 && end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.slice(0, end));
}

interface ToolReference {
  ref: string;
  id: string;
  timestampMs: number;
}

function asToolResult(
  messages: readonly NormalizedMessage[],
  hasMore: boolean,
  reason: ConversationStopReason,
  references: readonly ToolReference[] = [],
): string {
  // 既に見せた reply 先は本文を重ねず参照だけを返すが、並びは本文と同じ古い順に保つ。
  const entries = [
    ...messages.map((message) => ({
      id: message.id,
      timestampMs: message.timestampMs,
      value: formatMessageForTool(message) as ReadEarlierToolMessage,
    })),
    ...references.map((reference) => ({
      id: reference.id,
      timestampMs: reference.timestampMs,
      value: { ref: reference.ref } as ReadEarlierToolMessage,
    })),
  ].sort((left, right) => {
    if (left.timestampMs !== right.timestampMs) return left.timestampMs - right.timestampMs;
    return compareMessageIds(left.id, right.id);
  });
  const value: ReadEarlierMessageResult = {
    messages: entries.map((entry) => entry.value),
    has_more: hasMore,
    stop_reason: reason,
  };
  return JSON.stringify(value);
}

/** Resolves with `undefined` once `signal` aborts, leaving `promise` to settle on its own. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class ConversationWindowService {
  private readonly states = new Map<string, WindowState>();
  private generationCounter = 0;
  private readonly committedGenerations = new Map<string, number>();
  private readonly eligibility: MessageEligibilityService;
  private readonly records: IReplyRecordRepository;

  constructor(
    private readonly reader: IDiscordMessageReader,
    records: IReplyRecordRepository,
    private readonly now: () => number = () => Date.now(),
    private readonly imageCapability: (model: string) => Promise<boolean | null> = async () => true,
    private readonly windowFetchTimeoutMs = WINDOW_FETCH_TIMEOUT_MS,
    private readonly readEarlierDeadlineMs = READ_EARLIER_DEADLINE_MS,
  ) {
    this.records = records;
    this.eligibility = new MessageEligibilityService(reader, records);
  }

  async build(input: BuildConversationWindowInput): Promise<ConversationWindowContext | null> {
    const now = this.now();
    this.sweepStaleChannels(now);
    if (!input.historyEnabled) return null;
    const currentTime = messageTime(input.current) || now;
    const budget = new RestBudget(CONVERSATION_REST_LIMIT);
    const toolBudget = new RestBudget(TOOL_REST_LIMIT);
    const verificationCache: MessageEligibilityCache = new Map();
    const externalDeletions: MessageEligibilityExternalDeletionSet = new Set();
    const fetchedMessages: MessageEligibilityFetchedMessages = new Map();
    const controller = new AbortController();
    const authorize = input.authorize
      ? input.authorize
      : input.authorizationMessage
        ? () =>
            canReadConversation(
              input.authorizationMessage as AuthorizationMessageLike,
              input.botUser,
              budget,
            )
        : async () => false;
    // Tool calls check access again on every call, from the tool budget, so
    // that a window that used up its own budget does not turn them into
    // no_permission.
    const checkToolAccess = input.authorize
      ? async (): Promise<ConversationAccess> =>
          (await (input.authorize as () => Promise<boolean>)()) ? "allowed" : "denied"
      : input.authorizationMessage
        ? () =>
            checkConversationAccess(
              input.authorizationMessage as AuthorizationMessageLike,
              input.botUser,
              toolBudget,
            )
        : async (): Promise<ConversationAccess> => "denied";
    const generation = this.nextGeneration();
    const reauthorize = input.reauthorize;
    let staleCursor: string | undefined;

    try {
      const result = await this.withTimeout(
        (async () => {
          if (!(await authorize())) return null;
          if (controller.signal.aborted) return null;
          const state = this.states.get(input.current.channel_id);
          const needsRebuild =
            state === undefined || now - state.lastUsedAt > WINDOW_REBUILD_AFTER_MS;
          const stateIsAhead =
            state !== undefined && compareMessageIds(state.startMessageId, input.current.id) >= 0;
          if (stateIsAhead && state) {
            staleCursor = minMessageId(state.startMessageId, input.current.id);
          }
          return stateIsAhead
            ? this.rebuild(
                input,
                currentTime,
                now,
                budget,
                verificationCache,
                externalDeletions,
                controller.signal,
                fetchedMessages,
                generation,
                false,
              )
            : needsRebuild
              ? this.rebuild(
                  input,
                  currentTime,
                  now,
                  budget,
                  verificationCache,
                  externalDeletions,
                  controller.signal,
                  fetchedMessages,
                  generation,
                )
              : this.extend(
                  input,
                  state,
                  currentTime,
                  now,
                  budget,
                  verificationCache,
                  externalDeletions,
                  controller.signal,
                  fetchedMessages,
                  generation,
                );
        })(),
        this.windowFetchTimeoutMs,
        controller,
      );
      if (!result) return null;
      const responseState: ResponseState = {
        current: input.current,
        botUserId: input.botUserId,
        e2eTesterBotId: input.e2eTesterBotId,
        nodeEnv: input.nodeEnv,
        userId: input.userId,
        channel: input.channel,
        checkAccess: checkToolAccess,
        checkAttachmentAccess: reauthorize ? () => reauthorize(toolBudget) : checkToolAccess,
        toolBudget,
        cursor: minMessageId(staleCursor ?? result.startMessageId, input.current.id),
        replyTarget: result.replyTarget,
        buffer: [],
        shown: new Map(),
        pinShown: new Map(),
        seenReplies: new Set(),
        knownMessages: new Map(result.rawMessages.map((message) => [message.id, message])),
        refCounter: 0,
        exhausted: false,
        reachedReplyTarget: false,
        openedAttachments: new Set(),
        attachmentResults: new Map(),
        verificationCache,
        externalDeletions,
        fetchedMessages,
      };
      // ここの除外は二重の守りである。同じ判定を rebuild() と extend() が reply 先の確認の後に行い、
      // reply 先自体は findReplyTarget() が落とす。テストが落ちるのはそちらなので、両方を残す。
      const messages = result.messages
        .filter((message) => !externalDeletions.has(message.exchangeId))
        .map((message) => this.addShown(responseState, message));
      const replyTargetResult =
        result.replyTarget && !externalDeletions.has(result.replyTarget.exchangeId)
          ? result.replyTarget
          : undefined;
      const windowReplyTarget = replyTargetResult
        ? messages.find((message) => message.id === replyTargetResult.id)
        : undefined;
      const replyTarget =
        replyTargetResult && !windowReplyTarget
          ? this.addShown(responseState, replyTargetResult)
          : undefined;
      responseState.replyTarget = replyTarget;
      return {
        messages,
        ...(replyTarget && { replyTarget }),
        ...((windowReplyTarget ?? replyTarget)?.ref && {
          replyTargetRef: (windowReplyTarget ?? replyTarget)?.ref,
        }),
        sessionId: result.sessionId,
        windowStartMessageId: result.startMessageId,
        toolRestBudget: toolBudget,
        readPins: (fetch, signal, budgetTokens) =>
          this.readPins(responseState, fetch, signal, budgetTokens ?? Number.POSITIVE_INFINITY),
        toolContext: {
          resolveMessageRef: (ref) =>
            [...responseState.shown.values(), ...responseState.pinShown.values()].find(
              (message) => message.ref === ref,
            )?.id,
          readEarlierMessages: (count, signal, budgetTokens) =>
            this.readEarlier(
              responseState,
              count,
              budgetTokens ?? Number.POSITIVE_INFINITY,
              signal,
            ),
          viewAttachment: (messageRef, attachmentIndex, model, signal, budgetTokens) =>
            this.viewAttachment(
              responseState,
              messageRef,
              attachmentIndex,
              model,
              budgetTokens ?? Number.POSITIVE_INFINITY,
              signal,
            ),
        },
      };
    } catch (error) {
      console.warn(
        "[conversationWindow] history read failed",
        error instanceof Error ? error.name : typeof error,
      );
      return null;
    }
  }

  sweepStaleChannels(now = this.now()): number {
    let removed = 0;
    for (const [channelId, state] of this.states) {
      if (now - state.lastUsedAt > WINDOW_REBUILD_AFTER_MS) {
        this.states.delete(channelId);
        this.committedGenerations.delete(channelId);
        removed += 1;
      }
    }
    return removed;
  }

  private nextGeneration(): number {
    this.generationCounter += 1;
    return this.generationCounter;
  }

  private commitState(channelId: string, state: WindowState, generation: number): void {
    if (generation <= (this.committedGenerations.get(channelId) ?? 0)) return;
    this.states.set(channelId, state);
    this.committedGenerations.set(channelId, generation);
  }

  private async rebuild(
    input: BuildConversationWindowInput,
    currentTime: number,
    now: number,
    budget: DiscordRestBudget,
    verificationCache: MessageEligibilityCache,
    externalDeletions: MessageEligibilityExternalDeletionSet,
    signal: AbortSignal,
    fetchedMessages: MessageEligibilityFetchedMessages,
    generation: number,
    commitState = true,
  ): Promise<WindowBuildResult | null> {
    const collected: RawDiscordMessage[] = [];
    let before = input.current.id;
    while (true) {
      if (signal.aborted) return null;
      const page = await this.reader.list(
        input.current.channel_id,
        { before, limit: 100 },
        budget,
        signal,
      );
      if (signal.aborted) return null;
      if (page.status !== "ok") return null;
      collected.push(
        ...page.messages.filter((message) => compareMessageIds(message.id, input.current.id) < 0),
      );
      const oldest = page.messages[0];
      if (
        page.messages.length < 100 ||
        oldest === undefined ||
        messageTime(oldest) <= now - WINDOW_SHRUNK_AGE_MS
      ) {
        break;
      }
      if (budget.used >= budget.limit) break;
      const eligible = await this.eligibleEntries(
        uniqueMessages(collected),
        input,
        currentTime,
        budget,
        true,
        verificationCache,
        externalDeletions,
        signal,
        fetchedMessages,
        now - WINDOW_SHRUNK_AGE_MS,
      );
      if (signal.aborted) return null;
      if (reachesShrunkBoundary(eligible, now) || budget.used >= budget.limit) break;
      before = oldest.id;
    }
    const rawMessages = uniqueMessages(collected);
    const messages = await this.eligibleEntries(
      rawMessages,
      input,
      currentTime,
      budget,
      true,
      verificationCache,
      externalDeletions,
      signal,
      fetchedMessages,
      now - WINDOW_SHRUNK_AGE_MS,
    );
    if (signal.aborted) return null;
    const replyTarget = await this.findReplyTarget(
      input,
      rawMessages,
      currentTime,
      budget,
      verificationCache,
      externalDeletions,
      signal,
      fetchedMessages,
    );
    if (signal.aborted) return null;
    const filteredMessages = messages.filter(
      (message) => !externalDeletions.has(message.exchangeId),
    );
    const shrunk = shrinkToLimits(filteredMessages, now, input.current.id);
    const { messages: selected, startMessageId } = shrunk;
    const sessionId = crypto.randomUUID();
    if (commitState) {
      this.commitState(
        input.current.channel_id,
        { startMessageId, sessionId, lastUsedAt: now },
        generation,
      );
    }
    return { messages: selected, rawMessages, startMessageId, sessionId, replyTarget };
  }

  private async extend(
    input: BuildConversationWindowInput,
    state: WindowState,
    currentTime: number,
    now: number,
    budget: DiscordRestBudget,
    verificationCache: MessageEligibilityCache,
    externalDeletions: MessageEligibilityExternalDeletionSet,
    signal: AbortSignal,
    fetchedMessages: MessageEligibilityFetchedMessages,
    generation: number,
  ): Promise<WindowBuildResult | null> {
    if (signal.aborted) return null;
    const anchor = await this.fetchMessage(
      input.current.channel_id,
      state.startMessageId,
      budget,
      externalDeletions,
      signal,
    );
    if (signal.aborted) return null;
    const fetched: RawDiscordMessage[] =
      anchor.status === "found" && compareMessageIds(anchor.message.id, input.current.id) < 0
        ? [anchor.message]
        : [];
    let after = state.startMessageId;
    while (true) {
      if (signal.aborted) return null;
      const page = await this.reader.list(
        input.current.channel_id,
        { after, limit: 100 },
        budget,
        signal,
      );
      if (signal.aborted) return null;
      if (page.status !== "ok") return null;
      const eligibleRange = page.messages.filter(
        (message) => compareMessageIds(message.id, input.current.id) < 0,
      );
      fetched.push(...eligibleRange);
      // 今回の発言に達したら、そのページで走査は終わりである。
      // 続けると REST 予算を使い切り、取得済みの窓ごと失うことがある。
      if (eligibleRange.length < page.messages.length) break;
      if (page.messages.length < 100 || eligibleRange.length === 0) break;
      const last = page.messages.at(-1);
      if (!last || last.id === after) break;
      after = last.id;
    }
    const rawMessages = uniqueMessages(fetched);
    const messages = await this.eligibleEntries(
      rawMessages,
      input,
      currentTime,
      budget,
      true,
      verificationCache,
      externalDeletions,
      signal,
      fetchedMessages,
    );
    if (signal.aborted) return null;
    let selected = selectEntries(messages, state.startMessageId);
    let startMessageId = state.startMessageId;
    let sessionId = state.sessionId;
    const replyTarget = await this.findReplyTarget(
      input,
      rawMessages,
      currentTime,
      budget,
      verificationCache,
      externalDeletions,
      signal,
      fetchedMessages,
    );
    if (signal.aborted) return null;
    selected = selected.filter((message) => !externalDeletions.has(message.exchangeId));
    if (rawLimitExceeded(selected, now)) {
      const shrunk = shrinkToLimits(selected, now, input.current.id);
      selected = shrunk.messages;
      startMessageId = shrunk.startMessageId;
      sessionId = crypto.randomUUID();
    }
    this.commitState(
      input.current.channel_id,
      { startMessageId, sessionId, lastUsedAt: now },
      generation,
    );
    return { messages: selected, rawMessages, startMessageId, sessionId, replyTarget };
  }

  private async eligibleEntries(
    rawMessages: readonly RawDiscordMessage[],
    input: BuildConversationWindowInput,
    currentTime: number,
    budget: DiscordRestBudget,
    requireCompleteExchange: boolean,
    verificationCache: MessageEligibilityCache,
    externalDeletions: MessageEligibilityExternalDeletionSet,
    signal?: AbortSignal,
    fetchedMessages: MessageEligibilityFetchedMessages = new Map(),
    minTimestampMs?: number,
  ): Promise<NormalizedMessage[]> {
    const sorted = sortedMessages(rawMessages);
    const known = new Map(sorted.map((message) => [message.id, message]));
    const entries: NormalizedMessage[] = [];
    const seenReplies = new Set<string>();
    for (const message of sorted) {
      // 窓外の返答検証で期限を消費しないが、古い trigger/pages は known に残して検証に使う。
      if (minTimestampMs !== undefined && messageTime(message) < minTimestampMs) continue;
      const result = await this.eligibility.evaluate(
        message,
        {
          currentTimestampMs: currentTime,
          botUserId: input.botUserId,
          e2eTesterBotId: input.e2eTesterBotId,
          nodeEnv: input.nodeEnv,
          channelId: input.current.channel_id,
        },
        budget,
        known,
        verificationCache,
        externalDeletions,
        signal,
        fetchedMessages,
      );
      if (signal?.aborted) return [];
      if (!result.eligible) continue;
      const pollEntry = this.normalizePollEntry(message, result, input.botUserId);
      if (pollEntry) {
        entries.push(pollEntry);
        continue;
      }
      if (result.isHuman) {
        const normalized = normalizeHumanMessage(message, this.now());
        if (result.reply) normalized.exchangeId = result.reply.record.triggerMsgId;
        entries.push(normalized);
        continue;
      }
      const reply = result.reply;
      if (!reply || seenReplies.has(reply.record.triggerMsgId)) continue;
      if (requireCompleteExchange) {
        const complete = reply.pages.every((page) => known.has(page.id));
        if (!complete) continue;
      }
      seenReplies.add(reply.record.triggerMsgId);
      entries.push(normalizeBotReply(reply.record.triggerMsgId, reply.pages));
    }
    return entries
      .filter((entry) => !externalDeletions.has(entry.exchangeId))
      .sort((left, right) => {
        if (left.timestampMs !== right.timestampMs) return left.timestampMs - right.timestampMs;
        return compareMessageIds(left.id, right.id);
      });
  }

  private async findReplyTarget(
    input: BuildConversationWindowInput,
    rawMessages: readonly RawDiscordMessage[],
    currentTime: number,
    budget: DiscordRestBudget,
    verificationCache: MessageEligibilityCache,
    externalDeletions: MessageEligibilityExternalDeletionSet,
    signal: AbortSignal,
    fetchedMessages: MessageEligibilityFetchedMessages,
  ): Promise<NormalizedMessage | undefined> {
    const targetId = input.current.message_reference?.message_id;
    const targetChannelId = input.current.message_reference?.channel_id;
    if (
      !targetId ||
      (targetChannelId !== undefined && targetChannelId !== input.current.channel_id)
    ) {
      return undefined;
    }
    const known = rawMessages.find((message) => message.id === targetId);
    const target = known
      ? ({ status: "found", message: known } satisfies DiscordMessageFetchResult)
      : await this.fetchMessage(
          input.current.channel_id,
          targetId,
          budget,
          externalDeletions,
          signal,
          fetchedMessages,
        );
    if (signal.aborted) return undefined;
    if (target.status === "not-found") {
      return undefined;
    }
    if (target.status !== "found") return undefined;
    const referenced = target.message;
    if (
      referenced.author.id !== input.botUserId &&
      (referenced.author.bot === true || referenced.webhook_id !== undefined) &&
      (referenced.type === undefined || referenced.type === 0 || referenced.type === 19)
    ) {
      return externalDeletions.has(referenced.id)
        ? undefined
        : normalizeExternalBotMessage(referenced, this.now());
    }
    const knownMessages = new Map(rawMessages.map((message) => [message.id, message]));
    knownMessages.set(target.message.id, target.message);
    const result = await this.eligibility.evaluate(
      target.message,
      {
        currentTimestampMs: currentTime,
        botUserId: input.botUserId,
        e2eTesterBotId: input.e2eTesterBotId,
        nodeEnv: input.nodeEnv,
        channelId: input.current.channel_id,
      },
      budget,
      knownMessages,
      verificationCache,
      externalDeletions,
      signal,
      fetchedMessages,
    );
    if (!result.eligible) return undefined;
    const resolved =
      this.normalizePollEntry(target.message, result, input.botUserId) ??
      (result.isHuman
        ? normalizeHumanMessage(target.message, this.now())
        : result.reply
          ? normalizeBotReply(result.reply.record.triggerMsgId, result.reply.pages)
          : undefined);
    return resolved && !externalDeletions.has(resolved.exchangeId) ? resolved : undefined;
  }

  /** A bot poll or a poll-closed notice, which have no reply record to normalize from. */
  private normalizePollEntry(
    message: RawDiscordMessage,
    result: MessageEligibilityResult,
    botUserId: string,
  ): NormalizedMessage | undefined {
    if (result.exchangeId === undefined) return undefined;
    if (result.reason === "bot-poll") {
      return normalizeBotPoll(message, result.exchangeId, this.now());
    }
    if (result.reason === "poll-result") {
      return normalizePollResultNotice(message, result.exchangeId, message.author.id === botUserId);
    }
    return undefined;
  }

  private async fetchMessage(
    channelId: string,
    messageId: string,
    budget: DiscordRestBudget,
    externalDeletions: MessageEligibilityExternalDeletionSet,
    signal: AbortSignal,
    fetchedMessages?: MessageEligibilityFetchedMessages,
  ): Promise<DiscordMessageFetchResult> {
    const result = await this.reader.fetch(channelId, messageId, budget, signal);
    if (result.status === "found") fetchedMessages?.set(messageId, result.message);
    if (result.status === "not-found" && !signal.aborted) {
      classifyNotFoundMessage(messageId, this.records, externalDeletions);
    }
    return result;
  }

  private addShown(state: ResponseState, message: NormalizedMessage): NormalizedMessage {
    const existing = state.shown.get(message.id);
    if (existing) return existing;
    const withRef = {
      ...message,
      ref: state.pinShown.get(message.id)?.ref ?? `m${++state.refCounter}`,
    };
    state.pinShown.delete(message.id);
    state.shown.set(withRef.id, withRef);
    if (withRef.kind === "assistant" && withRef.triggerMsgId) {
      state.seenReplies.add(withRef.triggerMsgId);
    }
    return withRef;
  }

  private async readPins(
    state: ResponseState,
    fetch: (signal: AbortSignal) => Promise<IPinsPage>,
    signal: AbortSignal,
    budgetTokens: number,
  ): Promise<string> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.readEarlierDeadlineMs);
    const fetchSignal = AbortSignal.any([signal, deadline.signal]);
    const pins: Array<ReturnType<typeof formatMessageForTool> & { pinned_at: string }> = [];
    let skipped = 0;
    let hasMore = false;
    let stopReason: ConversationStopReason = null;
    let nextBefore: string | undefined;
    const serialize = (): string =>
      JSON.stringify({
        pins,
        skipped_count: skipped,
        has_more: hasMore,
        ...(hasMore && nextBefore && { next_before: nextBefore }),
        stop_reason: stopReason,
      });
    try {
      const page = await untilAborted(fetch(fetchSignal), fetchSignal);
      if (!page) {
        hasMore = true;
        stopReason = deadline.signal.aborted ? "fetch_deadline" : "fetch_failed";
        return serialize();
      }
      if (page.error) return JSON.stringify({ error: page.error });
      hasMore = page.hasMore;
      const known = new Map(state.knownMessages);
      for (const item of page.items) known.set(item.message.id, item.message);
      for (const { message, pinnedAt } of [...page.items].sort(
        (a, b) => Date.parse(b.pinnedAt) - Date.parse(a.pinnedAt),
      )) {
        if (fetchSignal.aborted || state.toolBudget.used >= state.toolBudget.limit) {
          hasMore = true;
          stopReason = deadline.signal.aborted
            ? "fetch_deadline"
            : signal.aborted
              ? "fetch_failed"
              : "rest_budget_exhausted";
          break;
        }
        const judged = await untilAborted(
          this.eligibility.evaluate(
            message,
            {
              currentTimestampMs: messageTime(state.current),
              botUserId: state.botUserId,
              e2eTesterBotId: state.e2eTesterBotId,
              nodeEnv: state.nodeEnv,
              channelId: state.current.channel_id,
            },
            state.toolBudget,
            known,
            state.verificationCache,
            state.externalDeletions,
            fetchSignal,
            state.fetchedMessages,
          ),
          fetchSignal,
        );
        if (!judged || fetchSignal.aborted || state.toolBudget.refused) {
          hasMore = true;
          stopReason = state.toolBudget.refused
            ? "rest_budget_exhausted"
            : deadline.signal.aborted
              ? "fetch_deadline"
              : "fetch_failed";
          break;
        }
        nextBefore = pinnedAt;
        if (!judged.eligible || judged.reason === "unconfirmable") {
          skipped += 1;
          continue;
        }
        let normalized =
          this.normalizePollEntry(message, judged, state.botUserId) ??
          normalizeHumanMessage(message, this.now());
        if (!judged.isHuman && judged.reply) {
          const page = judged.reply.pages.find((candidate) => candidate.id === message.id);
          if (!page) {
            skipped += 1;
            continue;
          }
          normalized = {
            ...normalizeBotReply(judged.reply.record.triggerMsgId, [page]),
            text: extractComponentsV2ReplyBody(page, page.page.seq === 0),
          };
        }
        if (judged.isHuman && judged.reply)
          normalized.exchangeId = judged.reply.record.triggerMsgId;
        const ref =
          state.shown.get(message.id)?.ref ??
          state.pinShown.get(message.id)?.ref ??
          `m${state.refCounter + 1}`;
        const entry = { ...formatMessageForTool({ ...normalized, ref }), pinned_at: pinnedAt };
        pins.push(entry);
        // Size with the longest reason and paging fields before committing the ref.
        const size = (): number =>
          estimateToolResultTokens(
            JSON.stringify({
              pins,
              skipped_count: page.items.length,
              has_more: true,
              next_before: pinnedAt,
              stop_reason: LONGEST_STOP_REASON,
            }),
          );
        if (size() > budgetTokens) {
          pins.pop();
          hasMore = true;
          stopReason = "result_budget_exhausted";
          if (pins.length === 0) {
            const truncated = this.truncateToFit(normalized, ref, budgetTokens, (message) => {
              pins.push({ ...formatMessageForTool({ ...message, ref }), pinned_at: pinnedAt });
              const tokens = size();
              pins.pop();
              return tokens;
            });
            if (truncated) {
              pins.push({ ...formatMessageForTool({ ...truncated, ref }), pinned_at: pinnedAt });
              if (!state.shown.has(message.id) && !state.pinShown.has(message.id)) {
                state.refCounter += 1;
                state.pinShown.set(message.id, { ...truncated, ref });
              }
              state.knownMessages.set(message.id, message);
            }
          }
          break;
        }
        // A pinned page does not mean the merged reply has been read.
        if (judged.reply && !judged.isHuman && judged.reply.pages.length > 1) {
          if (!state.shown.has(message.id) && !state.pinShown.has(message.id)) {
            state.refCounter += 1;
            state.pinShown.set(message.id, { ...normalized, ref });
          }
        } else {
          this.addShown(state, normalized);
        }
        state.knownMessages.set(message.id, message);
      }
      return serialize();
    } catch {
      hasMore = true;
      stopReason = state.toolBudget.refused ? "rest_budget_exhausted" : "fetch_failed";
      return serialize();
    } finally {
      clearTimeout(timer);
    }
  }

  private async readEarlier(
    state: ResponseState,
    requestedCount: number,
    budgetTokens: number,
    signal: AbortSignal,
  ): Promise<ToolLlmResult> {
    const aborted = (): ToolLlmResult => asToolResult([], true, "fetch_failed");
    if (signal.aborted) return aborted();
    if (state.stickyStop) return asToolResult([], true, state.stickyStop);
    if (
      budgetTokens <
      estimateToolResultTokens(asToolResult([], true, LONGEST_STOP_REASON)) +
        READ_EARLIER_MIN_MESSAGE_TOKENS
    ) {
      state.stickyStop = "result_budget_exhausted";
      return asToolResult([], true, state.stickyStop);
    }

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.readEarlierDeadlineMs);
    const fetchSignal = AbortSignal.any([signal, deadline.signal]);
    try {
      // The authorization REST call takes no signal, so the deadline can only
      // stop waiting for it. History is never returned before it passes.
      const access = await untilAborted(state.checkAccess(), fetchSignal);
      if (signal.aborted) return aborted();
      if (access === undefined) return asToolResult([], true, "fetch_deadline");
      if (access === "denied") return asToolResult([], false, "no_permission");
      if (access === "failed") return asToolResult([], true, "fetch_failed");
      if (access === "rest_budget_exhausted") {
        state.stickyStop = "rest_budget_exhausted";
        return asToolResult([], true, state.stickyStop);
      }
      return await this.readEarlierPages(
        state,
        Math.max(1, Math.min(READ_EARLIER_MAX_COUNT, Math.trunc(requestedCount))),
        budgetTokens,
        signal,
        deadline.signal,
        fetchSignal,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async readEarlierPages(
    state: ResponseState,
    count: number,
    budgetTokens: number,
    signal: AbortSignal,
    deadlineSignal: AbortSignal,
    fetchSignal: AbortSignal,
  ): Promise<ToolLlmResult> {
    const aborted = (): ToolLlmResult => asToolResult([], true, "fetch_failed");
    const draft: ResponseState = {
      ...state,
      buffer: [...state.buffer],
      shown: new Map(state.shown),
      pinShown: new Map(state.pinShown),
      seenReplies: new Set(state.seenReplies),
    };
    let stoppedReason: ConversationStopReason = null;
    const references: ToolReference[] = [];
    // A page is committed (cursor, buffer, reply-target reference) only after
    // every message on it has been checked. A page cut short by the deadline
    // or the REST budget is dropped whole and fetched again by the next call;
    // the checks it finished stay in the response's caches.
    while (this.eligibleBufferCount(draft) < count && !draft.exhausted) {
      if (signal.aborted) return aborted();
      if (deadlineSignal.aborted) {
        stoppedReason = "fetch_deadline";
        break;
      }
      if (draft.toolBudget.used >= draft.toolBudget.limit) {
        stoppedReason = "rest_budget_exhausted";
        break;
      }
      const page = await this.reader.list(
        draft.current.channel_id,
        { before: draft.cursor, limit: 100 },
        draft.toolBudget,
        fetchSignal,
      );
      if (signal.aborted) return aborted();
      if (deadlineSignal.aborted) {
        stoppedReason = "fetch_deadline";
        break;
      }
      if (page.status !== "ok") {
        stoppedReason =
          page.status === "forbidden"
            ? "no_permission"
            : draft.toolBudget.refused
              ? "rest_budget_exhausted"
              : "fetch_failed";
        break;
      }
      const beforeCurrent = page.messages.filter(
        (message) => compareMessageIds(message.id, draft.current.id) < 0,
      );
      const oldest = beforeCurrent[0];
      if (!oldest) {
        draft.exhausted = true;
        break;
      }
      const entries = await this.eligibleEntries(
        beforeCurrent,
        {
          current: draft.current,
          guildId: draft.current.guild_id ?? "",
          userId: draft.userId,
          botUserId: draft.botUserId,
          botUser: undefined,
          channel: draft.channel,
          historyEnabled: true,
          e2eTesterBotId: draft.e2eTesterBotId,
          nodeEnv: draft.nodeEnv,
        },
        messageTime(draft.current),
        draft.toolBudget,
        false,
        draft.verificationCache,
        draft.externalDeletions,
        fetchSignal,
        draft.fetchedMessages,
      );
      if (signal.aborted) return aborted();
      // A check cut short here reads as a failed fetch, which would make a
      // human trigger look eligible and drop a bot reply. Neither is a
      // verdict, so the page is left unprocessed instead.
      if (deadlineSignal.aborted) {
        stoppedReason = "fetch_deadline";
        break;
      }
      if (draft.toolBudget.refused) {
        stoppedReason = "rest_budget_exhausted";
        break;
      }
      draft.cursor = oldest.id;
      draft.buffer = draft.buffer.filter(
        (message) =>
          compareMessageIds(entryPositionId(message), draft.current.id) < 0 &&
          !draft.externalDeletions.has(message.exchangeId),
      );
      for (const entry of entries) {
        if (compareMessageIds(entryPositionId(entry), draft.current.id) >= 0) continue;
        if (draft.replyTarget?.id === entry.id) {
          if (
            !draft.reachedReplyTarget &&
            !draft.externalDeletions.has(draft.replyTarget.exchangeId)
          ) {
            draft.reachedReplyTarget = true;
            if (draft.replyTarget.ref) {
              references.push({
                ref: draft.replyTarget.ref,
                id: draft.replyTarget.id,
                timestampMs: draft.replyTarget.timestampMs,
              });
            }
          }
          continue;
        }
        if (draft.shown.has(entry.id) || draft.buffer.some((item) => item.id === entry.id))
          continue;
        draft.buffer.push(entry);
      }
      draft.buffer.sort(byChronology);
      if (page.messages.length < 100) {
        draft.exhausted = true;
        break;
      }
    }

    draft.buffer = draft.buffer.filter(
      (message) =>
        compareMessageIds(entryPositionId(message), draft.current.id) < 0 &&
        !draft.externalDeletions.has(message.exchangeId),
    );
    // 走査がまだ追いついていない範囲より古い発言は、いま返すと「新しい方から count 件」に反する。
    // 分割した返答は後半のページから先に見つかるので、走査が終わるまでバッファに残す。
    const selectable = draft.exhausted
      ? draft.buffer
      : draft.buffer.filter(
          (message) => compareMessageIds(entryPositionId(message), draft.cursor) >= 0,
        );
    const candidates = selectable
      .slice(Math.max(0, selectable.length - count))
      .filter((message) => !draft.shown.has(message.id));
    const safeReferences =
      draft.replyTarget && draft.externalDeletions.has(draft.replyTarget.exchangeId)
        ? []
        : references;
    const fitted = this.fitToBudget(draft, candidates, safeReferences, budgetTokens);
    if (candidates.length > 0 && fitted.length === 0) {
      stoppedReason = "result_budget_exhausted";
    }
    const fittedIds = new Set(fitted.map((message) => message.id));
    draft.buffer = draft.buffer.filter((message) => !fittedIds.has(message.id));
    const shown = fitted.map((message) => this.addShown(draft, message));
    if (signal.aborted) return aborted();

    state.cursor = draft.cursor;
    state.buffer = draft.buffer;
    state.shown = draft.shown;
    state.pinShown = draft.pinShown;
    state.seenReplies = draft.seenReplies;
    state.refCounter = draft.refCounter;
    state.exhausted = draft.exhausted;
    state.reachedReplyTarget = draft.reachedReplyTarget;
    if (stoppedReason === "rest_budget_exhausted" || stoppedReason === "result_budget_exhausted") {
      state.stickyStop = stoppedReason;
    }
    const hasMore = draft.buffer.length > 0 || !draft.exhausted;
    return asToolResult(shown, hasMore, stoppedReason, safeReferences);
  }

  private eligibleBufferCount(state: ResponseState): number {
    return state.buffer.filter(
      (message) =>
        !state.shown.has(message.id) &&
        compareMessageIds(entryPositionId(message), state.current.id) < 0 &&
        !state.externalDeletions.has(message.exchangeId) &&
        compareMessageIds(entryPositionId(message), state.cursor) >= 0,
    ).length;
  }

  /**
   * Takes messages from the newest end of `candidates` while the whole
   * result, sized as the JSON the model receives, stays within
   * `budgetTokens`. Every message is sized with the longest ref it could get
   * and the result with the longest stop reason, so the estimate is an upper
   * bound. When not even the newest message fits, its text is cut to fit and
   * marked truncated; when not even an empty text fits, nothing is returned.
   * Returned in chronological order.
   */
  private fitToBudget(
    state: ResponseState,
    candidates: readonly NormalizedMessage[],
    references: readonly ToolReference[],
    budgetTokens: number,
  ): NormalizedMessage[] {
    if (candidates.length === 0) return [];
    const longestRef = `m${state.refCounter + candidates.length}`;
    let remaining =
      budgetTokens -
      estimateToolResultTokens(asToolResult([], true, LONGEST_STOP_REASON, references));
    const fitted: NormalizedMessage[] = [];
    for (let index = candidates.length - 1; index >= 0; index--) {
      const message = candidates[index];
      if (!message) continue;
      const tokens = estimateFormattedMessageTokens(message, longestRef);
      if (tokens <= remaining) {
        fitted.unshift(message);
        remaining -= tokens;
        continue;
      }
      if (fitted.length === 0) {
        const truncated = this.truncateToFit(message, longestRef, remaining);
        if (truncated) fitted.push(truncated);
      }
      break;
    }
    return fitted;
  }

  private truncateToFit(
    whole: NormalizedMessage,
    ref: string,
    budgetTokens: number,
    estimateTokens: (
      message: NormalizedMessage,
      ref: string,
    ) => number = estimateFormattedMessageTokens,
  ): NormalizedMessage | undefined {
    // The poll is folded into the text so that it is cut too; a poll left
    // whole could alone exceed the budget and stop the tool from paging on.
    const message: NormalizedMessage =
      whole.poll === undefined
        ? whole
        : { ...whole, text: [whole.text, whole.poll].filter(Boolean).join("\n"), poll: undefined };
    const withText = (length: number): NormalizedMessage => {
      const end =
        length > 0 &&
        length < message.text.length &&
        message.text.charCodeAt(length - 1) >= 0xd800 &&
        message.text.charCodeAt(length - 1) <= 0xdbff
          ? length - 1
          : length;
      return { ...message, text: message.text.slice(0, end), toolTruncated: true };
    };
    if (estimateTokens(withText(0), ref) > budgetTokens) return undefined;
    let low = 0;
    let high = message.text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (estimateTokens(withText(mid), ref) <= budgetTokens) low = mid;
      else high = mid - 1;
    }
    return withText(low);
  }

  private async viewAttachment(
    state: ResponseState,
    messageRef: string,
    attachmentIndex: number,
    model: string,
    budgetTokens: number,
    signal: AbortSignal,
  ): Promise<ToolLlmResult> {
    const shown = [...state.shown.values(), ...state.pinShown.values()].find(
      (candidate) => candidate.ref === messageRef,
    );
    if (shown && state.externalDeletions.has(shown.exchangeId)) {
      return '{"error":"attachment_unavailable"}';
    }
    const result = await this.loadAttachment(
      state,
      messageRef,
      attachmentIndex,
      model,
      budgetTokens,
      signal,
    );
    return shown && state.externalDeletions.has(shown.exchangeId)
      ? '{"error":"attachment_unavailable"}'
      : result;
  }

  private async loadAttachment(
    state: ResponseState,
    messageRef: string,
    attachmentIndex: number,
    model: string,
    budgetTokens: number,
    signal: AbortSignal,
  ): Promise<ToolLlmResult> {
    const access = await state.checkAttachmentAccess();
    if (access === "denied") return '{"error":"no_permission"}';
    if (access === "rest_budget_exhausted") return '{"error":"rest_budget_exhausted"}';
    if (access === "failed") return '{"error":"attachment_unavailable"}';
    const message = [...state.shown.values(), ...state.pinShown.values()].find(
      (candidate) => candidate.ref === messageRef,
    );
    if (!message) return '{"error":"message_ref_not_shown"}';
    const attachment = message.attachments.find((candidate) => candidate.index === attachmentIndex);
    if (!attachment) {
      return '{"error":"attachment_unavailable"}';
    }
    const cacheKey = `${state.current.id}:${attachment.id}`;
    const cached = state.attachmentResults.get(cacheKey);
    if (cached) return Array.isArray(cached) ? '{"status":"already_loaded"}' : cached;
    // Checked before anything is marked, so a later call with more room could
    // still open it; the budget never grows within a response, though.
    if (
      (attachment.kind === "image" || attachment.kind === "pdf") &&
      estimateToolResultTokens([
        attachment.kind === "image"
          ? { type: "input_image", detail: "auto", image_url: "" }
          : { type: "input_file", filename: attachment.filename, file_data: "" },
      ]) > budgetTokens
    ) {
      return '{"error":"result_budget_exhausted"}';
    }
    if (!state.openedAttachments.has(cacheKey) && state.openedAttachments.size >= 2) {
      const result = '{"error":"attachment_limit"}';
      state.attachmentResults.set(cacheKey, result);
      return result;
    }
    state.openedAttachments.add(cacheKey);
    if (attachment.kind !== "image" && attachment.kind !== "pdf") {
      const result = '{"error":"attachment_unavailable"}';
      state.attachmentResults.set(cacheKey, result);
      return result;
    }
    if (attachment.kind === "image") {
      const capable = await this.imageCapability(model);
      if (!capable) {
        const result = '{"error":"model_does_not_support_images"}';
        state.attachmentResults.set(cacheKey, result);
        return result;
      }
    }
    const fetched = await this.fetchMessage(
      state.current.channel_id,
      message.id,
      state.toolBudget,
      state.externalDeletions,
      signal,
    );
    if (fetched.status !== "found") {
      if (state.toolBudget.refused) return '{"error":"rest_budget_exhausted"}';
      const result = '{"error":"attachment_unavailable"}';
      state.attachmentResults.set(cacheKey, result);
      return result;
    }
    const fresh = fetched.message.attachments?.find((candidate) => candidate.id === attachment.id);
    if (!fresh) {
      const result = '{"error":"attachment_unavailable"}';
      state.attachmentResults.set(cacheKey, result);
      return result;
    }
    const maxBytes = attachment.kind === "image" ? 8 * 1024 * 1024 : 20 * 1024 * 1024;
    if (fresh.size > maxBytes) {
      const result = '{"error":"attachment_too_large"}';
      state.attachmentResults.set(cacheKey, result);
      return result;
    }
    let url: URL;
    try {
      url = new URL(fresh.url);
    } catch {
      const result = '{"error":"attachment_unavailable"}';
      state.attachmentResults.set(cacheKey, result);
      return result;
    }
    if (!this.isDiscordCdnHost(url.hostname)) {
      const result = '{"error":"attachment_unavailable"}';
      state.attachmentResults.set(cacheKey, result);
      return result;
    }
    try {
      const fetched = await this.fetchAttachment(url, signal);
      if (!fetched) {
        const result = '{"error":"attachment_unavailable"}';
        state.attachmentResults.set(cacheKey, result);
        return result;
      }
      const finalUrl = new URL(fetched.response.url || fetched.url.href);
      if (
        !this.isDiscordCdnHost(finalUrl.hostname) ||
        finalUrl.protocol !== "https:" ||
        !fetched.response.ok
      ) {
        const result = '{"error":"attachment_unavailable"}';
        state.attachmentResults.set(cacheKey, result);
        return result;
      }
      const bytesResult = await this.readAttachmentBody(fetched.response, maxBytes, signal);
      if (bytesResult === "too-large") {
        const result = '{"error":"attachment_too_large"}';
        state.attachmentResults.set(cacheKey, result);
        return result;
      }
      if (!bytesResult) {
        const result = '{"error":"attachment_unavailable"}';
        state.attachmentResults.set(cacheKey, result);
        return result;
      }
      const bytes = bytesResult;
      const mime = fetched.response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
      const expected = attachment.mimeType?.toLowerCase() ?? mime;
      if (
        !this.acceptedMime(expected, attachment.kind) ||
        !this.acceptedMime(mime, attachment.kind)
      ) {
        const result = '{"error":"attachment_unavailable"}';
        state.attachmentResults.set(cacheKey, result);
        return result;
      }
      const data = Buffer.from(bytes).toString("base64");
      const result =
        attachment.kind === "image"
          ? [
              {
                type: "input_image" as const,
                detail: "auto" as const,
                image_url: `data:${expected};base64,${data}`,
              },
            ]
          : [
              {
                type: "input_file" as const,
                filename: fresh.filename,
                file_data: `data:application/pdf;base64,${data}`,
              },
            ];
      state.attachmentResults.set(cacheKey, result);
      return result;
    } catch {
      const result = '{"error":"attachment_unavailable"}';
      state.attachmentResults.set(cacheKey, result);
      return result;
    }
  }

  private isDiscordCdnHost(hostname: string): boolean {
    return hostname === "cdn.discordapp.com" || hostname === "media.discordapp.net";
  }

  private async fetchAttachment(
    url: URL,
    signal: AbortSignal,
  ): Promise<{ response: Response; url: URL } | null> {
    let current = url;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (current.protocol !== "https:" || !this.isDiscordCdnHost(current.hostname)) return null;
      const response = await fetch(current, { redirect: "manual", signal });
      if (response.status < 300 || response.status >= 400) {
        return { response, url: current };
      }
      const location = response.headers.get("location");
      if (!location) return null;
      try {
        current = new URL(location, current);
      } catch {
        return null;
      }
    }
    return null;
  }

  private async readAttachmentBody(
    response: Response,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array | "too-large" | null> {
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        if (signal.aborted) {
          await reader.cancel();
          return null;
        }
        const next = await reader.read();
        if (next.done) break;
        const chunk = new Uint8Array(next.value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // The size decision is already conclusive even if stream cancellation fails.
          }
          return "too-large";
        }
        chunks.push(chunk);
      }
    } catch {
      return null;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private acceptedMime(mime: string | null | undefined, kind: "image" | "pdf"): boolean {
    if (kind === "pdf") return mime === "application/pdf";
    return (
      mime === "image/png" || mime === "image/jpeg" || mime === "image/gif" || mime === "image/webp"
    );
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    controller: AbortController,
  ): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

interface WindowBuildResult {
  messages: NormalizedMessage[];
  rawMessages: RawDiscordMessage[];
  startMessageId: string;
  sessionId: string;
  replyTarget?: NormalizedMessage;
}

export function buildConversationWindowSystemMessage(): ReturnType<
  typeof buildConversationUntrustedDataSystemMessage
> {
  return buildConversationUntrustedDataSystemMessage();
}
