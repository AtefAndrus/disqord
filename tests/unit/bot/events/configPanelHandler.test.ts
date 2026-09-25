import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  type Interaction,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import {
  type CommandHandlers,
  createInteractionCreateHandler,
} from "../../../../src/bot/events/interactionCreate";
import { GuildSettingsRepository } from "../../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../../src/db/schema";
import { describeSearchBilling } from "../../../../src/llm/tools/webSearch";
import type { IChatService } from "../../../../src/services/chatService";
import type { IModelService } from "../../../../src/services/modelService";
import { SettingsService } from "../../../../src/services/settingsService";
import {
  CONFIG_SWITCHES,
  type ConfigSwitch,
  configCustomId,
} from "../../../../src/utils/configPanel";
import { createMockLLMClient } from "../../../helpers/mockFactories";

function interaction(
  customId: string,
  kind = "button",
  values: string[] = [],
  manage = true,
  roles: string[] = [],
) {
  const fixture = {
    customId,
    guildId: "guild",
    guild: null,
    user: { id: "actor" },
    values,
    roles: new Map<string, { managed: boolean }>(),
    member: { roles },
    memberPermissions: new PermissionsBitField(manage ? [PermissionFlagsBits.ManageGuild] : []),
    isAutocomplete: () => false,
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "string",
    isChannelSelectMenu: () => kind === "channel",
    isRoleSelectMenu: () => kind === "role",
    isChatInputCommand: () => false,
    replied: false,
    deferred: false,
    reply: mock(async (_payload: unknown): Promise<void> => {}),
    followUp: mock(async (_payload: unknown): Promise<void> => {}),
    update: mock(async (_payload: unknown): Promise<void> => {}),
    editReply: mock(async (_payload: unknown): Promise<void> => {}),
    deferUpdate: mock(async (): Promise<void> => {
      fixture.deferred = true;
    }),
  };
  return fixture;
}
function flags(payload: unknown): number {
  return (payload as { flags: number }).flags;
}

