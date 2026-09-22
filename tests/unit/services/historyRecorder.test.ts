import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  ConversationRepository,
  type CreateConversationTurnInput,
  DeletedBeforeSaveRecord,
} from "../../../src/db/repositories/conversation";
import { GuildSettingsRepository } from "../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../src/db/schema";
import {
  createHistorySweepRunner,
  HISTORY_SWEEP_RETRY_DELAY_MS,
  HistoryRecorder,
  type IHistoryRecorder,
} from "../../../src/services/historyRecorder";

describe("HistoryRecorder", () => {
  let db: Database;
  let repository: ConversationRepository;
  let recorder: HistoryRecorder;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    applyMigrations(db);
    const settings = new GuildSettingsRepository(db, "test-model");
    await settings.setHistoryEnabled("guild-1", true);
    repository = new ConversationRepository(db, new DeletedBeforeSaveRecord());
    recorder = new HistoryRecorder(repository);
  });

  afterEach(() => db.close());

  function input(
    messageId: string,
    createdAt: number,
    channelId = "channel-1",
  ): CreateConversationTurnInput {
    return {
      guildId: "guild-1",
      channelId,
      parentChannelId: null,
      discordMessageId: messageId,
      authorId: "user-1",
      authorLabel: "User",
      content: [{ type: "text", text: messageId }],
      replyToDiscordMessageId: null,
      discordCreatedAt: createdAt,
      handlingStartedAt: createdAt,
    };
  }

  async function createExchange(
    messageId: string,
    createdAt: number,
    channelId = "channel-1",
  ): Promise<number> {
    const result = await repository.createUserAndAssistantTurn(
      input(messageId, createdAt, channelId),
    );
    if (result.userTurnId === undefined) throw new Error("user turn was not created");
    return result.userTurnId;
  }

  test("failed message purge is retried before context construction", async () => {
    const now = Date.now();
    await createExchange("old-user", now);
    const currentUserTurnId = await createExchange("current-user", now + 1);
    const originalPurgeMessage = repository.purgeMessage.bind(repository);
    let shouldFail = true;
    repository.purgeMessage = async (messageId: string): Promise<boolean> => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("deleted content must not be logged");
      }
      return originalPurgeMessage(messageId);
    };
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    expect(await recorder.purgeMessage("old-user", { channelId: "channel-1" })).toBe(false);
    const context = await recorder.getContext(currentUserTurnId);

    expect(context?.exchanges).toEqual([]);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM turns").get()?.count,
    ).toBe(2);
    expect(errorSpy.mock.calls.flat()).not.toContain("deleted content must not be logged");
    errorSpy.mockRestore();
  });

  test("a pending purge excludes deleted history when its retry still fails", async () => {
    const now = Date.now();
    const oldUserTurnId = await createExchange("old-user", now);
    const currentUserTurnId = await createExchange("current-user", now + 1);
    repository.purgeMessage = async (): Promise<boolean> => {
      throw new Error("purge content must not be logged");
    };
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    expect(await recorder.purgeMessage("old-user")).toBe(false);
    const context = await recorder.getContext(currentUserTurnId);

    expect(oldUserTurnId).not.toBe(currentUserTurnId);
    expect(context?.exchanges).toEqual([]);
    expect(errorSpy.mock.calls.flat()).not.toContain("purge content must not be logged");
    errorSpy.mockRestore();
  });

  test("a failed channel purge excludes the affected channel scope", async () => {
    const now = Date.now();
    const affectedUserTurnId = await createExchange("affected-user", now, "affected-channel");
    const otherUserTurnId = await createExchange("other-user", now + 1, "other-channel");
    repository.purgeChannel = async (): Promise<boolean> => {
      throw new Error("channel purge content must not be logged");
    };
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    expect(await recorder.purgeChannel("affected-channel")).toBe(false);
    expect(await recorder.getContext(affectedUserTurnId)).toBeNull();
    expect(await recorder.getContext(otherUserTurnId)).not.toBeNull();
    expect(errorSpy.mock.calls.flat()).not.toContain("channel purge content must not be logged");
    errorSpy.mockRestore();
  });

  test("mapping failure purges the exchange and fails closed when that purge fails", async () => {
    const userTurnId = await createExchange("user-message", Date.now());
    const assistantTurnId = db
      .query<{ id: number }, [number]>(
        "SELECT id FROM turns WHERE parent_user_turn_id = ? AND role = 'assistant'",
      )
      .get(userTurnId)?.id;
    if (assistantTurnId === undefined) throw new Error("assistant turn was not created");
    repository.onBotMessageSent = async (): Promise<boolean> => {
      throw new Error("mapping content must not be logged");
    };
    repository.purgeAssistantExchange = async (): Promise<boolean> => {
      throw new Error("purge content must not be logged");
    };
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    expect(
      await recorder.onBotMessageSent(assistantTurnId, "bot-message", Date.now(), {
        channelId: "channel-1",
        guildId: "guild-1",
      }),
    ).toBe(false);
    await repository.finalizeAssistantTurn(assistantTurnId, "failed", "partial");
    expect(await recorder.getContext(userTurnId)).toBeNull();
    expect(errorSpy.mock.calls.flat()).not.toContain("mapping content must not be logged");
    expect(errorSpy.mock.calls.flat()).not.toContain("purge content must not be logged");
    errorSpy.mockRestore();
  });

  test("mapping failure purges the whole exchange when the purge itself succeeds", async () => {
    const userTurnId = await createExchange("user-message", Date.now());
    const assistantTurnId = db
      .query<{ id: number }, [number]>(
        "SELECT id FROM turns WHERE parent_user_turn_id = ? AND role = 'assistant'",
      )
      .get(userTurnId)?.id;
    if (assistantTurnId === undefined) throw new Error("assistant turn was not created");
    repository.onBotMessageSent = async (): Promise<boolean> => {
      throw new Error("mapping failed");
    };
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    expect(await recorder.onBotMessageSent(assistantTurnId, "bot-message", Date.now())).toBe(false);

    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM turns").get()?.count,
    ).toBe(0);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM turn_messages").get()?.count,
    ).toBe(0);
    errorSpy.mockRestore();
  });

  test("an internal delete keeps the mapping a pending purge still needs", async () => {
    const now = Date.now();
    const oldUserTurnId = await createExchange("old-user", now);
    const oldAssistantTurnId = db
      .query<{ id: number }, [number]>(
        "SELECT id FROM turns WHERE parent_user_turn_id = ? AND role = 'assistant'",
      )
      .get(oldUserTurnId)?.id;
    if (oldAssistantTurnId === undefined) throw new Error("assistant turn was not created");
    expect(await repository.onBotMessageSent(oldAssistantTurnId, "old-bot", now)).toBe(true);
    const originalPurgeMessage = repository.purgeMessage.bind(repository);
    let shouldFail = true;
    repository.purgeMessage = async (messageId: string): Promise<boolean> => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("purge failed once");
      }
      return originalPurgeMessage(messageId);
    };
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    // The user deletes the bot message, the purge fails, then the bot's own
    // cleanup tries to drop the same mapping before the purge is retried.
    expect(await recorder.purgeMessage("old-bot", { channelId: "channel-1" })).toBe(false);
    expect(await recorder.deleteMessageMapping("old-bot")).toBe(false);
    const currentUserTurnId = await createExchange("current-user", now + 1);
    const context = await recorder.getContext(currentUserTurnId);

    expect(context?.exchanges).toEqual([]);
    expect(
      db
        .query<{ count: number }, [number]>("SELECT COUNT(*) as count FROM turns WHERE id = ?")
        .get(oldUserTurnId)?.count,
    ).toBe(0);
    errorSpy.mockRestore();
  });

  test("an internal delete during an in-flight purge keeps the mapping", async () => {
    const now = Date.now();
    const oldUserTurnId = await createExchange("old-user", now);
    const oldAssistantTurnId = db
      .query<{ id: number }, [number]>(
        "SELECT id FROM turns WHERE parent_user_turn_id = ? AND role = 'assistant'",
      )
      .get(oldUserTurnId)?.id;
    if (oldAssistantTurnId === undefined) throw new Error("assistant turn was not created");
    expect(await repository.onBotMessageSent(oldAssistantTurnId, "old-bot", now)).toBe(true);
    const originalPurgeMessage = repository.purgeMessage.bind(repository);
    let failInFlight!: (error: Error) => void;
    let calls = 0;
    repository.purgeMessage = (messageId: string): Promise<boolean> => {
      calls += 1;
      if (calls === 1) {
        return new Promise<boolean>((_resolve, reject) => {
          failInFlight = reject;
        });
      }
      return originalPurgeMessage(messageId);
    };
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const purge = recorder.purgeMessage("old-bot", { channelId: "channel-1" });
    // The internal delete runs while the first purge has not settled yet.
    expect(await recorder.deleteMessageMapping("old-bot")).toBe(false);
    failInFlight(new Error("purge failed"));
    expect(await purge).toBe(false);
    const currentUserTurnId = await createExchange("current-user", now + 1);
    const context = await recorder.getContext(currentUserTurnId);

    expect(context?.exchanges).toEqual([]);
    expect(
      db
        .query<{ count: number }, [number]>("SELECT COUNT(*) as count FROM turns WHERE id = ?")
        .get(oldUserTurnId)?.count,
    ).toBe(0);
    errorSpy.mockRestore();
  });

  test("context read failures return no context and do not reject", async () => {
    const userTurnId = await createExchange("user-message", Date.now());
    repository.getContext = async (): Promise<null> => {
      throw new Error("history read content must not be logged");
    };
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    await expect(recorder.getContext(userTurnId)).resolves.toBeNull();

    expect(errorSpy).toHaveBeenCalledWith("[history] getContext failed", "Error");
    expect(errorSpy.mock.calls.flat()).not.toContain("history read content must not be logged");
    errorSpy.mockRestore();
  });

  test("a failed sweep is retried once after ten minutes and the retry is unref'd", async () => {
    const sweepExpired = mock(() => Promise.resolve(false));
    const historyRecorder = { sweepExpired } as unknown as IHistoryRecorder;
    const callbacks: Array<() => void> = [];
    const timer = { unref: mock(() => {}) } as unknown as ReturnType<typeof setTimeout>;
    const schedule = mock((callback: () => void, delay: number) => {
      callbacks.push(callback);
      expect(delay).toBe(HISTORY_SWEEP_RETRY_DELAY_MS);
      return timer;
    }) as unknown as typeof setTimeout;
    const runner = createHistorySweepRunner(historyRecorder, schedule);

    runner.run();
    await Promise.resolve();
    expect(sweepExpired).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(timer.unref).toHaveBeenCalledTimes(1);

    callbacks[0]?.();
    await Promise.resolve();
    expect(sweepExpired).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenCalledTimes(1);
    runner.cancel();
  });
});
