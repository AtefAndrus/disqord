import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  ConversationRepository,
  type CreateConversationTurnInput,
  type CreateConversationTurnResult,
  DELETED_RECORD_TTL_MS,
  DeletedBeforeSaveRecord,
  HISTORY_RETENTION_MS,
  SESSION_GAP_MS,
  TURN_SAVE_MAX_AGE_MS,
} from "../../../src/db/repositories/conversation";
import { GuildSettingsRepository } from "../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../src/db/schema";

const NOW = new Date("2026-09-22T00:00:00.000Z").getTime();

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a created identifier");
  return value;
}

describe("ConversationRepository", () => {
  let db: Database;
  let settings: GuildSettingsRepository;
  let repository: ConversationRepository;
  let deletedBeforeSave: DeletedBeforeSaveRecord;

  beforeEach(async () => {
    setSystemTime(NOW);
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    applyMigrations(db);
    settings = new GuildSettingsRepository(db, "test-model");
    await settings.setHistoryEnabled("guild-1", true);
    deletedBeforeSave = new DeletedBeforeSaveRecord();
    repository = new ConversationRepository(db, deletedBeforeSave);
  });

  afterEach(() => {
    db.close();
    setSystemTime();
  });

  function input(
    messageId: string,
    createdAt = NOW,
    overrides: Partial<CreateConversationTurnInput> = {},
  ): CreateConversationTurnInput {
    return {
      guildId: "guild-1",
      channelId: "channel-1",
      parentChannelId: null,
      discordMessageId: messageId,
      authorId: "user-1",
      authorLabel: "Alice",
      content: [{ type: "text", text: messageId }],
      replyToDiscordMessageId: null,
      discordCreatedAt: createdAt,
      handlingStartedAt: NOW,
      ...overrides,
    };
  }

  function rows(table: "sessions" | "turns" | "turn_messages"): Array<Record<string, unknown>> {
    return db.query(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  }

  test("enables foreign keys and creates the complete schema", () => {
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(
      1,
    );
    expect(
      db.query<{ name: string }, []>("PRAGMA table_info(guild_settings)").all(),
    ).toContainEqual(expect.objectContaining({ name: "history_enabled" }));
    for (const table of ["sessions", "turns", "turn_messages"]) {
      expect(
        db
          .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE name = ?")
          .get(table),
      ).toBeTruthy();
    }
  });

  test("does not write when history is disabled", async () => {
    await settings.setHistoryEnabled("guild-1", false);
    const result = await repository.createUserAndAssistantTurn(input("disabled"));

    expect(result).toMatchObject({
      historyEnabled: false,
      created: false,
      skippedReason: "disabled",
    });
    expect(rows("sessions")).toHaveLength(0);
    expect(rows("turns")).toHaveLength(0);
    expect(rows("turn_messages")).toHaveLength(0);
  });

  test("re-reads history_enabled after the outside read and before saving", async () => {
    type ImmediateTransaction = {
      immediate: (turnInput: CreateConversationTurnInput) => CreateConversationTurnResult;
    };
    const originalTransaction = db.transaction.bind(db) as unknown as (
      callback: unknown,
    ) => ImmediateTransaction;
    let interceptCreateTurn = true;
    const hookedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "query") return target.query.bind(target);
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (callback: unknown): ImmediateTransaction => {
          const transaction = originalTransaction(callback);
          if (!interceptCreateTurn) return transaction;
          interceptCreateTurn = false;
          return {
            immediate: (turnInput) => {
              db.query("UPDATE guild_settings SET history_enabled = 0 WHERE guild_id = ?").run(
                "guild-1",
              );
              return transaction.immediate(turnInput);
            },
          };
        };
      },
    }) as unknown as Database;
    const hookedRepository = new ConversationRepository(hookedDb, deletedBeforeSave);

    const rechecked = await hookedRepository.createUserAndAssistantTurn(input("rechecked"));
    expect(rechecked.skippedReason).toBe("disabled");
    expect(rows("turns")).toHaveLength(0);
    expect(rows("sessions")).toHaveLength(0);
  });

  test("is idempotent for a duplicate Discord message", async () => {
    const first = await repository.createUserAndAssistantTurn(input("duplicate"));
    const second = await repository.createUserAndAssistantTurn(input("duplicate"));

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ historyEnabled: true, created: false, duplicate: true });
    expect(rows("turns")).toHaveLength(2);
    expect(rows("turn_messages")).toHaveLength(1);
  });

  test("skips a message that took too long to reach turn creation", async () => {
    const result = await repository.createUserAndAssistantTurn(
      input("old", NOW, { handlingStartedAt: NOW - TURN_SAVE_MAX_AGE_MS - 1 }),
    );

    expect(result.skippedReason).toBe("too-old");
    expect(rows("turns")).toHaveLength(0);
  });

  test("an own deleted message skips the response", async () => {
    deletedBeforeSave.recordMessage("deleted-message");
    const result = await repository.createUserAndAssistantTurn(input("deleted-message"));
    expect(result).toMatchObject({ skippedReason: "deleted", skipResponse: true });
    expect(rows("turns")).toHaveLength(0);
  });

  test("a deleted channel skips saving but still answers", async () => {
    deletedBeforeSave.recordChannel("channel-1");
    const result = await repository.createUserAndAssistantTurn(input("deleted-channel"));
    expect(result).toMatchObject({ skippedReason: "deleted", skipResponse: false });
    expect(rows("turns")).toHaveLength(0);
  });

  test("a deleted thread parent skips saving but still answers", async () => {
    deletedBeforeSave.recordChannel("parent-channel");
    const result = await repository.createUserAndAssistantTurn(
      input("deleted-parent", NOW, {
        channelId: "thread-1",
        parentChannelId: "parent-channel",
      }),
    );
    expect(result).toMatchObject({ skippedReason: "deleted", skipResponse: false });
    expect(rows("turns")).toHaveLength(0);
  });

  test("a deleted guild skips saving but still answers without a channel match", async () => {
    deletedBeforeSave.recordGuild("guild-1");
    const result = await repository.createUserAndAssistantTurn(
      input("deleted-guild", NOW, { channelId: "guild-only-channel" }),
    );
    expect(result).toMatchObject({ skippedReason: "deleted", skipResponse: false });
    expect(rows("turns")).toHaveLength(0);
  });

  test("expires deleted-before-save records after fifteen minutes", () => {
    const clock = { value: NOW };
    const record = new DeletedBeforeSaveRecord(DELETED_RECORD_TTL_MS, () => clock.value);
    record.recordMessage("message");
    expect(record.hasMessage("message")).toBe(true);
    clock.value += DELETED_RECORD_TTL_MS + 1;
    expect(record.hasMessage("message")).toBe(false);
  });

  test("assigns sessions by channel gap and keeps the greatest last activity", async () => {
    const first = await repository.createUserAndAssistantTurn(input("gap-1", NOW));
    const second = await repository.createUserAndAssistantTurn(
      input("gap-2", NOW + SESSION_GAP_MS - 1),
    );
    const outOfOrder = await repository.createUserAndAssistantTurn(input("gap-3", NOW + 1));
    const nextSession = await repository.createUserAndAssistantTurn(
      input("gap-4", NOW + SESSION_GAP_MS * 2),
    );

    expect(second.sessionId).toBe(first.sessionId);
    expect(outOfOrder.sessionId).toBe(first.sessionId);
    expect(nextSession.sessionId).not.toBe(first.sessionId);
    expect(rows("sessions")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.sessionId,
          last_activity_at: NOW + SESSION_GAP_MS - 1,
        }),
      ]),
    );
    expect(nextSession.openrouterSessionId).not.toBe(first.openrouterSessionId);
  });

  test("validates the assistant parent and records bot mappings in sequence", async () => {
    const created = await repository.createUserAndAssistantTurn(input("parent"));
    const invalid = await repository.createAssistantTurn(
      required(created.sessionId),
      required(created.assistantTurnId),
    );
    expect(invalid).toBeNull();

    const assistantTurnId = created.assistantTurnId;
    if (assistantTurnId === undefined) throw new Error("assistant turn was not created");
    await repository.onBotMessageSent(assistantTurnId, "bot-1", NOW + 1);
    await repository.onBotMessageSent(assistantTurnId, "bot-2", NOW + 2);
    expect(
      db
        .query("SELECT seq, discord_msg_id FROM turn_messages WHERE turn_id = ? ORDER BY seq")
        .all(assistantTurnId),
    ).toEqual([
      { seq: 0, discord_msg_id: "bot-1" },
      { seq: 1, discord_msg_id: "bot-2" },
    ]);
    expect(
      db.query("SELECT discord_created_at FROM turns WHERE id = ?").get(assistantTurnId),
    ).toEqual({ discord_created_at: NOW + 1 });
  });

  test("purges an exchange when a mapping arrives for an already-deleted bot message", async () => {
    const created = await repository.createUserAndAssistantTurn(input("mapping-delete"));
    deletedBeforeSave.recordMessage("bot-deleted");

    const assistantTurnId = created.assistantTurnId;
    if (assistantTurnId === undefined) throw new Error("assistant turn was not created");
    await repository.onBotMessageSent(assistantTurnId, "bot-deleted", NOW + 1);

    expect(rows("turns")).toHaveLength(0);
    expect(rows("sessions")).toHaveLength(0);
  });

  test("removes internal mappings before deletion without purging the exchange", async () => {
    const created = await repository.createUserAndAssistantTurn(input("internal-delete"));
    const assistantTurnId = created.assistantTurnId;
    if (assistantTurnId === undefined) throw new Error("assistant turn was not created");
    await repository.onBotMessageSent(assistantTurnId, "internal-bot", NOW + 1);
    expect(await repository.deleteMessageMapping("internal-bot")).toBe(true);

    expect(rows("turns")).toHaveLength(2);
    expect(rows("sessions")).toHaveLength(1);
    expect(rows("turn_messages")).toHaveLength(1);
  });

  test("mapping and finalize are no-ops after an exchange has already been purged", async () => {
    const created = await repository.createUserAndAssistantTurn(input("purged-race"));
    const assistantTurnId = required(created.assistantTurnId);
    await repository.onBotMessageSent(assistantTurnId, "purged-bot", NOW + 1);
    expect(await repository.purgeMessage("purged-bot")).toBe(true);

    expect(await repository.onBotMessageSent(assistantTurnId, "late-bot", NOW + 2)).toBe(false);
    expect(await repository.finalizeAssistantTurn(assistantTurnId, "completed", "late")).toBe(
      false,
    );
    expect(rows("turns")).toHaveLength(0);
    expect(rows("turn_messages")).toHaveLength(0);
  });

  test("deleting any assistant chunk purges the entire exchange", async () => {
    const created = await repository.createUserAndAssistantTurn(input("split-user"));
    const assistantTurnId = required(created.assistantTurnId);
    await repository.onBotMessageSent(assistantTurnId, "split-bot-1", NOW + 1);
    await repository.onBotMessageSent(assistantTurnId, "split-bot-2", NOW + 2);
    await repository.finalizeAssistantTurn(assistantTurnId, "completed", "split reply", NOW + 3);

    expect(await repository.purgeMessage("split-bot-2")).toBe(true);
    expect(rows("turns")).toHaveLength(0);
    expect(rows("sessions")).toHaveLength(0);
  });

  test("context excludes an exchange whose mapped message was deleted before purge", async () => {
    const old = await repository.createUserAndAssistantTurn(input("context-old"));
    const oldAssistantTurnId = required(old.assistantTurnId);
    await repository.onBotMessageSent(oldAssistantTurnId, "context-old-bot-1", NOW + 1);
    await repository.onBotMessageSent(oldAssistantTurnId, "context-old-bot-2", NOW + 2);
    await repository.finalizeAssistantTurn(oldAssistantTurnId, "completed", "old reply", NOW + 3);

    const current = await repository.createUserAndAssistantTurn(input("context-current", NOW + 4));
    deletedBeforeSave.recordMessage("context-old-bot-2");

    const context = await repository.getContext(required(current.userTurnId));
    expect(context?.exchanges).toHaveLength(0);
  });

  test("includes only assistant turns finalized before the current message", async () => {
    const first = await repository.createUserAndAssistantTurn(input("cutoff-1", NOW));
    const firstAssistantTurnId = required(first.assistantTurnId);
    await repository.onBotMessageSent(firstAssistantTurnId, "cutoff-bot-1", NOW + 1);
    await repository.finalizeAssistantTurn(firstAssistantTurnId, "completed", "reply", NOW + 100);

    const currentBeforeFinalize = await repository.createUserAndAssistantTurn(
      input("cutoff-2", NOW + 50),
    );
    const before = await repository.getContext(required(currentBeforeFinalize.userTurnId));
    expect(before?.exchanges[0]?.assistant).toBeUndefined();

    const currentAfterFinalize = await repository.createUserAndAssistantTurn(
      input("cutoff-3", NOW + 150),
    );
    const after = await repository.getContext(required(currentAfterFinalize.userTurnId));
    expect(after?.exchanges[0]?.assistant?.content).toEqual([{ type: "text", text: "reply" }]);
  });

  test("uses the snowflake tie-breaker for equal Discord creation timestamps", async () => {
    const first = await repository.createUserAndAssistantTurn(input("100", NOW));
    const second = await repository.createUserAndAssistantTurn(input("99", NOW));
    const firstContext = await repository.getContext(required(first.userTurnId));
    const secondContext = await repository.getContext(required(second.userTurnId));

    expect(firstContext?.exchanges).toHaveLength(1);
    expect(secondContext?.exchanges).toHaveLength(0);
  });

  test("fails pending turns at startup and sweeps complete exchanges by retention", async () => {
    const pending = await repository.createUserAndAssistantTurn(input("pending"));
    const pendingAssistantTurnId = pending.assistantTurnId;
    if (pendingAssistantTurnId === undefined) throw new Error("assistant turn was not created");
    expect(await repository.failPendingTurns()).toBe(1);
    expect(
      db.query("SELECT status, active FROM turns WHERE id = ?").get(pendingAssistantTurnId),
    ).toEqual({
      status: "failed",
      active: 0,
    });

    const old = NOW - HISTORY_RETENTION_MS - 1_000;
    const expired = await repository.createUserAndAssistantTurn(
      input("expired", old, { channelId: "expired-channel" }),
    );
    const expiredAssistantTurnId = expired.assistantTurnId;
    const expiredSessionId = expired.sessionId;
    if (expiredAssistantTurnId === undefined || expiredSessionId === undefined) {
      throw new Error("expired exchange was not created");
    }
    await repository.onBotMessageSent(expiredAssistantTurnId, "expired-bot", old + 1);
    await repository.finalizeAssistantTurn(expiredAssistantTurnId, "completed", "old", old + 2);
    expect(await repository.sweepExpired(NOW)).toBeGreaterThanOrEqual(1);
    expect(db.query("SELECT * FROM sessions WHERE id = ?").get(expiredSessionId)).toBeNull();
  });
});
