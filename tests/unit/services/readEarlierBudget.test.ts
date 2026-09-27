import { afterEach, describe, expect, mock, test } from "bun:test";
import type { IReplyRecordRepository, ReplyRecord } from "../../../src/db/repositories/replyRecord";
import { estimateToolResultTokens } from "../../../src/llm/contextBudget";
import {
  type BuildConversationWindowInput,
  ConversationWindowService,
  TOOL_REST_LIMIT,
} from "../../../src/services/conversationWindow";
import type {
  DiscordMessageFetchResult,
  DiscordMessageListResult,
  DiscordRestBudget,
  IDiscordMessageReader,
} from "../../../src/services/discordMessageReader";
import type { RawDiscordMessage } from "../../../src/utils/discordMessageNormalizer";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

function botPage(id: string, text: string, timestamp?: string): RawDiscordMessage {
  return message(id, timestamp, {
    author: { id: "bot", username: "bot", bot: true },
    content: "",
    components: [{ type: 17, components: [{ type: 10, content: text }] }],
  });
}

type ListHandler = (
  query: { before?: string; after?: string; limit: number },
  signal?: AbortSignal,
) => Promise<DiscordMessageListResult>;
type FetchHandler = (messageId: string, signal?: AbortSignal) => Promise<DiscordMessageFetchResult>;

/** The first list call builds the window; `toolList` answers every later one. */
class ScriptedReader implements IDiscordMessageReader {
  readonly toolListQueries: Array<{ before?: string; after?: string; limit: number }> = [];
  readonly fetchQueries: string[] = [];
  private listCalls = 0;

  constructor(
    private readonly toolList: ListHandler,
    private readonly fetchHandler: FetchHandler = async () => ({ status: "not-found" }),
  ) {}

  async list(
    _channelId: string,
    query: { before?: string; after?: string; limit: number },
    budget: DiscordRestBudget,
    signal?: AbortSignal,
  ): Promise<DiscordMessageListResult> {
    if (!budget.consume()) return { status: "failed", messages: [] };
    this.listCalls += 1;
    if (this.listCalls === 1) return { status: "ok", messages: [] };
    this.toolListQueries.push(query);
    return this.toolList(query, signal);
  }

  async fetch(
    _channelId: string,
    messageId: string,
    budget: DiscordRestBudget,
    signal?: AbortSignal,
  ): Promise<DiscordMessageFetchResult> {
    if (!budget.consume()) return { status: "failed", error: new Error("REST budget exhausted") };
    this.fetchQueries.push(messageId);
    return this.fetchHandler(messageId, signal);
  }
}

function records(overrides: Partial<IReplyRecordRepository> = {}): IReplyRecordRepository {
  return {
    createPending: () => true,
    appendPage: () => true,
    removePage: () => true,
    finalize: () => true,
    findByTrigger: () => null,
    findByPage: () => null,
    listPages: () => [],
    markPendingFailed: () => 0,
    deleteByGuild: () => 0,
    deleteByChannel: () => 0,
    deleteGuildsNotIn: () => 0,
    ...overrides,
  };
}

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

interface ReadResult {
  messages: Array<{ ref?: string; text?: string; kind?: string; truncated?: boolean }>;
  has_more: boolean;
  stop_reason: string | null;
}

async function read(
  context: Awaited<ReturnType<ConversationWindowService["build"]>>,
  count: number,
  budgetTokens?: number,
): Promise<ReadResult> {
  const raw = await context?.toolContext.readEarlierMessages(
    count,
    new AbortController().signal,
    budgetTokens,
  );
  return JSON.parse(raw as string) as ReadResult;
}

function hangUntilAborted<T>(signal: AbortSignal | undefined, value: T): Promise<T> {
  return new Promise((resolve) => {
    if (signal?.aborted) resolve(value);
    signal?.addEventListener("abort", () => resolve(value), { once: true });
  });
}

describe("read_earlier_messages without the 24-hour limit", () => {
  test("reads a human message, a bot reply, and a reply target older than 24 hours", async () => {
    const old = new Date(NOW - 3 * DAY_MS).toISOString();
    const replyRecord: ReplyRecord = {
      triggerMsgId: "940",
      channelId: "channel",
      guildId: "guild",
      status: "completed",
      pageCount: 1,
      finalizedAt: NOW - 3 * DAY_MS + 5_000,
      createdAt: NOW - 3 * DAY_MS,
    };
    const target = message("800", new Date(NOW - 30 * DAY_MS).toISOString());
    const reader = new ScriptedReader(
      async () => ({
        status: "ok",
        messages: [message("940", old), botPage("950", "old answer", old)],
      }),
      async (id) => (id === "800" ? { status: "found", message: target } : { status: "not-found" }),
    );
    const repository = records({
      findByTrigger: (id) => (id === "940" ? replyRecord : null),
      findByPage: (id) => (id === "950" ? replyRecord : null),
      listPages: () => [{ pageMsgId: "950", triggerMsgId: "940", seq: 0 }],
    });
    const service = new ConversationWindowService(reader, repository, () => NOW);
    const context = await service.build(
      input(
        message("1000", new Date(NOW).toISOString(), {
          message_reference: { channel_id: "channel", message_id: "800" },
        }),
      ),
    );

    expect(context?.replyTarget?.text).toBe("message-800");
    const result = await read(context, 5);
    expect(result.messages.map((entry) => [entry.kind, entry.text])).toEqual([
      ["user", "message-940"],
      ["assistant", "old answer"],
    ]);
  });
});

