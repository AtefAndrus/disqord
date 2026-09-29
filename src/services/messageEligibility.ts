import type {
  IReplyRecordRepository,
  ReplyPage,
  ReplyRecord,
} from "../db/repositories/replyRecord";
import {
  formatPollResultNotice,
  POLL_RESULT_MESSAGE_TYPE,
  type RawDiscordMessage,
} from "../utils/discordMessageNormalizer";
import type {
  DiscordMessageFetchResult,
  DiscordRestBudget,
  IDiscordMessageReader,
} from "./discordMessageReader";

export type MessageEligibilityReason =
  | "human"
  | "e2e-human"
  | "other-bot"
  | "webhook"
  | "system"
  | "record-missing"
  | "pending"
  | "failed"
  | "record-incomplete"
  | "finalized-after-current"
  | "externally-deleted"
  | "unconfirmable"
  | "bot-poll"
  | "poll-result";

export interface VerifiedReply {
  record: ReplyRecord;
  pages: Array<RawDiscordMessage & { page: ReplyPage }>;
  trigger: RawDiscordMessage;
}

export interface MessageEligibilityResult {
  eligible: boolean;
  isHuman: boolean;
  externallyDeleted: boolean;
  reason: MessageEligibilityReason;
  reply?: VerifiedReply;
  /**
   * For `bot-poll` and `poll-result`, which have no reply record: the message
   * whose deletion hides this one (the message a bot poll answered, or the
   * poll a notice closes, resolved the same way).
   */
  exchangeId?: string;
}

export interface MessageEligibilityInput {
  currentTimestampMs: number;
  botUserId: string;
  e2eTesterBotId?: string;
  nodeEnv?: string;
  channelId: string;
}

export type MessageEligibilityVerification =
  | { status: "verified"; value: VerifiedReply }
  | { status: "deleted" }
  | { status: "failed" };

interface CachedReplyVerification {
  externallyDeleted: boolean;
  trigger: DiscordMessageFetchResult;
  pages: Array<{ page: ReplyPage; result: DiscordMessageFetchResult }>;
  verification?: MessageEligibilityVerification;
}

export type MessageEligibilityCache = Map<string, Promise<CachedReplyVerification>>;

export type MessageEligibilityExternalDeletionSet = Set<string>;

/**
 * Messages found by an earlier REST fetch in the same response. A reply's
 * verification entry is dropped as a whole when any of its fetches fails, so
 * without this a multi-page reply whose check keeps getting cut short by a
 * deadline would fetch its first pages again on every attempt.
 */
export type MessageEligibilityFetchedMessages = Map<string, RawDiscordMessage>;

export interface IReplyRecordLookup {
  findByTrigger(triggerMsgId: string): ReplyRecord | null;
  findByPage(pageMsgId: string): ReplyRecord | null;
  listPages(triggerMsgId: string): ReplyPage[];
}

export function classifyNotFoundMessage(
  messageId: string,
  records: IReplyRecordLookup,
  externalDeletions: MessageEligibilityExternalDeletionSet,
): void {
  const record = records.findByPage(messageId) ?? records.findByTrigger(messageId);
  if (!record) {
    externalDeletions.add(messageId);
    return;
  }
  const isRegistered =
    messageId === record.triggerMsgId ||
    records.listPages(record.triggerMsgId).some((page) => page.pageMsgId === messageId);
  if (isRegistered) externalDeletions.add(record.triggerMsgId);
}

function isE2eTester(message: RawDiscordMessage, input: MessageEligibilityInput): boolean {
  return (
    input.nodeEnv !== "production" &&
    input.e2eTesterBotId !== undefined &&
    message.author.id === input.e2eTesterBotId
  );
}

function isHumanMessage(message: RawDiscordMessage, input: MessageEligibilityInput): boolean {
  if (isE2eTester(message, input)) return true;
  if (message.author.bot === true) return false;
  if (message.webhook_id !== undefined) return false;
  return message.type === undefined || message.type === 0 || message.type === 19;
}

function ineligible(
  reason: MessageEligibilityReason,
  externallyDeleted = false,
): MessageEligibilityResult {
  return { eligible: false, isHuman: false, externallyDeleted, reason };
}

function sameMessageId(left: RawDiscordMessage, right: RawDiscordMessage): boolean {
  return left.id === right.id;
}

function recordStatusReason(record: ReplyRecord): MessageEligibilityReason | undefined {
  if (record.status === "pending") return "pending";
  if (record.status === "failed") return "failed";
  if (record.status !== "completed" && record.status !== "stopped") return "record-incomplete";
  if (record.pageCount === null) return "record-incomplete";
  return undefined;
}

