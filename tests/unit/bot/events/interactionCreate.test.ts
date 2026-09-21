import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MessageFlags } from "discord.js";
import type { CommandHandlers } from "../../../../src/bot/events/interactionCreate";
import { createInteractionCreateHandler } from "../../../../src/bot/events/interactionCreate";
import type { ILLMClient } from "../../../../src/llm/openrouter";
import type { IChatService } from "../../../../src/services/chatService";
import type { IModelService } from "../../../../src/services/modelService";
import type { ISettingsService } from "../../../../src/services/settingsService";

interface ButtonInteractionFixture {
  customId: string;
  guildId: string | null;
  isAutocomplete: () => boolean;
  isButton: () => boolean;
  isChatInputCommand: () => boolean;
  deferUpdate: ReturnType<typeof mock>;
  reply: ReturnType<typeof mock>;
}

function buttonInteraction(
  customId: string,
  guildId: string | null = "guild-1",
): ButtonInteractionFixture {
  return {
    customId,
    guildId,
    isAutocomplete: () => false,
    isButton: () => true,
    isChatInputCommand: () => false,
    deferUpdate: mock(() => Promise.resolve()),
    reply: mock(() => Promise.resolve()),
  };
}

describe("interactionCreate: 停止ボタン", () => {
  let cancelRequest: ReturnType<typeof mock>;
  let handler: ReturnType<typeof createInteractionCreateHandler>;

  beforeEach(() => {
    cancelRequest = mock(() => true);
    handler = createInteractionCreateHandler(
      {} as CommandHandlers,
      {} as ISettingsService,
      {} as IModelService,
      {} as ILLMClient,
      { cancelRequest } as unknown as IChatService,
      "perplexity",
    );
    spyOn(console, "error").mockImplementation(() => {});
  });

  test("customId の message ID で cancelRequest を呼び、成功したら deferUpdate する", async () => {
    const interaction = buttonInteraction("stop_response_1234567890");

    await handler(interaction as never);

    expect(cancelRequest).toHaveBeenCalledTimes(1);
    expect(cancelRequest).toHaveBeenCalledWith("1234567890");
    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  test("該当するリクエストが無ければ、ephemeral でその旨を返し deferUpdate しない", async () => {
    cancelRequest.mockImplementation(() => false);
    const interaction = buttonInteraction("stop_response_1234567890");

    await handler(interaction as never);

    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const payload = interaction.reply.mock.calls[0]?.[0] as { flags: number; content: string };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).toContain("既に完了");
  });

  test("guild 外で押された場合は cancelRequest を呼ばない", async () => {
    const interaction = buttonInteraction("stop_response_1234567890", null);

    await handler(interaction as never);

    expect(cancelRequest).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
  });
});
