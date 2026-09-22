import { describe, expect, mock, test } from "bun:test";
import type {
  IReplyRecordRepository,
  ReplyPage,
  ReplyRecord,
} from "../../../src/db/repositories/replyRecord";
import type {
  DiscordMessageFetchResult,
  DiscordMessageListResult,
  IDiscordMessageReader,
} from "../../../src/services/discordMessageReader";
import { DiscordRestBudget } from "../../../src/services/discordMessageReader";
import {
  type MessageEligibilityCache,
  MessageEligibilityService,
} from "../../../src/services/messageEligibility";
import type { RawDiscordMessage } from "../../../src/utils/discordMessageNormalizer";

const currentTimestampMs = Date.parse("2026-09-22T12:00:00.000Z");

function human(id: string): RawDiscordMessage {
  return {
    id,
    channel_id: "channel",
    guild_id: "guild",
    content: id,
    timestamp: new Date(currentTimestampMs - 1_000).toISOString(),
    author: { id: `user-${id}`, username: `user-${id}`, bot: false },
    components: [],
    attachments: [],
  };
}

function botPage(id: string): RawDiscordMessage {
  return {
    ...human(id),
    content: "",
    author: { id: "bot", username: "bot", bot: true },
  };
}

function record(status: ReplyRecord["status"] = "completed"): ReplyRecord {
  return {
    triggerMsgId: "trigger",
    channelId: "channel",
    guildId: "guild",
    status,
    pageCount: 1,
    finalizedAt: currentTimestampMs - 1_000,
    createdAt: currentTimestampMs - 2_000,
  };
}

function setup(
  triggerRecord: ReplyRecord | null,
  pages: ReplyPage[],
  fetch: (id: string) => Promise<DiscordMessageFetchResult>,
): { service: MessageEligibilityService; budget: DiscordRestBudget } {
  const records: IReplyRecordRepository = {
    createPending: mock(() => true),
    appendPage: mock(() => true),
    removePage: mock(() => true),
    finalize: mock(() => true),
    findByTrigger: mock((id: string) => (id === "trigger" ? triggerRecord : null)),
    findByPage: mock((id: string) =>
      pages.some((page) => page.pageMsgId === id) ? triggerRecord : null,
    ),
    listPages: mock(() => pages),
    markPendingFailed: mock(() => 0),
    deleteExpired: mock(() => 0),
  };
  const reader: IDiscordMessageReader = {
    list: mock(async (): Promise<DiscordMessageListResult> => ({ status: "ok", messages: [] })),
    fetch: mock(async (_channelId: string, id: string) => fetch(id)),
  };
  return {
    service: new MessageEligibilityService(reader, records),
    budget: new DiscordRestBudget(),
  };
}

