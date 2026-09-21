import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createRawEventHandler } from "../../../../src/bot/events/raw";
import {
  ConversationRepository,
  type CreateConversationTurnInput,
  DeletedBeforeSaveRecord,
} from "../../../../src/db/repositories/conversation";
import { GuildSettingsRepository } from "../../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../../src/db/schema";

describe("raw conversation deletion events", () => {
  let db: Database;
  let repository: ConversationRepository;
  let deletedBeforeSave: DeletedBeforeSaveRecord;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    applyMigrations(db);
    const settings = new GuildSettingsRepository(db, "test-model");
    await settings.setHistoryEnabled("guild-1", true);
    deletedBeforeSave = new DeletedBeforeSaveRecord();
    repository = new ConversationRepository(db, deletedBeforeSave);
  });

  afterEach(() => db.close());

  function input(
    messageId: string,
    channelId: string,
    guildId = "guild-1",
    parentChannelId: string | null = null,
  ): CreateConversationTurnInput {
    const now = Date.now();
    return {
      guildId,
      channelId,
      parentChannelId,
      discordMessageId: messageId,
      authorId: "user-1",
      authorLabel: "User",
      content: [{ type: "text", text: messageId }],
      replyToDiscordMessageId: null,
      discordCreatedAt: now,
      handlingStartedAt: now,
    };
  }

  async function exchange(
    messageId: string,
    channelId: string,
    guildId = "guild-1",
    parentChannelId: string | null = null,
  ): Promise<void> {
    const created = await repository.createUserAndAssistantTurn(
      input(messageId, channelId, guildId, parentChannelId),
    );
    if (created.assistantTurnId === undefined) throw new Error("exchange was not created");
    await repository.onBotMessageSent(created.assistantTurnId, `bot-${messageId}`, Date.now());
    await repository.finalizeAssistantTurn(created.assistantTurnId, "completed", "reply");
  }

  function turnCount(): number {
    return db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM turns").get()?.count ?? 0;
  }

  test("MESSAGE_DELETE purges the mapped exchange and remembers the message id", async () => {
    await exchange("user-delete", "channel-1");
    const handle = createRawEventHandler(repository, deletedBeforeSave);

    await handle({ t: "MESSAGE_DELETE", d: { id: "user-delete" } });

    expect(turnCount()).toBe(0);
    expect(deletedBeforeSave.hasMessage("user-delete")).toBe(true);
  });

  test("purge failures are logged and do not reject the raw handler", async () => {
    repository.purgeMessage = async () => {
      throw new Error("message content must not be logged");
    };
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const handle = createRawEventHandler(repository, deletedBeforeSave);

    await expect(handle({ t: "MESSAGE_DELETE", d: { id: "deleted-message" } })).resolves.toBe(
      undefined,
    );

    expect(errorSpy).toHaveBeenCalledWith("Failed to handle raw Discord event", "Error");
    expect(errorSpy.mock.calls.flat()).not.toContain("message content must not be logged");
    expect(deletedBeforeSave.hasMessage("deleted-message")).toBe(true);
    errorSpy.mockRestore();
  });

  test("MESSAGE_DELETE_BULK purges all mapped exchanges and remembers every id", async () => {
    await exchange("bulk-a", "channel-1");
    await exchange("bulk-b", "channel-1");
    const handle = createRawEventHandler(repository, deletedBeforeSave);

    await handle({ t: "MESSAGE_DELETE_BULK", d: { ids: ["bulk-a", "bulk-b"] } });

    expect(turnCount()).toBe(0);
    expect(deletedBeforeSave.hasMessage("bulk-a")).toBe(true);
    expect(deletedBeforeSave.hasMessage("bulk-b")).toBe(true);
  });

  test("CHANNEL_DELETE purges the channel and child-thread sessions", async () => {
    await exchange("parent-message", "parent-channel");
    await exchange("thread-message", "thread-channel", "guild-1", "parent-channel");
    await exchange("other-message", "other-channel");
    const handle = createRawEventHandler(repository, deletedBeforeSave);

    await handle({ t: "CHANNEL_DELETE", d: { id: "parent-channel" } });

    expect(turnCount()).toBe(2);
    expect(deletedBeforeSave.hasScope("parent-channel", null, "guild-1")).toBe(true);
  });

  test("THREAD_DELETE purges an uncached thread without purging its parent", async () => {
    await exchange("parent-message", "parent-channel");
    await exchange("thread-message", "thread-channel", "guild-1", "parent-channel");
    const handle = createRawEventHandler(repository, deletedBeforeSave);

    await handle({ t: "THREAD_DELETE", d: { id: "thread-channel" } });

    expect(turnCount()).toBe(2);
    expect(db.query("SELECT channel_id FROM sessions ORDER BY channel_id").all()).toEqual([
      { channel_id: "parent-channel" },
    ]);
    expect(deletedBeforeSave.hasScope("thread-channel", null, "guild-1")).toBe(true);
  });

  test("GUILD_DELETE with unavailable true keeps history, while a real leave purges it", async () => {
    await exchange("guild-message", "channel-1");
    const handle = createRawEventHandler(repository, deletedBeforeSave);

    await handle({ t: "GUILD_DELETE", d: { id: "guild-1", unavailable: true } });
    expect(turnCount()).toBe(2);
    expect(deletedBeforeSave.hasScope("channel-1", null, "guild-1")).toBe(false);

    await handle({ t: "GUILD_DELETE", d: { id: "guild-1" } });
    expect(turnCount()).toBe(0);
    expect(deletedBeforeSave.hasScope("channel-1", null, "guild-1")).toBe(true);
  });
});
