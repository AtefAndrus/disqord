import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ReplyRecordRepository } from "../../../src/db/repositories/replyRecord";
import { applyMigrations } from "../../../src/db/schema";
import type {
  DiscordMessageFetchResult,
  DiscordMessageListResult,
  IDiscordMessageReader,
} from "../../../src/services/discordMessageReader";
import { DiscordRestBudget } from "../../../src/services/discordMessageReader";
import { MessageEligibilityService } from "../../../src/services/messageEligibility";
import type { RawDiscordMessage } from "../../../src/utils/discordMessageNormalizer";

describe("ReplyRecordRepository", () => {
  let database: Database;
  let repository: ReplyRecordRepository;

  beforeEach(() => {
    database = new Database(":memory:");
    database.run("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    repository = new ReplyRecordRepository(database);
  });

  afterEach(() => {
    database.close();
  });

  test("records pages in sequence and finalizes with the surviving page count", () => {
    expect(
      repository.createPending({
        triggerMsgId: "trigger",
        channelId: "channel",
        guildId: "guild",
        createdAt: 100,
      }),
    ).toBe(true);
    expect(repository.appendPage("trigger", "page-1")).toBe(true);
    expect(repository.appendPage("trigger", "page-2")).toBe(true);
    expect(repository.removePage("page-1")).toBe(true);
    expect(repository.finalize("trigger", "completed", 1, 200)).toBe(true);

    expect(repository.listPages("trigger")).toEqual([
      { pageMsgId: "page-2", triggerMsgId: "trigger", seq: 1 },
    ]);
    expect(repository.findByTrigger("trigger")).toMatchObject({
      status: "completed",
      pageCount: 1,
      finalizedAt: 200,
    });
    expect(repository.appendPage("trigger", "late-page")).toBe(false);
    expect(repository.listPages("trigger")).toHaveLength(1);
  });

  test("marks pending records failed and removes records older than 24 hours", () => {
    repository.createPending({
      triggerMsgId: "pending",
      channelId: "channel",
      guildId: "guild",
      createdAt: 1,
    });
    repository.createPending({
      triggerMsgId: "fresh",
      channelId: "channel",
      guildId: "guild",
      createdAt: 172_799_901,
    });
    repository.createPending({
      triggerMsgId: "completed-old",
      channelId: "channel",
      guildId: "guild",
      createdAt: 172_799_999,
    });
    expect(repository.appendPage("completed-old", "page-old")).toBe(true);
    expect(repository.finalize("completed-old", "completed", 1, 1)).toBe(true);

    expect(repository.markPendingFailed()).toBe(2);
    expect(repository.findByTrigger("pending")?.status).toBe("failed");
    expect(repository.findByTrigger("pending")?.finalizedAt).toBeNull();

    expect(repository.deleteExpired(172_800_000)).toBe(2);
    expect(repository.findByTrigger("pending")).toBeNull();
    expect(repository.findByTrigger("completed-old")).toBeNull();
    expect(repository.findByTrigger("fresh")).not.toBeNull();
  });

  test("resolves a registered bot page through real SQLite eligibility", async () => {
    const currentTimestampMs = 1_000_000;
    const trigger: RawDiscordMessage = {
      id: "trigger",
      channel_id: "channel",
      guild_id: "guild",
      content: "question",
      timestamp: new Date(currentTimestampMs - 2_000).toISOString(),
      author: { id: "user", username: "user", bot: false },
      components: [],
      attachments: [],
    };
    const page: RawDiscordMessage = {
      id: "page",
      channel_id: "channel",
      guild_id: "guild",
      content: "answer",
      timestamp: new Date(currentTimestampMs - 1_000).toISOString(),
      author: { id: "bot", username: "bot", bot: true },
      components: [],
      attachments: [],
    };
    repository.createPending({
      triggerMsgId: trigger.id,
      channelId: trigger.channel_id,
      guildId: trigger.guild_id ?? "guild",
      createdAt: currentTimestampMs - 2_000,
    });
    repository.appendPage(trigger.id, page.id);
    repository.finalize(trigger.id, "completed", 1, currentTimestampMs - 500);

    const reader: IDiscordMessageReader = {
      list: async (): Promise<DiscordMessageListResult> => ({ status: "ok", messages: [] }),
      fetch: async (
        _channelId: string,
        messageId: string,
        _budget: DiscordRestBudget,
      ): Promise<DiscordMessageFetchResult> =>
        messageId === trigger.id
          ? { status: "found", message: trigger }
          : { status: "found", message: page },
    };
    const service = new MessageEligibilityService(reader, repository);
    const result = await service.evaluate(
      page,
      {
        currentTimestampMs,
        botUserId: "bot",
        channelId: "channel",
      },
      new DiscordRestBudget(),
      new Map([
        [trigger.id, trigger],
        [page.id, page],
      ]),
    );

    expect(result.eligible).toBe(true);
    expect(result.reply?.record.triggerMsgId).toBe(trigger.id);
    expect(result.reply?.pages).toHaveLength(1);
  });
});
