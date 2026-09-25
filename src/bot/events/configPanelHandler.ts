import {
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { AppError, SettingsConflictError, SettingsRuleError } from "../../errors";
import { describeSearchBilling, type WebSearchEngine } from "../../llm/tools/webSearch";
import type { IModelService } from "../../services/modelService";
import { resolveReleaseChannel } from "../../services/releaseAnnouncer";
import {
  canManageGuildSettings,
  settingsActorFromInteraction,
  settingsPermissionDeniedMessage,
} from "../../services/settingsAuthorization";
import type { ISettingsService } from "../../services/settingsService";
import {
  buildErrorContainer,
  buildSuccessNoticeContainer,
  toNoticePayload,
} from "../../utils/chatContainerBuilder";
import {
  buildConfigPanel,
  type ConfigPage,
  type IConfigPanelOptions,
  isConfigPage,
  parseConfigCustomId,
} from "../../utils/configPanel";
import { logger } from "../../utils/logger";

/**
 * Whether unchecking this channel can be taken as the presser's choice. The
 * client cannot show a channel the presser is not allowed to see, so it drops
 * out of the submitted values without anyone removing it; such a channel stays.
 * A deleted channel has nothing to keep and goes.
 */
async function removableBy(
  interaction: ChannelSelectMenuInteraction,
  channelId: string,
): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild) return false;
  const channel =
    guild.channels.cache.get(channelId) ??
    (await guild.channels
      .fetch(channelId)
      .catch((error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === RESTJSONErrorCodes.UnknownChannel
          ? null
          : undefined,
      ));
  if (channel === null) return true;
  if (!channel) return false;
  return channel.permissionsFor(interaction.user.id)?.has(PermissionFlagsBits.ViewChannel) === true;
}

type ConfigInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ChannelSelectMenuInteraction
  | RoleSelectMenuInteraction;

export async function handleConfigPanelInteraction(
  interaction: ConfigInteraction,
  settingsService: ISettingsService,
  modelService: IModelService,
  webSearchEngine: WebSearchEngine,
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
    let staleEdit = false;
    if (action.action === "list" || action.action === "add" || action.action === "remove") {
      options.autoPage = action.autoPage;
      options.allowedPage = action.allowedPage;
    }
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
        (action.action === "release" &&
          interaction.isChannelSelectMenu() &&
          interaction.values.length === 1) ||
        (action.action === "release-clear" && interaction.isButton()) ||
        (action.action === "set" && interaction.isButton()) ||
        (action.action === "edit" && interaction.isChannelSelectMenu()) ||
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
      if (action.action === "release" || action.action === "release-clear") {
        let channelId: string | null = null;
        if (action.action === "release" && interaction.isChannelSelectMenu()) {
          await interaction.deferUpdate();
          try {
            if (!interaction.guild) throw new Error("サーバー情報を取得できませんでした。");
            channelId = (await resolveReleaseChannel(interaction.guild, interaction.values[0])).id;
          } catch (error) {
            logger.error("Release destination validation failed", { guildId, error });
            await notice(
              error instanceof AppError ? error.userMessage : "通知先を確認できませんでした。",
            );
            return;
          }
          const latest = await settingsService.getGuildSettings(guildId);
          if (!canManageGuildSettings(settingsActorFromInteraction(interaction), latest)) {
            await notice(settingsPermissionDeniedMessage(latest));
            return;
          }
        }
        await settingsService.setReleaseAnnounceChannelId(guildId, channelId, actorId);
      } else if (action.action === "role" || action.action === "clear") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          await notice("管理ロールの変更には「サーバーの管理」権限が必要です。");
          return;
        }
        if (action.action === "role" && interaction.isRoleSelectMenu()) {
          const roleId = interaction.values[0];
          if (roleId === guildId) {
            await notice("@everyone は管理ロールに指定できません。");
            return;
          }
          if (interaction.roles.get(roleId)?.managed) {
            await notice("Bot や連携によって管理されるロールは管理ロールに指定できません。");
            return;
          }
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
      } else if (action.action === "edit" && interaction.isChannelSelectMenu()) {
        // The select was drawn from one version of the settings; against any other the
        // presser's unchecks and checks cannot be told apart from someone else's edit.
        if (action.version !== settings.settingsVersion) {
          staleEdit = true;
        } else {
          // Looking up unchecked channels can go to the REST API and pass Discord's
          // 3-second deadline, so the interaction is acknowledged first.
          await interaction.deferUpdate();
          const stored =
            action.list === "auto" ? settings.autoReplyChannels : (settings.allowedChannels ?? []);
          const removed: string[] = [];
          for (const id of stored.filter((id) => !interaction.values.includes(id))) {
            if (await removableBy(interaction, id)) removed.push(id);
          }
          try {
            await settingsService.changeChannelList(
              guildId,
              action.list,
              {
                added: interaction.values.filter((id) => !stored.includes(id)),
                removed,
                expectedVersion: action.version,
              },
              actorId,
            );
          } catch (error) {
            if (!(error instanceof SettingsConflictError)) throw error;
            staleEdit = true;
          }
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
    if (staleEdit) {
      await notice(
        "パネルを表示した後に設定が変わったため、保存しませんでした。最新の一覧でもう一度選んでください。",
      );
    }
    if (action.action === "set" && action.key === "web_search" && action.enabled) {
      await interaction.followUp(
        toNoticePayload(
          buildSuccessNoticeContainer(
            `Web検索を **有効** にしました（エンジン: ${webSearchEngine}）。\n\n${describeSearchBilling(webSearchEngine)}1回あたりの料金はエンジンごとに異なります: <https://openrouter.ai/docs/guides/features/server-tools/web-search>`,
            "Web検索設定",
          ),
          true,
        ),
      );
    }
  } catch (error) {
    logger.error("Config panel interaction failed", { error, customId: interaction.customId });
    await notice(
      error instanceof SettingsConflictError || error instanceof SettingsRuleError
        ? error.userMessage
        : "操作中にエラーが発生しました。",
    );
  }
}
