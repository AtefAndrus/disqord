import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ContainerBuilder,
  Interaction,
} from "discord.js";
import packageJson from "../../../package.json";
import { isSettingsRejection } from "../../errors";
import type { ILLMClient } from "../../llm/openrouter";
import type { WebSearchEngine } from "../../llm/tools/webSearch";
import type { IChatService } from "../../services/chatService";
import type { IModelService } from "../../services/modelService";
import type { ISettingsService } from "../../services/settingsService";
import {
  buildErrorContainer,
  buildSuccessNoticeContainer,
  formatAutoReplyChannelList,
  toNoticePayload,
} from "../../utils/chatContainerBuilder";
import { logger } from "../../utils/logger";
import { metrics } from "../../utils/metrics";
import { buildStatusMessage } from "../../utils/statusMessage";
import { handleAutocomplete } from "../commands/handlers";
import { handleConfigPanelInteraction } from "./configPanelHandler";

/**
 * A rejected settings change carries text meant for the user (a conflict
 * says to retry, a free-only violation says what to change), shown under the
 * title the free-only checks used before they moved into the service. Other
 * failures keep their generic reply.
 */
function settingsErrorContainer(error: unknown): ContainerBuilder | undefined {
  return isSettingsRejection(error)
    ? buildErrorContainer(error.userMessage, "設定エラー")
    : undefined;
}

export interface CommandHandlers {
  help: (interaction: ChatInputCommandInteraction) => Promise<void>;
  modelCurrent: (interaction: ChatInputCommandInteraction) => Promise<void>;
  modelSet: (interaction: ChatInputCommandInteraction) => Promise<void>;
  modelList: (interaction: ChatInputCommandInteraction) => Promise<void>;
  modelRefresh: (interaction: ChatInputCommandInteraction) => Promise<void>;
  status: (interaction: ChatInputCommandInteraction) => Promise<void>;
  config: (interaction: ChatInputCommandInteraction) => Promise<void>;
  releaseNote: (interaction: ChatInputCommandInteraction) => Promise<void>;
  releaseNoteAutocomplete: (interaction: AutocompleteInteraction) => Promise<void>;
}

export function createInteractionCreateHandler(
  handlers: CommandHandlers,
  settingsService: ISettingsService,
  modelService: IModelService,
  llmClient: ILLMClient,
  chatService: IChatService,
  webSearchEngine: WebSearchEngine,
): (interaction: Interaction) => Promise<void> {
  return async function onInteractionCreate(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "release-note") {
        await handlers.releaseNoteAutocomplete(interaction);
        return;
      }
      await handleAutocomplete(interaction, settingsService, modelService);
      return;
    }

    if (
      (interaction.isButton() ||
        interaction.isStringSelectMenu() ||
        interaction.isChannelSelectMenu() ||
        interaction.isRoleSelectMenu()) &&
      interaction.customId.startsWith("cfg:")
    ) {
      await handleConfigPanelInteraction(
        interaction,
        settingsService,
        modelService,
        webSearchEngine,
      );
      return;
    }

    if (interaction.isButton()) {
      await handleButtonInteraction(
        interaction,
        settingsService,
        modelService,
        llmClient,
        chatService,
        webSearchEngine,
      );
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      const { commandName } = interaction;
      metrics.increment(`command.${commandName}`);

      switch (commandName) {
        case "help":
          await handlers.help(interaction);
          break;

        case "status":
          await handlers.status(interaction);
          break;

        case "release-note":
          await handlers.releaseNote(interaction);
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

        case "config":
          await handlers.config(interaction);
          break;

        default:
          logger.warn("Unknown command", { commandName });
      }
    } catch (error) {
      metrics.increment("command.errors");
      (isSettingsRejection(error) ? logger.warn : logger.error)("Command execution failed", {
        error,
      });
      try {
        const reply =
          interaction.replied || interaction.deferred
            ? interaction.followUp.bind(interaction)
            : interaction.reply.bind(interaction);
        const settingsError = settingsErrorContainer(error);
        const container =
          settingsError ?? buildErrorContainer("コマンドの実行中にエラーが発生しました。");
        await reply(toNoticePayload(container, interaction.commandName === "config"));
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
  webSearchEngine: WebSearchEngine,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply(
      toNoticePayload(buildErrorContainer("このボタンはサーバー内でのみ使用できます。"), true),
    );
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
        await interaction.reply(
          toNoticePayload(
            buildErrorContainer("既に完了しているか、該当するリクエストが見つかりません。"),
            true,
          ),
        );
      }
      return;
    }

    if (
      customId.startsWith("status_set:") ||
      customId === "status_toggle_free_only" ||
      customId === "status_toggle_llm_details"
    ) {
      await interaction.reply(
        toNoticePayload(
          buildSuccessNoticeContainer("設定の変更には /config を使ってください。", "設定パネル"),
          true,
        ),
      );
      return;
    }
    if (customId === "status_model_refresh") {
      await interaction.deferUpdate();
      await modelService.refreshCache();
    } else if (customId === "status_auto_reply_list") {
      // 自動応答チャンネル一覧は別メッセージで表示
      const settings = await settingsService.getGuildSettings(interaction.guildId);
      const channels = settings.autoReplyChannels;

      if (channels.length === 0) {
        await interaction.reply(
          toNoticePayload(
            buildSuccessNoticeContainer(
              "自動応答チャンネルは設定されていません。",
              "自動応答チャンネル一覧",
            ),
          ),
        );
      } else {
        await interaction.reply(
          toNoticePayload(
            buildSuccessNoticeContainer(
              formatAutoReplyChannelList(channels),
              "自動応答チャンネル一覧",
            ),
          ),
        );
      }
      return;
    } else {
      logger.warn("Unknown button customId", { customId });
      return;
    }

    // メッセージ再構築
    const credits = await llmClient.getCredits();
    const cacheStatus = modelService.getCacheStatus();
    const updatedSettings = await settingsService.getGuildSettings(interaction.guildId);

    const message = buildStatusMessage({
      credits,
      cacheStatus,
      settings: updatedSettings,
      webSearchEngine,
      version: packageJson.version,
    });

    await interaction.editReply(message);
  } catch (error) {
    (isSettingsRejection(error) ? logger.warn : logger.error)("Button interaction failed", {
      error,
      customId: interaction.customId,
    });
    try {
      const reply =
        interaction.replied || interaction.deferred
          ? interaction.followUp.bind(interaction)
          : interaction.reply.bind(interaction);
      const settingsError = settingsErrorContainer(error);
      const container = settingsError ?? buildErrorContainer("操作中にエラーが発生しました。");
      await reply(toNoticePayload(container, !settingsError));
    } catch (replyError) {
      logger.error("Failed to send error message", { replyError });
    }
  }
}
