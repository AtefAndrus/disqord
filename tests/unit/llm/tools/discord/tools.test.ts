import { describe, expect, mock, test } from "bun:test";
import { ChannelType } from "discord.js";
import { createAddReactionTool } from "../../../../../src/llm/tools/discord/addReaction";
import { createCreatePollTool } from "../../../../../src/llm/tools/discord/createPoll";
import { createCreateThreadTool } from "../../../../../src/llm/tools/discord/createThread";
import { createPinMessageTool } from "../../../../../src/llm/tools/discord/pinMessage";
import type {
  DiscordToolContext,
  IClientTool,
  IToolContext,
  IToolInvocationMeta,
} from "../../../../../src/llm/tools/registry";

const tools = [
  createAddReactionTool(),
  createCreatePollTool(),
  createCreateThreadTool(),
  createPinMessageTool(),
];
const discord: DiscordToolContext = {
  channelType: ChannelType.GuildText,
  addReaction: mock(async () => '{"ok":true}'),
  createPoll: mock(async () => '{"ok":true}'),
  createThread: mock(async () => '{"ok":true}'),
  pinMessage: mock(async () => '{"ok":true}'),
};
const context = (overrides: Partial<IToolContext> = {}): IToolContext => ({
  guildId: "guild",
  channelId: "channel",
  userId: "user",
  discord,
  ...overrides,
});

describe("Discord client tools", () => {
  test("only offers supported guild channels when enabled", () => {
    for (const tool of tools) {
      expect(tool.isEnabled(context())).toBe(true);
      expect(tool.isEnabled(context({ guildId: null }))).toBe(false);
      expect(tool.isEnabled(context({ discord: undefined }))).toBe(false);
      expect(tool.isEnabled(context({ toolsAllowed: false }))).toBe(false);
      expect(
        tool.isEnabled(context({ discord: { ...discord, channelType: ChannelType.GuildVoice } })),
      ).toBe(false);
      expect(tool.isEnabled(context({ discord: { ...discord, channelType: -1 } }))).toBe(false);
      expect(
        tool.isEnabled(
          context({ discord: { ...discord, channelType: ChannelType.GuildAnnouncement } }),
        ),
      ).toBe(false);
      expect(
        tool.isEnabled(context({ discord: { ...discord, channelType: ChannelType.PublicThread } })),
      ).toBe(tool.name !== "create_thread");
      expect(
        tool.isEnabled(
          context({ discord: { ...discord, channelType: ChannelType.PrivateThread } }),
        ),
      ).toBe(tool.name !== "create_thread");
    }
  });

  test("validates limits before calling Discord", () => {
    expect(createAddReactionTool().validate({ emoji: "👍", message_ref: "m7" }).ok).toBe(true);
    expect(createAddReactionTool().validate({ emoji: "👍", message_ref: "123" }).ok).toBe(false);
    expect(createAddReactionTool().validate({ emoji: "<:party:123>" }).ok).toBe(false);
    expect(createAddReactionTool().validate({ emoji: "blob%3A123456789012345678" }).ok).toBe(false);
    expect(
      createCreatePollTool().validate({ question: "x".repeat(301), answers: ["a", "b"] }).ok,
    ).toBe(false);
    expect(createCreatePollTool().validate({ question: "Q", answers: ["a"] }).ok).toBe(false);
    expect(
      createCreatePollTool().validate({ question: "Q", answers: ["a", "b"], duration_hours: 769 })
        .ok,
    ).toBe(false);
    expect(createCreateThreadTool().validate({ name: "x".repeat(101) }).ok).toBe(false);
    expect(createPinMessageTool().validate({ message_ref: "m7" }).ok).toBe(true);
  });

  test("marks completed side effects as terminal results", async () => {
    const meta = {
      requestId: "r",
      toolCallId: "t",
      invocationId: "i",
    } satisfies IToolInvocationMeta;
    const cases: { tool: IClientTool; args: unknown }[] = [
      { tool: createAddReactionTool(), args: { emoji: "👍" } },
      { tool: createCreatePollTool(), args: { question: "Q", answers: ["a", "b"] } },
      { tool: createCreateThreadTool(), args: { name: "topic" } },
      { tool: createPinMessageTool(), args: {} },
    ];
    for (const { tool, args } of cases) {
      const result = await tool.handler(args, context(), new AbortController().signal, meta);
      expect(result).toEqual({ llmResult: '{"ok":true}', terminal: true });
    }
  });
});
