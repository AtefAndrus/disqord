import type { ButtonInteraction, ChatInputCommandInteraction, Interaction } from "discord.js";
import { MessageFlags } from "discord.js";
import packageJson from "../../../package.json";
import type { ILLMClient } from "../../llm/openrouter";
import type { IChatService } from "../../services/chatService";
import type { IModelService } from "../../services/modelService";
import type { ISettingsService } from "../../services/settingsService";
import { createErrorEmbed, createSuccessEmbed } from "../../utils/embedBuilder";
import { logger } from "../../utils/logger";
import { buildStatusMessage } from "../../utils/statusMessage";
import { handleAutocomplete } from "../commands/handlers";

export interface CommandHandlers {
  help: (interaction: ChatInputCommandInteraction) => Promise<void>;
  modelCurrent: (interaction: ChatInputCommandInteraction) => Promise<void>;
  modelSet: (interaction: ChatInputCommandInteraction) => Promise<void>;
  modelList: (interaction: ChatInputCommandInteraction) => Promise<void>;
  modelRefresh: (interaction: ChatInputCommandInteraction) => Promise<void>;
  status: (interaction: ChatInputCommandInteraction) => Promise<void>;
  configFreeOnly: (interaction: ChatInputCommandInteraction) => Promise<void>;
  configReleaseChannel: (interaction: ChatInputCommandInteraction) => Promise<void>;
  configLlmDetails: (interaction: ChatInputCommandInteraction) => Promise<void>;
  configAutoReplyAdd: (interaction: ChatInputCommandInteraction) => Promise<void>;
  configAutoReplyRemove: (interaction: ChatInputCommandInteraction) => Promise<void>;
  configAutoReplyList: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export function createInteractionCreateHandler(
  handlers: CommandHandlers,
  settingsService: ISettingsService,
  modelService: IModelService,
  llmClient: ILLMClient,
  chatService: IChatService,
) {
  return async function onInteractionCreate(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction, settingsService, modelService);
      return;
    }

    if (interaction.isButton()) {
      await handleButtonInteraction(
        interaction,
        settingsService,
        modelService,
        llmClient,
        chatService,
      );
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      const { commandName } = interaction;

      switch (commandName) {
        case "help":
          await handlers.help(interaction);
          break;

        case "status":
          await handlers.status(interaction);
          break;

        case "model": {
          const subcommand = interaction.options.getSubcommand();
          switch (subcommand) {
            case "current":
              await handlers.modelCurrent(interaction);
              break;
            case "set":
              await handlers.modelSet(interaction);
              break;
            case "list":
              await handlers.modelList(interaction);
              break;
            case "refresh":
              await handlers.modelRefresh(interaction);
              break;
          }
          break;
        }

        case "config": {
          const subcommandGroup = interaction.options.getSubcommandGroup(false);
          const subcommand = interaction.options.getSubcommand();

          if (subcommandGroup === "auto-reply") {
            switch (subcommand) {
              case "add":
                await handlers.configAutoReplyAdd(interaction);
                break;
              case "remove":
                await handlers.configAutoReplyRemove(interaction);
                break;
              case "list":
                await handlers.configAutoReplyList(interaction);
                break;
            }
          } else {
            switch (subcommand) {
              case "free-only":
                await handlers.configFreeOnly(interaction);
                break;
              case "release-channel":
                await handlers.configReleaseChannel(interaction);
                break;
              case "llm-details":
                await handlers.configLlmDetails(interaction);
                break;
            }
          }
          break;
        }

        default:
          logger.warn("Unknown command", { commandName });
      }
    } catch (error) {
      logger.error("Command execution failed", { error });
      try {
        const reply =
          interaction.replied || interaction.deferred
            ? interaction.followUp.bind(interaction)
            : interaction.reply.bind(interaction);
        await reply("コマンドの実行中にエラーが発生しました。");
      } catch (replyError) {
        logger.error("Failed to send error message", { replyError });
      }
    }
  };
}

async function handleButtonInteraction(
  interaction: ButtonInteraction,
  settingsService: ISettingsService,
  modelService: IModelService,
  llmClient: ILLMClient,
  chatService: IChatService,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [createErrorEmbed("このボタンはサーバー内でのみ使用できます。")],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const { customId } = interaction;

    // 停止ボタン処理
    if (customId.startsWith("stop_response_")) {
      const messageId = customId.replace("stop_response_", "");
      const cancelled = chatService.cancelRequest(messageId);

      if (cancelled) {
        // キャンセル成功 - メッセージはmessageCreate.tsのAbortError処理で更新される
        await interaction.deferUpdate();
      } else {
        await interaction.reply({
          content: "既に完了しているか、該当するリクエストが見つかりません。",
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (customId === "status_toggle_free_only") {
      const settings = await settingsService.getGuildSettings(interaction.guildId);
      const newValue = !settings.freeModelsOnly;

      if (newValue) {
        const isFree = await modelService.isFreeModel(settings.defaultModel);
        if (!isFree) {
          await interaction.reply({
            embeds: [
              createErrorEmbed(
                `現在のモデル \`${settings.defaultModel}\` は無料モデルではありません。先に無料モデルに変更してから有効化してください。`,
                "設定エラー",
              ),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }

      await settingsService.setFreeModelsOnly(interaction.guildId, newValue);
    } else if (customId === "status_toggle_llm_details") {
      await settingsService.toggleShowLlmDetails(interaction.guildId);
    } else if (customId === "status_model_refresh") {
      await modelService.refreshCache();
    } else if (customId === "status_auto_reply_list") {
      // 自動応答チャンネル一覧は別メッセージで表示
      const settings = await settingsService.getGuildSettings(interaction.guildId);
      const channels = settings.autoReplyChannels;

      if (channels.length === 0) {
        await interaction.reply({
          embeds: [
            createSuccessEmbed(
              "自動応答チャンネルは設定されていません。",
              "自動応答チャンネル一覧",
            ),
          ],
        });
      } else {
        const channelList = channels.map((id) => `- <#${id}>`).join("\n");
        await interaction.reply({
          embeds: [
            createSuccessEmbed(`**自動応答チャンネル:**\n${channelList}`, "自動応答チャンネル一覧"),
          ],
        });
      }
      return;
    } else {
      logger.warn("Unknown button customId", { customId });
      return;
    }

    // メッセージ再構築
    const credits = await llmClient.getCredits();
    const rateLimited = llmClient.isRateLimited();
    const cacheStatus = modelService.getCacheStatus();
    const updatedSettings = await settingsService.getGuildSettings(interaction.guildId);

    const message = buildStatusMessage({
      credits,
      rateLimited,
      cacheStatus,
      settings: updatedSettings,
      version: packageJson.version,
    });

    await interaction.update(message);
  } catch (error) {
    logger.error("Button interaction failed", { error, customId: interaction.customId });
    try {
      const reply =
        interaction.replied || interaction.deferred
          ? interaction.followUp.bind(interaction)
          : interaction.reply.bind(interaction);
      await reply({
        embeds: [createErrorEmbed("操作中にエラーが発生しました。")],
        flags: MessageFlags.Ephemeral,
      });
    } catch (replyError) {
      logger.error("Failed to send error message", { replyError });
    }
  }
}
