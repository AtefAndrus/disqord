import { describe, expect, mock, test } from "bun:test";
import type { Message } from "discord.js";
import { createDeleteOwnMessage } from "../../../src/bot/events/messageCreate";
import {
  createReplyRecordCleanupRunner,
  type IReplyRecordService,
} from "../../../src/services/replyRecordService";

function service(events: string[]): IReplyRecordService {
  return {
    createPending: mock(async () => true),
    appendPage: mock(async () => ({ recorded: true, finalized: false })),
    removePage: mock(async () => {
      events.push("record-remove");
      return true;
    }),
    finalize: mock(async () => true),
    findByTrigger: mock(() => null),
    findByPage: mock(() => null),
    listPages: mock(() => []),
    markPendingFailed: mock(async () => 0),
    cleanupExpired: mock(async () => 0),
  };
}

describe("reply-record send/delete funnel", () => {
  test("removes the page row before calling Discord delete", async () => {
    const events: string[] = [];
    const botMessage = {
      id: "page-1",
      delete: mock(async () => {
        events.push("discord-delete");
      }),
      edit: mock(async () => {}),
    } as unknown as Message;
    const deleteOwnMessage = createDeleteOwnMessage(service(events), "trigger", "model", 0);

    await deleteOwnMessage(botMessage);

    expect(events).toEqual(["record-remove", "discord-delete"]);
  });

  test("runs the channel-state sweep with the hourly record cleanup", () => {
    let scheduled: (() => void) | undefined;
    const setIntervalFn = ((callback: () => void) => {
      scheduled = callback;
      return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    const clearIntervalFn = mock(() => {});
    const sweep = mock(() => {});
    const runner = createReplyRecordCleanupRunner(
      service([]),
      setIntervalFn,
      clearIntervalFn,
      sweep,
    );

    scheduled?.();
    runner.run();
    runner.cancel();

    expect(sweep).toHaveBeenCalledTimes(2);
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });
});
