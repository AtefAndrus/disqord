import type { IReplyRecordRepository } from "../db/repositories/replyRecord";
import type { ConversationToolContext, ToolLlmResult } from "../llm/tools/registry";
import type { NormalizedMessage, RawDiscordMessage } from "../utils/discordMessageNormalizer";
import {
  buildConversationUntrustedDataSystemMessage,
  estimateNormalizedMessageTokens,
  formatMessageForTool,
  normalizeBotReply,
  normalizeHumanMessage,
} from "../utils/discordMessageNormalizer";
import type {
  DiscordMessageFetchResult,
  DiscordRestBudget,
  IDiscordMessageReader,
} from "./discordMessageReader";
import { DiscordRestBudget as RestBudget } from "./discordMessageReader";
import {
  type AuthorizationChannelLike,
  type AuthorizationMessageLike,
  canReadConversation,
} from "./messageAuthorization";
import {
  classifyNotFoundMessage,
  type MessageEligibilityCache,
  type MessageEligibilityExternalDeletionSet,
  MessageEligibilityService,
} from "./messageEligibility";

export const WINDOW_RAW_TOKEN_LIMIT = 8_000;
export const WINDOW_RAW_MESSAGE_LIMIT = 40;
export const WINDOW_RAW_AGE_MS = 60 * 60 * 1000;
export const WINDOW_SHRUNK_TOKEN_LIMIT = 4_000;
export const WINDOW_SHRUNK_MESSAGE_LIMIT = 20;
export const WINDOW_SHRUNK_AGE_MS = 30 * 60 * 1000;
export const WINDOW_REBUILD_AFTER_MS = 60 * 60 * 1000;
export const CONVERSATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CONVERSATION_REST_LIMIT = 12;
export const WINDOW_FETCH_TIMEOUT_MS = 5_000;
export const READ_EARLIER_MAX_CALLS = 3;
export const READ_EARLIER_MAX_MESSAGES = 60;
export const READ_EARLIER_MAX_RESULT_BYTES = 12 * 1024;

export type ConversationStopReason =
  | "call_limit"
  | "message_limit"
  | "24h_cutoff"
  | "no_permission"
  | "fetch_failed"
  | null;

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
  authorize: () => Promise<boolean>;
  budget: DiscordRestBudget;
  cursor: string;
  cutoffAt: number;
  replyTarget?: NormalizedMessage;
  buffer: NormalizedMessage[];
  shown: Map<string, NormalizedMessage>;
  shownCount: number;
  calls: number;
  seenReplies: Set<string>;
  knownMessages: Map<string, RawDiscordMessage>;
  refCounter: number;
  exhausted: boolean;
  cutoffReached: boolean;
  reachedReplyTarget: boolean;
  openedAttachments: Set<string>;
  attachmentResults: Map<string, ToolLlmResult>;
  verificationCache: MessageEligibilityCache;
  externalDeletions: MessageEligibilityExternalDeletionSet;
}

export interface ConversationWindowContext {
  messages: NormalizedMessage[];
  replyTarget?: NormalizedMessage;
  sessionId: string;
  windowStartMessageId: string;
  toolContext: ConversationToolContext;
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

export function truncateTextByBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  let end = Math.max(0, Math.min(bytes.byteLength, Math.trunc(maxBytes)));
  while (end > 0 && end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.slice(0, end));
}

