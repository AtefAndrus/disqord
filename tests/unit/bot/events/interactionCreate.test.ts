import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  ComponentType,
  type ContainerBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import type { CommandHandlers } from "../../../../src/bot/events/interactionCreate";
import { createInteractionCreateHandler } from "../../../../src/bot/events/interactionCreate";
import { GuildSettingsRepository } from "../../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../../src/db/schema";
import { SettingsConflictError, SettingsRuleError } from "../../../../src/errors";
import type { ILLMClient } from "../../../../src/llm/openrouter";
import type { IChatService } from "../../../../src/services/chatService";
import type { IModelService } from "../../../../src/services/modelService";
import { type ISettingsService, SettingsService } from "../../../../src/services/settingsService";
import { STATUS_SWITCHES } from "../../../../src/utils/statusMessage";
import { createMockGuildSettings, createMockSettingsService } from "../../../helpers/mockFactories";

interface ButtonInteractionFixture {
  customId: string;
  guildId: string | null;
  member: null;
  memberPermissions: { has: ReturnType<typeof mock> };
  isAutocomplete: () => boolean;
  isButton: () => boolean;
  isChatInputCommand: () => boolean;
  deferUpdate: ReturnType<typeof mock>;
  reply: ReturnType<typeof mock>;
  update: ReturnType<typeof mock>;
  editReply: ReturnType<typeof mock>;
  followUp: ReturnType<typeof mock>;
  replied: boolean;
  deferred: boolean;
}

function buttonInteraction(
  customId: string,
  guildId: string | null = "guild-1",
  hasManageGuild = false,
): ButtonInteractionFixture {
  const fixture: ButtonInteractionFixture = {
    customId,
    guildId,
    member: null,
    memberPermissions: {
      has: mock((permission: bigint) =>
        hasManageGuild ? permission === PermissionFlagsBits.ManageGuild : false,
      ),
    },
    isAutocomplete: () => false,
    isButton: () => true,
    isChatInputCommand: () => false,
    deferUpdate: mock(() => {
      fixture.deferred = true;
      return Promise.resolve();
    }),
    reply: mock(() => Promise.resolve()),
    update: mock(() => Promise.resolve()),
    editReply: mock(() => Promise.resolve()),
    followUp: mock(() => Promise.resolve()),
    replied: false,
    deferred: false,
  };
  return fixture;
}

function createStatusHarness(defaultModel = "free/model:free", isFree = true) {
  const settingsService = createMockSettingsService();
  settingsService.getGuildSettings = mock(() =>
    Promise.resolve(createMockGuildSettings({ guildId: "guild-1", defaultModel })),
  );
  const modelService = {
    isFreeModel: mock(() => Promise.resolve(isFree)),
    getCacheStatus: mock(() => ({ lastUpdatedAt: null, modelCount: 0 })),
    refreshCache: mock(() => Promise.resolve()),
  } as unknown as IModelService;
  const llmClient = {
    getCredits: mock(() => Promise.resolve({ remaining: 1 })),
  } as unknown as ILLMClient;
  const handler = createInteractionCreateHandler(
    {} as CommandHandlers,
    settingsService,
    modelService,
    llmClient,
    {} as IChatService,
    "perplexity",
  );
  return { handler, settingsService, modelService, llmClient };
}

function payloadOf(callable: ReturnType<typeof mock>): {
  components: ContainerBuilder[];
  flags: number;
  embeds?: [];
  allowedMentions?: { parse: [] };
} {
  const payload = callable.mock.calls[0]?.[0] as
    | {
        components?: ContainerBuilder[];
        flags?: number;
        embeds?: [];
        allowedMentions?: { parse: [] };
      }
    | undefined;
  if (!payload?.components) throw new Error("Expected a Components V2 payload");
  return payload as {
    components: ContainerBuilder[];
    flags: number;
    embeds?: [];
    allowedMentions?: { parse: [] };
  };
}

function responseText(callable: ReturnType<typeof mock>): string {
  const container = payloadOf(callable).components[0];
  if (!container) throw new Error("Expected a Container");
  return container
    .toJSON()
    .components.flatMap((component) => {
      if (component.type === ComponentType.TextDisplay) return [component.content];
      if (component.type === ComponentType.Section) {
        return component.components.map((inner) => inner.content);
      }
      return [];
    })
    .join("\n");
}

