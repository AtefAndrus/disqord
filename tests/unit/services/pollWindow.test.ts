import { describe, expect, mock, test } from "bun:test";
import type {
  IReplyRecordRepository,
  ReplyPage,
  ReplyRecord,
} from "../../../src/db/repositories/replyRecord";
import {
  type BuildConversationWindowInput,
  ConversationWindowService,
} from "../../../src/services/conversationWindow";
import {
  type DiscordMessageFetchResult,
  type DiscordMessageListResult,
  DiscordRestBudget,
  type IDiscordMessageReader,
} from "../../../src/services/discordMessageReader";
import { MessageEligibilityService } from "../../../src/services/messageEligibility";
import type {
  NormalizedMessage,
  RawDiscordMessage,
  RawDiscordPoll,
} from "../../../src/utils/discordMessageNormalizer";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");

const POLL: RawDiscordPoll = {
  question: { text: "賛成ですか？" },
  answers: [
    { answer_id: 1, poll_media: { text: "はい" } },
    { answer_id: 2, poll_media: { text: "いいえ" } },
  ],
  expiry: "2026-09-28T13:00:00.000Z",
  allow_multiselect: false,
  results: { is_finalized: false, answer_counts: [{ id: 2, count: 1 }] },
};

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function human(id: string, overrides: Partial<RawDiscordMessage> = {}): RawDiscordMessage {
  return {
    id,
    channel_id: "channel",
    guild_id: "guild",
    content: `message-${id}`,
    timestamp: at(-100_000 + Number(id)),
    author: { id: `user-${id}`, username: `user-${id}`, bot: false },
    components: [],
    attachments: [],
    ...overrides,
  };
}

function botPoll(id: string, replyTo: string | undefined, authorId = "bot"): RawDiscordMessage {
  return human(id, {
    content: "",
    author: { id: authorId, username: authorId, bot: true },
    poll: POLL,
    type: replyTo ? 19 : 0,
    message_reference: replyTo ? { channel_id: "channel", message_id: replyTo } : null,
  });
}

function notice(
  id: string,
  pollId: string,
  author: RawDiscordMessage["author"],
): RawDiscordMessage {
  return human(id, {
    content: "",
    author,
    type: 46,
    message_reference: { channel_id: "channel", message_id: pollId },
    embeds: [
      {
        type: "poll_result",
        fields: [
          { name: "poll_question_text", value: "賛成ですか？" },
          { name: "victor_answer_votes", value: "1" },
          { name: "total_votes", value: "1" },
          { name: "victor_answer_text", value: "いいえ" },
        ],
      },
    ],
  });
}

class MapReader implements IDiscordMessageReader {
  readonly fetched: string[] = [];
  constructor(
    private readonly listed: RawDiscordMessage[],
    private readonly stored: Map<string, DiscordMessageFetchResult> = new Map(),
  ) {}

  async list(
    _channelId: string,
    query: { before?: string; after?: string; limit: number },
    budget: DiscordRestBudget,
  ): Promise<DiscordMessageListResult> {
    if (!budget.consume()) return { status: "failed", messages: [] };
    const before = query.before;
    return {
      status: "ok",
      messages: this.listed.filter(
        (message) => before === undefined || BigInt(message.id) < BigInt(before),
      ),
    };
  }

  async fetch(
    _channelId: string,
    messageId: string,
    budget: DiscordRestBudget,
  ): Promise<DiscordMessageFetchResult> {
    if (!budget.consume()) return { status: "failed", error: new Error("REST budget exhausted") };
    this.fetched.push(messageId);
    return this.stored.get(messageId) ?? { status: "not-found" };
  }
}

interface StoredReply {
  record: ReplyRecord;
  pages: ReplyPage[];
}

function records(replies: StoredReply[] = []): IReplyRecordRepository {
  const byTrigger = (id: string): StoredReply | undefined =>
    replies.find((reply) => reply.record.triggerMsgId === id);
  const byPage = (id: string): StoredReply | undefined =>
    replies.find((reply) => reply.pages.some((page) => page.pageMsgId === id));
  return {
    createPending: mock(() => true),
    appendPage: mock(() => true),
    removePage: mock(() => true),
    finalize: mock(() => true),
    findByTrigger: mock((id: string) => byTrigger(id)?.record ?? null),
    findByPage: mock((id: string) => byPage(id)?.record ?? null),
    listPages: mock((id: string) => byTrigger(id)?.pages ?? []),
    markPendingFailed: mock(() => 0),
    deleteByGuild: mock(() => 0),
    deleteByChannel: mock(() => 0),
    deleteGuildsNotIn: mock(() => 0),
  };
}

