import { describe, expect, mock, spyOn, test } from "bun:test";
import { type Message, MessageType } from "discord.js";
import { createMessageCreateHandler } from "../../../../src/bot/events/messageCreate";
import type { IChatService } from "../../../../src/services/chatService";
import type { ConversationWindowService } from "../../../../src/services/conversationWindow";
import type { IModelService } from "../../../../src/services/modelService";
import type { IReactionGateService } from "../../../../src/services/reactionGateService";
import type { IReplyRecordService } from "../../../../src/services/replyRecordService";
import type { ISettingsService } from "../../../../src/services/settingsService";
import { createMockApiKeyService, createMockGuildSettings } from "../../../helpers/mockFactories";

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

const GENERATION = {
  status: "final",
  text: "答え",
  finishReason: "stop",
  history: [],
  generations: [],
};

function setup(
  options: {
    emoji?: string | null;
    settings?: Record<string, unknown>;
    message?: Record<string, unknown>;
    closing?: () => boolean;
    addReaction?: () => Promise<string>;
    /** The bot's last message in the conversation window, which also turns history on. */
    botMessage?: string;
  } = {},
) {
  const page = { id: "page", edit: mock(async () => {}), delete: mock(async () => {}) };
  const send = mock(async () => page);
  const react = mock(options.addReaction ?? (async () => '{"ok":true}'));
  const message = {
    id: "trigger",
    content: "<@123> ありがとう",
    type: MessageType.Default,
    channel: { id: "channel", send, isThread: () => false },
    mentions: { has: mock(() => true), repliedUser: null },
    author: { id: "user", username: "user", bot: false },
    member: null,
    client: { user: { id: "123", username: "bot" } },
    guild: {
      id: "guild",
      members: { me: null },
      emojis: {
        cache: new Map([
          ["1", { name: "kusa", available: true }],
          ["2", { name: "gone", available: false }],
        ]),
      },
    },
    attachments: { values: () => [], size: 0 },
    poll: null,
    reply: mock(async () => {}),
    ...options.message,
  } as unknown as Message;
  const generateChatResponse = mock(async () => GENERATION);
  const chatService = {
    get isClosing() {
      return options.closing?.() ?? false;
    },
    generateChatResponse,
  } as unknown as IChatService;
  const replyRecordService = records();
  const judge = mock<IReactionGateService["judge"]>(async () =>
    options.emoji === undefined ? "👍" : options.emoji,
  );
  const handler = createMessageCreateHandler(
    chatService,
    {
      getGuildSettings: mock(async () =>
        createMockGuildSettings({
          historyEnabled: false,
          discordToolsEnabled: true,
          ...options.settings,
          ...(options.botMessage !== undefined && { historyEnabled: true }),
        }),
      ),
    } as unknown as ISettingsService,
    {
      getModelName: mock(async () => "model"),
      isMultimodalCapable: mock(async () => true),
    } as unknown as IModelService,
    createMockApiKeyService(),
    {
      replyRecordService,
      reactionGate: { judge },
      ...(options.botMessage !== undefined && {
        conversationWindow: {
          build: mock(async () => ({
            messages: [
              {
                id: "1",
                channelId: "channel",
                kind: "assistant",
                author: "assistant",
                time: "",
                timestampMs: 0,
                text: options.botMessage,
                attachments: [],
                exchangeId: "0",
                ref: "m1",
              },
            ],
            sessionId: "session",
            windowStartMessageId: "1",
            toolContext: { resolveMessageRef: () => undefined },
          })),
        } as unknown as ConversationWindowService,
      }),
    },
  );
  return { handler, message, send, page, generateChatResponse, replyRecordService, judge, react };
}