function asToolResult(
  messages: readonly NormalizedMessage[],
  hasMore: boolean,
  reason: ConversationStopReason,
  references: readonly string[] = [],
): string {
  const value: ReadEarlierMessageResult = {
    messages: [
      ...messages.map((message) => formatMessageForTool(message)),
      ...references.map((ref) => ({ ref })),
    ],
    has_more: hasMore,
    stop_reason: reason,
  };
  return JSON.stringify(value);
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
    const verificationCache: MessageEligibilityCache = new Map();
    const externalDeletions: MessageEligibilityExternalDeletionSet = new Set();
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
    const generation = this.nextGeneration();
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
        authorize,
        budget,
        cursor: minMessageId(staleCursor ?? result.startMessageId, input.current.id),
        cutoffAt: currentTime - CONVERSATION_MAX_AGE_MS,
        replyTarget: result.replyTarget,
        buffer: [],
        shown: new Map(),
        shownCount: 0,
        calls: 0,
        seenReplies: new Set(),
        knownMessages: new Map(result.rawMessages.map((message) => [message.id, message])),
        refCounter: 0,
        exhausted: false,
        cutoffReached: false,
        reachedReplyTarget: false,
        openedAttachments: new Set(),
        attachmentResults: new Map(),
        verificationCache,
        externalDeletions,
      };
      const messages = result.messages
        .filter((message) => !externalDeletions.has(message.exchangeId))
        .map((message) => this.addShown(responseState, message));
      const replyTargetResult =
        result.replyTarget && !externalDeletions.has(result.replyTarget.exchangeId)
          ? result.replyTarget
          : undefined;
      const hasReplyTarget = replyTargetResult
        ? messages.some((message) => message.id === replyTargetResult.id)
        : false;
      const replyTarget =
        replyTargetResult && !hasReplyTarget
          ? this.addShown(responseState, replyTargetResult)
          : undefined;
      responseState.replyTarget = replyTarget;
      return {
        messages,
        ...(replyTarget && { replyTarget }),
        sessionId: result.sessionId,
        windowStartMessageId: result.startMessageId,
        toolContext: {
          readEarlierMessages: (count, signal) => this.readEarlier(responseState, count, signal),
          viewAttachment: (messageRef, attachmentIndex, model, signal) =>
            this.viewAttachment(responseState, messageRef, attachmentIndex, model, signal),
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
  ): Promise<NormalizedMessage[]> {
    const sorted = sortedMessages(rawMessages);
    const known = new Map(sorted.map((message) => [message.id, message]));
    const entries: NormalizedMessage[] = [];
    const seenReplies = new Set<string>();
    for (const message of sorted) {
      const result = await this.eligibility.evaluate(
        message,
        {
          currentTimestampMs: currentTime,
          botUserId: input.botUserId,
          e2eTesterBotId: input.e2eTesterBotId,
          nodeEnv: input.nodeEnv,
          channelId: input.current.channel_id,
          maxAgeMs: CONVERSATION_MAX_AGE_MS,
        },
        budget,
        known,
        verificationCache,
        externalDeletions,
        signal,
      );
      if (signal?.aborted) return [];
      if (!result.eligible) continue;
      if (result.isHuman) {
        const normalized = normalizeHumanMessage(message);
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
        );
    if (signal.aborted) return undefined;
    if (target.status === "not-found") {
      return undefined;
    }
    if (
      target.status !== "found" ||
      messageTime(target.message) < currentTime - CONVERSATION_MAX_AGE_MS
    ) {
      return undefined;
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
        maxAgeMs: CONVERSATION_MAX_AGE_MS,
      },
      budget,
      knownMessages,
      verificationCache,
      externalDeletions,
      signal,
    );
    if (!result.eligible) return undefined;
    const resolved = result.isHuman
      ? normalizeHumanMessage(target.message)
      : result.reply
        ? normalizeBotReply(result.reply.record.triggerMsgId, result.reply.pages)
        : undefined;
    return resolved && !externalDeletions.has(resolved.exchangeId) ? resolved : undefined;
  }

  private async fetchMessage(
    channelId: string,
    messageId: string,
    budget: DiscordRestBudget,
    externalDeletions: MessageEligibilityExternalDeletionSet,
    signal: AbortSignal,
  ): Promise<DiscordMessageFetchResult> {
    const result = await this.reader.fetch(channelId, messageId, budget, signal);
    if (result.status === "not-found" && !signal.aborted) {
      classifyNotFoundMessage(messageId, this.records, externalDeletions);
    }
    return result;
  }

  private addShown(state: ResponseState, message: NormalizedMessage): NormalizedMessage {
    const existing = state.shown.get(message.id);
    if (existing) return existing;
    const withRef = { ...message, ref: `m${++state.refCounter}` };
    state.shown.set(withRef.id, withRef);
    state.shownCount += 1;
    if (withRef.kind === "assistant" && withRef.triggerMsgId) {
      state.seenReplies.add(withRef.triggerMsgId);
    }
    return withRef;
  }

  private async readEarlier(
    state: ResponseState,
    requestedCount: number,
    signal: AbortSignal,
  ): Promise<ToolLlmResult> {
    const aborted = (): ToolLlmResult => asToolResult([], true, "fetch_failed");
    if (signal.aborted) return aborted();
    if (state.calls >= READ_EARLIER_MAX_CALLS) {
      return asToolResult([], true, "call_limit");
    }
    state.calls += 1;
    if (!(await state.authorize())) {
      return asToolResult([], false, "no_permission");
    }
    if (signal.aborted) return aborted();

    const draft: ResponseState = {
      ...state,
      calls: state.calls,
      buffer: [...state.buffer],
      shown: new Map(state.shown),
      seenReplies: new Set(state.seenReplies),
    };
    const count = Math.max(1, Math.min(20, Math.trunc(requestedCount)));
    const available = READ_EARLIER_MAX_MESSAGES - draft.shownCount;
    if (available <= 0) return asToolResult([], true, "message_limit");
    const targetCount = Math.min(count, available);
    let stoppedReason: ConversationStopReason = null;
    const references: string[] = [];
    while (
      this.eligibleBufferCount(draft) < targetCount &&
      !draft.cutoffReached &&
      !draft.exhausted
    ) {
      if (signal.aborted) return aborted();
      const page = await this.reader.list(
        draft.current.channel_id,
        { before: draft.cursor, limit: 100 },
        draft.budget,
        signal,
      );
      if (signal.aborted) return aborted();
      if (page.status !== "ok") {
        stoppedReason = page.status === "forbidden" ? "no_permission" : "fetch_failed";
        break;
      }
      if (page.messages.length === 0) {
        draft.exhausted = true;
        break;
      }
      const beforeCurrent = page.messages.filter(
        (message) => compareMessageIds(message.id, draft.current.id) < 0,
      );
      if (beforeCurrent.length === 0) {
        draft.exhausted = true;
        break;
      }
      const oldest = beforeCurrent[0];
      if (oldest) {
        draft.cursor = oldest.id;
        if (messageTime(oldest) < draft.cutoffAt) draft.cutoffReached = true;
      }
      const inRange = beforeCurrent.filter((message) => messageTime(message) >= draft.cutoffAt);
      const entries = await this.eligibleEntries(
        inRange,
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
        draft.budget,
        false,
        draft.verificationCache,
        draft.externalDeletions,
        signal,
      );
      if (signal.aborted) return aborted();
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
            if (draft.replyTarget.ref) references.push(draft.replyTarget.ref);
          }
          continue;
        }
        if (draft.shown.has(entry.id) || draft.buffer.some((item) => item.id === entry.id))
          continue;
        draft.buffer.push(entry);
      }
      draft.buffer.sort((left, right) => left.timestampMs - right.timestampMs);
      if (page.messages.length < 100 || draft.cutoffReached) {
        draft.exhausted = true;
        break;
      }
    }

    draft.buffer = draft.buffer.filter(
      (message) =>
        compareMessageIds(entryPositionId(message), draft.current.id) < 0 &&
        !draft.externalDeletions.has(message.exchangeId),
    );

    const selected = draft.buffer.splice(
      Math.max(0, draft.buffer.length - targetCount),
      targetCount,
    );
    const shown: NormalizedMessage[] = [];
    for (const message of selected) {
      if (draft.shown.has(message.id)) continue;
      shown.push(this.addShown(draft, message));
    }
    const provisionalReason = stoppedReason
      ? stoppedReason
      : draft.cutoffReached && draft.buffer.length === 0
        ? "24h_cutoff"
        : available <= shown.length
          ? "message_limit"
          : null;
    const provisionalHasMore = draft.buffer.length > 0 || !draft.exhausted;
    const output = await this.fitToolResult(
      draft,
      shown,
      provisionalHasMore,
      provisionalReason,
      references,
    );
    if (signal.aborted) return aborted();
    const filteredOutput = output.filter(
      (message) =>
        compareMessageIds(entryPositionId(message), draft.current.id) < 0 &&
        !draft.externalDeletions.has(message.exchangeId),
    );
    const safeReferences =
      draft.replyTarget && draft.externalDeletions.has(draft.replyTarget.exchangeId)
        ? []
        : references;
    const hasMore = draft.buffer.length > 0 || !draft.exhausted;
    const reason = stoppedReason
      ? stoppedReason
      : draft.cutoffReached && draft.buffer.length === 0
        ? "24h_cutoff"
        : available <= filteredOutput.length
          ? "message_limit"
          : null;
    const outputIds = new Set(filteredOutput.map((message) => message.id));
    for (const message of shown) {
      if (!outputIds.has(message.id)) {
        draft.shown.delete(message.id);
        draft.shownCount -= 1;
      }
    }
    if (signal.aborted) return aborted();

    state.calls = draft.calls;
    state.cursor = draft.cursor;
    state.buffer = draft.buffer;
    state.shown = draft.shown;
    state.shownCount = draft.shownCount;
    state.seenReplies = draft.seenReplies;
    state.refCounter = draft.refCounter;
    state.exhausted = draft.exhausted;
    state.cutoffReached = draft.cutoffReached;
    state.reachedReplyTarget = draft.reachedReplyTarget;
    return asToolResult(filteredOutput, hasMore, reason, safeReferences);
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

  private async fitToolResult(
    state: ResponseState,
    messages: readonly NormalizedMessage[],
    hasMore: boolean,
    reason: ConversationStopReason,
    references: readonly string[] = [],
  ): Promise<NormalizedMessage[]> {
    const fits = (items: readonly NormalizedMessage[]): boolean =>
      new TextEncoder().encode(asToolResult(items, hasMore, reason, references)).length <=
      READ_EARLIER_MAX_RESULT_BYTES;
    const items = [...messages];
    const deferred: NormalizedMessage[] = [];
    while (items.length > 0 && !fits(items)) {
      if (items.length === 1) {
        const message = items[0];
        if (!message) break;
        let low = 0;
        let high = message.text.length;
        let best = "";
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const end =
            mid > 0 &&
            mid < message.text.length &&
            message.text.charCodeAt(mid - 1) >= 0xd800 &&
            message.text.charCodeAt(mid - 1) <= 0xdbff &&
            message.text.charCodeAt(mid) >= 0xdc00 &&
            message.text.charCodeAt(mid) <= 0xdfff
              ? mid - 1
              : mid;
          const candidate = {
            ...message,
            text: message.text.slice(0, end),
            toolTruncated: true,
          };
          if (fits([candidate])) {
            best = candidate.text;
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }
        items[0] = { ...message, text: best, toolTruncated: true };
        break;
      }
      const returned = items.shift();
      if (returned) deferred.push(returned);
    }
    state.buffer.push(...deferred);
    state.buffer.sort((left, right) => left.timestampMs - right.timestampMs);
    return items;
  }

  private async viewAttachment(
    state: ResponseState,
    messageRef: string,
    attachmentIndex: number,
    model: string,
    signal: AbortSignal,
  ): Promise<ToolLlmResult> {
    const shown = [...state.shown.values()].find((candidate) => candidate.ref === messageRef);
    if (shown && state.externalDeletions.has(shown.exchangeId)) {
      return '{"error":"attachment_unavailable"}';
    }
    const result = await this.loadAttachment(state, messageRef, attachmentIndex, model, signal);
    return shown && state.externalDeletions.has(shown.exchangeId)
      ? '{"error":"attachment_unavailable"}'
      : result;
  }

  private async loadAttachment(
    state: ResponseState,
    messageRef: string,
    attachmentIndex: number,
    model: string,
    signal: AbortSignal,
  ): Promise<ToolLlmResult> {
    if (!(await state.authorize())) return '{"error":"no_permission"}';
    const message = [...state.shown.values()].find((candidate) => candidate.ref === messageRef);
    if (!message) return '{"error":"message_ref_not_shown"}';
    const attachment = message.attachments.find((candidate) => candidate.index === attachmentIndex);
    if (!attachment) {
      return '{"error":"attachment_unavailable"}';
    }
    const cacheKey = `${state.current.id}:${attachment.id}`;
    const cached = state.attachmentResults.get(cacheKey);
    if (cached) return Array.isArray(cached) ? '{"status":"already_loaded"}' : cached;
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
      state.budget,
      state.externalDeletions,
      signal,
    );
    if (fetched.status !== "found") {
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
