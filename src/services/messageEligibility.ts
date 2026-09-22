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
}

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
  ): Promise<MessageEligibilityResult> {
    if (isE2eTester(message, input)) {
      return { eligible: true, isHuman: true, externallyDeleted: false, reason: "e2e-human" };
    }
    if (message.webhook_id !== undefined) {
      return { eligible: false, isHuman: false, externallyDeleted: false, reason: "webhook" };
    }
    if (message.author.bot !== true) {
      if (!isHumanMessage(message, input)) {
        return { eligible: false, isHuman: false, externallyDeleted: false, reason: "system" };
      }
      const record = this.records.findByTrigger(message.id);
      if (!record) {
        return { eligible: true, isHuman: true, externallyDeleted: false, reason: "human" };
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
      const verified = await this.verifyReply(record, message, input, budget, knownMessages);
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

    const record = this.records.findByPage(message.id);
    if (!record) {
      return {
        eligible: false,
        isHuman: false,
        externallyDeleted: false,
        reason: "record-missing",
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
    const verified = await this.verifyReply(record, undefined, input, budget, knownMessages);
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

  private async verifyReply(
    record: ReplyRecord,
    knownTrigger: RawDiscordMessage | undefined,
    input: MessageEligibilityInput,
    budget: DiscordRestBudget,
    knownMessages: ReadonlyMap<string, RawDiscordMessage>,
  ): Promise<
    { status: "verified"; value: VerifiedReply } | { status: "deleted" } | { status: "failed" }
  > {
    const trigger = await this.fetchKnownOrRemote(
      input.channelId,
      record.triggerMsgId,
      knownTrigger ?? knownMessages.get(record.triggerMsgId),
      budget,
    );
    if (trigger.status === "not-found") return { status: "deleted" };
    if (trigger.status === "failed") return { status: "failed" };

    const pages = this.records.listPages(record.triggerMsgId);
    if (record.pageCount === null || pages.length !== record.pageCount || pages.length === 0) {
      return { status: "failed" };
    }
    const fetchedPages: Array<RawDiscordMessage & { page: ReplyPage }> = [];
    for (const page of pages) {
      const fetched = await this.fetchKnownOrRemote(
        input.channelId,
        page.pageMsgId,
        knownMessages.get(page.pageMsgId),
        budget,
      );
      if (fetched.status === "not-found") return { status: "deleted" };
      if (fetched.status === "failed") return { status: "failed" };
      fetchedPages.push({ ...fetched.message, page });
    }
    return {
      status: "verified",
      value: { record, pages: fetchedPages, trigger: trigger.message },
    };
  }

  private fetchKnownOrRemote(
    channelId: string,
    messageId: string,
    known: RawDiscordMessage | undefined,
    budget: DiscordRestBudget,
  ): Promise<DiscordMessageFetchResult> {
    if (known) return Promise.resolve({ status: "found", message: known });
    return this.reader.fetch(channelId, messageId, budget);
  }
}

export function createMessageEligibilityService(
  reader: IDiscordMessageReader,
  records: IReplyRecordRepository,
): MessageEligibilityService {
  return new MessageEligibilityService(reader, records);
}