export class MessageEligibilityService {
  constructor(
    private readonly reader: IDiscordMessageReader,
    private readonly records: IReplyRecordLookup,
  ) {}

  async evaluate(
    message: RawDiscordMessage,
    input: MessageEligibilityInput,
    budget: DiscordRestBudget,
    knownMessages: ReadonlyMap<string, RawDiscordMessage> = new Map(),
    verificationCache: MessageEligibilityCache = new Map(),
    externalDeletions: MessageEligibilityExternalDeletionSet = new Set(),
    signal?: AbortSignal,
    fetchedMessages: MessageEligibilityFetchedMessages = new Map(),
  ): Promise<MessageEligibilityResult> {
    if (message.webhook_id !== undefined) {
      return { eligible: false, isHuman: false, externallyDeleted: false, reason: "webhook" };
    }
    const evaluateReferenced = async (
      referencing: RawDiscordMessage,
    ): Promise<
      | { status: "evaluated"; message: RawDiscordMessage; result: MessageEligibilityResult }
      | { status: "rejected"; result: MessageEligibilityResult }
    > => {
      const reference = referencing.message_reference;
      const targetId = reference?.message_id;
      if (!targetId || (reference.channel_id && reference.channel_id !== input.channelId)) {
        return { status: "rejected", result: ineligible("system") };
      }
      if (externalDeletions.has(targetId)) {
        return { status: "rejected", result: ineligible("externally-deleted", true) };
      }
      const fetched = await this.fetchKnownOrRemote(
        input.channelId,
        targetId,
        knownMessages.get(targetId),
        budget,
        externalDeletions,
        signal,
        fetchedMessages,
      );
      if (fetched.status === "not-found") {
        return { status: "rejected", result: ineligible("externally-deleted", true) };
      }
      if (fetched.status !== "found") {
        return { status: "rejected", result: ineligible("unconfirmable") };
      }
      const result = await this.evaluate(
        fetched.message,
        input,
        budget,
        knownMessages,
        verificationCache,
        externalDeletions,
        signal,
        fetchedMessages,
      );
      return { status: "evaluated", message: fetched.message, result };
    };

    if (message.type === POLL_RESULT_MESSAGE_TYPE) {
      // Discord posts the notice as the poll's author, so this also drops
      // notices of polls by other bots, which the window leaves out.
      const fromBot = message.author.id === input.botUserId;
      if (!fromBot && message.author.bot === true && !isE2eTester(message, input)) {
        return ineligible("other-bot");
      }
      // Without its result embed the notice would reach the model as an empty message.
      if (formatPollResultNotice(message) === undefined) return ineligible("system");
      const referenced = await evaluateReferenced(message);
      if (referenced.status === "rejected") return referenced.result;
      const { message: poll, result } = referenced;
      if (!result.eligible) return ineligible(result.reason, result.externallyDeleted);
      if (result.reason === "unconfirmable") return ineligible("unconfirmable");
      if (!poll.poll || (!result.isHuman && result.reason !== "bot-poll")) {
        return ineligible("system");
      }
      return {
        eligible: true,
        isHuman: false,
        externallyDeleted: false,
        reason: "poll-result",
        exchangeId: result.exchangeId ?? result.reply?.record.triggerMsgId ?? poll.id,
      };
    }

    if (isHumanMessage(message, input)) {
      if (externalDeletions.has(message.id)) {
        return {
          eligible: false,
          isHuman: true,
          externallyDeleted: true,
          reason: "externally-deleted",
        };
      }
      const record = this.records.findByTrigger(message.id);
      if (!record) {
        return { eligible: true, isHuman: true, externallyDeleted: false, reason: "human" };
      }
      if (externalDeletions.has(record.triggerMsgId)) {
        return {
          eligible: false,
          isHuman: true,
          externallyDeleted: true,
          reason: "externally-deleted",
        };
      }
      const checked = await this.checkReplyWithCache(
        record,
        message,
        input,
        budget,
        knownMessages,
        verificationCache,
        externalDeletions,
        signal,
        fetchedMessages,
      );
      if (checked.externallyDeleted) {
        return {
          eligible: false,
          isHuman: true,
          externallyDeleted: true,
          reason: "externally-deleted",
        };
      }
      const reason = recordStatusReason(record);
      if (reason) {
        return { eligible: true, isHuman: true, externallyDeleted: false, reason };
      }
      if (record.finalizedAt === null || record.finalizedAt >= input.currentTimestampMs) {
        return {
          eligible: true,
          isHuman: true,
          externallyDeleted: false,
          reason: "finalized-after-current",
        };
      }
      const verified = this.verifyReplyWithCache(record, checked);
      if (verified.status === "deleted") {
        return {
          eligible: false,
          isHuman: true,
          externallyDeleted: true,
          reason: "externally-deleted",
        };
      }
      if (verified.status === "failed") {
        return { eligible: true, isHuman: true, externallyDeleted: false, reason: "unconfirmable" };
      }
      return {
        eligible: true,
        isHuman: true,
        externallyDeleted: false,
        reason: "human",
        reply: verified.value,
      };
    }

    if (message.author.id !== input.botUserId) {
      return { eligible: false, isHuman: false, externallyDeleted: false, reason: "other-bot" };
    }

    if (message.poll && !this.records.findByPage(message.id)) {
      // A poll from `create_poll` is not a reply page. It is shown only while
      // the message it answered would itself be shown, reply pages included.
      const referenced = await evaluateReferenced(message);
      if (referenced.status === "rejected") return referenced.result;
      const { message: target, result } = referenced;
      if (!result.eligible) return ineligible(result.reason, result.externallyDeleted);
      if (result.reason === "unconfirmable") return ineligible("unconfirmable");
      if (!result.isHuman) return ineligible("system");
      return {
        eligible: true,
        isHuman: false,
        externallyDeleted: false,
        reason: "bot-poll",
        exchangeId: target.id,
      };
    }

    const record = this.records.findByPage(message.id);
    if (!record) {
      return {
        eligible: false,
        isHuman: false,
        externallyDeleted: false,
        reason: "record-missing",
      };
    }
    if (externalDeletions.has(record.triggerMsgId)) {
      return {
        eligible: false,
        isHuman: false,
        externallyDeleted: true,
        reason: "externally-deleted",
      };
    }
    const checked = await this.checkReplyWithCache(
      record,
      undefined,
      input,
      budget,
      knownMessages,
      verificationCache,
      externalDeletions,
      signal,
      fetchedMessages,
    );
    if (checked.externallyDeleted) {
      return {
        eligible: false,
        isHuman: false,
        externallyDeleted: true,
        reason: "externally-deleted",
      };
    }
    const reason = recordStatusReason(record);
    if (reason) {
      return { eligible: false, isHuman: false, externallyDeleted: false, reason };
    }
    if (record.finalizedAt === null || record.finalizedAt >= input.currentTimestampMs) {
      return {
        eligible: false,
        isHuman: false,
        externallyDeleted: false,
        reason: "finalized-after-current",
      };
    }
    const verified = this.verifyReplyWithCache(record, checked);
    if (verified.status === "deleted") {
      return {
        eligible: false,
        isHuman: false,
        externallyDeleted: true,
        reason: "externally-deleted",
      };
    }
    if (verified.status === "failed") {
      return { eligible: false, isHuman: false, externallyDeleted: false, reason: "unconfirmable" };
    }
    if (!verified.value.pages.some((page) => sameMessageId(page, message))) {
      return {
        eligible: false,
        isHuman: false,
        externallyDeleted: false,
        reason: "record-incomplete",
      };
    }
    return {
      eligible: true,
      isHuman: false,
      externallyDeleted: false,
      reason: "human",
      reply: verified.value,
    };
  }