describe("read_earlier_messages paging under a deadline", () => {
  test("drops a page cut short by the deadline and resumes it without duplicates or gaps", async () => {
    const replyRecord: ReplyRecord = {
      triggerMsgId: "700",
      channelId: "channel",
      guildId: "guild",
      status: "completed",
      pageCount: 1,
      finalizedAt: NOW - 2_000,
      createdAt: NOW - 3_000,
    };
    const page = [
      ...Array.from({ length: 99 }, (_, index) => message(String(801 + index))),
      botPage("900", "answer"),
    ];
    let fetchAttempts = 0;
    const reader = new ScriptedReader(
      async (query) =>
        query.before === "1000" ? { status: "ok", messages: page } : { status: "ok", messages: [] },
      async (_id, signal) => {
        fetchAttempts += 1;
        if (fetchAttempts === 1) {
          return hangUntilAborted<DiscordMessageFetchResult>(signal, {
            status: "failed",
            error: new Error("aborted"),
          });
        }
        return { status: "found", message: message("700", new Date(NOW - 5_000).toISOString()) };
      },
    );
    const repository = records({
      findByPage: (id) => (id === "900" ? replyRecord : null),
      listPages: () => [{ pageMsgId: "900", triggerMsgId: "700", seq: 0 }],
    });
    const service = new ConversationWindowService(
      reader,
      repository,
      () => NOW,
      async () => true,
      5_000,
      30,
    );
    const context = await service.build(input(message("1000", new Date(NOW).toISOString())));

    const first = await read(context, 5);
    expect(first).toEqual({ messages: [], has_more: true, stop_reason: "fetch_deadline" });

    const second = await read(context, 5);
    const third = await read(context, 100);

    // The cursor did not move past the interrupted page, so it was fetched again from the same place.
    expect(reader.toolListQueries.slice(0, 2)).toEqual([
      { before: "1000", limit: 100 },
      { before: "1000", limit: 100 },
    ]);
    expect(second.stop_reason).toBeNull();
    expect(second.messages.map((entry) => entry.text)).toEqual([
      "message-896",
      "message-897",
      "message-898",
      "message-899",
      "answer",
    ]);
    const texts = [...second.messages, ...third.messages].map((entry) => entry.text);
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts).toHaveLength(100);
    expect(third.has_more).toBe(false);
    const refs = [...second.messages, ...third.messages].map((entry) => entry.ref);
    expect(new Set(refs).size).toBe(100);
  });

  test("returns fetch_deadline without history while authorization is still pending", async () => {
    const reader = new ScriptedReader(async () => ({ status: "ok", messages: [message("900")] }));
    let calls = 0;
    const service = new ConversationWindowService(
      reader,
      records(),
      () => NOW,
      async () => true,
      5_000,
      20,
    );
    const context = await service.build({
      ...input(message("1000", new Date(NOW).toISOString())),
      authorize: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve(true) : new Promise<boolean>(() => {});
      },
    });

    const result = await read(context, 5);

    expect(result).toEqual({ messages: [], has_more: true, stop_reason: "fetch_deadline" });
    expect(reader.toolListQueries).toHaveLength(0);
  });
});

describe("fetched messages shared across the response", () => {
  test("a reply page fetched while building the window is not fetched again by a tool call", async () => {
    const replyRecord: ReplyRecord = {
      triggerMsgId: "940",
      channelId: "channel",
      guildId: "guild",
      status: "completed",
      pageCount: 2,
      finalizedAt: NOW - 5_000,
      createdAt: NOW - 6_000,
    };
    const fetchQueries: string[] = [];
    const reader: IDiscordMessageReader = {
      list: async (_channelId, _query, budget) =>
        budget.consume()
          ? { status: "ok", messages: [message("940")] }
          : { status: "failed", messages: [] },
      fetch: async (_channelId, id, budget) => {
        if (!budget.consume()) return { status: "failed", error: new Error("budget") };
        fetchQueries.push(id);
        return id === "950"
          ? { status: "found", message: botPage("950", "first page") }
          : { status: "failed", error: new Error("5xx") };
      },
    };
    const repository = records({
      findByTrigger: (id) => (id === "940" ? replyRecord : null),
      listPages: () => [
        { pageMsgId: "950", triggerMsgId: "940", seq: 0 },
        { pageMsgId: "951", triggerMsgId: "940", seq: 1 },
      ],
    });
    const service = new ConversationWindowService(reader, repository, () => NOW);
    const context = await service.build(input(message("1000", new Date(NOW).toISOString())));
    await read(context, 5);

    // The window checks the reply first (950 found, 951 failed), then the tool checks it again.
    expect(fetchQueries).toEqual(["950", "951", "951"]);
  });
});

