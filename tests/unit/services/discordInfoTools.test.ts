import { expect, mock, test } from "bun:test";
import { ChannelType } from "discord.js";
import { createGetChannelInfoTool } from "../../../src/llm/tools/discord/getChannelInfo";
import { createListEventsTool } from "../../../src/llm/tools/discord/listEvents";
import { createListPinsTool } from "../../../src/llm/tools/discord/listPins";
import type { IToolContext } from "../../../src/llm/tools/registry";
import { ToolRegistry } from "../../../src/llm/tools/registry";

function context(): IToolContext {
  return {
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    conversation: {
      resolveMessageRef: () => undefined,
      readEarlierMessages: async () => "",
      viewAttachment: async () => "",
    },
    discordInfo: {
      channelType: ChannelType.GuildText,
      listPins: mock(async () => '{"pins":[]}'),
      getChannelInfo: mock(async () => '{"name":"channel"}'),
      listEvents: mock(async () => '{"active":{"events":[]},"scheduled":{"events":[]}}'),
    },
  };
}
const tools = [createListPinsTool(), createGetChannelInfoTool(), createListEventsTool()];

test.each([
  "history-off",
  "no-tool-support",
  "voice",
  "stage",
  "forum",
  "wrong-parent",
  "no-context",
  "dm",
])("information tools are not offered for %s", (kind) => {
  const ctx = context();
  if (kind === "history-off") delete ctx.conversation;
  if (kind === "no-context") delete ctx.discordInfo;
  if (kind === "no-tool-support") ctx.toolsAllowed = false;
  if (kind === "dm") ctx.guildId = null;
  const types: Record<string, number> = {
    voice: ChannelType.GuildVoice,
    stage: ChannelType.GuildStageVoice,
    forum: ChannelType.GuildForum,
    "wrong-parent": -1,
  };
  const type = types[kind];
  if (type !== undefined && ctx.discordInfo) ctx.discordInfo.channelType = type;
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  expect(registry.buildTools(ctx)).toEqual([]);
});
test.each([ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread])(
  "tools enabled in supported channel %s",
  (type) => {
    const ctx = context();
    if (!ctx.discordInfo) throw new Error("missing info context");
    ctx.discordInfo.channelType = type;
    expect(tools.map((tool) => tool.isEnabled(ctx))).toEqual([true, true, true]);
  },
);
test("pin timestamps require offset and unknown args are rejected", () => {
  const tool = createListPinsTool();
  for (const value of [
    null,
    [],
    { before: 3 },
    { before: "2026-10-09T00:00:00" },
    { before: "bad" },
    { before: "2026-02-30T00:00:00Z" },
    { before: "2026-10-09T24:00:00Z" },
    { count: 5 },
  ])
    expect(tool.validate(value).ok).toBe(false);
  expect(tool.validate({}).ok).toBe(true);
  expect(tool.validate({ before: "2026-10-09T09:00:00+09:00" }).ok).toBe(true);
  expect(tool.validate({ before: "2026-10-09T00:00:00Z" }).ok).toBe(true);
});
test("event timestamps require offset and ordered bounds", () => {
  const tool = createListEventsTool();
  for (const value of [
    null,
    [],
    { from: "2026-10-09" },
    { until: 2 },
    { from: "2026-10-10T00:00:00Z", until: "2026-10-09T00:00:00Z" },
    { extra: true },
  ])
    expect(tool.validate(value).ok).toBe(false);
  expect(tool.validate({}).ok).toBe(true);
  expect(tool.validate({ until: "2026-10-10T00:00:00+09:00" }).ok).toBe(true);
});
test("channel info rejects arguments", () => {
  const tool = createGetChannelInfoTool();
  expect(tool.validate({}).ok).toBe(true);
  for (const value of [null, [], { channel: "other" }]) expect(tool.validate(value).ok).toBe(false);
});
test("handlers pass token budgets and use terminal for empty reports", async () => {
  const ctx = context();
  ctx.resultBudgetTokens = 100;
  const signal = new AbortController().signal;
  const meta = { requestId: "r", toolCallId: "c", invocationId: "i" };
  expect(
    (await createListPinsTool().handler({ before: "2026-10-09T00:00:00Z" }, ctx, signal, meta))
      .terminal,
  ).toBe(true);
  expect(ctx.discordInfo?.listPins).toHaveBeenCalledWith("2026-10-09T00:00:00Z", signal, 100);
  expect((await createListEventsTool().handler({}, ctx, signal, meta)).terminal).toBe(true);
  expect(ctx.discordInfo?.listEvents).toHaveBeenCalledWith(undefined, undefined, signal, 100);
  expect((await createGetChannelInfoTool().handler({}, ctx, signal, meta)).terminal).toBe(false);
  expect(ctx.discordInfo?.getChannelInfo).toHaveBeenCalledWith(signal, 100);
});
