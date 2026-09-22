import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ReplyRecordRepository } from "../../../src/db/repositories/replyRecord";
import { applyMigrations } from "../../../src/db/schema";

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
});
