import { describe, expect, mock, test } from "bun:test";
import { ChannelType } from "discord.js";
import { createAddReactionTool } from "../../../../../src/llm/tools/discord/addReaction";
import { createCreateEventTool } from "../../../../../src/llm/tools/discord/createEvent";
import { createCreatePollTool } from "../../../../../src/llm/tools/discord/createPoll";
import { createCreateThreadTool } from "../../../../../src/llm/tools/discord/createThread";
import { createPinMessageTool } from "../../../../../src/llm/tools/discord/pinMessage";
import type {
  DiscordToolContext,
  IClientTool,
  IToolContext,
  IToolInvocationMeta,
} from "../../../../../src/llm/tools/registry";
import { ToolRegistry } from "../../../../../src/llm/tools/registry";
import { ToolDispatcher } from "../../../../../src/llm/tools/toolHandler";

const tools = [
  createAddReactionTool(),
  createCreatePollTool(),
  createCreateThreadTool(),
  createPinMessageTool(),
  createCreateEventTool(),
];
const discord: DiscordToolContext = {
  channelType: ChannelType.GuildText,
  addReaction: mock(async () => '{"ok":true}'),
  createPoll: mock(async () => '{"ok":true}'),
  createThread: mock(async () => '{"ok":true}'),
  pinMessage: mock(async () => '{"ok":true}'),
  createEvent: mock(async () => '{"ok":true,"url":"https://discord.com/events/guild/event"}'),
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

  test("create_event validates kind-specific arguments, lengths and offset timestamps", () => {
    const tool = createCreateEventTool();
    const external = {
      kind: "external" as const,
      name: "Meet",
      start: "2099-01-01T20:00:00+09:00",
      end: "2099-01-01T21:00:00+09:00",
      location: "Park",
    };
    const voice = {
      kind: "voice",
      name: "Meet",
      start: "2099-01-01T11:00:00Z",
      channel_name: "Meeting",
    };
    for (const valid of [
      external,
      voice,
      { ...voice, end: external.end },
      {
        ...external,
        name: "x".repeat(100),
        location: "x".repeat(100),
        description: "x".repeat(1000),
      },
      { ...voice, start: "2000-01-01T00:00:00Z" },
      { ...external, end: external.start },
    ])
      expect(tool.validate(valid).ok).toBe(true);
    const emptyDescription = tool.validate({ ...external, description: "" });
    expect(emptyDescription).toEqual({ ok: true, value: external });
    for (const invalid of [
      null,
      [],
      "event",
      {},
      { ...external, kind: "stage" },
      { ...external, kind: undefined },
      { ...external, name: undefined },
      { ...external, name: "" },
      { ...external, name: "x".repeat(101) },
      { ...external, start: undefined },
      { ...external, start: "2099-01-01T20:00:00" },
      { ...external, start: "2099-02-30T20:00:00Z" },
      { ...external, start: "2099-01-01T25:00:00Z" },
      { ...external, start: "2099-01-01T20:00:00+09:60" },
      { ...external, start: 42 },
      { ...external, end: undefined },
      { ...external, end: "tomorrow" },
      { ...external, end: "2099-01-01T21:00:00" },
      { ...voice, end: null },
      { ...external, location: undefined },
      { ...external, location: "" },
      { ...external, location: "x".repeat(101) },
      { ...external, location: 42 },
      { ...external, channel_name: "Meeting" },
      { ...voice, channel_name: undefined },
      { ...voice, channel_name: "" },
      { ...voice, channel_name: 42 },
      { ...voice, location: "Park" },
      { ...external, description: "x".repeat(1001) },
      { ...external, description: null },
      { ...voice, unexpected: true },
    ])
      expect(tool.validate(invalid).ok).toBe(false);
  });

  test("create_event returns exactly URL JSON as a terminal result and forwards validated arguments", async () => {
    const tool = createCreateEventTool();
    const args = {
      kind: "external" as const,
      name: "Meet",
      start: "2099-01-01T20:00:00+09:00",
      end: "2099-01-01T21:00:00+09:00",
      location: "Park",
    };
    const signal = new AbortController().signal;
    const meta = { requestId: "r", toolCallId: "t", invocationId: "i" };
    expect(await tool.handler(args, context({ resultBudgetTokens: 0 }), signal, meta)).toEqual({
      llmResult: '{"ok":true,"url":"https://discord.com/events/guild/event"}',
      terminal: true,
    });
    expect(discord.createEvent).toHaveBeenCalledWith(args, signal);
    expect(await tool.handler(args, context({ discord: undefined }), signal, meta)).toEqual({
      llmResult: '{"ok":false,"reason":"unavailable"}',
      terminal: true,
    });
  });

  test("create_event URL fits the fixed result allowance with an exhausted budget", async () => {
    const registry = new ToolRegistry();
    registry.register(createCreateEventTool());
    const urlResult =
      '{"ok":true,"url":"https://discord.com/events/18446744073709551615/18446744073709551615"}';
    const ctx = context({
      resultBudgetTokens: 0,
      discord: { ...discord, createEvent: mock(async () => urlResult) },
    });
    const outcome = await new ToolDispatcher(registry).dispatch(
      {
        index: 0,
        id: "call",
        name: "create_event",
        rawArguments: JSON.stringify({
          kind: "voice",
          name: "Meet",
          start: "2099-01-01T00:00:00Z",
          channel_name: "Meeting",
        }),
      },
      { ctx, frozenToolNames: new Set(["create_event"]), requestId: "request" },
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.toolMessage.content).toBe(urlResult);
    expect(outcome.resultTooLarge).toBeUndefined();
    expect(registry.buildTools(context({ discord: undefined }))).toEqual([]);
  });
});
