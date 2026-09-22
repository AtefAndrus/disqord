import type {
  ConversationContext,
  ConversationTurnStatus,
  CreateConversationTurnInput,
  CreateConversationTurnResult,
  IConversationRepository,
} from "../db/repositories/conversation";

export interface HistoryPurgeScope {
  channelId?: string;
  parentChannelId?: string | null;
  guildId?: string;
}

export type HistoryPurgeTarget =
  | {
      type: "message";
      messageIds: readonly string[];
      scope: HistoryPurgeScope;
    }
  | {
      type: "channel";
      channelId: string;
    }
  | {
      type: "thread";
      channelId: string;
    }
  | {
      type: "guild";
      guildId: string;
    }
  | {
      type: "assistant";
      assistantTurnId: number;
      messageIds: readonly string[];
      scope: HistoryPurgeScope;
    };

export interface IHistoryRecorder {
  createUserAndAssistantTurn(
    input: CreateConversationTurnInput,
  ): Promise<CreateConversationTurnResult>;
  getContext(userTurnId: number): Promise<ConversationContext | null>;
  createAssistantTurn(
    sessionId: number,
    parentUserTurnId: number,
    discordCreatedAt?: number,
  ): Promise<number | null>;
  onBotMessageSent(
    assistantTurnId: number,
    discordMessageId: string,
    discordCreatedAt: number,
    scope?: HistoryPurgeScope,
  ): Promise<boolean>;
  deleteMessageMapping(discordMessageId: string): Promise<boolean>;
  finalizeAssistantTurn(
    assistantTurnId: number,
    status: Exclude<ConversationTurnStatus, "pending">,
    text: string,
    finalizedAt?: number,
  ): Promise<boolean>;
  failPendingTurns(): Promise<boolean>;
  purgeMessage(discordMessageId: string, scope?: HistoryPurgeScope): Promise<boolean>;
  purgeMessages(discordMessageIds: readonly string[], scope?: HistoryPurgeScope): Promise<boolean>;
  purgeChannel(channelId: string, scope?: HistoryPurgeScope): Promise<boolean>;
  purgeThread(channelId: string, scope?: HistoryPurgeScope): Promise<boolean>;
  purgeGuild(guildId: string): Promise<boolean>;
  sweepExpired(now?: number): Promise<boolean>;
}

export const HISTORY_SWEEP_RETRY_DELAY_MS = 10 * 60 * 1000;

export interface HistorySweepRunner {
  run(): void;
  scheduleRetry(): void;
  cancel(): void;
}

export function createHistorySweepRunner(
  historyRecorder: IHistoryRecorder,
  schedule: typeof setTimeout = setTimeout,
): HistorySweepRunner {
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleRetry = (): void => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = schedule(() => {
      retryTimer = undefined;
      run(false);
    }, HISTORY_SWEEP_RETRY_DELAY_MS);
    retryTimer.unref();
  };

  const run = (retryAllowed = true): void => {
    void historyRecorder
      .sweepExpired()
      .then((succeeded) => {
        if (!succeeded && retryAllowed) scheduleRetry();
      })
      .catch((error: unknown) => {
        logHistoryOperationFailure("sweepExpired", error);
        if (retryAllowed) scheduleRetry();
      });
  };

  return {
    run: () => run(),
    scheduleRetry,
    cancel: () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
    },
  };
}

export function historyErrorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (typeof error === "object" && error !== null) {
    const constructorName = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof constructorName === "string" && constructorName.length > 0) {
      return constructorName;
    }
  }
  return typeof error;
}

export function logHistoryOperationFailure(operation: string, error: unknown): void {
  console.error(`[history] ${operation} failed`, historyErrorName(error));
}

export class HistoryRecorder implements IHistoryRecorder {
  private readonly pendingPurgeTargets = new Map<string, HistoryPurgeTarget>();

  constructor(private readonly repository: IConversationRepository) {}

  async createUserAndAssistantTurn(
    input: CreateConversationTurnInput,
  ): Promise<CreateConversationTurnResult> {
    try {
      return await this.repository.createUserAndAssistantTurn(input);
    } catch (error) {
      logHistoryOperationFailure("createUserAndAssistantTurn", error);
      return {
        historyEnabled: false,
        created: false,
        duplicate: false,
      };
    }
  }

  async getContext(userTurnId: number): Promise<ConversationContext | null> {
    await this.retryPendingPurges();
    try {
      return await this.repository.getContext(userTurnId, this.pendingTargets());
    } catch (error) {
      logHistoryOperationFailure("getContext", error);
      return null;
    }
  }

  async createAssistantTurn(
    sessionId: number,
    parentUserTurnId: number,
    discordCreatedAt = Date.now(),
  ): Promise<number | null> {
    try {
      return await this.repository.createAssistantTurn(
        sessionId,
        parentUserTurnId,
        discordCreatedAt,
      );
    } catch (error) {
      logHistoryOperationFailure("createAssistantTurn", error);
      return null;
    }
  }

  async onBotMessageSent(
    assistantTurnId: number,
    discordMessageId: string,
    discordCreatedAt: number,
    scope: HistoryPurgeScope = {},
  ): Promise<boolean> {
    try {
      const mapped = await this.repository.onBotMessageSent(
        assistantTurnId,
        discordMessageId,
        discordCreatedAt,
      );
      if (mapped) return true;
    } catch (error) {
      logHistoryOperationFailure("onBotMessageSent", error);
    }

    const target: HistoryPurgeTarget = {
      type: "assistant",
      assistantTurnId,
      messageIds: [discordMessageId],
      scope,
    };
    await this.purgeTarget(target);
    return false;
  }

