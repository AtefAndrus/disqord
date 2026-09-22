import { Routes } from "discord.js";
import type { RawDiscordMessage } from "../utils/discordMessageNormalizer";

export interface DiscordRestClient {
  get(route: string, options?: { query?: Record<string, string | number> }): Promise<unknown>;
}

export type DiscordMessageFetchResult =
  | { status: "found"; message: RawDiscordMessage }
  | { status: "not-found" }
  | { status: "failed"; error: unknown };

export interface DiscordMessageListResult {
  status: "ok" | "forbidden" | "failed";
  messages: RawDiscordMessage[];
  error?: unknown;
}

export interface IDiscordMessageReader {
  list(
    channelId: string,
    query: { before?: string; after?: string; limit: number },
    budget: DiscordRestBudget,
  ): Promise<DiscordMessageListResult>;
  fetch(
    channelId: string,
    messageId: string,
    budget: DiscordRestBudget,
  ): Promise<DiscordMessageFetchResult>;
}

/** Counts application REST calls; discord.js's internal retry attempts are outside this counter. */
export class DiscordRestBudget {
  private count = 0;

  constructor(readonly limit = 12) {}

  get used(): number {
    return this.count;
  }

  consume(): boolean {
    if (this.count >= this.limit) return false;
    this.count += 1;
    return true;
  }
}

function asRawMessage(value: unknown): RawDiscordMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const message = value as Partial<RawDiscordMessage>;
  if (
    typeof message.id !== "string" ||
    typeof message.channel_id !== "string" ||
    typeof message.content !== "string" ||
    typeof message.timestamp !== "string" ||
    typeof message.author !== "object" ||
    message.author === null ||
    typeof message.author.id !== "string" ||
    typeof message.author.username !== "string"
  ) {
    return null;
  }
  return message as RawDiscordMessage;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function sortOldestFirst(messages: RawDiscordMessage[]): RawDiscordMessage[] {
  return [...messages].sort((left, right) => {
    try {
      const leftId = BigInt(left.id);
      const rightId = BigInt(right.id);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    } catch {
      return left.id.localeCompare(right.id);
    }
  });
}

export class DiscordMessageReader implements IDiscordMessageReader {
  constructor(private readonly rest: DiscordRestClient) {}

  async list(
    channelId: string,
    query: { before?: string; after?: string; limit: number },
    budget: DiscordRestBudget,
  ): Promise<DiscordMessageListResult> {
    if (!budget.consume()) return { status: "failed", messages: [] };
    try {
      const response = await this.rest.get(Routes.channelMessages(channelId), { query });
      if (!Array.isArray(response)) return { status: "failed", messages: [] };
      const messages = response.flatMap((value) => {
        const message = asRawMessage(value);
        return message ? [message] : [];
      });
      return { status: "ok", messages: sortOldestFirst(messages) };
    } catch (error) {
      return {
        status: statusOf(error) === 403 ? "forbidden" : "failed",
        messages: [],
        error,
      };
    }
  }

  async fetch(
    channelId: string,
    messageId: string,
    budget: DiscordRestBudget,
  ): Promise<DiscordMessageFetchResult> {
    if (!budget.consume()) return { status: "failed", error: new Error("REST budget exhausted") };
    try {
      const response = await this.rest.get(Routes.channelMessage(channelId, messageId));
      const message = asRawMessage(response);
      return message
        ? { status: "found", message }
        : { status: "failed", error: new Error("Invalid message response") };
    } catch (error) {
      return statusOf(error) === 404 ? { status: "not-found" } : { status: "failed", error };
    }
  }
}
