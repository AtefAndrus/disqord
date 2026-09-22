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
import { MessageEligibilityService } from "./messageEligibility";

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
  reachedReplyTarget: boolean;
  openedAttachments: Set<string>;
  attachmentResults: Map<string, ToolLlmResult>;
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

function exchangeGroups(messages: readonly NormalizedMessage[]): NormalizedMessage[][] {
  const groups: NormalizedMessage[][] = [];
  const byExchange = new Map<string, NormalizedMessage[]>();
  for (const message of messages) {
    const group = byExchange.get(message.exchangeId);
    if (group) group.push(message);
    else byExchange.set(message.exchangeId, [message]);
  }
  for (const message of messages) {
    const group = byExchange.get(message.exchangeId);
    if (group && !groups.includes(group)) groups.push(group);
  }
  return groups;
}

function shrinkToLimits(messages: readonly NormalizedMessage[], now: number): NormalizedMessage[] {
  const groups = exchangeGroups(messages);
  let firstGroup = 0;
  let candidate = groups.flat();
  const fits = (value: readonly NormalizedMessage[]): boolean => {
    const oldest = value[0];
    return (
      value.length <= WINDOW_SHRUNK_MESSAGE_LIMIT &&
      value.reduce(
        (total, message, index) =>
          total + estimateNormalizedMessageTokens(message, `m${index + 1}`),
        0,
      ) <= WINDOW_SHRUNK_TOKEN_LIMIT &&
      (oldest === undefined || now - oldest.timestampMs <= WINDOW_SHRUNK_AGE_MS)
    );
  };
  while (candidate.length > 0 && !fits(candidate) && firstGroup < groups.length) {
    firstGroup += 1;
    candidate = groups.slice(firstGroup).flat();
  }
  return candidate;
}

function truncateTextByBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && encoder.encode(text.slice(0, end)).length > maxBytes) end -= 1;
  return text.slice(0, end);
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
  private readonly eligibility: MessageEligibilityService;

  constructor(
    private readonly reader: IDiscordMessageReader,
    records: IReplyRecordRepository,
    private readonly now: () => number = () => Date.now(),
    private readonly imageCapability: (model: string) => Promise<boolean | null> = async () => true,
  ) {
    this.eligibility = new MessageEligibilityService(reader, records);
  }

  async build(input: BuildConversationWindowInput): Promise<ConversationWindowContext | null> {
    if (!input.historyEnabled) return null;
    const authorized = input.authorize
      ? await input.authorize()
      : input.authorizationMessage
        ? await canReadConversation(input.authorizationMessage, input.botUser)
        : false;
    if (!authorized) return null;

    const currentTime = messageTime(input.current) || this.now();
    const now = this.now();
    const budget = new RestBudget(CONVERSATION_REST_LIMIT);
    const state = this.states.get(input.current.channel_id);
    const needsRebuild = state === undefined || now - state.lastUsedAt > WINDOW_REBUILD_AFTER_MS;

    try {
      const result = await this.withTimeout(
        needsRebuild
          ? this.rebuild(input, currentTime, now, budget)
          : this.extend(input, state, currentTime, now, budget),
        WINDOW_FETCH_TIMEOUT_MS,
      );
      if (!result) return null;
      const responseState: ResponseState = {
        current: input.current,
        botUserId: input.botUserId,
        e2eTesterBotId: input.e2eTesterBotId,
        nodeEnv: input.nodeEnv,
        userId: input.userId,
        channel: input.channel,
        authorize: input.authorize
          ? input.authorize
          : input.authorizationMessage
            ? () =>
                canReadConversation(
                  input.authorizationMessage as AuthorizationMessageLike,
                  input.botUser,
                )
            : async () => false,
        budget,
        cursor: result.startMessageId,
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
        reachedReplyTarget: false,
        openedAttachments: new Set(),
        attachmentResults: new Map(),
      };
      const messages = result.messages.map((message) => this.addShown(responseState, message));
      const hasReplyTarget = result.replyTarget
        ? messages.some((message) => message.id === result.replyTarget?.id)
        : false;
      const replyTarget =
        result.replyTarget && !hasReplyTarget
          ? this.addShown(responseState, result.replyTarget)
          : undefined;
      responseState.replyTarget = replyTarget;
      return {
        messages,
        ...(replyTarget && { replyTarget }),
        sessionId: result.sessionId,
        windowStartMessageId: result.startMessageId,
        toolContext: {
          readEarlierMessages: (count) => this.readEarlier(responseState, count),
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

  private async rebuild(
    input: BuildConversationWindowInput,
    currentTime: number,
    now: number,
    budget: DiscordRestBudget,
  ): Promise<WindowBuildResult | null> {
    const collected: RawDiscordMessage[] = [];
    let before = input.current.id;
    while (true) {
      const page = await this.reader.list(input.current.channel_id, { before, limit: 100 }, budget);
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
      before = oldest.id;
    }
    const rawMessages = uniqueMessages(collected);
    const messages = await this.eligibleEntries(rawMessages, input, currentTime, budget, true);
    const shrunk = shrinkToLimits(messages, now);
    const startMessageId = shrunk[0]?.id ?? input.current.id;
    const sessionId = crypto.randomUUID();
    this.states.set(input.current.channel_id, { startMessageId, sessionId, lastUsedAt: now });
    const replyTarget = await this.findReplyTarget(input, rawMessages, currentTime, budget);
    return { messages: shrunk, rawMessages, startMessageId, sessionId, replyTarget };
  }

  private async extend(
    input: BuildConversationWindowInput,
    state: WindowState,
    currentTime: number,
    now: number,
    budget: DiscordRestBudget,
  ): Promise<WindowBuildResult | null> {
    const anchor = await this.reader.fetch(input.current.channel_id, state.startMessageId, budget);
    if (anchor.status === "not-found" || anchor.status === "failed") {
      return this.rebuild(input, currentTime, now, budget);
    }
    const fetched: RawDiscordMessage[] =
      anchor.status === "found" && compareMessageIds(anchor.message.id, input.current.id) < 0
        ? [anchor.message]
        : [];
    let after = state.startMessageId;
    while (true) {
      const page = await this.reader.list(
        input.current.channel_id,
        { after, before: input.current.id, limit: 100 },
        budget,
      );
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
    const messages = await this.eligibleEntries(rawMessages, input, currentTime, budget, true);
    let selected = messages;
    let startMessageId = state.startMessageId;
    let sessionId = state.sessionId;
    if (rawLimitExceeded(messages, now)) {
      selected = shrinkToLimits(messages, now);
      startMessageId = selected[0]?.id ?? input.current.id;
      sessionId = crypto.randomUUID();
    }
    this.states.set(input.current.channel_id, { startMessageId, sessionId, lastUsedAt: now });
    const replyTarget = await this.findReplyTarget(input, rawMessages, currentTime, budget);
    return { messages: selected, rawMessages, startMessageId, sessionId, replyTarget };
  }

  private async eligibleEntries(
    rawMessages: readonly RawDiscordMessage[],
    input: BuildConversationWindowInput,
    currentTime: number,
    budget: DiscordRestBudget,
    requireCompleteExchange: boolean,
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
        },
        budget,
        known,
      );
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
        const complete =
          known.has(reply.trigger.id) && reply.pages.every((page) => known.has(page.id));
        if (!complete) continue;
      }
      seenReplies.add(reply.record.triggerMsgId);
      entries.push(normalizeBotReply(reply.record.triggerMsgId, reply.pages));
    }
    return entries.sort((left, right) => {
      if (left.timestampMs !== right.timestampMs) return left.timestampMs - right.timestampMs;
      return compareMessageIds(left.id, right.id);
    });
  }

  private async findReplyTarget(
    input: BuildConversationWindowInput,
    rawMessages: readonly RawDiscordMessage[],
    currentTime: number,
    budget: DiscordRestBudget,
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
      : await this.reader.fetch(input.current.channel_id, targetId, budget);
    if (
      target.status !== "found" ||
      messageTime(target.message) < currentTime - CONVERSATION_MAX_AGE_MS
    ) {
      return undefined;
    }
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
      new Map(rawMessages.map((message) => [message.id, message])),
    );
    if (!result.eligible) return undefined;
    if (result.isHuman) return normalizeHumanMessage(target.message);
    return result.reply
      ? normalizeBotReply(result.reply.record.triggerMsgId, result.reply.pages)
      : undefined;
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

  private async readEarlier(state: ResponseState, requestedCount: number): Promise<ToolLlmResult> {
    if (!(await state.authorize())) {
      return asToolResult([], false, "no_permission");
    }
    state.calls += 1;
    if (state.calls > READ_EARLIER_MAX_CALLS) {
      return asToolResult([], true, "call_limit");
    }
    const count = Math.max(1, Math.min(20, Math.trunc(requestedCount)));
    const available = READ_EARLIER_MAX_MESSAGES - state.shownCount;
    if (available <= 0) return asToolResult([], true, "message_limit");
    const targetCount = Math.min(count, available);
    let cutoffReached = false;
    let stoppedReason: ConversationStopReason = null;
    const references: string[] = [];
    while (this.eligibleBufferCount(state) < targetCount && !cutoffReached && !state.exhausted) {
      const page = await this.reader.list(
        state.current.channel_id,
        { before: state.cursor, limit: 100 },
        state.budget,
      );
      if (page.status !== "ok") {
        stoppedReason = page.status === "forbidden" ? "no_permission" : "fetch_failed";
        break;
      }
      if (page.messages.length === 0) {
        state.exhausted = true;
        break;
      }
      const oldest = page.messages[0];
      if (oldest) {
        state.cursor = oldest.id;
        if (messageTime(oldest) < state.cutoffAt) cutoffReached = true;
      }
      const inRange = page.messages.filter((message) => messageTime(message) >= state.cutoffAt);
      const entries = await this.eligibleEntries(
        inRange,
        {
          current: state.current,
          guildId: state.current.guild_id ?? "",
          userId: state.userId,
          botUserId: state.botUserId,
          botUser: undefined,
          channel: state.channel,
          historyEnabled: true,
          e2eTesterBotId: state.e2eTesterBotId,
          nodeEnv: state.nodeEnv,
        },
        messageTime(state.current),
        state.budget,
        false,
      );
      for (const entry of entries) {
        if (state.replyTarget?.id === entry.id) {
          if (!state.reachedReplyTarget) {
            state.reachedReplyTarget = true;
            if (state.replyTarget.ref) references.push(state.replyTarget.ref);
          }
          continue;
        }
        if (state.shown.has(entry.id) || state.buffer.some((item) => item.id === entry.id))
          continue;
        state.buffer.push(entry);
      }
      state.buffer.sort((left, right) => left.timestampMs - right.timestampMs);
      if (page.messages.length < 100 || cutoffReached) {
        state.exhausted = true;
        break;
      }
    }

    const selected = state.buffer.splice(
      Math.max(0, state.buffer.length - targetCount),
      targetCount,
    );
    const shown: NormalizedMessage[] = [];
    for (const message of selected) {
      if (state.shown.has(message.id)) continue;
      shown.push(this.addShown(state, message));
    }
    const reason = stoppedReason
      ? stoppedReason
      : cutoffReached && state.buffer.length === 0
        ? "24h_cutoff"
        : available <= shown.length
          ? "message_limit"
          : null;
    const hasMore = state.buffer.length > 0 || !state.exhausted;
    const output = await this.fitToolResult(state, shown, hasMore, reason, references);
    const outputIds = new Set(output.map((message) => message.id));
    for (const message of shown) {
      if (!outputIds.has(message.id)) {
        state.shown.delete(message.id);
        state.shownCount -= 1;
      }
    }
    return asToolResult(output, hasMore, reason, references);
  }

  private eligibleBufferCount(state: ResponseState): number {
    return state.buffer.filter((message) => !state.shown.has(message.id)).length;
  }

  private async fitToolResult(
    state: ResponseState,
    messages: NormalizedMessage[],
    hasMore: boolean,
    reason: ConversationStopReason,
    references: readonly string[] = [],
  ): Promise<NormalizedMessage[]> {
    const fits = (items: readonly NormalizedMessage[]): boolean =>
      new TextEncoder().encode(asToolResult(items, hasMore, reason, references)).length <=
      READ_EARLIER_MAX_RESULT_BYTES;
    const deferred: NormalizedMessage[] = [];
    while (messages.length > 0 && !fits(messages)) {
      if (messages.length === 1) {
        const message = messages[0];
        if (!message) break;
        let low = 0;
        let high = message.text.length;
        let best = "";
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const candidate = {
            ...message,
            text: truncateTextByBytes(message.text.slice(0, mid), mid),
            toolTruncated: true,
          };
          if (fits([candidate])) {
            best = candidate.text;
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }
        messages[0] = { ...message, text: best, toolTruncated: true };
        break;
      }
      const returned = messages.shift();
      if (returned) deferred.push(returned);
    }
    state.buffer.push(...deferred);
    state.buffer.sort((left, right) => left.timestampMs - right.timestampMs);
    return messages;
  }

  private async viewAttachment(
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
    if (cached) return cached;
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
    const fetched = await this.reader.fetch(state.current.channel_id, message.id, state.budget);
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
      const bytes = new Uint8Array(await fetched.response.arrayBuffer());
      const maxBytes = attachment.kind === "image" ? 8 * 1024 * 1024 : 20 * 1024 * 1024;
      if (bytes.length > maxBytes) {
        const result = '{"error":"attachment_too_large"}';
        state.attachmentResults.set(cacheKey, result);
        return result;
      }
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

  private acceptedMime(mime: string | null | undefined, kind: "image" | "pdf"): boolean {
    if (kind === "pdf") return mime === "application/pdf";
    return (
      mime === "image/png" || mime === "image/jpeg" || mime === "image/gif" || mime === "image/webp"
    );
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
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
