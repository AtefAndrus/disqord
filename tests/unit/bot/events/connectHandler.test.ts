import { afterEach, describe, expect, mock, test } from "bun:test";
import { MessageFlags, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { connectCommand, disconnectCommand } from "../../../../src/bot/commands/connect";
import {
  type ConnectInteraction,
  createConnectHandler,
  guildBalanceText,
} from "../../../../src/bot/events/connectHandler";
import type { ConnectionHooks } from "../../../../src/services/apiKeyService";
import {
  createMockApiKeyService,
  createMockGuildSettings,
  createMockSettingsService,
} from "../../../helpers/mockFactories";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function harness(
  action: string,
  options: {
    kind?: "command" | "button" | "modal";
    command?: string;
    dm?: boolean;
    authorized?: boolean;
  } = {},
): {
  keys: ReturnType<typeof createMockApiKeyService>;
  interaction: ConnectInteraction;
  reply: ReturnType<typeof mock>;
  edit: ReturnType<typeof mock>;
  defer: ReturnType<typeof mock>;
  modal: ReturnType<typeof mock>;
  run: () => Promise<void>;
} {
  const keys = createMockApiKeyService();
  const settings = createMockSettingsService();
  settings.getGuildSettings = mock(async () => createMockGuildSettings({ adminRoleId: null }));
  const reply = mock(async () => {});
  const edit = mock(async () => {});
  const modal = mock(async () => {});
  const interaction = {
    commandName: options.command ?? "connect",
    guildId: options.dm ? null : "guild",
    user: { id: "actor" },
    memberPermissions: new PermissionsBitField(
      options.authorized ? PermissionFlagsBits.ManageGuild : 0n,
    ),
    member: { roles: [] },
    client: {
      guilds: {
        fetch: mock(async () => ({
          members: {
            fetch: mock(async () => ({
              permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
              roles: { cache: new Map() },
            })),
          },
        })),
      },
    },
    customId: `connect:${options.kind === "button" ? "enter" : "code"}:${action}`,
    options: { getSubcommand: () => action },
    fields: { getTextInputValue: () => "code-fixture" },
    deferred: false,
    replied: false,
    isChatInputCommand: () => !options.kind || options.kind === "command",
    isButton: () => options.kind === "button",
    isModalSubmit: () => options.kind === "modal",
    reply,
    editReply: edit,
    showModal: modal,
    deferReply: async (_payload: unknown) => {},
  };
  const defer = mock(async (_payload: unknown) => {
    interaction.deferred = true;
  });
  interaction.deferReply = defer;
  const typed = interaction as unknown as ConnectInteraction;
  return {
    keys,
    interaction: typed,
    reply,
    edit,
    defer,
    modal,
    run: () => createConnectHandler(keys, settings)(typed),
  };
}
function output(mocked: ReturnType<typeof mock>): string {
  return JSON.stringify(mocked.mock.calls);
}

describe("OpenRouter connection UI", () => {
  test("registers user, guild and status subcommands and permits DMs", () => {
    expect(connectCommand.toJSON().options?.map((option) => option.name)).toEqual([
      "user",
      "guild",
      "status",
    ]);
    expect(disconnectCommand.toJSON().options?.map((option) => option.name)).toEqual([
      "user",
      "guild",
    ]);
    expect(connectCommand.toJSON().contexts).toContain(1);
  });
  test.each(["paste", "callback"] as const)(
    "connect user in DM uses ephemeral %s UI",
    async (mode) => {
      const h = harness("user", { dm: true });
      Object.assign(h.keys, { connectionMode: mode });
      await h.run();
      expect(h.defer).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
      expect(h.keys.startConnection).toHaveBeenCalledWith(
        "actor",
        { scope: "user", userId: "actor" },
        expect.anything(),
      );
      const json = output(h.edit);
      for (const text of [
        "暗号化",
        "自分のクレジット",
        "自動応答と定期実行には使われません",
        "他人に渡さない",
        "アカウントの持ち主（組織の workspace では組織の管理者も）が入力と出力を読めます",
      ])
        expect(json).toContain(text);
      expect(json.includes("connect:enter:user")).toBe(mode === "paste");
      expect(json).not.toContain("code_verifier");
    },
  );
  test.each(["connect", "disconnect"])(
    "%s guild requires a guild and management permission",
    async (command) => {
      for (const dm of [false, true]) {
        const h = harness("guild", { command, dm });
        await h.run();
        expect(h.keys.startConnection).not.toHaveBeenCalled();
        expect(h.keys.disconnect).not.toHaveBeenCalled();
        expect(h.reply).toHaveBeenCalled();
      }
    },
  );
  test("guild callback reauthorizes with fresh member data and edits the ephemeral result", async () => {
    const h = harness("guild", { authorized: true });
    Object.assign(h.keys, { connectionMode: "callback" });
    await h.run();
    const start = h.keys.startConnection as ReturnType<typeof mock>;
    const hooks = start.mock.calls[0]?.[2] as ConnectionHooks;
    expect(await hooks.authorize()).toBe(true);
    expect(h.interaction.client.guilds.fetch).toHaveBeenCalledWith("guild");
    await hooks.report("connected");
    expect(output(h.edit)).toContain("接続しました");
    expect(output(h.edit)).toContain("入出力ログ");
    expect(output(h.edit)).toContain(
      "アカウントの持ち主（組織の workspace では組織の管理者も）が入力と出力を読めます",
    );
    expect(output(h.edit)).toContain("typesafe/jev-1.14");
  });
  test("code-entry button requires current pending request and contains only scope", async () => {
    const h = harness("user", { kind: "button" });
    await h.run();
    expect(h.modal).not.toHaveBeenCalled();
    h.keys.hasPendingConnection = mock(() => true);
    await h.run();
    expect(output(h.modal)).toContain("connect:code:user");
    expect(output(h.modal)).not.toContain("code_verifier");
  });
  test("modal defers before completing and checks guild authorization again", async () => {
    const denied = harness("guild", { kind: "modal" });
    await denied.run();
    expect(denied.keys.completeConnection).not.toHaveBeenCalled();
    const h = harness("guild", { kind: "modal", authorized: true });
    h.keys.completeConnection = mock(async () => {
      expect(h.defer).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    });
    await h.run();
    expect(h.keys.completeConnection).toHaveBeenCalledWith(
      "actor",
      { scope: "guild", guildId: "guild" },
      "code-fixture",
    );
  });
  test("disconnect DM uses the saved hash and keeps instructions to delete the remote key", async () => {
    const h = harness("user", { command: "disconnect", dm: true });
    h.keys.disconnect = mock(() => ({ removed: true, keyHash: "hash-fixture" }));
    await h.run();
    expect(output(h.edit)).toContain("https://openrouter.ai/keys/hash-fixture");
    expect(output(h.edit)).toContain("OpenRouter 上のキーは残る");
  });
  test("status shows user cap privately and guild status, and guild balance never selects user", async () => {
    const h = harness("status");
    h.keys.getConnection = mock(() => ({ status: "connected" as const, keyHash: "hash-fixture" }));
    h.keys.resolveForMention = mock(() => ({ key: "user-fixture", source: "user" as const }));
    h.keys.resolveForGuild = mock(() => ({ key: "guild-fixture", source: "guild" as const }));
    globalThis.fetch = mock(async () =>
      Response.json({ data: { limit_remaining: null } }),
    ) as unknown as typeof globalThis.fetch;
    await h.run();
    expect(h.defer).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(output(h.edit)).toContain("上限なし");
    expect(await guildBalanceText(h.keys, "guild")).toContain("上限なし");
    expect(h.keys.resolveForGuild).toHaveBeenCalledWith("guild");
    h.keys.resolveForGuild = mock(() => {
      throw new Error("fixture");
    });
    expect(await guildBalanceText(h.keys, "guild")).toBe("取得できません");
  });
  test("disabled connection feature answers privately", async () => {
    const h = harness("user");
    Object.assign(h.keys, { enabled: false });
    await h.run();
    expect(h.keys.startConnection).not.toHaveBeenCalled();
    expect(output(h.reply)).toContain("無効");
  });
});
