import { describe, expect, mock, spyOn, test } from "bun:test";
import type { Message } from "discord.js";
import { createDeleteOwnMessage } from "../../../src/bot/events/messageCreate";
import type { IReplyRecordRepository } from "../../../src/db/repositories/replyRecord";
import {
  type IReplyRecordService,
  ReplyRecordService,
} from "../../../src/services/replyRecordService";

function service(events: string[]): IReplyRecordService {
  return {
    deletePendingWithoutPages: mock(async () => true),
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
    saveGenerationIds: mock(async () => true),
    listGenerationIds: mock(() => []),
    markPendingFailed: mock(async () => 0),
    deleteByGuild: mock(async () => 0),
    deleteByChannel: mock(async () => 0),
    deleteGuildsNotIn: mock(async () => 0),
  };
}

describe("reply-record send/delete funnel", () => {
  test("pending deletion returns the repository result and swallows write failures", async () => {
    const deletePendingWithoutPages = mock(() => true);
    const repository = { deletePendingWithoutPages } as unknown as IReplyRecordRepository;
    const records = new ReplyRecordService(repository);
    expect(await records.deletePendingWithoutPages("trigger")).toBe(true);
    expect(deletePendingWithoutPages).toHaveBeenCalledWith("trigger");
    deletePendingWithoutPages.mockImplementation(() => false);
    expect(await records.deletePendingWithoutPages("trigger")).toBe(false);
    deletePendingWithoutPages.mockImplementation(() => {
      throw new Error("private text");
    });
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await records.deletePendingWithoutPages("trigger")).toBe(false);
      expect(log).toHaveBeenCalledWith("[replyRecord] deletePendingWithoutPages failed", "Error");
    } finally {
      log.mockRestore();
    }
  });
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
});