  private checkReplyWithCache(
    record: ReplyRecord,
    knownTrigger: RawDiscordMessage | undefined,
    input: MessageEligibilityInput,
    budget: DiscordRestBudget,
    knownMessages: ReadonlyMap<string, RawDiscordMessage>,
    verificationCache: MessageEligibilityCache,
    externalDeletions: MessageEligibilityExternalDeletionSet,
    signal: AbortSignal | undefined,
    fetchedMessages: MessageEligibilityFetchedMessages,
  ): Promise<CachedReplyVerification> {
    const cached = verificationCache.get(record.triggerMsgId);
    if (cached) return cached;
    const pending = this.checkReply(
      record,
      knownTrigger,
      input,
      budget,
      knownMessages,
      externalDeletions,
      signal,
      fetchedMessages,
    );
    let cachedVerification: Promise<CachedReplyVerification>;
    cachedVerification = pending.then(
      (checked) => {
        if (
          (checked.trigger.status !== "found" && checked.trigger.status !== "not-found") ||
          checked.pages.some(
            ({ result }) => result.status !== "found" && result.status !== "not-found",
          )
        ) {
          if (verificationCache.get(record.triggerMsgId) === cachedVerification) {
            verificationCache.delete(record.triggerMsgId);
          }
        }
        return checked;
      },
      (error: unknown) => {
        if (verificationCache.get(record.triggerMsgId) === cachedVerification) {
          verificationCache.delete(record.triggerMsgId);
        }
        throw error;
      },
    );
    verificationCache.set(record.triggerMsgId, cachedVerification);
    return cachedVerification;
  }

