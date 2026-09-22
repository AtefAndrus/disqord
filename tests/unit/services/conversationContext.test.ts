import { expect, mock, test } from "bun:test";
import type {
  IReplyRecordRepository,
  ReplyPage,
  ReplyRecord,
} from "../../../src/db/repositories/replyRecord";
import {
  type BuildConversationWindowInput,
  ConversationWindowService,
  WINDOW_RAW_MESSAGE_LIMIT,
  WINDOW_REBUILD_AFTER_MS,
  WINDOW_SHRUNK_AGE_MS,
} from "../../../src/services/conversationWindow";
import type {
  DiscordMessageFetchResult,
  DiscordMessageListResult,
  IDiscordMessageReader,
} from "../../../src/services/discordMessageReader";
import { DiscordRestBudget } from "../../../src/services/discordMessageReader";
import {
  estimateNormalizedMessageTokens,
  type RawDiscordMessage,
} from "../../../src/utils/discordMessageNormalizer";

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
    budget: DiscordRestBudget,
    _signal?: AbortSignal,
  ): Promise<DiscordMessageListResult> {
    if (!budget.consume()) return { status: "failed", messages: [] };
    this.listQueries.push(query);
    return this.listResponses.shift() ?? { status: "ok", messages: [] };
  }

  async fetch(
    _channelId: string,
    messageId: string,
    budget: DiscordRestBudget,
    _signal?: AbortSignal,
  ): Promise<DiscordMessageFetchResult> {
    if (!budget.consume()) return { status: "failed", error: new Error("REST budget exhausted") };
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

test("FakeReader reports exhausted REST budgets", async () => {
  const reader = new FakeReader();
  const listResult = await reader.list(
    "channel",
    { before: "100", limit: 100 },
    new DiscordRestBudget(0),
  );
  const fetchResult = await reader.fetch("channel", "100", new DiscordRestBudget(0));

  expect(listResult.status).toBe("failed");
  expect(fetchResult.status).toBe("failed");
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

test("extends from the same anchor with an after-only query and preserves chronological order", async () => {
  const reader = new FakeReader();
  reader.listResponses.push({ status: "ok", messages: [message("100")] });
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const first = await service.build(input(message("101", new Date(NOW).toISOString())));

  reader.fetchResponses.push({ status: "found", message: message("100") });
  reader.listResponses.push({
    status: "ok",
    messages: [message("101"), message("102"), message("103")],
  });
  const second = await service.build(input(message("104", new Date(NOW).toISOString())));

  const anchor = first?.windowStartMessageId ?? "100";
  expect(second?.windowStartMessageId).toBe(first?.windowStartMessageId);
  expect(second?.sessionId).toBe(first?.sessionId);
  expect(reader.listQueries[1]).toEqual({ after: anchor, limit: 100 });
  expect(reader.listQueries[1]).not.toHaveProperty("before");
  expect(second?.messages.map((entry) => entry.id)).toEqual(["100", "101", "102", "103"]);
});

test("shrinking filters the original order instead of flattening exchange groups", async () => {
  const reader = new FakeReader();
  const replyRecord: ReplyRecord = {
    triggerMsgId: "100",
    channelId: "channel",
    guildId: "guild",
    status: "completed",
    pageCount: 1,
    finalizedAt: NOW - 1_000,
    createdAt: NOW - 2_000,
  };
  const repository = records();
  repository.findByTrigger = mock((id: string) => (id === "100" ? replyRecord : null));
  repository.findByPage = mock((id: string) => (id === "102" ? replyRecord : null));
  repository.listPages = mock(() => [{ pageMsgId: "102", triggerMsgId: "100", seq: 0 }]);
  reader.listResponses.push({
    status: "ok",
    messages: [
      ...Array.from({ length: 41 }, (_, index) => message(String(index + 1))),
      message("100"),
      message("101"),
      message("102", new Date(NOW - 1_000).toISOString(), {
        author: { id: "bot", username: "bot", bot: true },
      }),
    ],
  });
  const service = new ConversationWindowService(reader, repository, () => NOW);
  const first = await service.build(input(message("103", new Date(NOW).toISOString())));
  expect(first?.messages.map((entry) => entry.id).slice(-3)).toEqual(["100", "101", "102"]);

  const anchor = first?.windowStartMessageId ?? "25";
  reader.fetchResponses.push({ status: "found", message: message(anchor) });
  reader.listResponses.push({
    status: "ok",
    messages: [
      message("100"),
      message("101"),
      message("102", new Date(NOW - 1_000).toISOString(), {
        author: { id: "bot", username: "bot", bot: true },
      }),
      message("103"),
    ],
  });
  const second = await service.build(input(message("104", new Date(NOW).toISOString())));
  expect(second?.windowStartMessageId).toBe(first?.windowStartMessageId);
  expect(second?.messages.map((entry) => entry.id).slice(-4)).toEqual(["100", "101", "102", "103"]);
});

test("shrinks one extend directly to all compact limits and renews the session once", async () => {
  const reader = new FakeReader();
  reader.listResponses.push({ status: "ok", messages: [message("100")] });
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const first = await service.build(input(message("101", new Date(NOW).toISOString())));

  const extension = Array.from({ length: WINDOW_RAW_MESSAGE_LIMIT + 1 }, (_, index) =>
    message(
      String(101 + index),
      new Date(NOW - (WINDOW_RAW_MESSAGE_LIMIT - index) * 1_000).toISOString(),
    ),
  );
  reader.fetchResponses.push({ status: "found", message: message("100") });
  reader.listResponses.push({ status: "ok", messages: extension });
  const second = await service.build(input(message("150", new Date(NOW).toISOString())));

  expect(second?.sessionId).not.toBe(first?.sessionId);
  expect(second?.windowStartMessageId).not.toBe(first?.windowStartMessageId);
  expect(second?.messages.length).toBeLessThanOrEqual(20);
  expect(
    second?.messages.reduce(
      (total, entry, index) => total + estimateNormalizedMessageTokens(entry, `m${index + 1}`),
      0,
    ),
  ).toBeLessThanOrEqual(4_000);
  expect(new Date(second?.messages[0]?.time ?? 0).getTime()).toBeGreaterThanOrEqual(
    NOW - WINDOW_SHRUNK_AGE_MS,
  );
});

test("stops rebuilding after one recent page already crosses the compact boundary", async () => {
  const reader = new FakeReader();
  reader.listResponses.push({
    status: "ok",
    messages: Array.from({ length: 100 }, (_, index) =>
      message(String(1_000 + index), new Date(NOW - 1_000).toISOString()),
    ),
  });
  reader.listResponses.push(
    ...Array.from({ length: 12 }, () => ({
      status: "ok" as const,
      messages: Array.from({ length: 100 }, (_, index) =>
        message(String(2_000 + index), new Date(NOW - 1_000).toISOString()),
      ),
    })),
  );
  const service = new ConversationWindowService(reader, records(), () => NOW);

  const context = await service.build(input(message("10000", new Date(NOW).toISOString())));

  expect(context).not.toBeNull();
  expect(reader.listQueries).toHaveLength(1);
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
  const result = await context?.toolContext.readEarlierMessages(1, new AbortController().signal);

  expect(result).toBeString();
  const parsed = JSON.parse(result as string) as { messages: Array<{ ref: string }> };
  expect(parsed.messages).toHaveLength(1);
  expect(reader.listQueries[2]).toMatchObject({ before: "801" });
});

test("read_earlier_messages restores deferred large messages and reports has_more", async () => {
  const reader = new FakeReader();
  reader.listResponses.push({ status: "ok", messages: [] });
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const context = await service.build(input(message("1000", new Date(NOW).toISOString())));
  reader.listResponses.push({
    status: "ok",
    messages: [
      message("900", new Date(NOW - 3_000).toISOString(), { content: "a".repeat(8_000) }),
      message("901", new Date(NOW - 2_000).toISOString(), { content: "b".repeat(8_000) }),
      message("902", new Date(NOW - 1_000).toISOString(), { content: "c".repeat(8_000) }),
    ],
  });

  const first = JSON.parse(
    (await context?.toolContext.readEarlierMessages(3, new AbortController().signal)) as string,
  ) as { messages: Array<{ ref: string; text: string }>; has_more: boolean };
  const second = JSON.parse(
    (await context?.toolContext.readEarlierMessages(1, new AbortController().signal)) as string,
  ) as { messages: Array<{ text: string }> };
  const third = JSON.parse(
    (await context?.toolContext.readEarlierMessages(1, new AbortController().signal)) as string,
  ) as { messages: Array<{ text: string }> };

  expect(first.messages).toHaveLength(1);
  expect(first.messages[0]?.text).toBe("c".repeat(8_000));
  expect(first.has_more).toBe(true);
  expect(second.messages[0]?.text).toBe("b".repeat(8_000));
  expect(third.messages[0]?.text).toBe("a".repeat(8_000));
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

  const result = await context?.toolContext.readEarlierMessages(5, new AbortController().signal);
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

  const first = JSON.parse(
    (await context?.toolContext.readEarlierMessages(20, new AbortController().signal)) as string,
  ) as {
    messages: unknown[];
  };
  const second = JSON.parse(
    (await context?.toolContext.readEarlierMessages(20, new AbortController().signal)) as string,
  ) as {
    messages: unknown[];
  };
  const third = JSON.parse(
    (await context?.toolContext.readEarlierMessages(20, new AbortController().signal)) as string,
  ) as {
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

  await context?.toolContext.readEarlierMessages(1, new AbortController().signal);
  await context?.toolContext.readEarlierMessages(1, new AbortController().signal);
  await context?.toolContext.readEarlierMessages(1, new AbortController().signal);
  const fourth = JSON.parse(
    (await context?.toolContext.readEarlierMessages(1, new AbortController().signal)) as string,
  ) as {
    messages: unknown[];
    stop_reason: string;
  };

  expect(fourth.messages).toEqual([]);
  expect(fourth.stop_reason).toBe("call_limit");
});

test("memoizes a deleted exchange across raw pages and reply-target lookup", async () => {
  const reader = new FakeReader();
  const replyRecord: ReplyRecord = {
    triggerMsgId: "900",
    channelId: "channel",
    guildId: "guild",
    status: "completed",
    pageCount: 1,
    finalizedAt: NOW - 1_000,
    createdAt: NOW - 2_000,
  };
  const missingPage: ReplyPage = { pageMsgId: "9999", triggerMsgId: "900", seq: 0 };
  const repository = records();
  repository.findByTrigger = mock((id: string) => (id === "900" ? replyRecord : null));
  repository.findByPage = mock((id: string) =>
    id === "900" || (Number(id) >= 901 && Number(id) <= 913) ? replyRecord : null,
  );
  repository.listPages = mock(() => [missingPage]);
  reader.listResponses.push({
    status: "ok",
    messages: [
      message("900"),
      ...Array.from({ length: 13 }, (_, index) =>
        message(String(901 + index), new Date(NOW - 1_000).toISOString(), {
          author: { id: "bot", username: "bot", bot: true },
        }),
      ),
    ],
  });
  const service = new ConversationWindowService(reader, repository, () => NOW);
  const context = await service.build(
    input(
      message("1000", new Date(NOW).toISOString(), {
        message_reference: { channel_id: "channel", message_id: "900" },
      }),
    ),
  );

  expect(context?.messages).toEqual([]);
  expect(context?.replyTarget).toBeUndefined();
  expect(reader.fetchQueries).toEqual(["9999"]);
});

test("excludes a split reply when a reconstructed page crosses the 24-hour cutoff", async () => {
  const buildRead = async (oldPageTimestamp: string): Promise<{ messages: unknown[] }> => {
    const reader = new FakeReader();
    const replyRecord: ReplyRecord = {
      triggerMsgId: "900",
      channelId: "channel",
      guildId: "guild",
      status: "completed",
      pageCount: 2,
      finalizedAt: NOW - 1_000,
      createdAt: NOW - 2_000,
    };
    const repository = records();
    repository.findByPage = mock((id: string) => (id === "901" ? replyRecord : null));
    repository.findByTrigger = mock(() => null);
    repository.listPages = mock(() => [
      { pageMsgId: "800", triggerMsgId: "900", seq: 0 },
      { pageMsgId: "901", triggerMsgId: "900", seq: 1 },
    ]);
    const trigger = message("900", new Date(NOW - 60 * 60 * 1000).toISOString());
    const oldPage = message("800", oldPageTimestamp, {
      author: { id: "bot", username: "bot", bot: true },
    });
    const recentPage = message("901", new Date(NOW - 30 * 60 * 1000).toISOString(), {
      author: { id: "bot", username: "bot", bot: true },
    });
    reader.listResponses.push({ status: "ok", messages: [] });
    reader.listResponses.push({ status: "ok", messages: [recentPage] });
    reader.fetchResponses.push({ status: "found", message: trigger });
    reader.fetchResponses.push({ status: "found", message: oldPage });
    const service = new ConversationWindowService(reader, repository, () => NOW);
    const context = await service.build(input(message("1000", new Date(NOW).toISOString())));
    return JSON.parse(
      (await context?.toolContext.readEarlierMessages(1, new AbortController().signal)) as string,
    ) as { messages: unknown[] };
  };

  const tooOld = await buildRead(new Date(NOW - 25 * 60 * 60 * 1000).toISOString());
  const withinRange = await buildRead(new Date(NOW - 2 * 60 * 60 * 1000).toISOString());
  expect(tooOld.messages).toEqual([]);
  expect(withinRange.messages).toHaveLength(1);
});

test("aborting read_earlier_messages leaves its cursor, buffer, and shown set unchanged", async () => {
  const listQueries: Array<Record<string, string | number>> = [];
  let listCall = 0;
  let releaseDelayed: (() => void) | undefined;
  let delayed = true;
  const reader: IDiscordMessageReader = {
    list: mock(
      async (
        _channelId: string,
        query: { before?: string; after?: string; limit: number },
        budget: DiscordRestBudget,
      ): Promise<DiscordMessageListResult> => {
        if (!budget.consume()) return { status: "failed", messages: [] };
        listQueries.push(query);
        listCall += 1;
        if (listCall === 1) return { status: "ok", messages: [] };
        if (delayed) {
          return new Promise((resolve) => {
            releaseDelayed = () => resolve({ status: "ok", messages: [message("900")] });
          });
        }
        return { status: "ok", messages: [message("900"), message("901")] };
      },
    ),
    fetch: mock(
      async (
        _channelId: string,
        _messageId: string,
        budget: DiscordRestBudget,
      ): Promise<DiscordMessageFetchResult> => {
        if (!budget.consume())
          return { status: "failed", error: new Error("REST budget exhausted") };
        return { status: "not-found" };
      },
    ),
  };
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const context = await service.build(input(message("1000", new Date(NOW).toISOString())));
  const controller = new AbortController();
  const pending = context?.toolContext.readEarlierMessages(2, controller.signal);
  while (!releaseDelayed) await Bun.sleep(0);
  controller.abort();
  releaseDelayed();
  const aborted = JSON.parse((await pending) as string) as { stop_reason: string };

  delayed = false;
  const next = JSON.parse(
    (await context?.toolContext.readEarlierMessages(2, new AbortController().signal)) as string,
  ) as { messages: unknown[] };
  expect(aborted.stop_reason).toBe("fetch_failed");
  expect(listQueries).toHaveLength(3);
  expect(listQueries[2]).toEqual({ before: "1000", limit: 100 });
  expect(next.messages).toHaveLength(2);
});

test("a timed-out build cannot install a late window state", async () => {
  let releaseFirst: (() => void) | undefined;
  let listCall = 0;
  const reader: IDiscordMessageReader = {
    list: mock(
      async (
        _channelId: string,
        _query: { before?: string; after?: string; limit: number },
        budget: DiscordRestBudget,
      ): Promise<DiscordMessageListResult> => {
        if (!budget.consume()) return { status: "failed", messages: [] };
        listCall += 1;
        if (listCall === 1) {
          return new Promise((resolve) => {
            releaseFirst = () => resolve({ status: "ok", messages: [message("900")] });
          });
        }
        return { status: "ok", messages: [] };
      },
    ),
    fetch: mock(async (): Promise<DiscordMessageFetchResult> => ({ status: "not-found" })),
  };
  const service = new ConversationWindowService(
    reader,
    records(),
    () => NOW,
    async () => true,
    5,
  );
  const first = service.build(input(message("1000", new Date(NOW).toISOString())));
  while (!releaseFirst) await Bun.sleep(0);
  expect(await first).toBeNull();
  releaseFirst();
  await Bun.sleep(20);
  const states = (service as unknown as { states: Map<string, unknown> }).states;
  expect(states.size).toBe(0);

  const second = await service.build(input(message("1001", new Date(NOW).toISOString())));
  expect(second).not.toBeNull();
  expect(listCall).toBe(2);
  expect(reader.fetch).not.toHaveBeenCalled();
});

test("a timeout during reply-target resolution cannot install a window state", async () => {
  let releaseTarget: (() => void) | undefined;
  const reader: IDiscordMessageReader = {
    list: mock(
      async (
        _channelId: string,
        _query: { before?: string; after?: string; limit: number },
        budget: DiscordRestBudget,
      ): Promise<DiscordMessageListResult> => {
        if (!budget.consume()) return { status: "failed", messages: [] };
        return { status: "ok", messages: [message("900")] };
      },
    ),
    fetch: mock(
      async (
        _channelId: string,
        _messageId: string,
        budget: DiscordRestBudget,
      ): Promise<DiscordMessageFetchResult> => {
        if (!budget.consume())
          return { status: "failed", error: new Error("REST budget exhausted") };
        return new Promise((resolve) => {
          releaseTarget = () => resolve({ status: "not-found" });
        });
      },
    ),
  };
  const service = new ConversationWindowService(
    reader,
    records(),
    () => NOW,
    async () => true,
    5,
  );
  const current = message("1000", new Date(NOW).toISOString(), {
    message_reference: { message_id: "800", channel_id: "channel" },
  });
  const first = service.build(input(current));
  while (!releaseTarget) await Bun.sleep(0);
  expect(await first).toBeNull();
  releaseTarget();
  await Bun.sleep(20);

  const states = (service as unknown as { states: Map<string, unknown> }).states;
  expect(states.size).toBe(0);
});

test("sweeps stale channel states on access", async () => {
  let now = NOW;
  const reader = new FakeReader();
  reader.listResponses.push(
    { status: "ok", messages: [] },
    { status: "ok", messages: [] },
    { status: "ok", messages: [] },
  );
  const service = new ConversationWindowService(reader, records(), () => now);
  await service.build(input(message("1000", new Date(now).toISOString(), { channel_id: "one" })));
  await service.build(input(message("1001", new Date(now).toISOString(), { channel_id: "two" })));
  now += WINDOW_REBUILD_AFTER_MS + 1;
  await service.build(input(message("1002", new Date(now).toISOString(), { channel_id: "three" })));

  const states = (service as unknown as { states: Map<string, unknown> }).states;
  expect(states.size).toBe(1);
  expect(states.has("three")).toBe(true);
});
