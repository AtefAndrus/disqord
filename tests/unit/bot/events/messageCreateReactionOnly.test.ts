import { describe, expect, mock, spyOn, test } from "bun:test";
import { type Message, MessageType } from "discord.js";
import { createMessageCreateHandler } from "../../../../src/bot/events/messageCreate";
import type { IToolLoopUpdater } from "../../../../src/llm/toolLoop";
import type { IChatService } from "../../../../src/services/chatService";
import type { IModelService } from "../../../../src/services/modelService";
import type { IReplyRecordService } from "../../../../src/services/replyRecordService";
import type { ISettingsService } from "../../../../src/services/settingsService";
import { createMockApiKeyService, createMockGuildSettings } from "../../../helpers/mockFactories";

const GENERATIONS = [{ id: "generation", serverTools: false, keySource: "default" as const }];

function records(): IReplyRecordService {
  return {
    deletePendingWithoutPages: mock(async () => true),
    createPending: mock(async () => true),
    appendPage: mock(async () => ({ recorded: true, finalized: false })),
    removePage: mock(async () => true),
    finalize: mock(async () => true),
    findByTrigger: mock(() => null),
    findByPage: mock(() => null),
    listPages: mock(() => []),
    saveGenerations: mock(async () => true),
    listGenerations: mock(() => []),
    markPendingFailed: mock(async () => 0),
    deleteByGuild: mock(async () => 0),
    deleteByChannel: mock(async () => 0),
    deleteGuildsNotIn: mock(async () => 0),
  };
}

type Generate = (updater: IToolLoopUpdater) => Promise<Record<string, unknown>>;

function setup(generate: Generate, options: { isClosing?: () => boolean } = {}) {
  const page = { id: "page", edit: mock(async () => {}), delete: mock(async () => {}) };
  const send = mock(async () => page);
  const message = {
    id: "trigger",
    content: "<@bot> ありがとう",
    type: MessageType.Default,
    channel: { id: "channel", send, isThread: () => false },
    mentions: { has: mock(() => true) },
    author: { id: "user", username: "user", bot: false },
    member: null,
    client: { user: { id: "bot" } },
    guild: { id: "guild", members: { me: null } },
    attachments: { values: () => [], size: 0 },
    reply: mock(async () => {}),
  } as unknown as Message;
  const generateChatResponse = mock(
    async (_guild: string, _input: unknown, _id: string, updater: IToolLoopUpdater) => ({
      history: [],
      generations: GENERATIONS,
      ...(await generate(updater)),
    }),
  );
  const chatService = {
    get isClosing() {
      return options.isClosing?.() ?? false;
    },
    generateChatResponse,
  } as unknown as IChatService;
  const replyRecordService = records();
  const modelService = { getModelName: mock(async () => "model") } as unknown as IModelService;
  const handler = createMessageCreateHandler(
    chatService,
    {
      getGuildSettings: mock(async () =>
        createMockGuildSettings({ historyEnabled: false, discordToolsEnabled: true }),
      ),
    } as unknown as ISettingsService,
    modelService,
    createMockApiKeyService(),
    { replyRecordService },
  );
  return { handler, message, send, page, generateChatResponse, replyRecordService, modelService };
}

const reactionOnly = {
  status: "final",
  text: "",
  finishReason: "stop",
  reaction: "👍",
  model: "m",
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.001 },
};

