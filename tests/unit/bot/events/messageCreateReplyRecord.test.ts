import { describe, expect, mock, spyOn, test } from "bun:test";
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

  test("neutralizes instead of deleting when page-record removal fails", async () => {
    const warnLines: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation(((line: string) => {
      warnLines.push(line);
    }) as typeof console.warn);
    try {
      const botMessage = {
        id: "page-1",
        delete: mock(async () => {}),
        edit: mock(async () => {}),
      } as unknown as Message;
      const replyRecordService = createReplyRecordService([]);
      replyRecordService.removePage = mock(async () => {
        throw new Error("record failure with message content");
      });

      await createDeleteOwnMessage(replyRecordService, "trigger", "model", 0)(botMessage);

      expect(botMessage.delete).not.toHaveBeenCalled();
      expect(botMessage.edit).toHaveBeenCalledTimes(1);
      expect(warnLines.join("\n")).toContain('"error":"Error"');
      expect(warnLines.join("\n")).not.toContain("record failure with message content");
    } finally {
      warnSpy.mockRestore();
    }
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

  test("does not leak reply text into logs when fatal cleanup fails", async () => {
    const secretText = `secret-${crypto.randomUUID()}`;
    const warnLines: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation(((line: string) => {
      warnLines.push(line);
    }) as typeof console.warn);
    try {
      class FakeDiscordApiError extends Error {
        requestBody = {
          json: { components: [{ type: 17, components: [{ type: 10, content: secretText }] }] },
        };

        constructor() {
          super("Invalid Form Body");
          this.name = "DiscordAPIError[50035]";
        }
      }
      const pageMessage = {
        id: "page-1",
        edit: mock(async () => {
          throw new FakeDiscordApiError();
        }),
        delete: mock(async () => {}),
      };
      const channel = { id: "channel", send: mock(async () => pageMessage) };
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
          historyEnabled: false,
          createdAt: "now",
          updatedAt: "now",
        })),
      } as unknown as ISettingsService;
      const modelService = { getModelName: mock(async () => "model") } as unknown as IModelService;
      const chatService = {
        generateChatResponse: mock(
          async (
            _guildId: string,
            _input: unknown,
            _requestId: string,
            updater: { beginTurn(): void; stageContent(text: string): Promise<void> },
          ) => {
            updater.beginTurn();
            await updater.stageContent(secretText);
            throw new Error("boom");
          },
        ),
      } as unknown as IChatService;

      await createMessageCreateHandler(chatService, settingsService, modelService, {})(message);

      const combined = warnLines.join("\n");
      expect(combined).toContain("Failed to clean up a bot message");
      expect(combined).not.toContain(secretText);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