  private verifyReplyWithCache(
    record: ReplyRecord,
    checked: CachedReplyVerification,
  ): MessageEligibilityVerification {
    if (checked.verification) return checked.verification;
    const verification = this.verifyReply(record, checked);
    checked.verification = verification;
    return verification;
  }

  private async checkReply(
    record: ReplyRecord,
    knownTrigger: RawDiscordMessage | undefined,
    input: MessageEligibilityInput,
    budget: DiscordRestBudget,
    knownMessages: ReadonlyMap<string, RawDiscordMessage>,
    externalDeletions: MessageEligibilityExternalDeletionSet,
    signal: AbortSignal | undefined,
    fetchedMessages: MessageEligibilityFetchedMessages,
  ): Promise<CachedReplyVerification> {
    const trigger = await this.fetchKnownOrRemote(
      input.channelId,
      record.triggerMsgId,
      knownTrigger ?? knownMessages.get(record.triggerMsgId),
      budget,
      externalDeletions,
      signal,
      fetchedMessages,
    );
    const pages = this.records.listPages(record.triggerMsgId);
    if (trigger.status === "not-found") {
      return {
        externallyDeleted: externalDeletions.has(record.triggerMsgId),
        trigger,
        pages: [],
      };
    }
    const fetchedPages: Array<{ page: ReplyPage; result: DiscordMessageFetchResult }> = [];
    for (const page of pages) {
      const fetched = await this.fetchKnownOrRemote(
        input.channelId,
        page.pageMsgId,
        knownMessages.get(page.pageMsgId),
        budget,
        externalDeletions,
        signal,
        fetchedMessages,
      );
      fetchedPages.push({ page, result: fetched });
      if (fetched.status === "not-found") {
        return {
          externallyDeleted: externalDeletions.has(record.triggerMsgId),
          trigger,
          pages: fetchedPages,
        };
      }
    }
    return {
      externallyDeleted: false,
      trigger,
      pages: fetchedPages,
    };
  }

  private verifyReply(
    record: ReplyRecord,
    checked: CachedReplyVerification,
  ): MessageEligibilityVerification {
    if (checked.externallyDeleted) return { status: "deleted" };
    if (checked.trigger.status !== "found") return { status: "failed" };
    if (
      record.pageCount === null ||
      checked.pages.length !== record.pageCount ||
      checked.pages.length === 0
    ) {
      return { status: "failed" };
    }
    const fetchedPages: Array<RawDiscordMessage & { page: ReplyPage }> = [];
    for (const { page, result } of checked.pages) {
      if (result.status !== "found") {
        return {
          status: result.status === "not-found" && checked.externallyDeleted ? "deleted" : "failed",
        };
      }
      fetchedPages.push({ ...result.message, page });
    }
    return {
      status: "verified",
      value: { record, pages: fetchedPages, trigger: checked.trigger.message },
    };
  }

  private fetchKnownOrRemote(
    channelId: string,
    messageId: string,
    known: RawDiscordMessage | undefined,
    budget: DiscordRestBudget,
    externalDeletions: MessageEligibilityExternalDeletionSet,
    signal: AbortSignal | undefined,
    fetchedMessages: MessageEligibilityFetchedMessages,
  ): Promise<DiscordMessageFetchResult> {
    const resolved = known ?? fetchedMessages.get(messageId);
    if (resolved) return Promise.resolve({ status: "found", message: resolved });
    return this.reader.fetch(channelId, messageId, budget, signal).then((result) => {
      if (result.status === "found") fetchedMessages.set(messageId, result.message);
      if (result.status === "not-found" && !signal?.aborted) {
        classifyNotFoundMessage(messageId, this.records, externalDeletions);
      }
      return result;
    });
  }
}

export function createMessageEligibilityService(
  reader: IDiscordMessageReader,
  records: IReplyRecordRepository,
): MessageEligibilityService {
  return new MessageEligibilityService(reader, records);
}
