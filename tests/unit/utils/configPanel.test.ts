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
  { page: "admin", action: "release" },
  { page: "admin", action: "release-clear" },
  ...(["auto", "allowed"] as const).flatMap((list): ConfigAction[] => [
    { page: "channels", action: "add", list },
    { page: "channels", action: "remove", list },
    { page: "channels", action: "list", list, index: 123 },
    { page: "channels", action: "add", list, autoPage: 1, allowedPage: 2 },
    { page: "channels", action: "remove", list, autoPage: 2, allowedPage: 1 },
    {
      page: "channels",
      action: "list",
      list,
      index: 123,
      autoPage: Number.MAX_SAFE_INTEGER,
      allowedPage: Number.MAX_SAFE_INTEGER,
    },
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
    "cfg:channels:add:auto:1",
    "cfg:channels:add:auto:01:0",
    "cfg:channels:remove:allowed:0:-1",
    "cfg:channels:list:auto:1:0:9007199254740992",
    "cfg:channels:list:auto:-1:0:0",
    "cfg:channels:list:allowed:1:1.2:0",
    "cfg:channels:list:auto:1:0:0:extra",
    "cfg:admin:role:extra",
    `cfg:${"a".repeat(100)}`,
  ])("reject %s", (id) => expect(parseConfigCustomId(id)).toBeUndefined());
});

describe("config pages", () => {
  test("an untouched guild does not claim a last change", () => {
    const settings = createMockGuildSettings({ updatedBy: null, settingsVersion: 0 });
    expect(JSON.stringify(buildConfigPanel("response", settings))).not.toContain("最終変更");
    expect(
      JSON.stringify(buildConfigPanel("response", { ...settings, settingsVersion: 1 })),
    ).toContain("最終変更");
  });
  test("uncached channels have unknown eligibility unless directly allowed", () => {
    const settings = createMockGuildSettings({
      autoReplyChannels: ["archived", "direct"],
      allowedChannels: ["parent", "direct"],
    });
    const json = JSON.stringify(buildConfigPanel("channels", settings));
    expect(json).not.toContain("許可チャンネル外のため応答しない");
    expect(json).toContain("<#archived> — 親チャンネルが不明のため応答可否を確認できません");
    expect(json).not.toContain("<#direct> —");
  });
  test("all list controls carry both clamped page positions", () => {
    const channels = Array.from({ length: 60 }, (_, i) => `channel-${i}`);
    const json = JSON.stringify(
      buildConfigPanel(
        "channels",
        createMockGuildSettings({
          autoReplyChannels: channels.slice(0, 30),
          allowedChannels: channels,
        }),
        { autoPage: 2, allowedPage: 1 },
      ),
    );
    for (const list of ["auto", "allowed"]) {
      expect(json).toContain(`cfg:channels:add:${list}:1:1`);
      expect(json).toContain(`cfg:channels:remove:${list}:1:1`);
      expect(json).toContain(`cfg:channels:list:${list}:0:1:1`);
      expect(json).toContain(`cfg:channels:list:${list}:2:1:1`);
    }
  });
  test("admin page exposes one text or announcement destination and the disabled clear button", () => {
    const empty = JSON.stringify(buildConfigPanel("admin", createMockGuildSettings()));
    expect(empty).toContain("通知しない");
    expect(empty).toContain('"channel_types":[0,5]');
    expect(empty).toContain('"min_values":1');
    expect(empty).toContain('"max_values":1');
    const selected = JSON.stringify(
      buildConfigPanel("admin", createMockGuildSettings({ releaseAnnounceChannelId: "channel" })),
    );
    expect(selected).toContain("<#channel>");
    expect(selected).toContain("cfg:admin:release-clear");
  });
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