// DiscordActionService talks to Discord, so the reaction is stubbed where it is called.
async function withReaction<T>(react: () => Promise<string>, run: () => Promise<T>): Promise<T> {
  const module = await import("../../../../src/services/discordActionService");
  const spy = spyOn(module.DiscordActionService.prototype, "addReaction").mockImplementation(react);
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

describe("a message the reaction gate answers with an emoji", () => {
  test("reacts, posts nothing, calls no model, deletes the record, and logs who paid", async () => {
    const info = spyOn(console, "info").mockImplementation(() => {});
    const fixture = setup();
    await withReaction(fixture.react, () => fixture.handler(fixture.message));
    expect(fixture.react).toHaveBeenCalledTimes(1);
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.generateChatResponse).not.toHaveBeenCalled();
    expect(fixture.replyRecordService.deletePendingWithoutPages).toHaveBeenCalledWith("trigger");
    expect(fixture.replyRecordService.finalize).not.toHaveBeenCalled();
    const line = info.mock.calls
      .map((call) => String(call[0]))
      .find((text) => text.includes("Reaction-only reply"));
    expect(line).toContain('"emoji":"👍"');
    expect(line).toContain('"keySource":"default"');
    info.mockRestore();
  });

  test("passes the mention in the state and the guild's usable custom emoji", async () => {
    const fixture = setup({ emoji: null });
    await fixture.handler(fixture.message);
    const [input] = fixture.judge.mock.calls[0] as Parameters<IReactionGateService["judge"]>;
    expect(JSON.stringify(input.state)).toContain("@bot ありがとう");
    expect(input.customEmoji).toEqual(["kusa"]);
  });

  test("hands over the end of a long bot message, which the judgment state would cut off", async () => {
    const fixture = setup({ emoji: null, botMessage: `${"あ".repeat(500)}書きましょうか？` });
    await fixture.handler(fixture.message);
    const [input] = fixture.judge.mock.calls[0] as Parameters<IReactionGateService["judge"]>;
    expect(String(input.state.last_bot_message_end).endsWith("書きましょうか？")).toBe(true);
  });

  test("a record that cannot be deleted is finalized as failed", async () => {
    const fixture = setup();
    fixture.replyRecordService.deletePendingWithoutPages = mock(async () => false);
    await withReaction(fixture.react, () => fixture.handler(fixture.message));
    expect(fixture.replyRecordService.finalize).toHaveBeenCalledWith("trigger", "failed", 0);
  });

  test("the same message arriving again is not processed", async () => {
    const fixture = setup();
    await withReaction(fixture.react, async () => {
      await fixture.handler(fixture.message);
      await fixture.handler(fixture.message);
    });
    expect(fixture.judge).toHaveBeenCalledTimes(1);
    expect(fixture.generateChatResponse).not.toHaveBeenCalled();
  });

  test("the first one ending while the repeated event waits on createPending stops it too", async () => {
    let finish = (): void => {};
    const reacting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fixture = setup({
      addReaction: async () => {
        await reacting;
        return '{"ok":true}';
      },
    });
    await withReaction(fixture.react, async () => {
      const first = fixture.handler(fixture.message);
      await Bun.sleep(1);
      // createPending saw the first one's record; by the time it returns, the record is gone.
      fixture.replyRecordService.createPending = mock(async () => {
        finish();
        await first;
        return false;
      });
      await fixture.handler(fixture.message);
    });
    expect(fixture.judge).toHaveBeenCalledTimes(1);
    expect(fixture.react).toHaveBeenCalledTimes(1);
    expect(fixture.generateChatResponse).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
  });

  test("a repeated event past the first checks when the first one ends is stopped next to createPending", async () => {
    const fixture = setup();
    let exists = false;
    fixture.replyRecordService.createPending = mock(async () => {
      if (exists) return false;
      exists = true;
      return true;
    });
    fixture.replyRecordService.findByTrigger = mock(() =>
      exists ? ({ triggerMsgId: "trigger" } as never) : null,
    );
    fixture.replyRecordService.deletePendingWithoutPages = mock(async () => {
      exists = false;
      return true;
    });
    await withReaction(fixture.react, async () => {
      const settings = fixture.handler(fixture.message);
      const second = fixture.handler(fixture.message);
      await Promise.all([settings, second]);
      await fixture.handler(fixture.message);
    });
    expect(fixture.generateChatResponse).not.toHaveBeenCalled();
    expect(fixture.react).toHaveBeenCalledTimes(1);
  });
});

