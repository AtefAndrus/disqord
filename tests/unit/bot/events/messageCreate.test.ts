import { describe, expect, mock, test } from "bun:test";
import { type Message, MessageType } from "discord.js";
import {
  createDeleteOwnMessage,
  createMessageCreateHandler,
} from "../../../../src/bot/events/messageCreate";
import type { IChatService } from "../../../../src/services/chatService";
import type { IModelService } from "../../../../src/services/modelService";
import type { IReplyRecordService } from "../../../../src/services/replyRecordService";
import type { ISettingsService } from "../../../../src/services/settingsService";

function createReplyRecordService(events: string[]): IReplyRecordService {
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

describe("message create reply-record funnel", () => {
  test("removes a page record before deleting the Discord message", async () => {
    const events: string[] = [];
    const botMessage = {
      id: "page-1",
      delete: mock(async () => {
        events.push("discord-delete");
      }),
      edit: mock(async () => {}),
    } as unknown as Message;

    await createDeleteOwnMessage(
      createReplyRecordService(events),
      "trigger",
      "model",
      0,
    )(botMessage);

    expect(events).toEqual(["record-remove", "discord-delete"]);
  });

  test("finalizes with rendered pages when a middle page registration fails", async () => {
    const pageMessages = ["page-1", "page-2", "page-3"].map((id) => ({
      id,
      edit: mock(async () => {}),
      delete: mock(async () => {}),
    }));
    const channel = {
      id: "channel",
      send: mock(async () => pageMessages.shift() ?? pageMessages[0]),
    };
    const message = {
      id: "trigger",
      content: "<@bot> request",
      type: MessageType.Default,
      channel,
      mentions: { has: mock(() => true) },
      author: { id: "user", username: "user", bot: false },
      member: null,
      client: { user: { id: "bot" } },
      guild: { id: "guild" },
      attachments: { values: () => [] },
      reply: mock(async () => {}),
    } as unknown as Message;
    const settingsService = {
      getGuildSettings: mock(async () => ({
        guildId: "guild",
        defaultModel: "model",
        freeModelsOnly: false,
        showLlmDetails: false,
        autoReplyChannels: [],
        webSearchEnabled: false,
        twitterExpandEnabled: true,
        historyEnabled: true,
        createdAt: "now",
        updatedAt: "now",
      })),
    } as unknown as ISettingsService;
    const modelService = {
      getModelName: mock(async () => "model"),
    } as unknown as IModelService;
    const renderedText = "x".repeat(9_000);
    const chatService = {
      generateChatResponse: mock(
        async (
          _guildId: string,
          _input: unknown,
          _requestId: string,
          updater: { beginTurn(): void; stageContent(text: string): Promise<void> },
        ) => {
          updater.beginTurn();
          await updater.stageContent(renderedText);
          return {
            status: "final" as const,
            text: renderedText,
            finishReason: "stop" as const,
            history: [],
            model: "model",
            provider: "provider",
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      ),
    } as unknown as IChatService;
    let appendCount = 0;
    const replyRecordService = {
      ...createReplyRecordService([]),
      appendPage: mock(async () => {
        appendCount += 1;
        return { recorded: appendCount !== 2, finalized: false };
      }),
      finalize: mock(async () => true),
    } satisfies IReplyRecordService;

    await createMessageCreateHandler(chatService, settingsService, modelService, {
      replyRecordService,
    })(message);

    expect(replyRecordService.finalize).toHaveBeenCalledWith("trigger", "completed", 3);
  });
});
