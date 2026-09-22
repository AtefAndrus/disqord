import type {
  IReplyRecordRepository,
  ReplyPage,
  ReplyRecord,
} from "../db/repositories/replyRecord";
import type { RawDiscordMessage } from "../utils/discordMessageNormalizer";
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
  | "unconfirmable";

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
}

export interface MessageEligibilityInput {
  currentTimestampMs: number;
  botUserId: string;
  e2eTesterBotId?: string;
  nodeEnv?: string;
  channelId: string;
  maxAgeMs?: number;
}

export type MessageEligibilityVerification =
  | { status: "verified"; value: VerifiedReply }
  | { status: "deleted" }
  | { status: "too-old" }
  | { status: "failed" };

interface CachedReplyVerification {
  externallyDeleted: boolean;
  trigger: DiscordMessageFetchResult;
  pages: Array<{ page: ReplyPage; result: DiscordMessageFetchResult }>;
  verification?: MessageEligibilityVerification;
}

export type MessageEligibilityCache = Map<string, Promise<CachedReplyVerification>>;

export type MessageEligibilityExternalDeletionSet = Set<string>;

export interface IReplyRecordLookup {
  findByTrigger(triggerMsgId: string): ReplyRecord | null;
  findByPage(pageMsgId: string): ReplyRecord | null;
  listPages(triggerMsgId: string): ReplyPage[];
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
  ): Promise<MessageEligibilityResult> {
    if (message.webhook_id !== undefined) {
      return { eligible: false, isHuman: false, externallyDeleted: false, reason: "webhook" };
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
      const verified = this.verifyReplyWithCache(record, input, checked);
      if (verified.status === "deleted") {
        return {
          eligible: false,
          isHuman: true,
          externallyDeleted: true,
          reason: "externally-deleted",
        };
      }
      if (verified.status === "failed" || verified.status === "too-old") {
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
    const verified = this.verifyReplyWithCache(record, input, checked);
    if (verified.status === "deleted") {
      return {
        eligible: false,
        isHuman: false,
        externallyDeleted: true,
        reason: "externally-deleted",
      };
    }
    if (verified.status === "failed" || verified.status === "too-old") {
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
    input: MessageEligibilityInput,
    checked: CachedReplyVerification,
  ): MessageEligibilityVerification {
    if (checked.verification) return checked.verification;
    const verification = this.verifyReply(record, input, checked);
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
  ): Promise<CachedReplyVerification> {
    const trigger = await this.fetchKnownOrRemote(
      input.channelId,
      record.triggerMsgId,
      knownTrigger ?? knownMessages.get(record.triggerMsgId),
      budget,
      signal,
    );
    const pages = this.records.listPages(record.triggerMsgId);
    if (trigger.status === "not-found") {
      externalDeletions.add(record.triggerMsgId);
      return { externallyDeleted: true, trigger, pages: [] };
    }
    const fetchedPages: Array<{ page: ReplyPage; result: DiscordMessageFetchResult }> = [];
    for (const page of pages) {
      const fetched = await this.fetchKnownOrRemote(
        input.channelId,
        page.pageMsgId,
        knownMessages.get(page.pageMsgId),
        budget,
        signal,
      );
      fetchedPages.push({ page, result: fetched });
      if (fetched.status === "not-found") {
        externalDeletions.add(record.triggerMsgId);
        return { externallyDeleted: true, trigger, pages: fetchedPages };
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
    input: MessageEligibilityInput,
    checked: CachedReplyVerification,
  ): MessageEligibilityVerification {
    if (checked.externallyDeleted) return { status: "deleted" };
    if (checked.trigger.status !== "found") return { status: "failed" };
    const cutoffAt = input.currentTimestampMs - (input.maxAgeMs ?? 24 * 60 * 60 * 1000);
    if (messageTime(checked.trigger.message) < cutoffAt) return { status: "too-old" };
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
        return { status: result.status === "not-found" ? "deleted" : "failed" };
      }
      if (messageTime(result.message) < cutoffAt) return { status: "too-old" };
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
    signal: AbortSignal | undefined,
  ): Promise<DiscordMessageFetchResult> {
    if (known) return Promise.resolve({ status: "found", message: known });
    return this.reader.fetch(channelId, messageId, budget, signal);
  }
}

function messageTime(message: RawDiscordMessage): number {
  const parsed = Date.parse(message.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function createMessageEligibilityService(
  reader: IDiscordMessageReader,
  records: IReplyRecordRepository,
): MessageEligibilityService {
  return new MessageEligibilityService(reader, records);
}
