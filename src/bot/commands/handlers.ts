import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  PermissionFlagsBits,
} from "discord.js";
import packageJson from "../../../package.json";
import type { ILLMClient } from "../../llm/openrouter";
import { describeSearchBilling, type WebSearchEngine } from "../../llm/tools/webSearch";
import type { IModelService } from "../../services/modelService";
import type { ISettingsService } from "../../services/settingsService";
import {
  buildErrorContainer,
  buildSuccessNoticeContainer,
  formatAutoReplyChannelList,
  toNoticeEditPayload,
  toNoticePayload,
} from "../../utils/chatContainerBuilder";
import { logger } from "../../utils/logger";
import {
  buildModelDetailsContainer,
  getOpenRouterModelUrl,
} from "../../utils/modelDetailsContainer";
import { buildStatusMessage } from "../../utils/statusMessage";
import type { CommandHandlers } from "../events/interactionCreate";

function successNotice(message: string, title?: string): InteractionReplyOptions {
  return toNoticePayload(buildSuccessNoticeContainer(message, title));
}

function errorNotice(message: string, title?: string, ephemeral = false): InteractionReplyOptions {
  return toNoticePayload(buildErrorContainer(message, title), ephemeral);
}

export function createCommandHandlers(
  llmClient: ILLMClient,
  settingsService: ISettingsService,
  modelService: IModelService,
  webSearchEngine: WebSearchEngine,
): CommandHandlers {
  return {
    async help(interaction: ChatInputCommandInteraction): Promise<void> {
      const helpText = `**使い方:**
- Botにメンションして話しかけると、LLMが応答します
- 例: \`@DisQord こんにちは\`

**コマンド:**
- \`/help\` - このヘルプを表示
- \`/status\` - Bot状態（残高等）を表示
- \`/model current\` - 現在のモデルを表示
- \`/model set <model>\` - モデルを変更
- \`/model list\` - OpenRouterのモデル一覧ページへ
- \`/model refresh\` - モデルキャッシュを更新
- \`/config free-only <on|off>\` - 無料モデル限定の切り替え
- \`/config llm-details <on|off>\` - LLM詳細情報表示の切り替え
- \`/config web-search <on|off>\` - Web検索の切り替え（サーバーの管理権限が必要）
- \`/config reasoning-display <on|off>\` - 推論内容の表示切り替え（サーバーの管理権限が必要）
- \`/config twitter-expand <on|off>\` - ツイート展開の切り替え（サーバーの管理権限が必要）
- \`/config history <on|off>\` - 会話履歴の切り替え（サーバーの管理権限が必要）
- \`/config auto-reply add <channel>\` - 自動応答チャンネルを追加
- \`/config auto-reply remove <channel>\` - 自動応答チャンネルを削除
- \`/config auto-reply list\` - 自動応答チャンネル一覧`;

      await interaction.reply(successNotice(helpText, "DisQord ヘルプ"));
    },

    async modelCurrent(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply(errorNotice("このコマンドはサーバー内でのみ使用できます。"));
        return;
      }

      await interaction.deferReply();
      const settings = await settingsService.getGuildSettings(interaction.guildId);
      let details: Awaited<ReturnType<IModelService["getModelDetails"]>> = null;
      try {
        details = await modelService.getModelDetails(settings.defaultModel);
      } catch (error) {
        logger.warn("Failed to fetch current model details", {
          error,
          model: settings.defaultModel,
        });
      }
      const container = details
        ? buildModelDetailsContainer(details, {
            title: "現在のモデル",
            description: `現在のモデルは \`${settings.defaultModel}\` です。`,
          })
        : buildSuccessNoticeContainer(
            `現在のモデル: \`${settings.defaultModel}\`\n\n<${getOpenRouterModelUrl(settings.defaultModel)}>`,
            "現在のモデル",
          );
      await interaction.editReply(toNoticeEditPayload(container));
    },

    async modelSet(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply(errorNotice("このコマンドはサーバー内でのみ使用できます。"));
        return;
      }

      const model = interaction.options.getString("model", true);
      const settings = await settingsService.getGuildSettings(interaction.guildId);

      const validation = await modelService.validateModelSelection(model, settings.freeModelsOnly);
      if (!validation.valid) {
        if (validation.error === "MODEL_NOT_FOUND") {
          await interaction.reply(
            errorNotice(
              `モデル \`${model}\` は見つかりませんでした。\`/model list\` で利用可能なモデルを確認してください。`,
              "モデル設定エラー",
            ),
          );
        } else if (validation.error === "MODEL_NOT_FREE") {
          await interaction.reply(
            errorNotice(
              `このサーバーは無料モデル限定に設定されています。モデル \`${model}\` は無料モデルではありません。`,
              "モデル設定エラー",
            ),
          );
        }
        return;
      }

      // The check above used settings read before any await; the save
      // re-checks free-only against the stored settings.
      const isFree = await modelService.isFreeModel(model);
      await settingsService.setGuildModel(interaction.guildId, { model, isFree });

      // モデル詳細情報を取得して表示
      const details = await modelService.getModelDetails(model);

      if (details) {
        const container = buildModelDetailsContainer(details, {
          title: "モデル変更",
          description: `モデルを \`${model}\` に変更しました。`,
        });
        await interaction.reply(toNoticePayload(container));
      } else {
        // フォールバック（詳細取得失敗時）
        await interaction.reply(
          successNotice(
            `モデルを \`${model}\` に変更しました。\n\n<${getOpenRouterModelUrl(model)}>`,
            "モデル変更",
          ),
        );
      }
    },

    async modelList(interaction: ChatInputCommandInteraction): Promise<void> {
      const message = `モデル一覧はOpenRouterのサイトで確認できます:
<https://openrouter.ai/models>

モデルを変更するには \`/model set <model>\` を使用してください。`;

      await interaction.reply(successNotice(message, "モデル一覧"));
    },

    async modelRefresh(interaction: ChatInputCommandInteraction): Promise<void> {
      await interaction.deferReply();
      await modelService.refreshCache();
      const cacheStatus = modelService.getCacheStatus();
      const container = buildSuccessNoticeContainer(
        `モデルキャッシュを更新しました。${cacheStatus.modelCount}件のモデルを取得しました。`,
        "モデルキャッシュ更新",
      );
      await interaction.editReply(toNoticeEditPayload(container));
    },

    async status(interaction: ChatInputCommandInteraction): Promise<void> {
      await interaction.deferReply();

      const credits = await llmClient.getCredits();
      const cacheStatus = modelService.getCacheStatus();

      const settings = interaction.guildId
        ? await settingsService.getGuildSettings(interaction.guildId)
        : undefined;

      const message = buildStatusMessage({
        credits,
        cacheStatus,
        settings,
        webSearchEngine,
        version: packageJson.version,
      });

      await interaction.editReply(message);
    },

    async configFreeOnly(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply(errorNotice("このコマンドはサーバー内でのみ使用できます。"));
        return;
      }

      const enabled = interaction.options.getString("enabled", true) === "on";

      if (enabled) {
        // The service rejects a paid model, or a model replaced while this
        // one was being checked, against the settings as stored.
        const { defaultModel } = await settingsService.getGuildSettings(interaction.guildId);
        const isFree = await modelService.isFreeModel(defaultModel);
        await settingsService.setFreeModelsOnly(interaction.guildId, true, {
          model: defaultModel,
          isFree,
        });
      } else {
        await settingsService.setFreeModelsOnly(interaction.guildId, false);
      }
      await interaction.reply(
        successNotice(
          enabled
            ? "無料モデル限定を **有効** にしました。"
            : "無料モデル限定を **無効** にしました。",
          "無料モデル限定設定",
        ),
      );
    },

    async configLlmDetails(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply(errorNotice("このコマンドはサーバー内でのみ使用できます。"));
        return;
      }

      const enabled = interaction.options.getString("enabled", true) === "on";
      await settingsService.setShowLlmDetails(interaction.guildId, enabled);

      await interaction.reply(
        successNotice(
          `LLM詳細情報表示を **${enabled ? "有効" : "無効"}** にしました。`,
          "LLM詳細設定",
        ),
      );
    },

    async configWebSearch(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply(errorNotice("このコマンドはサーバー内でのみ使用できます。"));
        return;
      }

      // Checked here rather than with setDefaultMemberPermissions, which would
      // gate every /config subcommand. The permissions change replaces this
      // with its admin_role_id check.
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply(
          errorNotice("Web検索の設定には「サーバーの管理」権限が必要です。", "Web検索設定", true),
        );
        return;
      }

      const enabled = interaction.options.getString("enabled", true) === "on";
      await settingsService.setWebSearchEnabled(interaction.guildId, enabled);

      await interaction.reply(
        successNotice(
          enabled
            ? `Web検索を **有効** にしました（エンジン: ${webSearchEngine}）。\n\n${describeSearchBilling(webSearchEngine)}1回あたりの料金はエンジンごとに異なります: <https://openrouter.ai/docs/guides/features/server-tools/web-search>`
            : "Web検索を **無効** にしました。",
          "Web検索設定",
        ),
      );
    },

    async configReasoningDisplay(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply(errorNotice("このコマンドはサーバー内でのみ使用できます。"));
        return;
      }

      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply(
          errorNotice(
            "推論内容の表示設定には「サーバーの管理」権限が必要です。",
            "推論表示設定",
            true,
          ),
        );
        return;
      }

      const enabled = interaction.options.getString("enabled", true) === "on";
      await settingsService.setReasoningDisplayEnabled(interaction.guildId, enabled);
      await interaction.reply(
        successNotice(
          `推論内容の表示を **${enabled ? "有効" : "無効"}** にしました。`,
          "推論表示設定",
        ),
      );
    },

    async configTwitterExpand(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply(errorNotice("このコマンドはサーバー内でのみ使用できます。"));
        return;
      }

      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply(
          errorNotice(
            "ツイート展開の設定には「サーバーの管理」権限が必要です。",
            "ツイート展開設定",
            true,
          ),
        );
        return;
      }

      const enabled = interaction.options.getString("enabled", true) === "on";
      await settingsService.setTwitterExpandEnabled(interaction.guildId, enabled);

      await interaction.reply(
        successNotice(
          enabled ? "ツイート展開を **有効** にしました。" : "ツイート展開を **無効** にしました。",
          "ツイート展開設定",
        ),
      );
    },

    async configHistory(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply(errorNotice("このコマンドはサーバー内でのみ使用できます。"));
        return;
      }

      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply(
          errorNotice("会話履歴の設定には「サーバーの管理」権限が必要です。", "会話履歴設定", true),
        );
        return;
      }

      const enabled = interaction.options.getString("enabled", true) === "on";
      await settingsService.setHistoryEnabled(interaction.guildId, enabled);
      await interaction.reply(
        successNotice(
          enabled ? "会話履歴を **有効** にしました。" : "会話履歴を **無効** にしました。",
          "会話履歴設定",
        ),
      );
    },

    async configAutoReplyAdd(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply(errorNotice("このコマンドはサーバー内でのみ使用できます。"));
        return;
      }

      const channel = interaction.options.getChannel("channel", true);
      await settingsService.addAutoReplyChannel(interaction.guildId, channel.id);

      await interaction.reply(
        successNotice(`<#${channel.id}> を自動応答チャンネルに追加しました。`, "自動応答設定"),
      );
    },

    async configAutoReplyRemove(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply(errorNotice("このコマンドはサーバー内でのみ使用できます。"));
        return;
      }

      const channelId = interaction.options.getString("channel", true);
      const removed = await settingsService.removeAutoReplyChannel(interaction.guildId, channelId);

      if (removed) {
        await interaction.reply(
          successNotice(`<#${channelId}> を自動応答チャンネルから削除しました。`, "自動応答設定"),
        );
      } else {
        await interaction.reply(
          errorNotice(`<#${channelId}> は自動応答チャンネルに設定されていません。`, "自動応答設定"),
        );
      }
    },

    async configAutoReplyList(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply(errorNotice("このコマンドはサーバー内でのみ使用できます。"));
        return;
      }

      const settings = await settingsService.getGuildSettings(interaction.guildId);
      const channels = settings.autoReplyChannels;

      if (channels.length === 0) {
        await interaction.reply(
          successNotice("自動応答チャンネルは設定されていません。", "自動応答チャンネル一覧"),
        );
        return;
      }

      await interaction.reply(
        successNotice(formatAutoReplyChannelList(channels), "自動応答チャンネル一覧"),
      );
    },
  };
}