function expectComponentsV2(callable: ReturnType<typeof mock>, ephemeral = false): void {
  const payload = payloadOf(callable);
  const expected = MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0);
  expect(payload.flags).toBe(expected);
  expect(payload.allowedMentions).toEqual({ parse: [] });
}

describe("interactionCreate: 停止ボタン", () => {
  test("停止対象があれば deferUpdate する", async () => {
    const cancelRequest = mock(() => true);
    const handler = createInteractionCreateHandler(
      {} as CommandHandlers,
      {} as ISettingsService,
      {} as IModelService,
      {} as ILLMClient,
      { cancelRequest } as unknown as IChatService,
      "perplexity",
    );
    const interaction = buttonInteraction("stop_response_1234567890");

    await handler(interaction as never);

    expect(cancelRequest).toHaveBeenCalledWith("1234567890");
    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  test("停止対象がなければComponents V2で本人にだけ返す", async () => {
    const cancelRequest = mock(() => false);
    const handler = createInteractionCreateHandler(
      {} as CommandHandlers,
      {} as ISettingsService,
      {} as IModelService,
      {} as ILLMClient,
      { cancelRequest } as unknown as IChatService,
      "perplexity",
    );
    const interaction = buttonInteraction("stop_response_1234567890");

    await handler(interaction as never);

    expectComponentsV2(interaction.reply, true);
    expect(responseText(interaction.reply)).toContain(
      "既に完了しているか、該当するリクエストが見つかりません。",
    );
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });

  test("ギルド外の操作はComponents V2のephemeralエラーを返す", async () => {
    const cancelRequest = mock(() => true);
    const handler = createInteractionCreateHandler(
      {} as CommandHandlers,
      {} as ISettingsService,
      {} as IModelService,
      {} as ILLMClient,
      { cancelRequest } as unknown as IChatService,
      "perplexity",
    );
    const interaction = buttonInteraction("stop_response_1234567890", null);

    await handler(interaction as never);

    expect(cancelRequest).not.toHaveBeenCalled();
    expectComponentsV2(interaction.reply, true);
  });
});

describe("interactionCreate: status_set buttons", () => {
  beforeEach(() => {
    spyOn(console, "error").mockImplementation(() => {});
  });

  test("OpenRouter の応答を待つ前に deferUpdate で interaction を受け付ける", async () => {
    const { handler, llmClient } = createStatusHarness();
    let resolveCredits: (value: { remaining: number }) => void = () => {};
    (llmClient.getCredits as ReturnType<typeof mock>).mockImplementation(
      () => new Promise((resolve) => (resolveCredits = resolve)),
    );
    const interaction = buttonInteraction("status_set:llm_details:on", "guild-1", true);

    const pending = handler(interaction as never);
    await Bun.sleep(0);
    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();

    resolveCredits({ remaining: 1 });
    await pending;
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
  });

  test.each(STATUS_SWITCHES.flatMap((key) => [[key, true] as const, [key, false] as const]))(
    "%s を %s に設定し、status message を更新する",
    async (key, enabled) => {
      const { handler, settingsService, modelService } = createStatusHarness();
      const interaction = buttonInteraction(
        `status_set:${key}:${enabled ? "on" : "off"}`,
        "guild-1",
        true,
      );

      await handler(interaction as never);

      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
      expect(interaction.editReply).toHaveBeenCalledTimes(1);
      expectComponentsV2(interaction.editReply);
      expect(payloadOf(interaction.editReply).embeds).toEqual([]);
      if (key === "free_only") {
        if (enabled) {
          expect(modelService.isFreeModel).toHaveBeenCalledWith("free/model:free");
          expect(settingsService.setFreeModelsOnly).toHaveBeenCalledWith("guild-1", true, {
            model: "free/model:free",
            isFree: true,
          });
        } else {
          expect(modelService.isFreeModel).not.toHaveBeenCalled();
          expect(settingsService.setFreeModelsOnly).toHaveBeenCalledWith("guild-1", false);
        }
      } else if (key === "llm_details") {
        expect(settingsService.setShowLlmDetails).toHaveBeenCalledWith("guild-1", enabled);
      } else if (key === "web_search") {
        expect(settingsService.setWebSearchEnabled).toHaveBeenCalledWith("guild-1", enabled);
      } else if (key === "twitter_expand") {
        expect(settingsService.setTwitterExpandEnabled).toHaveBeenCalledWith("guild-1", enabled);
      } else if (key === "history") {
        expect(settingsService.setHistoryEnabled).toHaveBeenCalledWith("guild-1", enabled);
      } else {
        expect(settingsService.setReasoningDisplayEnabled).toHaveBeenCalledWith("guild-1", enabled);
      }
    },
  );

  const deniedSettingsButtons: string[] = [
    ...STATUS_SWITCHES.map((key) =>
      key === "free_only" ? "status_set:free_only:off" : `status_set:${key}:on`,
    ),
    "status_toggle_free_only",
    "status_toggle_llm_details",
  ];

  test.each(deniedSettingsButtons)(
    "%s rejects an unauthorized member before deferring or writing",
    async (customId) => {
      const { handler, settingsService, modelService, llmClient } = createStatusHarness();
      const interaction = buttonInteraction(customId);

      await handler(interaction as never);

      expect(interaction.update).not.toHaveBeenCalled();
      expect(interaction.editReply).not.toHaveBeenCalled();
      expect(interaction.deferUpdate).not.toHaveBeenCalled();
      expectComponentsV2(interaction.reply, true);
      expect(responseText(interaction.reply)).toContain("## ⚠️ 設定の変更");
      expect(responseText(interaction.reply)).toContain(
        "この設定の変更には「サーバーの管理」権限が必要です。",
      );
      for (const write of [
        settingsService.setFreeModelsOnly,
        settingsService.toggleFreeModelsOnly,
        settingsService.setShowLlmDetails,
        settingsService.toggleShowLlmDetails,
        settingsService.addAutoReplyChannel,
        settingsService.removeAutoReplyChannel,
        settingsService.setWebSearchEnabled,
        settingsService.setReasoningDisplayEnabled,
        settingsService.setTwitterExpandEnabled,
        settingsService.setHistoryEnabled,
      ]) {
        expect(write).not.toHaveBeenCalled();
      }
      expect(modelService.isFreeModel).not.toHaveBeenCalled();
      expect(modelService.refreshCache).not.toHaveBeenCalled();
      expect(llmClient.getCredits).not.toHaveBeenCalled();
    },
  );

  test("status_model_refresh はV2 status messageへ更新する", async () => {
    const { handler, modelService } = createStatusHarness();
    const interaction = buttonInteraction("status_model_refresh");

    await handler(interaction as never);

    expect(modelService.refreshCache).toHaveBeenCalledTimes(1);
    expectComponentsV2(interaction.editReply);
    expect(payloadOf(interaction.editReply).embeds).toEqual([]);
  });

  test("status_auto_reply_list はComponents V2通知を返す", async () => {
    const { handler } = createStatusHarness();
    const interaction = buttonInteraction("status_auto_reply_list");

    await handler(interaction as never);

    expectComponentsV2(interaction.reply);
    expect(responseText(interaction.reply)).toContain("自動応答チャンネルは設定されていません。");
  });

  test("有料 default model で無料モデル限定を有効化すると非ephemeralの設定エラーを返す", async () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    applyMigrations(db);
    const settingsService = new SettingsService(new GuildSettingsRepository(db, "paid/model"));
    const modelService = {
      isFreeModel: mock(() => Promise.resolve(false)),
      getCacheStatus: () => ({ lastUpdatedAt: null, modelCount: 0 }),
    } as unknown as IModelService;
    const handler = createInteractionCreateHandler(
      {} as CommandHandlers,
      settingsService,
      modelService,
      { getCredits: () => Promise.resolve({ remaining: 1 }) } as unknown as ILLMClient,
      {} as IChatService,
      "perplexity",
    );
    const interaction = buttonInteraction("status_set:free_only:on", "guild-1", true);

    await handler(interaction as never);

    expect((await settingsService.getGuildSettings("guild-1")).freeModelsOnly).toBe(false);
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expectComponentsV2(interaction.followUp);
    expect(responseText(interaction.followUp)).toContain("## ⚠️ 設定エラー");
    expect(responseText(interaction.followUp)).toContain(
      "現在のモデル `paid/model` は無料モデルではありません。先に無料モデルに変更してから有効化してください。",
    );
    db.close();
  });
});

describe("interactionCreate: status の旧ボタン", () => {
  let db: Database;
  let settingsService: SettingsService;
  let handler: ReturnType<typeof createInteractionCreateHandler>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    applyMigrations(db);
    settingsService = new SettingsService(new GuildSettingsRepository(db, "free/model:free"));
    const modelService = {
      isFreeModel: mock(() => Promise.resolve(true)),
      getCacheStatus: () => ({ lastUpdatedAt: null, modelCount: 0 }),
    } as unknown as IModelService;
    handler = createInteractionCreateHandler(
      {} as CommandHandlers,
      settingsService,
      modelService,
      { getCredits: () => Promise.resolve({ remaining: 1 }) } as unknown as ILLMClient,
      {} as IChatService,
      "perplexity",
    );
    spyOn(console, "error").mockImplementation(() => {});
  });

  test("status_toggle_free_only は従来どおり反転し、更新後は新しいレイアウトになる", async () => {
    const interaction = buttonInteraction("status_toggle_free_only", "guild-1", true);

    await handler(interaction as never);

    expect((await settingsService.getGuildSettings("guild-1")).freeModelsOnly).toBe(true);
    expectComponentsV2(interaction.editReply);
    expect(payloadOf(interaction.editReply).embeds).toEqual([]);
  });

  test("status_toggle_llm_details は従来どおり反転し、更新後は新しいレイアウトになる", async () => {
    const interaction = buttonInteraction("status_toggle_llm_details", "guild-1", true);

    await handler(interaction as never);

    expect((await settingsService.getGuildSettings("guild-1")).showLlmDetails).toBe(false);
    expectComponentsV2(interaction.editReply);
    expect(payloadOf(interaction.editReply).embeds).toEqual([]);
  });
});

