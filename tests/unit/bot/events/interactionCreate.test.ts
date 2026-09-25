import { describe, expect, mock, spyOn, test } from "bun:test";
import {
  ComponentType,
  type ContainerBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import type { CommandHandlers } from "../../../../src/bot/events/interactionCreate";
import { createInteractionCreateHandler } from "../../../../src/bot/events/interactionCreate";
import { SettingsConflictError, SettingsRuleError } from "../../../../src/errors";
import type { ILLMClient } from "../../../../src/llm/openrouter";
import type { IChatService } from "../../../../src/services/chatService";
import type { IModelService } from "../../../../src/services/modelService";
import type { ISettingsService } from "../../../../src/services/settingsService";
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
  test("status refresh defers and redraws without changing settings", async () => {
    const { handler, modelService, settingsService } = createStatusHarness();
    const interaction = buttonInteraction("status_model_refresh");
    await handler(interaction as never);
    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(modelService.refreshCache).toHaveBeenCalledTimes(1);
    expectComponentsV2(interaction.editReply);
    expect(settingsService.setShowLlmDetails).not.toHaveBeenCalled();
  });
  test("old auto-reply list button still returns the list", async () => {
    const { handler, settingsService } = createStatusHarness();
    settingsService.getGuildSettings = mock(async () =>
      createMockGuildSettings({ autoReplyChannels: ["channel"] }),
    );
    const interaction = buttonInteraction("status_auto_reply_list");
    await handler(interaction as never);
    expect(responseText(interaction.reply)).toContain("<#channel>");
    expectComponentsV2(interaction.reply);
  });
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

describe("interactionCreate: コマンドのエラー表示", () => {
  test("configを専用ハンドラへ振り分ける", async () => {
    const config = mock(() => Promise.resolve());
    const handler = createInteractionCreateHandler(
      { config } as unknown as CommandHandlers,
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
      isStringSelectMenu: () => false,
      isChannelSelectMenu: () => false,
      isRoleSelectMenu: () => false,
      isChatInputCommand: () => true,
      options: { getSubcommandGroup: () => null, getSubcommand: () => "twitter-expand" },
    } as never);

    expect(config).toHaveBeenCalledTimes(1);
  });

  async function run(error: Error): Promise<ReturnType<typeof mock>> {
    spyOn(console, "error").mockImplementation(() => {});
    const handlers = {
      config: mock(() => Promise.reject(error)),
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
      isStringSelectMenu: () => false,
      isChannelSelectMenu: () => false,
      isRoleSelectMenu: () => false,
      isChatInputCommand: () => true,
      options: { getSubcommandGroup: () => null, getSubcommand: () => "free-only" },
      replied: false,
      deferred: false,
      reply,
    } as never);
    return reply;
  }

  test("設定の競合と規則違反はephemeralの設定エラーContainerで案内する", async () => {
    const conflict = await run(new SettingsConflictError("changed"));
    expectComponentsV2(conflict, true);
    expect(responseText(conflict)).toContain("## ⚠️ 設定エラー");
    expect(responseText(conflict)).toContain("もう一度操作してください");

    const rule = await run(new SettingsRuleError("paid", "先に無料モデルに変更してください。"));
    expectComponentsV2(rule, true);
    expect(responseText(rule)).toContain("先に無料モデルに変更してください。");
  });

  test("それ以外の失敗は汎用エラーをComponents V2で返す", async () => {
    const reply = await run(new Error("boom"));
    expectComponentsV2(reply, true);
    expect(responseText(reply)).toContain("コマンドの実行中にエラーが発生しました。");
  });

  test("既にacknowledge済みのコマンドエラーはComponents V2 followUpで返す", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const handler = createInteractionCreateHandler(
      {
        config: mock(() => Promise.reject(new Error("boom"))),
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
      isStringSelectMenu: () => false,
      isChannelSelectMenu: () => false,
      isRoleSelectMenu: () => false,
      isChatInputCommand: () => true,
      options: { getSubcommandGroup: () => null, getSubcommand: () => "free-only" },
      replied: true,
      deferred: false,
      followUp,
      reply: mock(() => Promise.resolve()),
    } as never);

    expectComponentsV2(followUp, true);
  });
});