function replyTo(triggerId: string, pageId: string): StoredReply {
  return {
    record: {
      triggerMsgId: triggerId,
      channelId: "channel",
      guildId: "guild",
      status: "completed",
      pageCount: 1,
      finalizedAt: NOW - 50_000,
      createdAt: NOW - 60_000,
    },
    pages: [{ pageMsgId: pageId, triggerMsgId: triggerId, seq: 0 }],
  };
}

function current(overrides: Partial<RawDiscordMessage> = {}): RawDiscordMessage {
  return human("1000", { timestamp: at(0), ...overrides });
}

function input(message: RawDiscordMessage): BuildConversationWindowInput {
  return {
    current: message,
    guildId: "guild",
    userId: "user-1000",
    botUserId: "bot",
    botUser: {},
    channel: {},
    historyEnabled: true,
    authorize: async () => true,
  };
}

async function windowOf(
  listed: RawDiscordMessage[],
  stored: RawDiscordMessage[] = [],
  replies: StoredReply[] = [],
  currentMessage = current(),
): Promise<{ messages: NormalizedMessage[]; replyTarget?: NormalizedMessage }> {
  const reader = new MapReader(
    listed,
    new Map(stored.map((message) => [message.id, { status: "found", message }])),
  );
  const service = new ConversationWindowService(reader, records(replies), () => NOW);
  const context = await service.build(input(currentMessage));
  if (!context) throw new Error("window was not built");
  return { messages: context.messages, replyTarget: context.replyTarget };
}

describe("bot polls in the window", () => {
  test("places a bot poll as the assistant's message after the message it answered", async () => {
    const { messages } = await windowOf([human("900"), botPoll("910", "900")]);
    expect(messages.map((message) => [message.id, message.kind, message.exchangeId])).toEqual([
      ["900", "user", "900"],
      ["910", "assistant", "900"],
    ]);
    expect(messages[1]?.poll).toContain('[投票 "賛成ですか？"');
    expect(messages[1]?.poll).toContain("- いいえ: 1 票");
  });

  test("fetches the answered message when it is older than the window", async () => {
    const reader = new MapReader(
      [botPoll("910", "500")],
      new Map([["500", { status: "found", message: human("500") }]]),
    );
    const service = new ConversationWindowService(reader, records(), () => NOW);
    const context = await service.build(input(current()));
    expect(context?.messages.map((message) => message.id)).toEqual(["910"]);
    expect(reader.fetched).toContain("500");
  });

  test("leaves out a bot poll whose answered message was deleted", async () => {
    const { messages } = await windowOf([botPoll("910", "500")]);
    expect(messages).toEqual([]);
  });

  test("leaves out a bot poll whose answered message lost its reply page outside the bot", async () => {
    const { messages } = await windowOf(
      [botPoll("910", "500")],
      [human("500")],
      [replyTo("500", "510")],
    );
    expect(messages).toEqual([]);
  });

  test("leaves out a poll by another bot and a bot poll that answers nothing", async () => {
    const { messages } = await windowOf([
      human("900"),
      botPoll("910", "900", "other-bot"),
      botPoll("920", undefined),
    ]);
    expect(messages.map((message) => message.id)).toEqual(["900"]);
  });

  test("uses a bot poll as the reply target", async () => {
    const { replyTarget } = await windowOf(
      [],
      [botPoll("910", "900"), human("900")],
      [],
      current({ type: 19, message_reference: { channel_id: "channel", message_id: "910" } }),
    );
    expect(replyTarget?.id).toBe("910");
    expect(replyTarget?.kind).toBe("assistant");
    expect(replyTarget?.poll).toContain("賛成ですか？");
  });
});