describe("falling back to a text reply", () => {
  test("when the gate says text", async () => {
    const fixture = setup({ emoji: null });
    await fixture.handler(fixture.message);
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.generateChatResponse).toHaveBeenCalledTimes(1);
    expect(fixture.replyRecordService.finalize).toHaveBeenCalledWith("trigger", "completed", 1);
    expect(fixture.replyRecordService.deletePendingWithoutPages).not.toHaveBeenCalled();
  });

  test.each([
    ["a refused reaction", async () => '{"ok":false,"reason":"missing_permission","who":"bot"}'],
    [
      "a reaction that throws",
      async () => {
        throw new Error("network");
      },
    ],
  ])("after %s", async (_name, addReaction) => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const fixture = setup({ addReaction });
    await withReaction(fixture.react, () => fixture.handler(fixture.message));
    expect(fixture.generateChatResponse).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.replyRecordService.deletePendingWithoutPages).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("messages the gate is not asked about", () => {
  test.each([
    ["Discord tools off", { settings: { discordToolsEnabled: false } }],
    ["a free-only guild", { settings: { freeModelsOnly: true } }],
    [
      "a poll",
      {
        message: {
          poll: {
            question: { text: "q" },
            answers: new Map(),
            expiresTimestamp: null,
            allowMultiselect: false,
          },
        },
      },
    ],
    ["more than the judgment state keeps", { message: { content: `<@123> ${"あ".repeat(401)}` } }],
  ])("%s", async (_name, options) => {
    const fixture = setup(options);
    await fixture.handler(fixture.message);
    expect(fixture.judge).not.toHaveBeenCalled();
    expect(fixture.generateChatResponse).toHaveBeenCalledTimes(1);
  });

  test("an attachment", async () => {
    const fixture = setup({
      message: {
        content: "<@123> これ",
        attachments: {
          size: 1,
          values: () => [{ id: "a", name: "a.png", url: "u", contentType: "image/png", size: 1 }],
        },
      },
    });
    await fixture.handler(fixture.message);
    expect(fixture.generateChatResponse).toHaveBeenCalledTimes(1);
    expect(fixture.judge).not.toHaveBeenCalled();
  });

  test("with the window on but unavailable, the gate is not asked", async () => {
    const fixture = setup({ settings: { historyEnabled: true } });
    await fixture.handler(fixture.message);
    expect(fixture.judge).not.toHaveBeenCalled();
    expect(fixture.generateChatResponse).toHaveBeenCalledTimes(1);
  });

  test("a message of exactly the limit is asked about", async () => {
    const fixture = setup({ emoji: null, message: { content: `<@123> ${"あ".repeat(400)}` } });
    await fixture.handler(fixture.message);
    expect(fixture.judge).toHaveBeenCalledTimes(1);
  });

  test("once shutdown has begun, a chosen emoji is not added", async () => {
    let closing = false;
    const fixture = setup();
    fixture.judge.mockImplementation(async () => {
      closing = true;
      return "👍";
    });
    const handler = createMessageCreateHandler(
      {
        get isClosing() {
          return closing;
        },
        generateChatResponse: mock(async () => ({
          status: "cancelled",
          history: [],
          generations: [],
        })),
      } as unknown as IChatService,
      {
        getGuildSettings: mock(async () =>
          createMockGuildSettings({ historyEnabled: false, discordToolsEnabled: true }),
        ),
      } as unknown as ISettingsService,
      {
        getModelName: mock(async () => "model"),
        isMultimodalCapable: mock(async () => true),
      } as unknown as IModelService,
      createMockApiKeyService(),
      { replyRecordService: fixture.replyRecordService, reactionGate: { judge: fixture.judge } },
    );
    await withReaction(fixture.react, () => handler(fixture.message));
    expect(fixture.react).not.toHaveBeenCalled();
  });
});
