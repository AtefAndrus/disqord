import { Database } from "bun:sqlite";
import { describe, expect, mock, spyOn, test } from "bun:test";
import {
  type ChatInputCommandInteraction,
  ComponentType,
  type ContainerBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { configCommand } from "../../../../src/bot/commands/config";
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
    user: { id: "actor-1" },
    member: null,
    memberPermissions: {
      has: mock((permission: bigint) => permission === PermissionFlagsBits.ManageGuild),
    },
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
  test("/config has no subcommands or default permission and opens publicly", async () => {
    expect(configCommand.toJSON().options).toEqual([]);
    expect(configCommand.toJSON().default_member_permissions).toBeUndefined();
    const handlers = createCommandHandlers(
      createMockLLMClient(),
      createMockSettingsService(),
      new ModelService(createMockLLMClient()),
      "perplexity",
    );
    const { interaction, reply } = createInteraction();
    await handlers.config(interaction);
    expect((reply.mock.calls[0][0] as { flags: number }).flags).toBe(MessageFlags.IsComponentsV2);
    expect(JSON.stringify(reply.mock.calls[0][0])).toContain("cfg:page");
  });
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
    expect(settingsService.setGuildModel).toHaveBeenCalledWith(
      "guild-1",
      {
        model: "model-1",
        isFree: true,
      },
      "actor-1",
    );
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
