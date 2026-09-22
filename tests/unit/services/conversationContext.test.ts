import { expect, mock, test } from "bun:test";
import type {
  IReplyRecordRepository,
  ReplyPage,
  ReplyRecord,
} from "../../../src/db/repositories/replyRecord";
import {
  type BuildConversationWindowInput,
  ConversationWindowService,
  READ_EARLIER_MAX_RESULT_BYTES,
  truncateTextByBytes,
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

for (const anchorStatus of ["not-found", "failed"] as const) {
  test(`keeps the stored anchor boundary when the anchor is ${anchorStatus}`, async () => {
    const reader = new FakeReader();
    reader.listResponses.push({ status: "ok", messages: [message("100")] });
    const service = new ConversationWindowService(reader, records(), () => NOW);
    const first = await service.build(input(message("101", new Date(NOW).toISOString())));

    reader.fetchResponses.push(
      anchorStatus === "not-found"
        ? { status: "not-found" }
        : { status: "failed", error: new Error("temporary failure") },
    );
    reader.listResponses.push({ status: "ok", messages: [message("101"), message("102")] });
    const second = await service.build(input(message("103", new Date(NOW).toISOString())));

    expect(second?.windowStartMessageId).toBe(first?.windowStartMessageId);
    expect(second?.sessionId).toBe(first?.sessionId);
    expect(second?.messages.map((entry) => entry.id)).toEqual(["101", "102"]);
    expect(reader.listQueries[1]).toEqual({ after: "100", limit: 100 });
  });
}

test("excludes an exchange when the extend anchor is externally deleted", async () => {
  const reader = new FakeReader();
  const replyRecord: ReplyRecord = {
    triggerMsgId: "90",
    channelId: "channel",
    guildId: "guild",
    status: "completed",
    pageCount: 1,
    finalizedAt: NOW - 1_000,
    createdAt: NOW - 2_000,
  };
  const pages: ReplyPage[] = [{ pageMsgId: "100", triggerMsgId: "90", seq: 0 }];
  const repository = records();
  repository.findByTrigger = mock((id: string) => (id === "90" ? replyRecord : null));
  repository.findByPage = mock((id: string) => (id === "100" ? replyRecord : null));
  repository.listPages = mock(() => pages);
  const page100 = message("100", undefined, {
    author: { id: "bot", username: "bot", bot: true },
    content: "",
  });
  reader.listResponses.push({ status: "ok", messages: [page100] });
  reader.fetchResponses.push({ status: "found", message: message("90") });
  const service = new ConversationWindowService(reader, repository, () => NOW);
  const first = await service.build(input(message("102", new Date(NOW).toISOString())));

  reader.fetchResponses.push({ status: "not-found" }, { status: "found", message: message("90") });
  reader.listResponses.push({ status: "ok", messages: [page100] });
  const second = await service.build(input(message("103", new Date(NOW).toISOString())));

  expect(first?.messages).toHaveLength(1);
  expect(second?.messages).toEqual([]);
  expect(second?.windowStartMessageId).toBe(first?.windowStartMessageId);
  expect(second?.sessionId).toBe(first?.sessionId);
  expect(reader.fetchQueries).toEqual(["90", "100"]);
});

test("rebuilds a stale message below the stored start without clobbering the newer state", async () => {
  const reader = new FakeReader();
  reader.listResponses.push({ status: "ok", messages: [message("119")] });
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const states = (
    service as unknown as {
      states: Map<string, { startMessageId: string; sessionId: string; lastUsedAt: number }>;
    }
  ).states;
  states.set("channel", { startMessageId: "180", sessionId: "newer", lastUsedAt: NOW });

  const context = await service.build(input(message("120", new Date(NOW).toISOString())));
  reader.listResponses.push({
    status: "ok",
    messages: [message("177"), message("178"), message("179")],
  });
  const result = JSON.parse(
    (await context?.toolContext.readEarlierMessages(3, new AbortController().signal)) as string,
  ) as { messages: Array<{ text: string }> };

  expect(result.messages).toEqual([]);
  expect(reader.listQueries[0]).toEqual({ before: "120", limit: 100 });
  expect(reader.listQueries[1]).toEqual({ before: "120", limit: 100 });
  expect(states.get("channel")?.startMessageId).toBe("180");
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

test("keeps a reply selected by page position stable when its trigger falls before the start", async () => {
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
  repository.findByPage = mock((id: string) => (id === "131" ? replyRecord : null));
  repository.listPages = mock(() => [{ pageMsgId: "131", triggerMsgId: "100", seq: 0 }]);
  const history = [
    message("100"),
    ...Array.from({ length: 29 }, (_, index) => message(String(101 + index))),
    message("131", undefined, {
      author: { id: "bot", username: "bot", bot: true },
      content: "",
    }),
    ...Array.from({ length: 10 }, (_, index) => message(String(132 + index))),
  ];
  reader.listResponses.push({ status: "ok", messages: history });
  const service = new ConversationWindowService(reader, repository, () => NOW);

  const first = await service.build(input(message("142", new Date(NOW).toISOString())));
  const start = BigInt(first?.windowStartMessageId ?? "0");
  expect(start).toBeGreaterThan(100n);
  expect(start).toBeLessThanOrEqual(131n);
  expect(first?.messages.map((entry) => entry.id)).toContain("131");
  expect(first?.messages.map((entry) => entry.id)).not.toContain("100");

  reader.fetchResponses.push({
    status: "found",
    message:
      history.find((candidate) => candidate.id === first?.windowStartMessageId) ??
      message(first?.windowStartMessageId ?? "0"),
  });
  reader.fetchResponses.push({ status: "found", message: message("100") });
  reader.listResponses.push({
    status: "ok",
    messages: history.filter((candidate) => BigInt(candidate.id) > start),
  });
  const second = await service.build(input(message("143", new Date(NOW).toISOString())));

  expect(second?.windowStartMessageId).toBe(first?.windowStartMessageId);
  expect(second?.sessionId).toBe(first?.sessionId);
  expect(second?.messages.map(({ id, ref }) => ({ id, ref }))).toEqual(
    first?.messages.map(({ id, ref }) => ({ id, ref })),
  );
  expect(reader.fetchQueries).toContain("100");
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

test("keeps the extend window state when reply-target deletion removes the over-limit exchange", async () => {
  const reader = new FakeReader();
  const replyRecord: ReplyRecord = {
    triggerMsgId: "50",
    channelId: "channel",
    guildId: "guild",
    status: "completed",
    pageCount: 1,
    finalizedAt: NOW - 1_000,
    createdAt: NOW - 2_000,
  };
  const repository = records();
  repository.findByTrigger = mock((id: string) => (id === "50" ? replyRecord : null));
  repository.findByPage = mock((id: string) => (id === "30" ? replyRecord : null));
  repository.listPages = mock(() => [{ pageMsgId: "30", triggerMsgId: "50", seq: 0 }]);
  reader.listResponses.push({
    status: "ok",
    messages: Array.from({ length: 20 }, (_, index) => message(String(index + 1))),
  });
  const service = new ConversationWindowService(reader, repository, () => NOW);
  const first = await service.build(input(message("21", new Date(NOW).toISOString())));

  const extension = Array.from({ length: 40 }, (_, index) => {
    const id = String(index + 2);
    return id === "30"
      ? message(id, undefined, {
          author: { id: "bot", username: "bot", bot: true },
          content: "",
        })
      : message(id);
  });
  reader.fetchResponses.push(
    { status: "found", message: message("1") },
    { status: "found", message: message("50") },
    { status: "not-found" },
  );
  reader.listResponses.push({ status: "ok", messages: extension });
  const second = await service.build(
    input(
      message("100", new Date(NOW).toISOString(), {
        message_reference: { channel_id: "channel", message_id: "50" },
      }),
    ),
  );

  expect(second?.windowStartMessageId).toBe(first?.windowStartMessageId);
  expect(second?.sessionId).toBe(first?.sessionId);
  expect(second?.messages).toHaveLength(40);
  expect(second?.messages.map((entry) => entry.id)).not.toContain("30");
  expect(reader.fetchQueries).toEqual(["1", "50", "50"]);
});

test("keeps rebuilding while eligible entries stay below the compact boundary until the REST budget ends", async () => {
  const reader = new FakeReader();
  const pageOf = (base: number): RawDiscordMessage[] =>
    Array.from({ length: 100 }, (_, index) => {
      const id = String(base + index);
      if (index === 0) return message(id, new Date(NOW - 1_000).toISOString());
      return message(id, new Date(NOW - 1_000).toISOString(), {
        author: { id: "other-bot", username: "other", bot: true },
      });
    });
  for (let page = 0; page < 12; page += 1) {
    reader.listResponses.push({ status: "ok", messages: pageOf(1_000 + page * 1_000) });
  }
  const service = new ConversationWindowService(reader, records(), () => NOW);

  const context = await service.build(input(message("100000", new Date(NOW).toISOString())));

  expect(context).not.toBeNull();
  expect(reader.listQueries).toHaveLength(12);
});

test("pages past a full raw page of other-bot messages to find an eligible human message", async () => {
  const reader = new FakeReader();
  reader.listResponses.push({
    status: "ok",
    messages: Array.from({ length: 100 }, (_, index) =>
      message(String(900 + index), new Date(NOW - 1_000).toISOString(), {
        author: { id: "other-bot", username: "other", bot: true },
      }),
    ),
  });
  reader.listResponses.push({ status: "ok", messages: [message("800")] });
  const service = new ConversationWindowService(reader, records(), () => NOW);

  const context = await service.build(input(message("1000", new Date(NOW).toISOString())));

  expect(reader.listQueries).toHaveLength(2);
  expect(context?.messages.map((entry) => entry.id)).toEqual(["800"]);
});

test("includes a verified reply when its trigger is outside the fetched window", async () => {
  const reader = new FakeReader();
  const replyRecord: ReplyRecord = {
    triggerMsgId: "800",
    channelId: "channel",
    guildId: "guild",
    status: "completed",
    pageCount: 1,
    finalizedAt: NOW - 1_000,
    createdAt: NOW - 2_000,
  };
  const repository = records();
  repository.findByPage = mock((id: string) => (id === "900" ? replyRecord : null));
  repository.listPages = mock(() => [{ pageMsgId: "900", triggerMsgId: "800", seq: 0 }]);
  const trigger = message("800", new Date(NOW - 20 * 60 * 1000).toISOString());
  const page = message("900", new Date(NOW - 10 * 60 * 1000).toISOString(), {
    author: { id: "bot", username: "bot", bot: true },
    content: "",
  });
  reader.listResponses.push({ status: "ok", messages: [page] });
  reader.fetchResponses.push({ status: "found", message: trigger });

  const service = new ConversationWindowService(reader, repository, () => NOW);
  const context = await service.build(input(message("1000", new Date(NOW).toISOString())));

  expect(context?.messages).toHaveLength(1);
  expect(context?.messages[0]?.kind).toBe("assistant");
  expect(reader.fetchQueries).toEqual(["800"]);
});

test("reuses a fetched reply target when only two REST calls remain", async () => {
  const reader = new FakeReader();
  const replyRecord: ReplyRecord = {
    triggerMsgId: "1000",
    channelId: "channel",
    guildId: "guild",
    status: "completed",
    pageCount: 1,
    finalizedAt: NOW - 1_000,
    createdAt: NOW - 2_000,
  };
  const repository = records();
  repository.findByPage = mock((id: string) => (id === "2000" ? replyRecord : null));
  repository.listPages = mock(() => [{ pageMsgId: "2000", triggerMsgId: "1000", seq: 0 }]);
  for (let page = 0; page < 9; page += 1) {
    reader.listResponses.push({
      status: "ok",
      messages: Array.from({ length: 100 }, (_, index) =>
        message(String(10_000 + page * 100 + index), undefined, {
          author: { id: "other-bot", username: "other", bot: true },
        }),
      ),
    });
  }
  reader.listResponses.push({
    status: "ok",
    messages: [
      message("20000", undefined, {
        author: { id: "other-bot", username: "other", bot: true },
      }),
    ],
  });
  const target = message("2000", new Date(NOW - 10 * 60 * 1000).toISOString(), {
    author: { id: "bot", username: "bot", bot: true },
    content: "",
  });
  const trigger = message("1000", new Date(NOW - 20 * 60 * 1000).toISOString());
  reader.fetchResponses.push({ status: "found", message: target });
  reader.fetchResponses.push({ status: "found", message: trigger });

  const service = new ConversationWindowService(reader, repository, () => NOW);
  const context = await service.build(
    input(
      message("30000", new Date(NOW).toISOString(), {
        message_reference: { channel_id: "channel", message_id: "2000" },
      }),
    ),
  );

  expect(reader.listQueries).toHaveLength(10);
  expect(context?.replyTarget?.kind).toBe("assistant");
  expect(reader.fetchQueries).toEqual(["2000", "1000"]);
});

test("read_earlier_messages scans past a split reply positioned before the cursor", async () => {
  const reader = new FakeReader();
  const replyRecord: ReplyRecord = {
    triggerMsgId: "100",
    channelId: "channel",
    guildId: "guild",
    status: "completed",
    pageCount: 2,
    finalizedAt: NOW - 1_000,
    createdAt: NOW - 2_000,
  };
  const repository = records();
  repository.findByPage = mock((id: string) => (id === "900" ? replyRecord : null));
  repository.listPages = mock(() => [
    { pageMsgId: "110", triggerMsgId: "100", seq: 0 },
    { pageMsgId: "900", triggerMsgId: "100", seq: 1 },
  ]);
  reader.listResponses.push({ status: "ok", messages: [] });
  reader.listResponses.push({
    status: "ok",
    messages: Array.from({ length: 100 }, (_, index) =>
      message(String(801 + index), undefined, {
        author: { id: "other-bot", username: "other-bot", bot: true },
        ...(index === 99 && { author: { id: "bot", username: "bot", bot: true }, content: "" }),
      }),
    ),
  });
  reader.listResponses.push({ status: "ok", messages: [message("799")] });
  reader.fetchResponses.push({ status: "found", message: message("100") });
  reader.fetchResponses.push({
    status: "found",
    message: message("110", undefined, {
      author: { id: "bot", username: "bot", bot: true },
      content: "",
    }),
  });
  const service = new ConversationWindowService(reader, repository, () => NOW);
  const context = await service.build(input(message("1000", new Date(NOW).toISOString())));

  const result = JSON.parse(
    (await context?.toolContext.readEarlierMessages(1, new AbortController().signal)) as string,
  ) as { messages: Array<{ text: string }> };

  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]?.text).toBe("message-799");
  expect(reader.listQueries.at(-1)).toEqual({ before: "801", limit: 100 });
});

test("read_earlier_messages holds back a split reply when paging fails mid-scan", async () => {
  const reader = new FakeReader();
  const replyRecord: ReplyRecord = {
    triggerMsgId: "100",
    channelId: "channel",
    guildId: "guild",
    status: "completed",
    pageCount: 2,
    finalizedAt: NOW - 1_000,
    createdAt: NOW - 2_000,
  };
  const repository = records();
  repository.findByPage = mock((id: string) => (id === "900" ? replyRecord : null));
  repository.listPages = mock(() => [
    { pageMsgId: "110", triggerMsgId: "100", seq: 0 },
    { pageMsgId: "900", triggerMsgId: "100", seq: 1 },
  ]);
  reader.listResponses.push({ status: "ok", messages: [] });
  reader.listResponses.push({
    status: "ok",
    messages: Array.from({ length: 100 }, (_, index) =>
      message(String(801 + index), undefined, {
        author: { id: "other-bot", username: "other-bot", bot: true },
        ...(index === 99 && { author: { id: "bot", username: "bot", bot: true }, content: "" }),
      }),
    ),
  });
  reader.listResponses.push({ status: "failed", messages: [], error: new Error("boom") });
  reader.fetchResponses.push({ status: "found", message: message("100") });
  reader.fetchResponses.push({
    status: "found",
    message: message("110", undefined, {
      author: { id: "bot", username: "bot", bot: true },
      content: "",
    }),
  });
  const service = new ConversationWindowService(reader, repository, () => NOW);
  const context = await service.build(input(message("1000", new Date(NOW).toISOString())));

  const result = JSON.parse(
    (await context?.toolContext.readEarlierMessages(1, new AbortController().signal)) as string,
  ) as { messages: Array<{ text: string }>; has_more: boolean; stop_reason: string | null };

  // 801 より前は走査できていないので、位置 110 の返答を先に返すと「新しい方から」に反する。
  expect(result.messages).toHaveLength(0);
  expect(result.has_more).toBe(true);
  expect(result.stop_reason).toBe("fetch_failed");
});

test("truncateTextByBytes backs off at a multibyte UTF-8 boundary", () => {
  const text = "日本語😀abc";
  const maxBytes = 10;
  const encoded = new TextEncoder().encode(text);
  const result = truncateTextByBytes(text, maxBytes);
  const resultBytes = new TextEncoder().encode(result);

  expect(result).toBe("日本語");
  expect(resultBytes.byteLength).toBeLessThanOrEqual(maxBytes);
  expect(new TextDecoder().decode(resultBytes)).toBe(result);
  expect(new TextDecoder().decode(encoded.slice(0, resultBytes.byteLength + 1))).toContain("�");
  expect(new TextEncoder().encode(`${result}😀`).byteLength).toBeGreaterThan(maxBytes);
});

test("fitToolResult keeps a large Japanese message close to its byte budget", async () => {
  const reader = new FakeReader();
  reader.listResponses.push({ status: "ok", messages: [] });
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const context = await service.build(input(message("1000", new Date(NOW).toISOString())));
  reader.listResponses.push({
    status: "ok",
    messages: [message("900", undefined, { content: "日".repeat(5_000) })],
  });

  const raw = (await context?.toolContext.readEarlierMessages(
    1,
    new AbortController().signal,
  )) as string;
  const result = JSON.parse(raw) as {
    messages: Array<{ text: string; truncated: boolean }>;
  };
  const byteLength = new TextEncoder().encode(raw).byteLength;

  expect(byteLength).toBeGreaterThan(11 * 1024);
  expect(byteLength).toBeLessThanOrEqual(READ_EARLIER_MAX_RESULT_BYTES);
  expect(result.messages[0]?.truncated).toBe(true);
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

test("recomputes stop_reason and has_more after byte-fitting instead of the pre-fit message-count guess", async () => {
  const reader = new FakeReader();
  reader.listResponses.push({ status: "ok", messages: [] });
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const context = await service.build(input(message("100000", new Date(NOW).toISOString())));

  reader.listResponses.push({
    status: "ok",
    messages: Array.from({ length: 100 }, (_, index) =>
      message(String(900 + index), undefined, {
        ...(index >= 40 && {
          author: { id: "other-bot", username: "other", bot: true },
        }),
      }),
    ),
  });
  const first = JSON.parse(
    (await context?.toolContext.readEarlierMessages(20, new AbortController().signal)) as string,
  ) as { messages: unknown[] };
  const second = JSON.parse(
    (await context?.toolContext.readEarlierMessages(20, new AbortController().signal)) as string,
  ) as { messages: unknown[] };
  expect(first.messages).toHaveLength(20);
  expect(second.messages).toHaveLength(20);

  reader.listResponses.push({
    status: "ok",
    messages: Array.from({ length: 20 }, (_, index) =>
      message(String(700 + index), new Date(NOW - 1_000).toISOString(), {
        content: "x".repeat(8_000),
      }),
    ),
  });
  const third = JSON.parse(
    (await context?.toolContext.readEarlierMessages(20, new AbortController().signal)) as string,
  ) as { messages: unknown[]; has_more: boolean; stop_reason: string | null };

  expect(third.messages.length).toBeGreaterThan(0);
  expect(third.messages.length).toBeLessThan(20);
  expect(third.has_more).toBe(true);
  expect(third.stop_reason).toBeNull();
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

test("the reply target's reference keeps its place in the chronological order", async () => {
  const reader = new FakeReader();
  const target = message("800", new Date(NOW - 2_000).toISOString());
  const older = message("700", new Date(NOW - 3_000).toISOString());
  const newer = message("900", new Date(NOW - 1_500).toISOString());
  reader.listResponses.push({ status: "ok", messages: [] });
  reader.fetchResponses.push({ status: "found", message: target });
  reader.listResponses.push({ status: "ok", messages: [newer, target, older] });
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const context = await service.build(
    input(
      message("1000", new Date(NOW).toISOString(), {
        message_reference: { channel_id: "channel", message_id: "800" },
      }),
    ),
  );

  const parsed = JSON.parse(
    (await context?.toolContext.readEarlierMessages(5, new AbortController().signal)) as string,
  ) as { messages: Array<{ ref?: string; text?: string }> };

  expect(parsed.messages.map((entry) => entry.text ?? `ref:${entry.ref}`)).toEqual([
    "message-700",
    "ref:m1",
    "message-900",
  ]);
});

test("read_earlier_messages orders same-millisecond messages by id across pages", async () => {
  const reader = new FakeReader();
  const sameTime = new Date(NOW - 5_000).toISOString();
  const firstPage = [
    message("100", sameTime),
    ...Array.from({ length: 99 }, (_, index) =>
      message(String(101 + index), sameTime, {
        author: { id: "other-bot", username: "other-bot", bot: true },
      }),
    ),
  ];
  reader.listResponses.push({ status: "ok", messages: [] });
  reader.listResponses.push({ status: "ok", messages: firstPage });
  reader.listResponses.push({
    status: "ok",
    messages: [message("98", sameTime), message("99", sameTime)],
  });
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const context = await service.build(input(message("1000", new Date(NOW).toISOString())));

  const parsed = JSON.parse(
    (await context?.toolContext.readEarlierMessages(2, new AbortController().signal)) as string,
  ) as { messages: Array<{ text: string }> };

  // 同じミリ秒なので、新しい方の 2 件は message ID で決まる。
  expect(parsed.messages.map((entry) => entry.text)).toEqual(["message-99", "message-100"]);
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

test("read_earlier_messages checks the call limit before authorizing", async () => {
  const reader = new FakeReader();
  reader.listResponses.push({
    status: "ok",
    messages: Array.from({ length: 20 }, (_, index) => message(String(900 + index))),
  });
  reader.listResponses.push({
    status: "ok",
    messages: Array.from({ length: 100 }, (_, index) => message(String(700 + index))),
  });
  const authorize = mock(async () => true);
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const context = await service.build({
    ...input(message("1000", new Date(NOW).toISOString())),
    authorize,
  });

  authorize.mockClear();
  await context?.toolContext.readEarlierMessages(1, new AbortController().signal);
  await context?.toolContext.readEarlierMessages(1, new AbortController().signal);
  await context?.toolContext.readEarlierMessages(1, new AbortController().signal);
  authorize.mockClear();
  const fourth = JSON.parse(
    (await context?.toolContext.readEarlierMessages(1, new AbortController().signal)) as string,
  ) as {
    messages: unknown[];
    stop_reason: string;
  };

  expect(fourth.messages).toEqual([]);
  expect(fourth.stop_reason).toBe("call_limit");
  expect(authorize).not.toHaveBeenCalled();
});

test("read_earlier_messages counts unauthorized attempts toward the call cap", async () => {
  const reader = new FakeReader();
  reader.listResponses.push({ status: "ok", messages: [] });
  let allowBuild = true;
  const authorize = mock(async () => allowBuild);
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const context = await service.build({
    ...input(message("1000", new Date(NOW).toISOString())),
    authorize,
  });

  allowBuild = false;
  authorize.mockClear();
  const first = JSON.parse(
    (await context?.toolContext.readEarlierMessages(1, new AbortController().signal)) as string,
  ) as { stop_reason: string };
  const second = JSON.parse(
    (await context?.toolContext.readEarlierMessages(1, new AbortController().signal)) as string,
  ) as { stop_reason: string };
  const third = JSON.parse(
    (await context?.toolContext.readEarlierMessages(1, new AbortController().signal)) as string,
  ) as { stop_reason: string };
  const fourth = JSON.parse(
    (await context?.toolContext.readEarlierMessages(1, new AbortController().signal)) as string,
  ) as { stop_reason: string };

  expect(first.stop_reason).toBe("no_permission");
  expect(second.stop_reason).toBe("no_permission");
  expect(third.stop_reason).toBe("no_permission");
  expect(fourth.stop_reason).toBe("call_limit");
  expect(authorize).toHaveBeenCalledTimes(3);
});

test("read_earlier_messages keeps the 24-hour cutoff reason while draining its buffer", async () => {
  const reader = new FakeReader();
  reader.listResponses.push({ status: "ok", messages: [] });
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const context = await service.build(input(message("1000", new Date(NOW).toISOString())));
  reader.listResponses.push({
    status: "ok",
    messages: [
      message("800", new Date(NOW - 25 * 60 * 60 * 1000).toISOString()),
      message("900", new Date(NOW - 2 * 60 * 60 * 1000).toISOString()),
      message("901", new Date(NOW - 1 * 60 * 60 * 1000).toISOString()),
    ],
  });

  const first = JSON.parse(
    (await context?.toolContext.readEarlierMessages(1, new AbortController().signal)) as string,
  ) as { messages: unknown[]; has_more: boolean; stop_reason: string | null };
  const second = JSON.parse(
    (await context?.toolContext.readEarlierMessages(1, new AbortController().signal)) as string,
  ) as { messages: unknown[]; has_more: boolean; stop_reason: string | null };

  expect(first.messages).toHaveLength(1);
  expect(first.has_more).toBe(true);
  expect(first.stop_reason).toBeNull();
  expect(second.messages).toHaveLength(1);
  expect(second.has_more).toBe(false);
  expect(second.stop_reason).toBe("24h_cutoff");
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
    id === "900" || id === "9999" || (Number(id) >= 901 && Number(id) <= 913) ? replyRecord : null,
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

test("removes a trigger when reply-target lookup confirms its deletion", async () => {
  const reader = new FakeReader();
  const replyRecord: ReplyRecord = {
    triggerMsgId: "100",
    channelId: "channel",
    guildId: "guild",
    status: "pending",
    pageCount: 1,
    finalizedAt: NOW - 1_000,
    createdAt: NOW - 2_000,
  };
  const repository = records();
  repository.findByTrigger = mock((id: string) => (id === "100" ? replyRecord : null));
  repository.findByPage = mock((id: string) => (id === "101" ? replyRecord : null));
  repository.listPages = mock(() => [{ pageMsgId: "101", triggerMsgId: "100", seq: 0 }]);
  reader.listResponses.push({ status: "ok", messages: [message("100")] });
  reader.fetchResponses.push(
    { status: "failed", error: new Error("temporary failure") },
    { status: "not-found" },
  );

  const service = new ConversationWindowService(reader, repository, () => NOW);
  const context = await service.build(
    input(
      message("200", new Date(NOW).toISOString(), {
        message_reference: { channel_id: "channel", message_id: "101" },
      }),
    ),
  );

  expect(context?.messages).toEqual([]);
  expect(context?.replyTarget).toBeUndefined();
  expect(reader.fetchQueries).toEqual(["101", "101"]);
});

test("excludes an attachment exchange after the message re-fetch confirms deletion", async () => {
  const trigger = message("100", undefined, {
    attachments: [
      {
        id: "attachment",
        filename: "file.png",
        url: "https://cdn.discordapp.com/attachments/1/file.png",
        content_type: "image/png",
        size: 1,
      },
    ],
  });
  const page = message("101", undefined, {
    author: { id: "bot", username: "bot", bot: true },
    content: "",
  });
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
  repository.findByPage = mock((id: string) => (id === "101" ? replyRecord : null));
  repository.listPages = mock(() => [{ pageMsgId: "101", triggerMsgId: "100", seq: 0 }]);
  const reader = new FakeReader();
  reader.listResponses.push({ status: "ok", messages: [trigger] });
  reader.fetchResponses.push({ status: "found", message: page });
  const service = new ConversationWindowService(reader, repository, () => NOW);
  const context = await service.build(input(message("102", new Date(NOW).toISOString())));

  reader.fetchResponses.push({ status: "not-found" });
  const attachmentResult = await context?.toolContext.viewAttachment(
    "m1",
    1,
    "model",
    new AbortController().signal,
  );
  reader.listResponses.push({ status: "ok", messages: [page] });
  const readResult = JSON.parse(
    (await context?.toolContext.readEarlierMessages(1, new AbortController().signal)) as string,
  ) as { messages: unknown[] };

  expect(attachmentResult).toBe('{"error":"attachment_unavailable"}');
  expect(readResult.messages).toEqual([]);
});

test("keeps an exchange when its pinned attachment is gone but the message remains", async () => {
  const trigger = message("100", undefined, {
    attachments: [
      {
        id: "attachment",
        filename: "file.png",
        url: "https://cdn.discordapp.com/attachments/1/file.png",
        content_type: "image/png",
        size: 1,
      },
    ],
  });
  const page = message("101", undefined, {
    author: { id: "bot", username: "bot", bot: true },
    content: "",
  });
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
  repository.findByPage = mock((id: string) => (id === "101" ? replyRecord : null));
  repository.listPages = mock(() => [{ pageMsgId: "101", triggerMsgId: "100", seq: 0 }]);
  const reader = new FakeReader();
  reader.listResponses.push({ status: "ok", messages: [trigger] });
  reader.fetchResponses.push({ status: "found", message: page });
  const service = new ConversationWindowService(reader, repository, () => NOW);
  const context = await service.build(input(message("102", new Date(NOW).toISOString())));

  reader.fetchResponses.push({ status: "found", message: { ...trigger, attachments: [] } });
  const attachmentResult = await context?.toolContext.viewAttachment(
    "m1",
    1,
    "model",
    new AbortController().signal,
  );
  reader.listResponses.push({ status: "ok", messages: [page] });
  const readResult = JSON.parse(
    (await context?.toolContext.readEarlierMessages(1, new AbortController().signal)) as string,
  ) as { messages: unknown[] };

  expect(attachmentResult).toBe('{"error":"attachment_unavailable"}');
  expect(readResult.messages).toHaveLength(1);
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

test("the authorization step is covered by the window-fetch deadline", async () => {
  let releaseAuthorize: (() => void) | undefined;
  const reader: IDiscordMessageReader = {
    list: mock(async (): Promise<DiscordMessageListResult> => ({ status: "ok", messages: [] })),
    fetch: mock(async (): Promise<DiscordMessageFetchResult> => ({ status: "not-found" })),
  };
  const service = new ConversationWindowService(
    reader,
    records(),
    () => NOW,
    async () => true,
    5,
  );
  const slowAuthorize = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      releaseAuthorize = () => resolve(true);
    });
  const result = await service.build({
    ...input(message("1000", new Date(NOW).toISOString())),
    authorize: slowAuthorize,
  });

  expect(result).toBeNull();
  expect(reader.list).not.toHaveBeenCalled();
  releaseAuthorize?.();
  await Bun.sleep(20);
  const states = (service as unknown as { states: Map<string, unknown> }).states;
  expect(states.size).toBe(0);
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

test("a newer build wins when an older build for the same channel resolves after it", async () => {
  const listQueries: Array<Record<string, string | number>> = [];
  const fetchQueries: string[] = [];
  let releaseOld: (() => void) | undefined;
  const reader: IDiscordMessageReader = {
    list: mock(
      async (
        _channelId: string,
        query: { before?: string; after?: string; limit: number },
        budget: DiscordRestBudget,
      ): Promise<DiscordMessageListResult> => {
        if (!budget.consume()) return { status: "failed", messages: [] };
        listQueries.push(query);
        if (query.before === "199") {
          return new Promise((resolve) => {
            releaseOld = () =>
              resolve({
                status: "ok",
                messages: [message("100"), message("101"), message("102")],
              });
          });
        }
        return { status: "ok", messages: [message("900"), message("901")] };
      },
    ),
    fetch: mock(
      async (
        _channelId: string,
        id: string,
        budget: DiscordRestBudget,
      ): Promise<DiscordMessageFetchResult> => {
        if (!budget.consume())
          return { status: "failed", error: new Error("REST budget exhausted") };
        fetchQueries.push(id);
        return { status: "found", message: message(id) };
      },
    ),
  };
  const service = new ConversationWindowService(reader, records(), () => NOW);

  const older = service.build(input(message("199", new Date(NOW).toISOString())));
  while (!releaseOld) await Bun.sleep(0);
  const newer = await service.build(input(message("999", new Date(NOW).toISOString())));

  expect(newer?.windowStartMessageId).toBe("900");
  releaseOld?.();
  const olderResult = await older;
  expect(olderResult?.windowStartMessageId).toBe("100");

  const third = await service.build(input(message("1000", new Date(NOW).toISOString())));
  expect(third?.windowStartMessageId).toBe("900");
  expect(fetchQueries).toContain("900");
  expect(fetchQueries).not.toContain("100");
  expect(listQueries).toHaveLength(3);
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

  reader.listResponses.push({ status: "ok", messages: [] });
  await service.build(input(message("1003", new Date(now).toISOString(), { channel_id: "one" })));

  expect(reader.fetchQueries).toEqual([]);
  expect(reader.listQueries.at(-1)).toEqual({ before: "1003", limit: 100 });
});
