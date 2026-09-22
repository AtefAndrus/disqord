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
  cleanupExpired(now?: number): Promise<number>;
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

  async cleanupExpired(now?: number): Promise<number> {
    try {
      return this.repository.deleteExpired(now);
    } catch (error) {
      console.error("[replyRecord] cleanupExpired failed", operationError(error));
      return 0;
    }
  }
}

export const REPLY_RECORD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface ReplyRecordCleanupRunner {
  run(): void;
  cancel(): void;
}

export function createReplyRecordCleanupRunner(
  service: IReplyRecordService,
  setIntervalFn: typeof setInterval = setInterval,
  clearIntervalFn: typeof clearInterval = clearInterval,
  onCleanup?: () => void,
): ReplyRecordCleanupRunner {
  const timer = setIntervalFn(() => {
    void service.cleanupExpired();
    onCleanup?.();
  }, REPLY_RECORD_CLEANUP_INTERVAL_MS);
  timer.unref();
  return {
    run: () => {
      void service.cleanupExpired();
      onCleanup?.();
    },
    cancel: () => clearIntervalFn(timer),
  };
}
