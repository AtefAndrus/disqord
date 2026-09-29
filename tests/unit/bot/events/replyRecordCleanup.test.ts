import { describe, expect, mock, test } from "bun:test";
import { createReplyRecordCleanupHandlers } from "../../../../src/bot/events/replyRecordCleanup";

function service(): {
  deleteByGuild: ReturnType<typeof mock>;
  deleteByChannel: ReturnType<typeof mock>;
  deleteGuildsNotIn: ReturnType<typeof mock>;
} {
  return {
    deleteByGuild: mock(async () => 1),
    deleteByChannel: mock(async () => 1),
    deleteGuildsNotIn: mock(async () => 0),
  };
}

describe("reply record cleanup handlers", () => {
  test("deletes cron jobs and proposals for removed guilds, channels and threads", async () => {
    const cron = {
      deleteByGuild: mock((_id: string) => 1),
      deleteByChannel: mock((_id: string) => 1),
      deleteGuildsNotIn: mock((_ids: readonly string[]) => 1),
    };
    const handlers = createReplyRecordCleanupHandlers(service(), cron);
    await handlers.guildDelete({ id: "guild" });
    await handlers.channelDelete({ id: "channel" });
    await handlers.threadDelete({ id: "thread" });
    await handlers.reconcileGuilds(["kept"]);
    expect(cron.deleteByGuild.mock.calls).toEqual([["guild"]]);
    expect(cron.deleteByChannel.mock.calls).toEqual([["channel"], ["thread"]]);
    expect(cron.deleteGuildsNotIn.mock.calls).toEqual([[["kept"]]]);
  });
  test("deletes the records of the guild left, the channel deleted, and the thread deleted", async () => {
    const deleter = service();
    const handlers = createReplyRecordCleanupHandlers(deleter);

    await handlers.guildDelete({ id: "guild-1" });
    await handlers.channelDelete({ id: "channel-1" });
    await handlers.threadDelete({ id: "thread-1" });

    expect(deleter.deleteByGuild.mock.calls).toEqual([["guild-1"]]);
    expect(deleter.deleteByChannel.mock.calls).toEqual([["channel-1"], ["thread-1"]]);
    expect(deleter.deleteGuildsNotIn).not.toHaveBeenCalled();
  });

  test("reconciles against every guild the client is in at startup", async () => {
    const deleter = service();
    const cron = {
      deleteByGuild: mock((_id: string) => 0),
      deleteByChannel: mock((_id: string) => 0),
      deleteGuildsNotIn: mock((_ids: readonly string[]) => 0),
    };
    const handlers = createReplyRecordCleanupHandlers(deleter, cron);

    await handlers.reconcileGuilds(
      new Map([
        ["a", {}],
        ["b", {}],
      ]).keys(),
    );

    expect(deleter.deleteGuildsNotIn.mock.calls).toEqual([[["a", "b"]]]);
    expect(cron.deleteGuildsNotIn.mock.calls).toEqual([[["a", "b"]]]);
  });
  test("both cleanup paths run even if either deletion fails", async () => {
    const deleter = service();
    const cron = {
      deleteByGuild: mock((_id: string) => 1),
      deleteByChannel: mock((_id: string) => 1),
      deleteGuildsNotIn: mock((_ids: readonly string[]) => 1),
    };
    const handlers = createReplyRecordCleanupHandlers(deleter, cron);
    deleter.deleteByGuild.mockImplementation(async () => {
      throw new Error("reply failure");
    });
    await expect(handlers.guildDelete({ id: "guild" })).rejects.toThrow("reply failure");
    expect(cron.deleteByGuild).toHaveBeenCalledWith("guild");
    cron.deleteByChannel.mockImplementation(() => {
      throw new Error("cron failure");
    });
    await expect(handlers.channelDelete({ id: "channel" })).rejects.toThrow("cron failure");
    expect(deleter.deleteByChannel).toHaveBeenCalledWith("channel");
  });
});
