import { Database } from "bun:sqlite";
import { describe, expect, mock, spyOn, test } from "bun:test";
import {
  type ChatInputCommandInteraction,
  ComponentType,
  type ContainerBuilder,
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

function repliedText(reply: ReturnType<typeof mock>): string {
  const payload = reply.mock.calls[0]?.[0] as
    | {
        components?: ContainerBuilder[];
        flags?: number;
        allowedMentions?: { parse: [] };
        embeds?: [];
      }
    | undefined;
  const container = payload?.components?.[0];
  if (!container || typeof payload.flags !== "number") {
    throw new Error("Expected a Components V2 reply");
  }
  expect(payload.flags & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2);
  expect(payload.allowedMentions).toEqual({ parse: [] });
  if (payload.embeds) expect(payload.embeds).toEqual([]);
  const text = container
    .toJSON()
    .components.find((component) => component.type === ComponentType.TextDisplay);
  if (!text || text.type !== ComponentType.TextDisplay) throw new Error("Expected a TextDisplay");
  return text.content;
}

describe("Components V2 command replies", () => {
  test("/help と /model list は4,000文字以内のContainerで返信する", async () => {
    const llmClient = createMockLLMClient();
    const handlers = createCommandHandlers(
      llmClient,
      createMockSettingsService(),
      new ModelService(llmClient),
      "perplexity",
    );
    const help = createInteraction();
    const modelList = createInteraction();

    await handlers.help(help.interaction);
    await handlers.modelList(modelList.interaction);

    const helpText = repliedText(help.reply);
    const modelListText = repliedText(modelList.reply);
    expect(helpText).toStartWith("## DisQord ヘルプ\n\n");
    expect(modelListText).toStartWith("## モデル一覧\n\n");
    expect(helpText.length).toBeLessThanOrEqual(4000);
    expect(modelListText.length).toBeLessThanOrEqual(4000);
  });

  test("/status はrate-limit値を読まずV2フラグとembeds空配列で更新する", async () => {
    const llmClient = createMockLLMClient();
    const isRateLimited = spyOn(llmClient, "isRateLimited");
    const handlers = createCommandHandlers(
      llmClient,
      createMockSettingsService(),
      new ModelService(llmClient),
      "perplexity",
    );
    const status = createInteraction();

    await handlers.status(status.interaction);

    expect(isRateLimited).not.toHaveBeenCalled();
    expect(status.deferReply).toHaveBeenCalledTimes(1);
    expect(repliedText(status.editReply)).toContain("## ステータス");
    const payload = status.editReply.mock.calls[0]?.[0] as { flags: number; embeds: [] };
    expect(payload.flags & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2);
    expect(payload.embeds).toEqual([]);
  });

  test("/model refresh はV2フラグとembeds空配列で編集する", async () => {
    const llmClient = createMockLLMClient();
    const handlers = createCommandHandlers(
      llmClient,
      createMockSettingsService(),
      new ModelService(llmClient),
      "perplexity",
    );
    const refresh = createInteraction();

    await handlers.modelRefresh(refresh.interaction);

    expect(repliedText(refresh.editReply)).toContain("モデルキャッシュを更新しました。");
    const payload = refresh.editReply.mock.calls[0]?.[0] as { flags: number; embeds: [] };
    expect(payload.flags & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2);
    expect(payload.embeds).toEqual([]);
  });

  test("auto-reply の追加・未登録削除・一覧もComponents V2で返信する", async () => {
    const llmClient = createMockLLMClient();
    const settingsService = createMockSettingsService();
    settingsService.removeAutoReplyChannel = mock(() => Promise.resolve(false));
    const handlers = createCommandHandlers(
      llmClient,
      settingsService,
      new ModelService(llmClient),
      "perplexity",
    );
    const add = createInteraction();
    Object.assign(add.interaction.options, { getChannel: mock(() => ({ id: "channel-1" })) });
    const remove = createInteraction("channel-1");
    const list = createInteraction();

    await handlers.configAutoReplyAdd(add.interaction);
    await handlers.configAutoReplyRemove(remove.interaction);
    await handlers.configAutoReplyList(list.interaction);

    expect(repliedText(add.reply)).toContain("<#channel-1> を自動応答チャンネルに追加しました。");
    expect(repliedText(remove.reply)).toContain(
      "<#channel-1> は自動応答チャンネルに設定されていません。",
    );
    expect(repliedText(list.reply)).toContain("自動応答チャンネルは設定されていません。");
  });
});

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

    const currentText = repliedText(current.editReply);
    const setText = repliedText(set.reply);
    const currentFields = currentText.slice(currentText.indexOf("**モデル名**"));
    const setFields = setText.slice(setText.indexOf("**モデル名**"));
    expect(currentFields).toBe(setFields);
    expect(currentText).toContain("## [現在のモデル](https://openrouter.ai/model-1)");
    expect(setText).toContain("## [モデル変更](https://openrouter.ai/model-1)");
    const currentPayload = current.editReply.mock.calls[0]?.[0] as { flags: number; embeds: [] };
    expect(currentPayload.flags & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2);
    expect(currentPayload.embeds).toEqual([]);
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

    expect(repliedText(current.editReply)).toContain(
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

    expect(repliedText(current.editReply)).toContain("<https://openrouter.ai/fallback/model>");
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
    const description = repliedText(reply);
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
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
    expect(repliedText(reply)).toContain("サーバーの管理");
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
    expect(repliedText(reply)).toContain("ツイート展開を **有効** にしました。");
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
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
    expect(repliedText(reply)).toContain("サーバーの管理");
  });

  test("DMでは設定を変えず、サーバー内限定のエラーを返す", async () => {
    const { handlers, settingsService } = createHandlers();
    const { interaction, reply } = createTwitterExpandInteraction("on", true);
    Object.assign(interaction, { guildId: null });

    await handlers.configTwitterExpand(interaction);

    expect(settingsService.setTwitterExpandEnabled).not.toHaveBeenCalled();
    expect(repliedText(reply)).toContain("サーバー内でのみ");
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
    expect(repliedText(reply)).toContain("会話履歴を **有効** にしました。");
  });

  test("off disables history without claiming that stored history was removed", async () => {
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
    expect(repliedText(reply)).toContain("会話履歴を **無効** にしました。");
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
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
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
