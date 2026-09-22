import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import {
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { createCommandHandlers } from "../../../../src/bot/commands/handlers";
import { GuildSettingsRepository } from "../../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../../src/db/schema";
import { SettingsRuleError } from "../../../../src/errors";
import { ModelService } from "../../../../src/services/modelService";
import { SettingsService } from "../../../../src/services/settingsService";
import {
  createMockGuildSettings,
  createMockLLMClient,
  createMockSettingsService,
} from "../../../helpers/mockFactories";

function createInteraction(model?: string): {
  interaction: ChatInputCommandInteraction;
  reply: ReturnType<typeof mock>;
  deferReply: ReturnType<typeof mock>;
  editReply: ReturnType<typeof mock>;
} {
  const reply = mock(() => Promise.resolve());
  const deferReply = mock(() => Promise.resolve());
  const editReply = mock(() => Promise.resolve());
  const interaction = {
    guildId: "guild-1",
    options: {
      getString: mock(() => model),
    },
    reply,
    deferReply,
    editReply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply, deferReply, editReply };
}

function repliedEmbed(reply: ReturnType<typeof mock>): ReturnType<EmbedBuilder["toJSON"]> {
  const payload = reply.mock.calls[0]?.[0] as { embeds?: EmbedBuilder[] } | undefined;
  const embed = payload?.embeds?.[0];
  if (!embed) throw new Error("Expected an embed reply");
  return embed.toJSON();
}

describe("model command handlers", () => {
  test("currentとsetが同じモデル詳細フィールドとOpenRouter URLを表示する", async () => {
    const llmClient = createMockLLMClient();
    const settingsService = createMockSettingsService();
    settingsService.getGuildSettings = mock(() =>
      Promise.resolve(createMockGuildSettings({ guildId: "guild-1", defaultModel: "model-1" })),
    );
    const modelService = new ModelService(llmClient);
    const handlers = createCommandHandlers(llmClient, settingsService, modelService, "perplexity");
    const current = createInteraction();
    const set = createInteraction("model-1");

    await handlers.modelCurrent(current.interaction);
    await handlers.modelSet(set.interaction);

    const currentEmbed = repliedEmbed(current.editReply);
    const setEmbed = repliedEmbed(set.reply);
    expect(currentEmbed.fields).toEqual(setEmbed.fields);
    expect(currentEmbed.url).toBe("https://openrouter.ai/model-1");
    expect(setEmbed.url).toBe(currentEmbed.url);
    expect(current.deferReply).toHaveBeenCalledTimes(1);
    expect(current.reply).not.toHaveBeenCalled();
    expect(settingsService.setGuildModel).toHaveBeenCalledWith("guild-1", {
      model: "model-1",
      isFree: true,
    });
  });

  test("詳細取得不能でもcurrentのモデルページURLを表示する", async () => {
    const llmClient = createMockLLMClient();
    const settingsService = createMockSettingsService();
    settingsService.getGuildSettings = mock(() =>
      Promise.resolve(createMockGuildSettings({ defaultModel: "missing/model:free" })),
    );
    const modelService = new ModelService(llmClient);
    const handlers = createCommandHandlers(llmClient, settingsService, modelService, "perplexity");
    const current = createInteraction();

    await handlers.modelCurrent(current.interaction);

    expect(repliedEmbed(current.editReply).description).toContain(
      "<https://openrouter.ai/missing/model%3Afree>",
    );
  });

  test("Models APIが失敗してもcurrentは設定済みモデルとURLを表示する", async () => {
    const llmClient = createMockLLMClient();
    llmClient.listModelsWithPricing = mock(() => Promise.reject(new Error("unavailable")));
    const settingsService = createMockSettingsService();
    settingsService.getGuildSettings = mock(() =>
      Promise.resolve(createMockGuildSettings({ defaultModel: "fallback/model" })),
    );
    const modelService = new ModelService(llmClient);
    const handlers = createCommandHandlers(llmClient, settingsService, modelService, "perplexity");
    const current = createInteraction();

    await handlers.modelCurrent(current.interaction);

    expect(repliedEmbed(current.editReply).description).toContain(
      "<https://openrouter.ai/fallback/model>",
    );
  });
});

describe("config web-search handler", () => {
  function createWebSearchInteraction(
    value: "on" | "off",
    hasManageGuild: boolean,
  ): { interaction: ChatInputCommandInteraction; reply: ReturnType<typeof mock> } {
    const { interaction, reply } = createInteraction(value);
    Object.assign(interaction, {
      memberPermissions: {
        has: mock((permission: bigint) =>
          hasManageGuild ? permission === PermissionFlagsBits.ManageGuild : false,
        ),
      },
    });
    return { interaction, reply };
  }

  function createHandlers(): {
    handlers: ReturnType<typeof createCommandHandlers>;
    settingsService: ReturnType<typeof createMockSettingsService>;
  } {
    const llmClient = createMockLLMClient();
    const settingsService = createMockSettingsService();
    const handlers = createCommandHandlers(
      llmClient,
      settingsService,
      new ModelService(llmClient),
      "perplexity",
    );
    return { handlers, settingsService };
  }

  test("サーバーの管理権限があれば有効化し、エンジンと料金の確認先を伝える", async () => {
    const { handlers, settingsService } = createHandlers();
    const { interaction, reply } = createWebSearchInteraction("on", true);

    await handlers.configWebSearch(interaction);

    expect(settingsService.setWebSearchEnabled).toHaveBeenCalledWith("guild-1", true);
    const description = repliedEmbed(reply).description ?? "";
    expect(description).toContain("perplexity");
    expect(description).toContain("server-tools/web-search");
  });

  test("サーバーの管理権限があれば無効化する", async () => {
    const { handlers, settingsService } = createHandlers();
    const { interaction } = createWebSearchInteraction("off", true);

    await handlers.configWebSearch(interaction);

    expect(settingsService.setWebSearchEnabled).toHaveBeenCalledWith("guild-1", false);
  });

  test("サーバーの管理権限がなければ設定を変えず、本人にだけ断る", async () => {
    const { handlers, settingsService } = createHandlers();
    const { interaction, reply } = createWebSearchInteraction("on", false);

    await handlers.configWebSearch(interaction);

    expect(settingsService.setWebSearchEnabled).not.toHaveBeenCalled();
    const payload = reply.mock.calls[0]?.[0] as { flags?: number };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(repliedEmbed(reply).description).toContain("サーバーの管理");
  });
});

describe("config twitter-expand handler", () => {
  function createTwitterExpandInteraction(
    value: "on" | "off",
    hasManageGuild: boolean,
  ): { interaction: ChatInputCommandInteraction; reply: ReturnType<typeof mock> } {
    const { interaction, reply } = createInteraction(value);
    Object.assign(interaction, {
      memberPermissions: {
        has: mock((permission: bigint) =>
          hasManageGuild ? permission === PermissionFlagsBits.ManageGuild : false,
        ),
      },
    });
    return { interaction, reply };
  }

  function createHandlers(): {
    handlers: ReturnType<typeof createCommandHandlers>;
    settingsService: ReturnType<typeof createMockSettingsService>;
  } {
    const llmClient = createMockLLMClient();
    const settingsService = createMockSettingsService();
    const handlers = createCommandHandlers(
      llmClient,
      settingsService,
      new ModelService(llmClient),
      "perplexity",
    );
    return { handlers, settingsService };
  }

  test("サーバーの管理権限があれば有効化する", async () => {
    const { handlers, settingsService } = createHandlers();
    const { interaction, reply } = createTwitterExpandInteraction("on", true);

    await handlers.configTwitterExpand(interaction);

    expect(settingsService.setTwitterExpandEnabled).toHaveBeenCalledWith("guild-1", true);
    expect(repliedEmbed(reply).description).toBe("ツイート展開を **有効** にしました。");
  });

  test("サーバーの管理権限があれば無効化する", async () => {
    const { handlers, settingsService } = createHandlers();
    const { interaction } = createTwitterExpandInteraction("off", true);

    await handlers.configTwitterExpand(interaction);

    expect(settingsService.setTwitterExpandEnabled).toHaveBeenCalledWith("guild-1", false);
  });

  test("サーバーの管理権限がなければ設定を変えず、本人にだけ断る", async () => {
    const { handlers, settingsService } = createHandlers();
    const { interaction, reply } = createTwitterExpandInteraction("on", false);

    await handlers.configTwitterExpand(interaction);

    expect(settingsService.setTwitterExpandEnabled).not.toHaveBeenCalled();
    const payload = reply.mock.calls[0]?.[0] as { flags?: number };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(repliedEmbed(reply).description).toContain("サーバーの管理");
  });

  test("DMでは設定を変えず、サーバー内限定のエラーを返す", async () => {
    const { handlers, settingsService } = createHandlers();
    const { interaction, reply } = createTwitterExpandInteraction("on", true);
    Object.assign(interaction, { guildId: null });

    await handlers.configTwitterExpand(interaction);

    expect(settingsService.setTwitterExpandEnabled).not.toHaveBeenCalled();
    expect(repliedEmbed(reply).description).toContain("サーバー内でのみ");
  });
});

describe("config history handler", () => {
  function createHistoryInteraction(
    value: "on" | "off",
    hasManageGuild: boolean,
  ): { interaction: ChatInputCommandInteraction; reply: ReturnType<typeof mock> } {
    const { interaction, reply } = createInteraction(value);
    Object.assign(interaction, {
      memberPermissions: {
        has: mock((permission: bigint) =>
          hasManageGuild ? permission === PermissionFlagsBits.ManageGuild : false,
        ),
      },
    });
    return { interaction, reply };
  }

  test("on stores the setting and explains storage, retention, and online deletion limits", async () => {
    const llmClient = createMockLLMClient();
    const settingsService = createMockSettingsService();
    const handlers = createCommandHandlers(
      llmClient,
      settingsService,
      new ModelService(llmClient),
      "perplexity",
    );
    const { interaction, reply } = createHistoryInteraction("on", true);

    await handlers.configHistory(interaction);

    expect(settingsService.setHistoryEnabled).toHaveBeenCalledWith("guild-1", true);
    const description = repliedEmbed(reply).description ?? "";
    expect(description).toBe("会話履歴を **有効** にしました。");
  });

  test("off purges through the service and explains that saved history is removed", async () => {
    const llmClient = createMockLLMClient();
    const settingsService = createMockSettingsService();
    const handlers = createCommandHandlers(
      llmClient,
      settingsService,
      new ModelService(llmClient),
      "perplexity",
    );
    const { interaction, reply } = createHistoryInteraction("off", true);

    await handlers.configHistory(interaction);

    expect(settingsService.setHistoryEnabled).toHaveBeenCalledWith("guild-1", false);
    expect(repliedEmbed(reply).description).toContain("保存済みの会話履歴を削除");
  });

  test("without ManageGuild it replies ephemerally and does not change the setting", async () => {
    const llmClient = createMockLLMClient();
    const settingsService = createMockSettingsService();
    const handlers = createCommandHandlers(
      llmClient,
      settingsService,
      new ModelService(llmClient),
      "perplexity",
    );
    const { interaction, reply } = createHistoryInteraction("on", false);

    await handlers.configHistory(interaction);

    expect(settingsService.setHistoryEnabled).not.toHaveBeenCalled();
    const payload = reply.mock.calls[0]?.[0] as { flags?: number };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
  });
});

describe("model set と無料モデル限定の競合", () => {
  test("有料モデルの確認中に限定が ON になったら、モデルは保存されず規則違反になる", async () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    applyMigrations(db);
    const settingsService = new SettingsService(new GuildSettingsRepository(db, "free/model:free"));
    let releaseCheck: (() => void) | undefined;
    const modelService = {
      validateModelSelection: mock(() => Promise.resolve({ valid: true })),
      // Held so that free-only turns on after /model set has read the settings.
      isFreeModel: mock(
        () =>
          new Promise<boolean>((resolve) => {
            releaseCheck = () => resolve(false);
          }),
      ),
      getModelDetails: mock(() => Promise.resolve(null)),
    } as unknown as ModelService;
    const handlers = createCommandHandlers(
      createMockLLMClient(),
      settingsService,
      modelService,
      "perplexity",
    );
    const { interaction, reply } = createInteraction("paid/model");

    const setting = handlers.modelSet(interaction);
    await Bun.sleep(0);
    await settingsService.setFreeModelsOnly("guild-1", true, {
      model: "free/model:free",
      isFree: true,
    });
    releaseCheck?.();

    await expect(setting).rejects.toBeInstanceOf(SettingsRuleError);
    expect(reply).not.toHaveBeenCalled();
    expect(await settingsService.getGuildSettings("guild-1")).toMatchObject({
      defaultModel: "free/model:free",
      freeModelsOnly: true,
    });
    db.close();
  });
});
