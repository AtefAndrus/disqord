import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { type EmbedBuilder, MessageFlags } from "discord.js";
import type { CommandHandlers } from "../../../../src/bot/events/interactionCreate";
import { createInteractionCreateHandler } from "../../../../src/bot/events/interactionCreate";
import { GuildSettingsRepository } from "../../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../../src/db/schema";
import { SettingsConflictError, SettingsRuleError } from "../../../../src/errors";
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
    db.run("PRAGMA foreign_keys = ON");
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
    "%p の状態で 2 回同時に押すと、両方が成功して 2 回反転し元に戻る",
    async (initial) => {
      await settingsService.setFreeModelsOnly("guild-1", initial, {
        model: FREE_MODEL,
        isFree: true,
      });
      const toggleResults: boolean[] = [];
      const toggle = settingsService.toggleFreeModelsOnly.bind(settingsService);
      spyOn(settingsService, "toggleFreeModelsOnly").mockImplementation(async (...args) => {
        const result = await toggle(...args);
        toggleResults.push(result);
        return result;
      });
      const first = statusButton();
      const second = statusButton();

      const presses = Promise.all([handler(first as never), handler(second as never)]);
      await releaseChecks();
      await presses;

      // 2 回とも失敗しても最終値は元に戻るので、両方の押下が成功したことも確かめる
      expect(toggleResults).toEqual([!initial, initial]);
      for (const press of [first, second]) {
        expect(press.reply).not.toHaveBeenCalled();
        expect(press.update).toHaveBeenCalledTimes(1);
      }
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
    expect(payload.embeds[0]?.toJSON().title).toBe("設定エラー");
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

  async function run(error: Error): Promise<unknown> {
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
    return reply.mock.calls[0]?.[0];
  }

  function embedOf(payload: unknown): { title?: string; description?: string } | undefined {
    return (payload as { embeds: EmbedBuilder[] }).embeds[0]?.toJSON();
  }

  test("設定の競合と規則違反は、見出し「設定エラー」でそれぞれの案内を返す", async () => {
    const conflict = embedOf(await run(new SettingsConflictError("changed")));
    expect(conflict?.title).toBe("設定エラー");
    expect(conflict?.description).toContain("もう一度操作してください");

    const rule = embedOf(
      await run(new SettingsRuleError("paid", "先に無料モデルに変更してください。")),
    );
    expect(rule?.title).toBe("設定エラー");
    expect(rule?.description).toBe("先に無料モデルに変更してください。");
  });

  test("それ以外の失敗は、これまでどおり汎用の文言だけを返す", async () => {
    expect(await run(new Error("boom"))).toBe("コマンドの実行中にエラーが発生しました。");
  });
});