  async deleteMessageMapping(discordMessageId: string): Promise<boolean> {
    // A pending purge finds its exchange through this mapping. Removing it
    // here would make the retry delete nothing and drop the target, so the
    // deleted message would return to context; the purge's CASCADE removes
    // the mapping instead.
    if (this.isMessagePendingPurge(discordMessageId)) return false;
    try {
      return await this.repository.deleteMessageMapping(discordMessageId);
    } catch (error) {
      logHistoryOperationFailure("deleteMessageMapping", error);
      return false;
    }
  }

  async finalizeAssistantTurn(
    assistantTurnId: number,
    status: Exclude<ConversationTurnStatus, "pending">,
    text: string,
    finalizedAt = Date.now(),
  ): Promise<boolean> {
    try {
      return await this.repository.finalizeAssistantTurn(
        assistantTurnId,
        status,
        text,
        finalizedAt,
      );
    } catch (error) {
      logHistoryOperationFailure("finalizeAssistantTurn", error);
      return false;
    }
  }

  async failPendingTurns(): Promise<boolean> {
    try {
      await this.repository.failPendingTurns();
      return true;
    } catch (error) {
      logHistoryOperationFailure("failPendingTurns", error);
      return false;
    }
  }

  async purgeMessage(discordMessageId: string, scope: HistoryPurgeScope = {}): Promise<boolean> {
    return this.purgeTarget({ type: "message", messageIds: [discordMessageId], scope });
  }

  async purgeMessages(
    discordMessageIds: readonly string[],
    scope: HistoryPurgeScope = {},
  ): Promise<boolean> {
    if (discordMessageIds.length === 0) return false;
    return this.purgeTarget({ type: "message", messageIds: [...discordMessageIds], scope });
  }

  async purgeChannel(channelId: string, _scope?: HistoryPurgeScope): Promise<boolean> {
    return this.purgeTarget({ type: "channel", channelId });
  }

  async purgeThread(channelId: string, _scope?: HistoryPurgeScope): Promise<boolean> {
    return this.purgeTarget({ type: "thread", channelId });
  }

  async purgeGuild(guildId: string): Promise<boolean> {
    return this.purgeTarget({ type: "guild", guildId });
  }

  async sweepExpired(now = Date.now()): Promise<boolean> {
    await this.retryPendingPurges();
    try {
      await this.repository.sweepExpired(now);
      return true;
    } catch (error) {
      logHistoryOperationFailure("sweepExpired", error);
      return false;
    }
  }

  private isMessagePendingPurge(discordMessageId: string): boolean {
    for (const target of this.pendingPurgeTargets.values()) {
      if (
        (target.type === "message" || target.type === "assistant") &&
        target.messageIds.includes(discordMessageId)
      ) {
        return true;
      }
    }
    return false;
  }

  private async purgeTarget(target: HistoryPurgeTarget): Promise<boolean> {
    // Registered before the first await: anything that runs while the purge
    // is in flight (an internal delete dropping the mapping, a context build)
    // must already see the target as pending.
    const key = this.targetKey(target);
    this.pendingPurgeTargets.set(key, target);
    try {
      const result = await this.executePurge(target);
      this.pendingPurgeTargets.delete(key);
      return result;
    } catch (error) {
      logHistoryOperationFailure(this.operationName(target), error);
      return false;
    }
  }

  private async retryPendingPurges(): Promise<void> {
    for (const target of this.pendingTargets()) {
      await this.purgeTarget(target);
    }
  }

  private async executePurge(target: HistoryPurgeTarget): Promise<boolean> {
    switch (target.type) {
      case "message":
        return target.messageIds.length === 1
          ? await this.repository.purgeMessage(target.messageIds[0] ?? "")
          : await this.repository.purgeMessages(target.messageIds);
      case "channel":
        return this.repository.purgeChannel(target.channelId);
      case "thread":
        return this.repository.purgeThread(target.channelId);
      case "guild":
        return this.repository.purgeGuild(target.guildId);
      case "assistant":
        return this.repository.purgeAssistantExchange(target.assistantTurnId);
    }
  }

  private operationName(target: HistoryPurgeTarget): string {
    switch (target.type) {
      case "message":
        return target.messageIds.length === 1 ? "purgeMessage" : "purgeMessages";
      case "channel":
        return "purgeChannel";
      case "thread":
        return "purgeThread";
      case "guild":
        return "purgeGuild";
      case "assistant":
        return "purgeAssistantExchange";
    }
  }

  private pendingTargets(): HistoryPurgeTarget[] {
    return [...this.pendingPurgeTargets.values()];
  }

  private targetKey(target: HistoryPurgeTarget): string {
    switch (target.type) {
      case "message":
        return JSON.stringify({
          type: target.type,
          messageIds: [...target.messageIds].sort(),
          scope: target.scope,
        });
      case "channel":
        return JSON.stringify({ type: target.type, channelId: target.channelId });
      case "thread":
        return JSON.stringify({ type: target.type, channelId: target.channelId });
      case "guild":
        return JSON.stringify({ type: target.type, guildId: target.guildId });
      case "assistant":
        return JSON.stringify({
          type: target.type,
          assistantTurnId: target.assistantTurnId,
          messageIds: [...target.messageIds].sort(),
          scope: target.scope,
        });
    }
  }
}
