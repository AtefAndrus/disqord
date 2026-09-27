import type {
  CreateReplyRecordInput,
  IReplyRecordRepository,
  ReplyPage,
  ReplyRecord,
  ReplyRecordStatus,
} from "../db/repositories/replyRecord";

export interface AppendReplyPageResult {
  recorded: boolean;
  finalized: boolean;
}

export interface IReplyRecordService {
  createPending(input: CreateReplyRecordInput): Promise<boolean>;
  appendPage(triggerMsgId: string, pageMsgId: string): Promise<AppendReplyPageResult>;
  removePage(pageMsgId: string): Promise<boolean>;
  finalize(
    triggerMsgId: string,
    status: Exclude<ReplyRecordStatus, "pending">,
    pageCount: number,
  ): Promise<boolean>;
  findByTrigger(triggerMsgId: string): ReplyRecord | null;
  findByPage(pageMsgId: string): ReplyRecord | null;
  listPages(triggerMsgId: string): ReplyPage[];
  markPendingFailed(): Promise<number>;
  deleteByGuild(guildId: string): Promise<number>;
  deleteByChannel(channelId: string): Promise<number>;
  deleteGuildsNotIn(guildIds: readonly string[]): Promise<number>;
}

function operationError(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export class ReplyRecordService implements IReplyRecordService {
  constructor(private readonly repository: IReplyRecordRepository) {}

  async createPending(input: CreateReplyRecordInput): Promise<boolean> {
    try {
      return this.repository.createPending(input);
    } catch (error) {
      console.error("[replyRecord] createPending failed", operationError(error));
      return false;
    }
  }

  async appendPage(triggerMsgId: string, pageMsgId: string): Promise<AppendReplyPageResult> {
    try {
      const record = this.repository.findByTrigger(triggerMsgId);
      if (record?.status !== "pending") {
        return { recorded: false, finalized: record !== null };
      }
      const recorded = this.repository.appendPage(triggerMsgId, pageMsgId);
      if (!recorded) {
        const current = this.repository.findByTrigger(triggerMsgId);
        return { recorded: false, finalized: current !== null && current.status !== "pending" };
      }
      return {
        recorded: true,
        finalized: false,
      };
    } catch (error) {
      console.error("[replyRecord] appendPage failed", operationError(error));
      return { recorded: false, finalized: false };
    }
  }

  async removePage(pageMsgId: string): Promise<boolean> {
    try {
      return this.repository.removePage(pageMsgId);
    } catch (error) {
      console.error("[replyRecord] removePage failed", operationError(error));
      return false;
    }
  }

  async finalize(
    triggerMsgId: string,
    status: Exclude<ReplyRecordStatus, "pending">,
    pageCount: number,
  ): Promise<boolean> {
    try {
      return this.repository.finalize(triggerMsgId, status, pageCount);
    } catch (error) {
      console.error("[replyRecord] finalize failed", operationError(error));
      return false;
    }
  }

  findByTrigger(triggerMsgId: string): ReplyRecord | null {
    try {
      return this.repository.findByTrigger(triggerMsgId);
    } catch (error) {
      console.error("[replyRecord] findByTrigger failed", operationError(error));
      return null;
    }
  }

  findByPage(pageMsgId: string): ReplyRecord | null {
    try {
      return this.repository.findByPage(pageMsgId);
    } catch (error) {
      console.error("[replyRecord] findByPage failed", operationError(error));
      return null;
    }
  }

  listPages(triggerMsgId: string): ReplyPage[] {
    try {
      return this.repository.listPages(triggerMsgId);
    } catch (error) {
      console.error("[replyRecord] listPages failed", operationError(error));
      return [];
    }
  }

  async markPendingFailed(): Promise<number> {
    try {
      return this.repository.markPendingFailed();
    } catch (error) {
      console.error("[replyRecord] markPendingFailed failed", operationError(error));
      return 0;
    }
  }

  async deleteByGuild(guildId: string): Promise<number> {
    try {
      return this.repository.deleteByGuild(guildId);
    } catch (error) {
      console.error("[replyRecord] deleteByGuild failed", operationError(error));
      return 0;
    }
  }

  async deleteByChannel(channelId: string): Promise<number> {
    try {
      return this.repository.deleteByChannel(channelId);
    } catch (error) {
      console.error("[replyRecord] deleteByChannel failed", operationError(error));
      return 0;
    }
  }

  async deleteGuildsNotIn(guildIds: readonly string[]): Promise<number> {
    try {
      return this.repository.deleteGuildsNotIn(guildIds);
    } catch (error) {
      console.error("[replyRecord] deleteGuildsNotIn failed", operationError(error));
      return 0;
    }
  }
}