export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  settingsService: ISettingsService,
  modelService: IModelService,
): Promise<void> {
  try {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.respond([]);
      return;
    }

    // config auto-reply remove のAutocomplete
    if (interaction.commandName === "config") {
      const subcommandGroup = interaction.options.getSubcommandGroup(false);
      const subcommand = interaction.options.getSubcommand();

      if (subcommandGroup === "auto-reply" && subcommand === "remove") {
        const focusedValue = interaction.options.getFocused().toLowerCase();
        const settings = await settingsService.getGuildSettings(guildId);

        const choices = settings.autoReplyChannels
          .map((id) => {
            const channel = interaction.guild?.channels.cache.get(id);
            return {
              name: channel ? `#${channel.name}` : `ID: ${id}`,
              value: id,
            };
          })
          .filter((choice) => choice.name.toLowerCase().includes(focusedValue))
          .slice(0, 25);

        await interaction.respond(choices);
        return;
      }
    }

    // model set のAutocomplete
    if (interaction.commandName !== "model" || interaction.options.getSubcommand() !== "set") {
      await interaction.respond([]);
      return;
    }

    const focusedValue = interaction.options.getFocused().toLowerCase();

    // Guild設定を取得
    const settings = await settingsService.getGuildSettings(guildId);

    // モデル一覧取得
    const models = settings.freeModelsOnly
      ? await modelService.getFreeModels()
      : await modelService.getAllModels();

    // フィルタリング（name/id部分一致、大文字小文字無視）
    const filtered = models
      .filter(
        (model) =>
          model.name.toLowerCase().includes(focusedValue) ||
          model.id.toLowerCase().includes(focusedValue),
      )
      .sort((a, b) => b.created - a.created) // 新しい順
      .slice(0, 25) // Discord制限
      .map((model) => ({
        name: `${model.name} (${model.id})`,
        value: model.id,
      }));

    await interaction.respond(filtered);
  } catch (error) {
    logger.error("Autocomplete error", { error });
    await interaction.respond([]);
  }
}
