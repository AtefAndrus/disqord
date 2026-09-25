import {
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  PermissionFlagsBits,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { SettingsConflictError, SettingsRuleError } from "../../errors";
import type { IModelService } from "../../services/modelService";
import {
  canManageGuildSettings,
  settingsActorFromInteraction,
  settingsPermissionDeniedMessage,
} from "../../services/settingsAuthorization";
import type { ISettingsService } from "../../services/settingsService";
import { buildErrorContainer, toNoticePayload } from "../../utils/chatContainerBuilder";
import {
  buildConfigPanel,
  type ConfigPage,
  type IConfigPanelOptions,
  isConfigPage,
  parseConfigCustomId,
} from "../../utils/configPanel";
import { logger } from "../../utils/logger";

type ConfigInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ChannelSelectMenuInteraction
  | RoleSelectMenuInteraction;

export async function handleConfigPanelInteraction(
  interaction: ConfigInteraction,
  settingsService: ISettingsService,
  modelService: IModelService,
): Promise<void> {
  const notice = async (message: string): Promise<void> => {
    const payload = toNoticePayload(buildErrorContainer(message, "設定エラー"), true);
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  };
  try {
    if (!interaction.guildId) {
      await notice("この設定はサーバー内でのみ使用できます。");
      return;
    }
    const action = parseConfigCustomId(interaction.customId);
    if (!action) {
      await notice("この操作は無効です。`/config` から開き直してください。");
      return;
    }
    const guildId = interaction.guildId;
    let page: ConfigPage = "page" in action ? action.page : "response";
    const options: IConfigPanelOptions = {
      channel: (id) => {
        const channel = interaction.guild?.channels.cache.get(id);
        return channel
          ? { name: channel.name, parentId: channel.isThread() ? channel.parentId : null }
          : undefined;
      },
    };
    const settings = await settingsService.getGuildSettings(guildId);
    if (action.action === "open" && interaction.isButton()) {
      await interaction.reply(buildConfigPanel(page, settings, options));
      return;
    }
    if (
      action.action === "page" &&
      interaction.isStringSelectMenu() &&
      isConfigPage(interaction.values[0])
    ) {
      page = interaction.values[0];
    } else if (action.action === "list" && interaction.isButton()) {
      if (action.list === "auto") options.autoPage = action.index;
      else options.allowedPage = action.index;
    } else {
      const valid =
        (action.action === "set" && interaction.isButton()) ||
        (action.action === "add" &&
          interaction.isChannelSelectMenu() &&
          interaction.values.length === 1) ||
        (action.action === "remove" &&
          interaction.isStringSelectMenu() &&
          interaction.values.length === 1) ||
        (action.action === "role" &&
          interaction.isRoleSelectMenu() &&
          interaction.values.length === 1) ||
        (action.action === "clear" && interaction.isButton());
      if (!valid) {
        await notice("この操作は無効です。`/config` から開き直してください。");
        return;
      }
      if (!canManageGuildSettings(settingsActorFromInteraction(interaction), settings)) {
        await notice(settingsPermissionDeniedMessage(settings));
        return;
      }
      const actorId = interaction.user.id;
      if (action.action === "role" || action.action === "clear") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          await notice("管理ロールの変更には「サーバーの管理」権限が必要です。");
          return;
        }
        await settingsService.setAdminRoleId(
          guildId,
          action.action === "role" && interaction.isRoleSelectMenu() ? interaction.values[0] : null,
          actorId,
        );
      } else if (action.action === "set") {
        const enabled = action.enabled;
        switch (action.key) {
          case "free_only": {
            if (enabled) {
              await interaction.deferUpdate();
              const isFree = await modelService.isFreeModel(settings.defaultModel);
              const latest = await settingsService.getGuildSettings(guildId);
              if (!canManageGuildSettings(settingsActorFromInteraction(interaction), latest)) {
                await notice(settingsPermissionDeniedMessage(latest));
                return;
              }
              await settingsService.setFreeModelsOnly(
                guildId,
                true,
                { model: settings.defaultModel, isFree },
                actorId,
              );
            } else await settingsService.setFreeModelsOnly(guildId, false, undefined, actorId);
            break;
          }
          case "llm_details":
            await settingsService.setShowLlmDetails(guildId, enabled, actorId);
            break;
          case "reasoning_display":
            await settingsService.setReasoningDisplayEnabled(guildId, enabled, actorId);
            break;
          case "twitter_expand":
            await settingsService.setTwitterExpandEnabled(guildId, enabled, actorId);
            break;
          case "web_search":
            await settingsService.setWebSearchEnabled(guildId, enabled, actorId);
            break;
          case "history":
            await settingsService.setHistoryEnabled(guildId, enabled, actorId);
            break;
        }
      } else if (action.action === "add" && interaction.isChannelSelectMenu()) {
        if (action.list === "auto")
          await settingsService.addAutoReplyChannel(guildId, interaction.values[0], actorId);
        else await settingsService.addAllowedChannel(guildId, interaction.values[0], actorId);
      } else if (action.action === "remove" && interaction.isStringSelectMenu()) {
        if (action.list === "auto")
          await settingsService.removeAutoReplyChannel(guildId, interaction.values[0], actorId);
        else await settingsService.removeAllowedChannel(guildId, interaction.values[0], actorId);
      }
    }
    const payload = buildConfigPanel(
      page,
      await settingsService.getGuildSettings(guildId),
      options,
    );
    if (interaction.deferred) await interaction.editReply(payload);
    else await interaction.update(payload);
  } catch (error) {
    logger.error("Config panel interaction failed", { error, customId: interaction.customId });
    await notice(
      error instanceof SettingsConflictError || error instanceof SettingsRuleError
        ? error.userMessage
        : "操作中にエラーが発生しました。",
    );
  }
}
