import { describe, expect, mock, spyOn, test } from "bun:test";
import type { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { createCommandHandlers } from "../../../../src/bot/commands/handlers";
import { ModelService } from "../../../../src/services/modelService";
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
    const handlers = createCommandHandlers(llmClient, settingsService, modelService);
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
    expect(settingsService.setGuildModel).toHaveBeenCalledWith("guild-1", "model-1");
  });

  test("詳細取得不能でもcurrentのモデルページURLを表示する", async () => {
    const llmClient = createMockLLMClient();
    const settingsService = createMockSettingsService();
    settingsService.getGuildSettings = mock(() =>
      Promise.resolve(createMockGuildSettings({ defaultModel: "missing/model:free" })),
    );
    const modelService = new ModelService(llmClient);
    const handlers = createCommandHandlers(llmClient, settingsService, modelService);
    const current = createInteraction();

    await handlers.modelCurrent(current.interaction);

    expect(repliedEmbed(current.editReply).description).toContain(
      "<https://openrouter.ai/missing/model%3Afree>",
    );
  });

  test("Models APIが失敗してもcurrentは設定済みモデルとURLを表示する", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const llmClient = createMockLLMClient();
      llmClient.listModelsWithPricing = mock(() => Promise.reject(new Error("unavailable")));
      const settingsService = createMockSettingsService();
      settingsService.getGuildSettings = mock(() =>
        Promise.resolve(createMockGuildSettings({ defaultModel: "fallback/model" })),
      );
      const modelService = new ModelService(llmClient);
      const handlers = createCommandHandlers(llmClient, settingsService, modelService);
      const current = createInteraction();

      await handlers.modelCurrent(current.interaction);

      expect(repliedEmbed(current.editReply).description).toContain(
        "<https://openrouter.ai/fallback/model>",
      );
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