describe("MessageEligibilityService", () => {
  test("excludes a bot reply when its trigger message returns 404", async () => {
    const page = botPage("page");
    const { service, budget } = setup(
      record(),
      [{ pageMsgId: "page", triggerMsgId: "trigger", seq: 0 }],
      async (id) =>
        id === "trigger" ? { status: "not-found" } : { status: "found", message: page },
    );

    const result = await service.evaluate(
      page,
      {
        currentTimestampMs,
        botUserId: "bot",
        channelId: "channel",
      },
      budget,
      new Map([["page", page]]),
    );

    expect(result.eligible).toBe(false);
    expect(result.externallyDeleted).toBe(true);
    expect(result.reason).toBe("externally-deleted");
  });

  test("excludes a reply when any registered page returns 404", async () => {
    const trigger = human("trigger");
    const { service, budget } = setup(
      record(),
      [{ pageMsgId: "page", triggerMsgId: "trigger", seq: 0 }],
      async () => ({
        status: "not-found",
      }),
    );

    const result = await service.evaluate(
      trigger,
      { currentTimestampMs, botUserId: "bot", channelId: "channel" },
      budget,
      new Map([["trigger", trigger]]),
    );

    expect(result.eligible).toBe(false);
    expect(result.externallyDeleted).toBe(true);
  });

  test("applies external-deletion checks to tester-bot triggers", async () => {
    const trigger = {
      ...human("trigger"),
      author: { id: "tester", username: "tester", bot: true },
    };
    const { service, budget } = setup(
      record(),
      [{ pageMsgId: "page", triggerMsgId: "trigger", seq: 0 }],
      async (id) =>
        id === "page" ? { status: "not-found" } : { status: "found", message: trigger },
    );

    const result = await service.evaluate(
      trigger,
      {
        currentTimestampMs,
        botUserId: "bot",
        e2eTesterBotId: "tester",
        nodeEnv: "development",
        channelId: "channel",
      },
      budget,
      new Map([["trigger", trigger]]),
    );

    expect(result.eligible).toBe(false);
    expect(result.isHuman).toBe(true);
    expect(result.externallyDeleted).toBe(true);
    expect(result.reason).toBe("externally-deleted");
  });

  test("keeps the trigger eligible when the reply record is pending", async () => {
    const trigger = human("trigger");
    const { service, budget } = setup(record("pending"), [], async () => ({ status: "not-found" }));

    const result = await service.evaluate(
      trigger,
      { currentTimestampMs, botUserId: "bot", channelId: "channel" },
      budget,
      new Map([["trigger", trigger]]),
    );

    expect(result.eligible).toBe(true);
    expect(result.isHuman).toBe(true);
    expect(result.reason).toBe("pending");
  });

  test("excludes the trigger when a pending record's recorded page was externally deleted", async () => {
    const trigger = human("trigger");
    const { service, budget } = setup(
      record("pending"),
      [{ pageMsgId: "page", triggerMsgId: "trigger", seq: 0 }],
      async (id) =>
        id === "trigger" ? { status: "found", message: trigger } : { status: "not-found" },
    );

    const result = await service.evaluate(
      trigger,
      { currentTimestampMs, botUserId: "bot", channelId: "channel" },
      budget,
      new Map([["trigger", trigger]]),
    );

    expect(result.eligible).toBe(false);
    expect(result.externallyDeleted).toBe(true);
    expect(result.reason).toBe("externally-deleted");
  });

  test("excludes the trigger when a failed record's recorded page was externally deleted", async () => {
    const trigger = human("trigger");
    const { service, budget } = setup(
      record("failed"),
      [{ pageMsgId: "page", triggerMsgId: "trigger", seq: 0 }],
      async (id) =>
        id === "trigger" ? { status: "found", message: trigger } : { status: "not-found" },
    );

    const result = await service.evaluate(
      trigger,
      { currentTimestampMs, botUserId: "bot", channelId: "channel" },
      budget,
      new Map([["trigger", trigger]]),
    );

    expect(result.eligible).toBe(false);
    expect(result.externallyDeleted).toBe(true);
    expect(result.reason).toBe("externally-deleted");
  });

  test("caches the external-deletion check per response instead of refetching for each entry", async () => {
    const trigger = human("trigger");
    const page = botPage("page");
    let fetchCalls = 0;
    const { service, budget } = setup(
      record("completed"),
      [{ pageMsgId: "page", triggerMsgId: "trigger", seq: 0 }],
      async (id) => {
        fetchCalls += 1;
        return id === "trigger" ? { status: "found", message: trigger } : { status: "not-found" };
      },
    );
    const cache: MessageEligibilityCache = new Map();

    await service.evaluate(
      trigger,
      { currentTimestampMs, botUserId: "bot", channelId: "channel" },
      budget,
      new Map([["trigger", trigger]]),
      cache,
    );
    await service.evaluate(
      page,
      { currentTimestampMs, botUserId: "bot", channelId: "channel" },
      budget,
      new Map([["trigger", trigger]]),
      cache,
    );

    expect(fetchCalls).toBe(1);
  });
});