describe("read_earlier_messages budgets", () => {
  test("returns what it has when the tool REST budget runs out, then repeats the reason without REST", async () => {
    const reader = new ScriptedReader(async (query) => {
      const before = Number(query.before);
      return {
        status: "ok",
        messages: Array.from({ length: 100 }, (_, index) => {
          const id = String(before - 100 + index);
          return before === 1_000_000 && index === 99
            ? message(id)
            : message(id, undefined, {
                author: { id: "other-bot", username: "other-bot", bot: true },
              });
        }),
      };
    });
    const service = new ConversationWindowService(reader, records(), () => NOW);
    const context = await service.build(input(message("1000000", new Date(NOW).toISOString())));

    const first = await read(context, 5);
    const queriesAfterFirst = reader.toolListQueries.length;
    const second = await read(context, 5);

    expect(queriesAfterFirst).toBe(TOOL_REST_LIMIT);
    expect(first.stop_reason).toBe("rest_budget_exhausted");
    expect(first.messages.map((entry) => entry.text)).toEqual(["message-999999"]);
    expect(second).toEqual({ messages: [], has_more: true, stop_reason: "rest_budget_exhausted" });
    expect(reader.toolListQueries).toHaveLength(queriesAfterFirst);
  });

  test("reports result_budget_exhausted without REST and keeps reporting it", async () => {
    const reader = new ScriptedReader(async () => ({ status: "ok", messages: [message("900")] }));
    const service = new ConversationWindowService(reader, records(), () => NOW);
    const context = await service.build(input(message("1000", new Date(NOW).toISOString())));

    const first = await read(context, 5, 10);
    const second = await read(context, 5, 100_000);

    expect(first).toEqual({ messages: [], has_more: true, stop_reason: "result_budget_exhausted" });
    expect(second.stop_reason).toBe("result_budget_exhausted");
    expect(reader.toolListQueries).toHaveLength(0);
  });

  test("with room for the frame and little more, returns the newest message truncated", async () => {
    const reader = new ScriptedReader(async () => ({
      status: "ok",
      messages: [message("899"), message("900", undefined, { content: "z".repeat(400) })],
    }));
    const service = new ConversationWindowService(reader, records(), () => NOW);
    const context = await service.build(input(message("1000", new Date(NOW).toISOString())));
    const frame = estimateToolResultTokens(
      '{"messages":[],"has_more":true,"stop_reason":"result_budget_exhausted"}',
    );

    const result = await read(context, 5, frame + 64);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.truncated).toBe(true);
    const text = result.messages[0]?.text ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(400);
    expect("z".repeat(400).startsWith(text)).toBe(true);
    // The older message was not shown, so the next call returns it under the next ref.
    const next = await read(context, 5);
    expect(next.messages.map((entry) => [entry.ref, entry.text])).toEqual([["m2", "message-899"]]);
  });
});

describe("view_attachment budget", () => {
  test("does not load or mark an image the budget cannot hold", async () => {
    const withImage = message("900", undefined, {
      attachments: [
        {
          id: "attachment",
          filename: "a.png",
          url: "https://cdn.discordapp.com/attachments/1/a.png",
          content_type: "image/png",
          size: 3,
        },
      ],
    });
    const reader = new ScriptedReader(
      async () => ({ status: "ok", messages: [] }),
      async () => ({ status: "found", message: withImage }),
    );
    const firstList = mock(async () => ({ status: "ok" as const, messages: [withImage] }));
    reader.list = async (_channelId, _query, budget) => {
      if (!budget.consume()) return { status: "failed", messages: [] };
      return firstList();
    };
    const service = new ConversationWindowService(reader, records(), () => NOW);
    const context = await service.build(input(message("1000", new Date(NOW).toISOString())));
    globalThis.fetch = mock(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    ) as unknown as typeof fetch;

    const refused = await context?.toolContext.viewAttachment(
      "m1",
      1,
      "model",
      new AbortController().signal,
      100,
    );
    const loaded = await context?.toolContext.viewAttachment(
      "m1",
      1,
      "model",
      new AbortController().signal,
      100_000,
    );

    expect(refused).toBe('{"error":"result_budget_exhausted"}');
    expect(Array.isArray(loaded)).toBe(true);
  });
});
