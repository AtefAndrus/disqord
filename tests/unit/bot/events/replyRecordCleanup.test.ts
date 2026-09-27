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
    const handlers = createReplyRecordCleanupHandlers(deleter);

    await handlers.reconcileGuilds(
      new Map([
        ["a", {}],
        ["b", {}],
      ]).keys(),
    );

    expect(deleter.deleteGuildsNotIn.mock.calls).toEqual([[["a", "b"]]]);
  });
});
