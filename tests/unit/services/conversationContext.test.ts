import { expect, mock, test } from "bun:test";
import type { IReplyRecordRepository } from "../../../src/db/repositories/replyRecord";
import {
  type BuildConversationWindowInput,
  ConversationWindowService,
} from "../../../src/services/conversationWindow";
import type {
  DiscordMessageFetchResult,
  DiscordMessageListResult,
  DiscordRestBudget,
  IDiscordMessageReader,
} from "../../../src/services/discordMessageReader";
import type { RawDiscordMessage } from "../../../src/utils/discordMessageNormalizer";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");

function message(
  id: string,
  timestamp = new Date(NOW - 1_000).toISOString(),
  overrides: Partial<RawDiscordMessage> = {},
): RawDiscordMessage {
  return {
    id,
    channel_id: "channel",
    guild_id: "guild",
    content: `message-${id}`,
    timestamp,
    author: { id: `user-${id}`, username: `user-${id}`, bot: false },
    components: [],
    attachments: [],
    ...overrides,
  };
}

class FakeReader implements IDiscordMessageReader {
  readonly listQueries: Array<Record<string, string | number>> = [];
  readonly fetchQueries: string[] = [];
  listResponses: DiscordMessageListResult[] = [];
  fetchResponses: DiscordMessageFetchResult[] = [];

  async list(
    _channelId: string,
    query: { before?: string; after?: string; limit: number },
    _budget: DiscordRestBudget,
  ): Promise<DiscordMessageListResult> {
    this.listQueries.push(query);
    return this.listResponses.shift() ?? { status: "ok", messages: [] };
  }

  async fetch(
    _channelId: string,
    messageId: string,
    _budget: DiscordRestBudget,
  ): Promise<DiscordMessageFetchResult> {
    this.fetchQueries.push(messageId);
    return this.fetchResponses.shift() ?? { status: "not-found" };
  }
}

const records = (): IReplyRecordRepository => ({
  createPending: mock(() => true),
  appendPage: mock(() => true),
  removePage: mock(() => true),
  finalize: mock(() => true),
  findByTrigger: mock(() => null),
  findByPage: mock(() => null),
  listPages: mock(() => []),
  markPendingFailed: mock(() => 0),
  deleteExpired: mock(() => 0),
});

function input(current: RawDiscordMessage): BuildConversationWindowInput {
  return {
    current,
    guildId: "guild",
    userId: "user-current",
    botUserId: "bot",
    botUser: {},
    channel: {},
    historyEnabled: true,
    authorize: async () => true,
  };
}

test("anchored windows shrink to the compact limits and rebuild after sixty minutes", async () => {
  let now = NOW;
  const reader = new FakeReader();
  reader.listResponses.push({
    status: "ok",
    messages: Array.from({ length: 41 }, (_, index) =>
      message(String(900 + index), new Date(NOW - index * 1_000).toISOString()),
    ),
  });
  const service = new ConversationWindowService(reader, records(), () => now);
  const first = await service.build(input(message("1000", new Date(NOW).toISOString())));

  expect(first?.messages).toHaveLength(20);
  expect(first?.sessionId).toBeString();
  const firstSessionId = first?.sessionId;

  now += 61 * 60 * 1000;
  reader.fetchResponses.push({
    status: "found",
    message: message("2000", new Date(now - 1_000).toISOString()),
  });
  reader.listResponses.push({
    status: "ok",
    messages: [message("2000", new Date(now).toISOString())],
  });
  const second = await service.build(input(message("2001", new Date(now).toISOString())));

  expect(second?.sessionId).toBeString();
  expect(second?.sessionId).not.toBe(firstSessionId);
});

test("read_earlier_messages advances past an entirely ineligible page", async () => {
  const reader = new FakeReader();
  reader.listResponses.push({ status: "ok", messages: [] });
  reader.listResponses.push({
    status: "ok",
    messages: Array.from({ length: 100 }, (_, index) =>
      message(String(801 + index), undefined, {
        author: { id: "other-bot", username: "other", bot: true },
      }),
    ),
  });
  reader.listResponses.push({ status: "ok", messages: [message("700")] });
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const context = await service.build(input(message("1000", new Date(NOW).toISOString())));
  const result = await context?.toolContext.readEarlierMessages(1);

  expect(result).toBeString();
  const parsed = JSON.parse(result as string) as { messages: Array<{ ref: string }> };
  expect(parsed.messages).toHaveLength(1);
  expect(reader.listQueries[2]).toMatchObject({ before: "801" });
});

test("the reply target is already counted and does not appear twice while paging", async () => {
  const reader = new FakeReader();
  const target = message("800");
  reader.listResponses.push({ status: "ok", messages: [] });
  reader.fetchResponses.push({ status: "found", message: target });
  reader.listResponses.push({ status: "ok", messages: [target] });
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const context = await service.build(
    input(
      message("1000", new Date(NOW).toISOString(), {
        message_reference: { channel_id: "channel", message_id: "800" },
      }),
    ),
  );

  const result = await context?.toolContext.readEarlierMessages(5);
  const parsed = JSON.parse(result as string) as {
    messages: unknown[];
    has_more: boolean;
  };
  expect(context?.replyTarget?.ref).toBe("m1");
  expect(parsed.messages).toEqual([{ ref: "m1" }]);
  expect(parsed.has_more).toBe(false);
  expect(reader.listQueries[1]).toEqual({ before: "1000", limit: 100 });
});

test("read_earlier_messages enforces the combined sixty-message and three-call caps", async () => {
  const reader = new FakeReader();
  reader.listResponses.push({
    status: "ok",
    messages: Array.from({ length: 20 }, (_, index) => message(String(900 + index))),
  });
  reader.listResponses.push({
    status: "ok",
    messages: Array.from({ length: 40 }, (_, index) => message(String(800 + index))),
  });
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const context = await service.build(input(message("1000", new Date(NOW).toISOString())));

  const first = JSON.parse((await context?.toolContext.readEarlierMessages(20)) as string) as {
    messages: unknown[];
  };
  const second = JSON.parse((await context?.toolContext.readEarlierMessages(20)) as string) as {
    messages: unknown[];
  };
  const third = JSON.parse((await context?.toolContext.readEarlierMessages(20)) as string) as {
    messages: unknown[];
    stop_reason: string;
  };

  expect(first.messages).toHaveLength(20);
  expect(second.messages).toHaveLength(20);
  expect(third.messages).toEqual([]);
  expect(third.stop_reason).toBe("message_limit");
  expect(reader.listQueries).toHaveLength(2);
});

test("read_earlier_messages stops after three calls even when the message cap is not reached", async () => {
  const reader = new FakeReader();
  reader.listResponses.push({
    status: "ok",
    messages: Array.from({ length: 20 }, (_, index) => message(String(900 + index))),
  });
  reader.listResponses.push({
    status: "ok",
    messages: Array.from({ length: 100 }, (_, index) => message(String(700 + index))),
  });
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const context = await service.build(input(message("1000", new Date(NOW).toISOString())));

  await context?.toolContext.readEarlierMessages(1);
  await context?.toolContext.readEarlierMessages(1);
  await context?.toolContext.readEarlierMessages(1);
  const fourth = JSON.parse((await context?.toolContext.readEarlierMessages(1)) as string) as {
    messages: unknown[];
    stop_reason: string;
  };

  expect(fourth.messages).toEqual([]);
  expect(fourth.stop_reason).toBe("call_limit");
});
