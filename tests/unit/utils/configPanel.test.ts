import { describe, expect, test } from "bun:test";
import { ComponentType, MessageFlags } from "discord.js";
import {
  buildConfigPanel,
  CONFIG_PAGES,
  CONFIG_SWITCHES,
  type ConfigAction,
  type ConfigPage,
  type ConfigSwitch,
  configCustomId,
  parseConfigCustomId,
} from "../../../src/utils/configPanel";
import { createMockGuildSettings } from "../../helpers/mockFactories";

function countParts(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  const part = value as { type?: number; components?: unknown[]; accessory?: unknown };
  return (
    (part.type ? 1 : 0) +
    (part.components ?? []).reduce<number>((sum, child) => sum + countParts(child), 0) +
    countParts(part.accessory)
  );
}

const actions: ConfigAction[] = [
  { action: "open" },
  { action: "page" },
  { page: "admin", action: "role" },
  { page: "admin", action: "clear" },
  ...(["auto", "allowed"] as const).flatMap((list): ConfigAction[] => [
    { page: "channels", action: "add", list },
    { page: "channels", action: "remove", list },
    { page: "channels", action: "list", list, index: 123 },
  ]),
  ...(Object.keys(CONFIG_SWITCHES) as ConfigSwitch[]).flatMap((key): ConfigAction[] =>
    [true, false].map((enabled) => ({
      action: "set",
      page: CONFIG_SWITCHES[key].page,
      key,
      enabled,
    })),
  ),
];

describe("config custom IDs", () => {
  test.each(actions)("round trip %j", (action) => {
    const id = configCustomId(action);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(parseConfigCustomId(id)).toEqual(action);
  });
  test.each([
    "",
    "cfg",
    "cfg:open:extra",
    "cfg:page:extra",
    "cfg:features:set:free_only:on",
    "cfg:response:set:unknown:on",
    "cfg:response:set:free_only:yes",
    "cfg:response:set:free_only:on:extra",
    "cfg:channels:list:auto:-1",
    "cfg:channels:list:auto:1.2",
    "cfg:channels:list:auto:01",
    "cfg:channels:list:auto:9007199254740992",
    "cfg:channels:remove:unknown",
    "cfg:admin:role:extra",
    `cfg:${"a".repeat(100)}`,
  ])("reject %s", (id) => expect(parseConfigCustomId(id)).toBeUndefined());
});

describe("config pages", () => {
  test.each(Object.keys(CONFIG_PAGES) as ConfigPage[])("%s has at most 40 components", (page) => {
    const channels = Array.from({ length: 80 }, (_, i) => `${100000000000000000n + BigInt(i)}`);
    const settings = createMockGuildSettings({
      autoReplyChannels: channels,
      allowedChannels: channels.map((id) => `${BigInt(id) + 1000n}`),
      updatedBy: "200000000000000000",
    });
    const panel = buildConfigPanel(page, settings);
    const json = panel.components[0].toJSON();
    expect(countParts(json)).toBeLessThanOrEqual(40);
    expect(panel.flags).toBe(MessageFlags.IsComponentsV2);
    expect(panel.allowedMentions).toEqual({ parse: [] });
    expect(json.components[0].type).toBe(ComponentType.ActionRow);
    expect(JSON.stringify(json)).toContain("<@200000000000000000>");
    const textLength = (value: unknown): number => {
      if (!value || typeof value !== "object") return 0;
      const part = value as { content?: string; components?: unknown[] };
      return (
        (part.content?.length ?? 0) +
        (part.components ?? []).reduce<number>((sum, child) => sum + textLength(child), 0)
      );
    };
    expect(textLength(json)).toBeLessThanOrEqual(4000);
  });
  test("channel pagination reaches item 26 and clamps after removals", () => {
    const channels = Array.from({ length: 26 }, (_, i) => `channel-${i}`);
    const settings = createMockGuildSettings({ autoReplyChannels: channels });
    const json = buildConfigPanel("channels", settings, { autoPage: 1 }).components[0].toJSON();
    expect(JSON.stringify(json)).toContain("channel-25");
    expect(JSON.stringify(json)).not.toContain('"value":"channel-0"');
    expect(
      JSON.stringify(
        buildConfigPanel(
          "channels",
          { ...settings, autoReplyChannels: channels.slice(0, 1) },
          { autoPage: 1 },
        ).components[0].toJSON(),
      ),
    ).toContain('"value":"channel-0"');
  });
  test("empty lists explain defaults and parent permission avoids a false warning", () => {
    const settings = createMockGuildSettings();
    const empty = JSON.stringify(buildConfigPanel("channels", settings).components[0].toJSON());
    expect(empty).toContain("自動応答なし");
    expect(empty).toContain("全チャンネルで応答");
    expect(empty).not.toContain("<@");
    const json = JSON.stringify(
      buildConfigPanel(
        "channels",
        { ...settings, autoReplyChannels: ["thread", "outside"], allowedChannels: ["parent"] },
        { channel: (id) => ({ name: id, parentId: id === "thread" ? "parent" : null }) },
      ).components[0].toJSON(),
    );
    expect(json).toContain("<#outside> — 許可チャンネル外のため応答しない");
    expect(json).not.toContain("<#thread> —");
    expect(JSON.stringify(buildConfigPanel("admin", settings).components[0].toJSON())).toContain(
      "の持ち主だけが変更できる",
    );
  });
});