describe("interactionCreate: コマンドのエラー表示", () => {
  test("config twitter-expandを専用ハンドラへ振り分ける", async () => {
    const configTwitterExpand = mock(() => Promise.resolve());
    const handler = createInteractionCreateHandler(
      { configTwitterExpand } as unknown as CommandHandlers,
      {} as ISettingsService,
      {} as IModelService,
      {} as ILLMClient,
      {} as IChatService,
      "perplexity",
    );

    await handler({
      commandName: "config",
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => true,
      options: { getSubcommandGroup: () => null, getSubcommand: () => "twitter-expand" },
    } as never);

    expect(configTwitterExpand).toHaveBeenCalledTimes(1);
  });

  async function run(error: Error): Promise<ReturnType<typeof mock>> {
    spyOn(console, "error").mockImplementation(() => {});
    const handlers = {
      configFreeOnly: mock(() => Promise.reject(error)),
    } as unknown as CommandHandlers;
    const handler = createInteractionCreateHandler(
      handlers,
      {} as ISettingsService,
      {} as IModelService,
      {} as ILLMClient,
      {} as IChatService,
      "perplexity",
    );
    const reply = mock(() => Promise.resolve());
    await handler({
      commandName: "config",
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => true,
      options: { getSubcommandGroup: () => null, getSubcommand: () => "free-only" },
      replied: false,
      deferred: false,
      reply,
    } as never);
    return reply;
  }

  test("設定の競合と規則違反は非ephemeralの設定エラーContainerで案内する", async () => {
    const conflict = await run(new SettingsConflictError("changed"));
    expectComponentsV2(conflict);
    expect(responseText(conflict)).toContain("## ⚠️ 設定エラー");
    expect(responseText(conflict)).toContain("もう一度操作してください");

    const rule = await run(new SettingsRuleError("paid", "先に無料モデルに変更してください。"));
    expectComponentsV2(rule);
    expect(responseText(rule)).toContain("先に無料モデルに変更してください。");
  });

  test("それ以外の失敗は汎用エラーをComponents V2で返す", async () => {
    const reply = await run(new Error("boom"));
    expectComponentsV2(reply);
    expect(responseText(reply)).toContain("コマンドの実行中にエラーが発生しました。");
  });

  test("既にacknowledge済みのコマンドエラーはComponents V2 followUpで返す", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const handler = createInteractionCreateHandler(
      {
        configFreeOnly: mock(() => Promise.reject(new Error("boom"))),
      } as unknown as CommandHandlers,
      {} as ISettingsService,
      {} as IModelService,
      {} as ILLMClient,
      {} as IChatService,
      "perplexity",
    );
    const followUp = mock(() => Promise.resolve());

    await handler({
      commandName: "config",
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => true,
      options: { getSubcommandGroup: () => null, getSubcommand: () => "free-only" },
      replied: true,
      deferred: false,
      followUp,
      reply: mock(() => Promise.resolve()),
    } as never);

    expectComponentsV2(followUp);
  });
});