describe("a reply that is only a reaction", () => {
  test("sends nothing, deletes the record, and logs usage and who paid", async () => {
    const info = spyOn(console, "info").mockImplementation(() => {});
    const { handler, message, send, replyRecordService } = setup(async () => reactionOnly);
    await handler(message);
    expect(send).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
    expect(replyRecordService.deletePendingWithoutPages).toHaveBeenCalledWith("trigger");
    expect(replyRecordService.finalize).not.toHaveBeenCalled();
    const line = info.mock.calls
      .map((call) => String(call[0]))
      .find((l) => l.includes("Reaction-only reply"));
    expect(line).toContain('"emoji":"👍"');
    expect(line).toContain('"keySource":"default"');
    expect(line).toContain('"cost":0.001');
    info.mockRestore();
  });

  test("removes a page it had already sent, then deletes the record", async () => {
    const events: string[] = [];
    const { handler, message, send, page, replyRecordService } = setup(async (updater) => {
      await updater.beginToolBlock("read_earlier_messages");
      return reactionOnly;
    });
    page.delete.mockImplementation(async () => {
      events.push("delete-page");
    });
    replyRecordService.deletePendingWithoutPages = mock(async () => {
      events.push("delete-record");
      return true;
    });
    await handler(message);
    expect(send).toHaveBeenCalledTimes(1);
    expect(replyRecordService.appendPage).toHaveBeenCalledWith("trigger", "page");
    expect(replyRecordService.removePage).toHaveBeenCalledWith("page");
    expect(events).toEqual(["delete-page", "delete-record"]);
  });

  test("waits for a page still being sent, so that it does not stay behind", async () => {
    let resolveSend = (): void => {};
    const { handler, message, send, page, replyRecordService } = setup(async (updater) => {
      void updater.beginToolBlock("read_earlier_messages");
      return reactionOnly;
    });
    send.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = () => resolve(page);
        }),
    );
    const handling = handler(message);
    await Bun.sleep(5);
    expect(replyRecordService.deletePendingWithoutPages).not.toHaveBeenCalled();
    resolveSend();
    await handling;
    expect(replyRecordService.appendPage).toHaveBeenCalledWith("trigger", "page");
    expect(page.delete).toHaveBeenCalledTimes(1);
    expect(replyRecordService.deletePendingWithoutPages).toHaveBeenCalledTimes(1);
  });

  test("a record that cannot be deleted is finalized as failed with its generations", async () => {
    const { handler, message, replyRecordService } = setup(async () => reactionOnly);
    replyRecordService.deletePendingWithoutPages = mock(async () => false);
    await handler(message);
    expect(replyRecordService.finalize).toHaveBeenCalledWith("trigger", "failed", 0);
    expect(replyRecordService.saveGenerations).toHaveBeenCalledWith("trigger", GENERATIONS);
  });

  test("the same message arriving again is not processed", async () => {
    const { handler, message, generateChatResponse } = setup(async () => reactionOnly);
    await handler(message);
    await handler(message);
    expect(generateChatResponse).toHaveBeenCalledTimes(1);
  });

  test("the same message arriving during the first one's generation is not processed either", async () => {
    let finish = (): void => {};
    const generating = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fixture = setup(async () => {
      await generating;
      return reactionOnly;
    });
    const { handler, message, generateChatResponse, replyRecordService } = fixture;
    let exists = false;
    replyRecordService.createPending = mock(async () => {
      if (exists) return false;
      exists = true;
      return true;
    });
    replyRecordService.findByTrigger = mock(() =>
      exists ? ({ triggerMsgId: "trigger" } as never) : null,
    );
    replyRecordService.deletePendingWithoutPages = mock(async () => {
      exists = false;
      return true;
    });
    let releaseSecond = (): void => {};
    const heldBack = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const first = handler(message);
    await Bun.sleep(1);
    // The second event is past the handler's first checks when the first one ends and deletes
    // its record, so only the check next to createPending can stop it.
    fixture.modelService.getModelName = mock(async () => {
      await heldBack;
      return "model";
    });
    const second = handler(message);
    await Bun.sleep(1);
    finish();
    await first;
    releaseSecond();
    await second;
    expect(generateChatResponse).toHaveBeenCalledTimes(1);
  });

  test("whitespace written before the tool still counts as no text", async () => {
    const { handler, message, send, replyRecordService } = setup(async (updater) => {
      await updater.stageContent("\n");
      await updater.commitTurn("tool_calls");
      return reactionOnly;
    });
    await handler(message);
    expect(send).not.toHaveBeenCalled();
    expect(replyRecordService.deletePendingWithoutPages).toHaveBeenCalled();
  });
});

describe("a reaction with text", () => {
  test("is drawn as a normal reply and keeps the record", async () => {
    const { handler, message, page, replyRecordService } = setup(async (updater) => {
      await updater.stageContent("調べます");
      await updater.commitTurn("tool_calls");
      return { ...reactionOnly, reasoningText: "考えた" };
    });
    await handler(message);
    expect(JSON.stringify(page.edit.mock.calls)).toContain("調べます");
    expect(replyRecordService.finalize).toHaveBeenCalledWith("trigger", "completed", 1);
    expect(replyRecordService.deletePendingWithoutPages).not.toHaveBeenCalled();
  });
});

describe("generation that ends before the first page", () => {
  test("shutdown sends nothing and leaves the record pending for the next start", async () => {
    let closing = false;
    const { handler, message, send, replyRecordService } = setup(
      async (updater) => {
        closing = true;
        await updater.stageContent("あ");
        return { status: "cancelled" };
      },
      { isClosing: () => closing },
    );
    await handler(message);
    expect(send).not.toHaveBeenCalled();
    expect(replyRecordService.finalize).not.toHaveBeenCalled();
    expect(replyRecordService.deletePendingWithoutPages).not.toHaveBeenCalled();
  });

  test("an error still gets the error reply", async () => {
    const { handler, message, send, replyRecordService } = setup(async () => ({
      status: "error",
      error: new Error("failed"),
    }));
    await handler(message);
    expect(send).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledTimes(1);
    expect(replyRecordService.finalize).toHaveBeenCalledWith("trigger", "failed", 0);
  });

  test("with Discord tools off, the first page is sent before generation as before", async () => {
    const order: string[] = [];
    const { message, send } = setup(async () => reactionOnly);
    send.mockImplementation(async () => {
      order.push("send");
      return { id: "page", edit: mock(async () => {}), delete: mock(async () => {}) };
    });
    const handler = createMessageCreateHandler(
      {
        isClosing: false,
        generateChatResponse: mock(async () => {
          order.push("generate");
          return { status: "final", text: "a", finishReason: "stop", history: [], generations: [] };
        }),
      } as unknown as IChatService,
      {
        getGuildSettings: mock(async () =>
          createMockGuildSettings({ historyEnabled: false, discordToolsEnabled: false }),
        ),
      } as unknown as ISettingsService,
      { getModelName: mock(async () => "model") } as unknown as IModelService,
      createMockApiKeyService(),
    );
    await handler(message);
    expect(order).toEqual(["send", "generate"]);
  });
});
