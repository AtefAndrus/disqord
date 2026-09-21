import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { type EmbedBuilder, MessageFlags } from "discord.js";
import type { CommandHandlers } from "../../../../src/bot/events/interactionCreate";
import { createInteractionCreateHandler } from "../../../../src/bot/events/interactionCreate";
import { GuildSettingsRepository } from "../../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../../src/db/schema";
import { SettingsConflictError } from "../../../../src/errors";
import type { ILLMClient } from "../../../../src/llm/openrouter";
import type { IChatService } from "../../../../src/services/chatService";
import type { IModelService } from "../../../../src/services/modelService";
import { type ISettingsService, SettingsService } from "../../../../src/services/settingsService";

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

describe("interactionCreate: 無料モデル限定ボタン", () => {
  const FREE_MODEL = "free/model:free";
  const PAID_MODEL = "paid/model";
  let db: Database;
  let settingsService: SettingsService;
  let pendingChecks: Array<() => void>;
  let handler: ReturnType<typeof createInteractionCreateHandler>;

  function statusButton(): ButtonInteractionFixture & {
    update: ReturnType<typeof mock>;
    replied: boolean;
    deferred: boolean;
  } {
    return {
      ...buttonInteraction("status_toggle_free_only"),
      update: mock(() => Promise.resolve()),
      replied: false,
      deferred: false,
    };
  }

  /** Lets every pending model check finish, so both presses have read the settings first. */
  async function releaseChecks(): Promise<void> {
    await Bun.sleep(0);
    for (const release of pendingChecks.splice(0)) release();
  }

  beforeEach(async () => {
    db = new Database(":memory:");
    applyMigrations(db);
    settingsService = new SettingsService(new GuildSettingsRepository(db, FREE_MODEL));
    pendingChecks = [];
    const modelService = {
      // Held until the test releases it, so the settings read happens before
      // either press saves.
      isFreeModel: mock(
        (model: string) =>
          new Promise<boolean>((resolve) => {
            pendingChecks.push(() => resolve(model !== PAID_MODEL));
          }),
      ),
      getCacheStatus: () => ({ lastUpdatedAt: null, modelCount: 0 }),
    } as unknown as IModelService;
    const llmClient = {
      getCredits: () => Promise.resolve({ remaining: 1 }),
      isRateLimited: () => false,
    } as unknown as ILLMClient;
    handler = createInteractionCreateHandler(
      {} as CommandHandlers,
      settingsService,
      modelService,
      llmClient,
      {} as IChatService,
      "perplexity",
    );
    spyOn(console, "error").mockImplementation(() => {});
  });

  test.each([false, true])(
    "%p の状態で 2 回同時に押すと、2 回反転して元に戻る",
    async (initial) => {
      await settingsService.setFreeModelsOnly("guild-1", initial, {
        model: FREE_MODEL,
        isFree: true,
      });

      const presses = Promise.all([
        handler(statusButton() as never),
        handler(statusButton() as never),
      ]);
      await releaseChecks();
      await presses;

      expect((await settingsService.getGuildSettings("guild-1")).freeModelsOnly).toBe(initial);
    },
  );

  test("確認中にモデルが有料に変わったら、限定を ON にせず再操作を促す", async () => {
    const press = statusButton();
    const pressed = handler(press as never);
    await Bun.sleep(0);
    await settingsService.setGuildModel("guild-1", { model: PAID_MODEL, isFree: false });
    await releaseChecks();
    await pressed;

    expect((await settingsService.getGuildSettings("guild-1")).freeModelsOnly).toBe(false);
    const payload = press.reply.mock.calls[0]?.[0] as { embeds: EmbedBuilder[]; flags: number };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.embeds[0]?.toJSON().description).toContain("もう一度操作してください");
  });

  test("有料モデルのまま押したら、先に無料モデルへ変えるよう案内する", async () => {
    await settingsService.setGuildModel("guild-1", { model: PAID_MODEL, isFree: false });
    const press = statusButton();

    const pressed = handler(press as never);
    await releaseChecks();
    await pressed;

    expect((await settingsService.getGuildSettings("guild-1")).freeModelsOnly).toBe(false);
    const payload = press.reply.mock.calls[0]?.[0] as { embeds: EmbedBuilder[] };
    expect(payload.embeds[0]?.toJSON().description).toContain("先に無料モデルに変更");
  });
});

describe("interactionCreate: コマンドのエラー表示", () => {
  test("利用者向けの文言を持つエラーはその文言を、それ以外は汎用の文言を返す", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const run = async (error: Error): Promise<string | undefined> => {
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
      const reply = mock((_payload: unknown) => Promise.resolve());
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
      const payload = reply.mock.calls[0]?.[0] as { embeds: EmbedBuilder[] };
      return payload.embeds[0]?.toJSON().description;
    };

    expect(await run(new SettingsConflictError("changed"))).toContain("もう一度操作してください");
    expect(await run(new Error("boom"))).toBe("コマンドの実行中にエラーが発生しました。");
  });
});