describe("poll-closed notices in the window", () => {
  const noticeText = '[投票の締め切り "賛成ですか？": 「いいえ」が 1 票で最多（総票数 1）]';

  test("places a notice for a person's poll as that person's message", async () => {
    const poll = human("900", { content: "", poll: POLL });
    const { messages } = await windowOf([
      poll,
      notice("950", "900", { id: "user-900", username: "alice" }),
    ]);
    expect(messages.map((message) => [message.id, message.kind, message.exchangeId])).toEqual([
      ["900", "user", "900"],
      ["950", "user", "900"],
    ]);
    expect(messages[1]?.text).toBe(noticeText);
  });

  test("places a notice for the bot's poll as the assistant's, tied to the answered message", async () => {
    const { messages } = await windowOf([
      human("900"),
      botPoll("910", "900"),
      notice("950", "910", { id: "bot", username: "bot", bot: true }),
    ]);
    expect(messages.map((message) => [message.id, message.kind, message.exchangeId])).toEqual([
      ["900", "user", "900"],
      ["910", "assistant", "900"],
      ["950", "assistant", "900"],
    ]);
  });

  test("fetches a poll older than the window to judge its notice", async () => {
    const { messages } = await windowOf(
      [notice("950", "500", { id: "user-500", username: "alice" })],
      [human("500", { content: "", poll: POLL })],
    );
    expect(messages.map((message) => message.id)).toEqual(["950"]);
  });

  test("leaves out a notice of another bot's poll", async () => {
    const other = { id: "other-bot", username: "other-bot", bot: true };
    const { messages } = await windowOf([
      human("900"),
      botPoll("910", "900", "other-bot"),
      notice("950", "910", other),
    ]);
    expect(messages.map((message) => message.id)).toEqual(["900"]);
  });

  test("leaves out a notice without its result embed", async () => {
    const poll = human("900", { content: "", poll: POLL });
    const bare = { ...notice("950", "900", { id: "user-900", username: "alice" }), embeds: [] };
    const { messages } = await windowOf([poll, bare]);
    expect(messages.map((message) => message.id)).toEqual(["900"]);
  });

  test("leaves out a notice whose poll was deleted", async () => {
    const { messages } = await windowOf([notice("950", "500", { id: "user-500", username: "a" })]);
    expect(messages).toEqual([]);
  });

  test("leaves out a notice whose bot poll lost the message it answered", async () => {
    const { messages } = await windowOf([
      botPoll("910", "500"),
      notice("950", "910", { id: "bot", username: "bot", bot: true }),
    ]);
    expect(messages).toEqual([]);
  });
});

test("read_earlier_messages cuts a poll that alone exceeds the result budget", async () => {
  const longPoll: RawDiscordPoll = {
    ...POLL,
    question: { text: "質".repeat(300) },
    answers: Array.from({ length: 10 }, (_, index) => ({
      answer_id: index + 1,
      poll_media: { text: `${index}`.repeat(55) },
    })),
  };
  // Older than the shrunk window's age limit, so only the tool reaches it.
  const old = human("900", { content: "", poll: longPoll, timestamp: at(-2 * 3_600_000) });
  const reader = new MapReader([old]);
  const service = new ConversationWindowService(reader, records(), () => NOW);
  const context = await service.build(input(current()));
  expect(context?.messages).toEqual([]);
  const result = JSON.parse(
    (await context?.toolContext.readEarlierMessages(
      1,
      new AbortController().signal,
      300,
    )) as string,
  ) as { messages: Array<{ text: string; poll?: string; truncated: boolean }> };
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]?.truncated).toBe(true);
  expect(result.messages[0]?.poll).toBeUndefined();
  expect(result.messages[0]?.text.startsWith(`[投票 "${"質".repeat(10)}`)).toBe(true);
});

describe("poll eligibility when a check cannot finish", () => {
  const evaluationInput = { currentTimestampMs: NOW, botUserId: "bot", channelId: "channel" };

  test("leaves out a notice whose poll cannot be fetched within the REST limit", async () => {
    const service = new MessageEligibilityService(
      new MapReader(
        [],
        new Map([["500", { status: "found", message: human("500", { poll: POLL }) }]]),
      ),
      records(),
    );
    const result = await service.evaluate(
      notice("950", "500", { id: "user-500", username: "alice" }),
      evaluationInput,
      new DiscordRestBudget(0),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("unconfirmable");
  });

  test("leaves out a bot poll whose answered message's reply page cannot be confirmed", async () => {
    const reader: IDiscordMessageReader = {
      list: mock(async (): Promise<DiscordMessageListResult> => ({ status: "ok", messages: [] })),
      fetch: mock(
        async (_channelId: string, id: string): Promise<DiscordMessageFetchResult> =>
          id === "500"
            ? { status: "found", message: human("500") }
            : { status: "failed", error: new Error("network") },
      ),
    };
    const service = new MessageEligibilityService(reader, records([replyTo("500", "510")]));
    const result = await service.evaluate(
      botPoll("910", "500"),
      evaluationInput,
      new DiscordRestBudget(),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("unconfirmable");
  });
});
