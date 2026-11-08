import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MessageFlags, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { connectCommand, disconnectCommand } from "../../../../src/bot/commands/connect";
import {
  type ConnectInteraction,
  createConnectHandler,
  guildBalanceText,
} from "../../../../src/bot/events/connectHandler";
import { OAuthError } from "../../../../src/llm/openrouterAuth";
import type { ConnectionHooks } from "../../../../src/services/apiKeyService";
import { REPLY_GATE_MODEL } from "../../../../src/services/replyGateService";
import { buildErrorContainer } from "../../../../src/utils/chatContainerBuilder";
import { logger } from "../../../../src/utils/logger";
import { metrics } from "../../../../src/utils/metrics";
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
    callbackAuthorized?: boolean;
    adminRoleId?: string;
  } = {},
): {
  keys: ReturnType<typeof createMockApiKeyService>;
  interaction: ConnectInteraction;
  reply: ReturnType<typeof mock>;
  edit: ReturnType<typeof mock>;
  defer: ReturnType<typeof mock>;
  modal: ReturnType<typeof mock>;
  fetchMember: ReturnType<typeof mock>;
  run: () => Promise<void>;
} {
  const keys = createMockApiKeyService();
  const settings = createMockSettingsService();
  settings.getGuildSettings = mock(async () =>
    createMockGuildSettings({ adminRoleId: options.adminRoleId ?? null }),
  );
  const reply = mock(async () => {});
  const edit = mock(async () => {});
  const modal = mock(async () => {});
  const fetchMember = mock(async () => ({
    permissions: new PermissionsBitField(
      options.callbackAuthorized === false ? 0n : PermissionFlagsBits.ManageGuild,
    ),
    roles: { cache: new Map(options.adminRoleId ? [[options.adminRoleId, {}]] : []) },
  }));
  const interaction = {
    commandName: options.command ?? "connect",
    guildId: options.dm ? null : "guild",
    user: { id: "actor" },
    memberPermissions: new PermissionsBitField(
      options.authorized ? PermissionFlagsBits.ManageGuild : 0n,
    ),
    member: { roles: options.adminRoleId ? [options.adminRoleId] : [] },
    client: {
      guilds: {
        fetch: mock(async () => ({
          members: {
            fetch: fetchMember,
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
    fetchMember,
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
    expect(h.fetchMember).toHaveBeenCalledWith({ user: "actor", force: true, cache: false });
    await hooks.report("connected");
    expect(output(h.edit)).toContain("接続しました");
    expect(output(h.edit)).toContain("入出力ログ");
    expect(output(h.edit)).toContain(
      "アカウントの持ち主（組織の workspace では組織の管理者も）が入力と出力を読めます",
    );
    expect(output(h.edit)).toContain(REPLY_GATE_MODEL);
  });
  test("guild callback refuses a member who lost management permission", async () => {
    const h = harness("guild", { authorized: true, callbackAuthorized: false });
    Object.assign(h.keys, { connectionMode: "callback" });
    await h.run();
    const hooks = (h.keys.startConnection as ReturnType<typeof mock>).mock
      .calls[0]?.[2] as ConnectionHooks;
    expect(await hooks.authorize()).toBe(false);
  });
  test("guild callback authorizes a member with only the configured admin role", async () => {
    const h = harness("guild", { adminRoleId: "admin-role", callbackAuthorized: false });
    Object.assign(h.keys, { connectionMode: "callback" });
    await h.run();
    expect(h.keys.startConnection).toHaveBeenCalledTimes(1);
    const hooks = (h.keys.startConnection as ReturnType<typeof mock>).mock
      .calls[0]?.[2] as ConnectionHooks;
    expect(await hooks.authorize()).toBe(true);
    expect(h.fetchMember).toHaveBeenCalledWith({ user: "actor", force: true, cache: false });
  });
  test.each(["connected", "disconnected", "unreadable"] as const)(
    "status exposes only the guild %s label",
    async (status) => {
      const h = harness("status");
      h.keys.getConnection = mock((target) =>
        target.scope === "user"
          ? { status: "disconnected" as const }
          : status === "connected"
            ? { status, keyHash: "guild-secret-hash" }
            : { status },
      );
      await h.run();
      const text = output(h.edit);
      expect(text).toContain(
        `サーバー: ${{ connected: "接続済み", disconnected: "未接続", unreadable: "取得できません" }[status]}`,
      );
      expect(text).not.toContain("guild-secret-hash");
      expect(text).not.toContain("https://openrouter.ai/");
      expect(text).not.toContain("接続し直してください");
    },
  );
  test("permission denial and connection failure use the error container", async () => {
    const denied = harness("guild");
    await denied.run();
    const expectedColor = buildErrorContainer("fixture").toJSON().accent_color;
    expect(
      (
        denied.reply.mock.calls[0][0] as {
          components: { toJSON(): { accent_color?: number | null } }[];
        }
      ).components[0]?.toJSON().accent_color,
    ).toBe(expectedColor);
    const failed = harness("user", { kind: "modal" });
    failed.keys.completeConnection = mock(async () => {
      throw new Error("fixture");
    });
    await failed.run();
    expect(
      (
        failed.edit.mock.calls[0][0] as {
          components: { toJSON(): { accent_color?: number | null } }[];
        }
      ).components[0]?.toJSON().accent_color,
    ).toBe(expectedColor);
  });
  test.each(["connect", "disconnect"])("%s counts executions and failures", async (command) => {
    const counts = spyOn(metrics, "increment");
    try {
      const h = harness("user", { command });
      await h.run();
      expect(counts).toHaveBeenCalledWith(`command.${command}`);
      expect(counts).not.toHaveBeenCalledWith("command.errors");
      const failure = (): never => {
        throw new Error("fixture");
      };
      h.keys.startConnection = mock(failure);
      h.keys.disconnect = mock(failure);
      await h.run();
      expect(counts).toHaveBeenCalledWith("command.errors");
    } finally {
      counts.mockRestore();
    }
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
      return "connected" as const;
    });
    await h.run();
    expect(h.keys.completeConnection).toHaveBeenCalledWith(
      "actor",
      { scope: "guild", guildId: "guild" },
      "code-fixture",
    );
  });
  test("a second modal submission shows processing without suggesting a new connection", async () => {
    const h = harness("user", { kind: "modal" });
    h.keys.completeConnection = mock(async () => "processing" as const);
    await h.run();
    expect(output(h.edit)).toContain("処理中です。結果をお待ちください。");
    expect(output(h.edit)).not.toContain("/connect");
    expect(output(h.edit)).not.toContain("接続しました");
  });
  test.each([true, false])(
    "modal failure offers code reentry only with pending=%s",
    async (pending) => {
      const h = harness("user", { kind: "modal" });
      h.keys.hasPendingConnection = mock(() => pending);
      h.keys.completeConnection = mock(async () => {
        throw new OAuthError();
      });
      await h.run();
      expect(output(h.edit)).toContain(
        pending
          ? "コードを確認して同じメッセージの「コードを入力」から入力し直すか、`/connect` からやり直してください。"
          : "接続できませんでした。`/connect` からやり直してください。",
      );
      expect(output(h.edit).includes("コードを入力")).toBe(pending);
    },
  );
  test("callback failure keeps the instruction to start a new connection", async () => {
    const h = harness("user");
    Object.assign(h.keys, { connectionMode: "callback" });
    await h.run();
    const hooks = (h.keys.startConnection as ReturnType<typeof mock>).mock
      .calls[0]?.[2] as ConnectionHooks;
    await hooks.report("failed");
    expect(output(h.edit)).toContain("接続できませんでした。`/connect` からやり直してください。");
    expect(output(h.edit)).not.toContain("コードを入力");
  });
  test.each(["button", "modal"] as const)(
    "%s notification failure resolves and logs safe metadata",
    async (kind) => {
      const h = harness("user", { kind });
      const fail = async (): Promise<never> => {
        throw Object.assign(new Error("secret-message key code state verifier"), {
          name: "secret-name",
        });
      };
      h.keys.hasPendingConnection = mock(() => true);
      if (kind === "button") {
        h.modal.mockImplementation(fail);
        h.reply.mockImplementation(fail);
      } else {
        h.keys.completeConnection = mock(fail);
        h.edit.mockImplementation(fail);
      }
      const logs = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await expect(h.run()).resolves.toBeUndefined();
        expect(logs.mock.calls).toEqual([
          ["OpenRouter connection operation failed", { stage: "interaction", errorType: "Error" }],
          [
            "Failed to report the OpenRouter connection failure",
            { stage: "report", errorType: "Error" },
          ],
        ]);
        expect(JSON.stringify(logs.mock.calls)).not.toContain("secret");
      } finally {
        logs.mockRestore();
      }
    },
  );
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