describe("config panel interactions", () => {
  let db: Database;
  let service: SettingsService;
  let model: IModelService;
  let handler: (value: Interaction) => Promise<void>;
  const llm = createMockLLMClient();
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    service = new SettingsService(new GuildSettingsRepository(db, "free/model"));
    model = {
      isFreeModel: mock(async () => true),
      refreshCache: mock(async () => {}),
      getCacheStatus: () => ({ lastUpdatedAt: null, modelCount: 0 }),
    } as unknown as IModelService;
    handler = createInteractionCreateHandler(
      {} as CommandHandlers,
      service,
      model,
      llm,
      {} as IChatService,
      "perplexity",
    );
  });
  afterEach(() => {
    db.close();
  });
  test.each(
    (Object.keys(CONFIG_SWITCHES) as ConfigSwitch[]).flatMap((key) =>
      [true, false].map((enabled) => ({ key, enabled })),
    ),
  )("sets explicit value %j and records actor", async ({ key, enabled }) => {
    const action = { action: "set" as const, page: CONFIG_SWITCHES[key].page, key, enabled };
    const press = interaction(configCustomId(action));
    await handler(press as unknown as Interaction);
    const settings = await service.getGuildSettings("guild");
    expect(settings[CONFIG_SWITCHES[key].field]).toBe(enabled);
    expect(settings.settingsVersion).toBe(1);
    expect(settings.updatedBy).toBe("actor");
    expect(press.update.mock.calls.length + press.editReply.mock.calls.length).toBe(1);
    expect(press.reply).not.toHaveBeenCalled();
    const second = interaction(configCustomId(action));
    await handler(second as unknown as Interaction);
    expect((await service.getGuildSettings("guild"))[CONFIG_SWITCHES[key].field]).toBe(enabled);
    expect((await service.getGuildSettings("guild")).settingsVersion).toBe(2);
  });
  test("reads authorization on each press after the delegated role changes", async () => {
    await service.setAdminRoleId("guild", "admin");
    const first = interaction("cfg:features:set:history:on", "button", [], false, ["admin"]);
    await handler(first as unknown as Interaction);
    expect((await service.getGuildSettings("guild")).historyEnabled).toBe(true);
    expect((await service.getGuildSettings("guild")).updatedBy).toBe("actor");
    expect(first.update).toHaveBeenCalledTimes(1);
    expect(first.reply).not.toHaveBeenCalled();
    await service.setAdminRoleId("guild", "replacement");
    const before = await service.getGuildSettings("guild");
    const second = interaction("cfg:features:set:history:off", "button", [], false, ["admin"]);
    await handler(second as unknown as Interaction);
    expect(await service.getGuildSettings("guild")).toEqual(before);
    expect(second.update).not.toHaveBeenCalled();
    expect(flags(second.reply.mock.calls[0][0]) & MessageFlags.Ephemeral).toBeTruthy();
  });
  test.each(["role", "clear"])(
    "delegated administrator cannot %s the admin role",
    async (action) => {
      await service.setAdminRoleId("guild", "admin");
      const before = await service.getGuildSettings("guild");
      const press = interaction(
        `cfg:admin:${action}`,
        action === "role" ? "role" : "button",
        ["replacement"],
        false,
        ["admin"],
      );
      await handler(press as unknown as Interaction);
      expect(await service.getGuildSettings("guild")).toEqual(before);
      expect(flags(press.reply.mock.calls[0][0]) & MessageFlags.Ephemeral).toBeTruthy();
    },
  );
  test("ManageGuild can assign and clear the role", async () => {
    await handler(interaction("cfg:admin:role", "role", ["admin"]) as unknown as Interaction);
    expect((await service.getGuildSettings("guild")).adminRoleId).toBe("admin");
    await handler(interaction("cfg:admin:clear") as unknown as Interaction);
    expect((await service.getGuildSettings("guild")).adminRoleId).toBeNull();
  });
  test.each(["guild", "managed"])("rejects unsafe admin role %s privately", async (id) => {
    const before = await service.getGuildSettings("guild");
    const press = interaction("cfg:admin:role", "role", [id]);
    press.roles.set(id, { managed: id === "managed" });
    await handler(press as unknown as Interaction);
    expect(await service.getGuildSettings("guild")).toEqual(before);
    expect(press.update).not.toHaveBeenCalled();
    expect(flags(press.reply.mock.calls[0]?.[0]) & MessageFlags.Ephemeral).toBeTruthy();
    expect(JSON.stringify(press.reply.mock.calls[0][0])).toContain(
      id === "guild" ? "@everyone" : "連携",
    );
  });
  test("enabling native search explains its uncapped billing privately", async () => {
    handler = createInteractionCreateHandler(
      {} as CommandHandlers,
      service,
      model,
      llm,
      {} as IChatService,
      "native",
    );
    const press = interaction("cfg:features:set:web_search:on");
    await handler(press as unknown as Interaction);
    expect((await service.getGuildSettings("guild")).webSearchEnabled).toBe(true);
    expect(press.update).toHaveBeenCalledTimes(1);
    expect(press.followUp).toHaveBeenCalledTimes(1);
    expect(flags(press.followUp.mock.calls[0][0]) & MessageFlags.Ephemeral).toBeTruthy();
    expect(JSON.stringify(press.followUp.mock.calls[0][0])).toContain(
      describeSearchBilling("native"),
    );
    const off = interaction("cfg:features:set:web_search:off");
    await handler(off as unknown as Interaction);
    expect(off.followUp).not.toHaveBeenCalled();
  });
  test.each(["auto", "allowed"])(
    "%s add/remove and navigation preserve both lists",
    async (list) => {
      for (let i = 0; i < 60; i++) {
        await service.addAutoReplyChannel("guild", `auto-${i}`);
        await service.addAllowedChannel("guild", `allowed-${i}`);
      }
      const add = interaction(`cfg:channels:add:${list}:1:1`, "channel", ["extra"]);
      await handler(add as unknown as Interaction);
      expect(
        (await service.getGuildSettings("guild"))[
          list === "auto" ? "autoReplyChannels" : "allowedChannels"
        ],
      ).toContain("extra");
      const remove = interaction(`cfg:channels:remove:${list}:1:1`, "string", [`${list}-26`]);
      await handler(remove as unknown as Interaction);
      for (const press of [add, remove]) {
        const json = JSON.stringify(press.update.mock.calls[0]?.[0]);
        expect(json).toContain('"value":"auto-25"');
        expect(json).toContain('"value":"allowed-25"');
        expect(json).not.toContain('"value":"auto-0"');
        expect(json).not.toContain('"value":"allowed-0"');
      }
      const next = interaction(`cfg:channels:list:${list}:2:1:1`);
      await handler(next as unknown as Interaction);
      const json = JSON.stringify(next.update.mock.calls[0]?.[0]);
      expect(json).toContain(`"value":"${list}-51"`);
      expect(json).toContain(`"value":"${list === "auto" ? "allowed" : "auto"}-25"`);
    },
  );
  test.each(["auto", "allowed"])(
    "removing the final item on %s page clamps only that list",
    async (list) => {
      for (let i = 0; i < 26; i++) {
        await service.addAutoReplyChannel("guild", `auto-${i}`);
        await service.addAllowedChannel("guild", `allowed-${i}`);
      }
      const press = interaction(`cfg:channels:remove:${list}:1:1`, "string", [`${list}-25`]);
      await handler(press as unknown as Interaction);
      const json = JSON.stringify(press.update.mock.calls[0]?.[0]);
      expect(json).toContain(`"value":"${list}-0"`);
      expect(json).toContain(`"value":"${list === "auto" ? "allowed" : "auto"}-25"`);
    },
  );
  test.each([
    ["cfg:response:set:free_only:on", "button"],
    ["cfg:response:set:llm_details:off", "button"],
    ["cfg:response:set:reasoning_display:on", "button"],
    ["cfg:response:set:twitter_expand:off", "button"],
    ["cfg:features:set:web_search:on", "button"],
    ["cfg:features:set:history:on", "button"],
    ["cfg:channels:add:auto", "channel"],
    ["cfg:channels:remove:auto", "string"],
    ["cfg:channels:add:allowed", "channel"],
    ["cfg:channels:remove:allowed", "string"],
  ])("lost member permission rejects %s without editing the panel", async (id, kind) => {
    await service.addAutoReplyChannel("guild", "channel");
    await service.addAllowedChannel("guild", "channel");
    const before = await service.getGuildSettings("guild");
    const press = interaction(id, kind, ["channel"], false);
    await handler(press as unknown as Interaction);
    expect(await service.getGuildSettings("guild")).toEqual(before);
    expect(press.update).not.toHaveBeenCalled();
    expect(press.editReply).not.toHaveBeenCalled();
    expect(flags(press.reply.mock.calls[0][0]) & MessageFlags.Ephemeral).toBeTruthy();
  });
  test("paid model rule error is private and leaves the panel unchanged", async () => {
    model.isFreeModel = mock(async () => false);
    const before = await service.getGuildSettings("guild");
    const press = interaction("cfg:response:set:free_only:on");
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      await handler(press as unknown as Interaction);
    } finally {
      errorLog.mockRestore();
    }
    expect(await service.getGuildSettings("guild")).toEqual(before);
    expect(press.editReply).not.toHaveBeenCalled();
    expect(flags(press.followUp.mock.calls[0][0]) & MessageFlags.Ephemeral).toBeTruthy();
    expect(JSON.stringify(press.followUp.mock.calls[0][0])).toContain("無料モデルではありません");
  });
  test.each(["auto", "allowed"])(
    "%s channels use differences and last allowed removal resets to null",
    async (list) => {
      const field = list === "auto" ? "autoReplyChannels" : "allowedChannels";
      await Promise.all(
        ["a", "b"].map((id) =>
          handler(
            interaction(`cfg:channels:add:${list}`, "channel", [id]) as unknown as Interaction,
          ),
        ),
      );
      expect((await service.getGuildSettings("guild"))[field]).toEqual(["a", "b"]);
      await handler(
        interaction(`cfg:channels:remove:${list}`, "string", ["a"]) as unknown as Interaction,
      );
      expect((await service.getGuildSettings("guild"))[field]).toEqual(["b"]);
      await handler(
        interaction(`cfg:channels:remove:${list}`, "string", ["b"]) as unknown as Interaction,
      );
      expect((await service.getGuildSettings("guild"))[field]).toEqual(list === "auto" ? [] : null);
    },
  );
  test("read operations are public and do not write", async () => {
    const open = interaction("cfg:open", "button", [], false);
    await handler(open as unknown as Interaction);
    expect(flags(open.reply.mock.calls[0][0])).toBe(MessageFlags.IsComponentsV2);
    const page = interaction("cfg:page", "string", ["channels"], false);
    await handler(page as unknown as Interaction);
    expect(page.update).toHaveBeenCalledTimes(1);
    const next = interaction("cfg:channels:list:auto:1", "button", [], false);
    await handler(next as unknown as Interaction);
    expect(next.update).toHaveBeenCalledTimes(1);
    expect((await service.getGuildSettings("guild")).settingsVersion).toBe(0);
    expect(llm.getCredits).not.toHaveBeenCalled();
  });
  test("free model validation defers before network and reports a conflict privately", async () => {
    const press = interaction("cfg:response:set:free_only:on");
    model.isFreeModel = mock(async () => {
      expect(press.deferUpdate).toHaveBeenCalledTimes(1);
      await service.setGuildModel("guild", { model: "paid/model", isFree: false });
      return true;
    });
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      await handler(press as unknown as Interaction);
    } finally {
      errorLog.mockRestore();
    }
    expect((await service.getGuildSettings("guild")).freeModelsOnly).toBe(false);
    expect(press.editReply).not.toHaveBeenCalled();
    expect(flags(press.followUp.mock.calls[0][0]) & MessageFlags.Ephemeral).toBeTruthy();
  });
  test.each([
    "status_set:history:on",
    "status_set:unknown:on",
    "status_toggle_free_only",
    "status_toggle_llm_details",
  ])("old %s only directs to config", async (id) => {
    const before = await service.getGuildSettings("guild");
    const press = interaction(id);
    await handler(press as unknown as Interaction);
    expect(await service.getGuildSettings("guild")).toEqual(before);
    expect(JSON.stringify(press.reply.mock.calls[0][0])).toContain("/config");
    expect(flags(press.reply.mock.calls[0][0]) & MessageFlags.Ephemeral).toBeTruthy();
    expect(press.update).not.toHaveBeenCalled();
  });
});
