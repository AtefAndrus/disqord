import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
import packageJson from "../../../package.json";
import type { ILLMClient } from "../../llm/openrouter";
import type { IModelService } from "../../services/modelService";
import type { ISettingsService } from "../../services/settingsService";
import { EmbedColors } from "../../types/embed";
import { createEmbed, createErrorEmbed, createSuccessEmbed } from "../../utils/embedBuilder";
import { logger } from "../../utils/logger";
import { buildStatusMessage } from "../../utils/statusMessage";
import type { CommandHandlers } from "../events/interactionCreate";

export function createCommandHandlers(
  llmClient: ILLMClient,
  settingsService: ISettingsService,
  modelService: IModelService,
): CommandHandlers {
  return {
    async help(interaction: ChatInputCommandInteraction): Promise<void> {
      const helpText = `**使い方:**
- Botにメンションして話しかけると、LLMが応答します
- 例: \`@DisQord こんにちは\`

**コマンド:**
- \`/disqord help\` - このヘルプを表示
- \`/disqord status\` - Bot状態（残高等）を表示
- \`/disqord model current\` - 現在のモデルを表示
- \`/disqord model set <model>\` - モデルを変更
- \`/disqord model list\` - OpenRouterのモデル一覧ページへ
- \`/disqord model refresh\` - モデルキャッシュを更新
- \`/disqord config free-only <on|off>\` - 無料モデル限定の切り替え
- \`/disqord config release-channel [channel]\` - リリース通知チャンネルを設定（省略で無効化）`;

      const embed = createSuccessEmbed(helpText, "DisQord ヘルプ");
      await interaction.reply({ embeds: [embed] });
    },

    async modelCurrent(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        const embed = createErrorEmbed("このコマンドはサーバー内でのみ使用できます。");
        await interaction.reply({ embeds: [embed] });
        return;
      }

      const settings = await settingsService.getGuildSettings(interaction.guildId);
      const embed = createSuccessEmbed(
        `現在のモデル: \`${settings.defaultModel}\``,
        "現在のモデル",
      );
      await interaction.reply({ embeds: [embed] });
    },

    async modelSet(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        const embed = createErrorEmbed("このコマンドはサーバー内でのみ使用できます。");
        await interaction.reply({ embeds: [embed] });
        return;
      }

      const model = interaction.options.getString("model", true);
      const settings = await settingsService.getGuildSettings(interaction.guildId);

      const validation = await modelService.validateModelSelection(model, settings.freeModelsOnly);
      if (!validation.valid) {
        if (validation.error === "MODEL_NOT_FOUND") {
          const errorEmbed = createErrorEmbed(
            `モデル \`${model}\` は見つかりませんでした。\`/disqord model list\` で利用可能なモデルを確認してください。`,
            "モデル設定エラー",
          );
          await interaction.reply({ embeds: [errorEmbed] });
        } else if (validation.error === "MODEL_NOT_FREE") {
          const errorEmbed = createErrorEmbed(
            `このサーバーは無料モデル限定に設定されています。モデル \`${model}\` は無料モデルではありません。`,
            "モデル設定エラー",
          );
          await interaction.reply({ embeds: [errorEmbed] });
        }
        return;
      }

      await settingsService.setGuildModel(interaction.guildId, model);

      // モデル詳細情報を取得して表示
      const details = await modelService.getModelDetails(model);

      if (details) {
        const { formatContextLength, formatPrice } = await import(
          "../../utils/modelDetailsFormatter"
        );

        const successEmbed = createEmbed({
          color: EmbedColors.BLURPLE,
          title: "モデル変更",
          description: `モデルを \`${model}\` に変更しました。`,
          fields: [
            { name: "モデル名", value: details.name, inline: true },
            {
              name: "コンテキスト長",
              value: formatContextLength(details.contextLength),
              inline: true,
            },
            { name: "入力価格", value: formatPrice(details.pricing.prompt), inline: true },
            { name: "出力価格", value: formatPrice(details.pricing.completion), inline: true },
          ],
          timestamp: null,
        });
        await interaction.reply({ embeds: [successEmbed] });
      } else {
        // フォールバック（詳細取得失敗時）
        const successEmbed = createSuccessEmbed(
          `モデルを \`${model}\` に変更しました。`,
          "モデル変更",
        );
        await interaction.reply({ embeds: [successEmbed] });
      }
    },

    async modelList(interaction: ChatInputCommandInteraction): Promise<void> {
      const message = `モデル一覧はOpenRouterのサイトで確認できます:
<https://openrouter.ai/models>

モデルを変更するには \`/disqord model set <model>\` を使用してください。`;

      const embed = createSuccessEmbed(message, "モデル一覧");
      await interaction.reply({ embeds: [embed] });
    },

    async modelRefresh(interaction: ChatInputCommandInteraction): Promise<void> {
      await interaction.deferReply();
      await modelService.refreshCache();
      const cacheStatus = modelService.getCacheStatus();
      const embed = createSuccessEmbed(
        `モデルキャッシュを更新しました。${cacheStatus.modelCount}件のモデルを取得しました。`,
        "モデルキャッシュ更新",
      );
      await interaction.editReply({ embeds: [embed] });
    },

    async status(interaction: ChatInputCommandInteraction): Promise<void> {
      await interaction.deferReply();

      const credits = await llmClient.getCredits();
      const rateLimited = llmClient.isRateLimited();
      const cacheStatus = modelService.getCacheStatus();

      const settings = interaction.guildId
        ? await settingsService.getGuildSettings(interaction.guildId)
        : undefined;

      const message = buildStatusMessage({
        credits,
        rateLimited,
        cacheStatus,
        settings,
        version: packageJson.version,
      });

      await interaction.editReply(message);
    },

    async configFreeOnly(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        const embed = createErrorEmbed("このコマンドはサーバー内でのみ使用できます。");
        await interaction.reply({ embeds: [embed] });
        return;
      }

      const enabled = interaction.options.getString("enabled", true) === "on";

      if (enabled) {
        const settings = await settingsService.getGuildSettings(interaction.guildId);
        const isFree = await modelService.isFreeModel(settings.defaultModel);
        if (!isFree) {
          const errorEmbed = createErrorEmbed(
            `現在のモデル \`${settings.defaultModel}\` は無料モデルではありません。先に無料モデルに変更してから有効化してください。`,
            "設定エラー",
          );
          await interaction.reply({ embeds: [errorEmbed] });
          return;
        }
      }

      await settingsService.setFreeModelsOnly(interaction.guildId, enabled);
      const successEmbed = createSuccessEmbed(
        enabled
          ? "無料モデル限定を **有効** にしました。"
          : "無料モデル限定を **無効** にしました。",
        "無料モデル限定設定",
      );
      await interaction.reply({ embeds: [successEmbed] });
    },

    async configReleaseChannel(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        const embed = createErrorEmbed("このコマンドはサーバー内でのみ使用できます。");
        await interaction.reply({ embeds: [embed] });
        return;
      }

      const channel = interaction.options.getChannel("channel");

      if (!channel) {
        await settingsService.setReleaseChannel(interaction.guildId, null);
        const embed = createSuccessEmbed("リリース通知を無効にしました。", "リリース通知設定");
        await interaction.reply({ embeds: [embed] });
        return;
      }

      await settingsService.setReleaseChannel(interaction.guildId, channel.id);
      const embed = createSuccessEmbed(
        `リリース通知を <#${channel.id}> に設定しました。`,
        "リリース通知設定",
      );
      await interaction.reply({ embeds: [embed] });
    },

    async configLlmDetails(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        const embed = createErrorEmbed("このコマンドはサーバー内でのみ使用できます。");
        await interaction.reply({ embeds: [embed] });
        return;
      }

      const enabled = interaction.options.getString("enabled", true) === "on";
      await settingsService.setShowLlmDetails(interaction.guildId, enabled);

      const embed = createSuccessEmbed(
        `LLM details display: **${enabled ? "ON" : "OFF"}**`,
        "Configuration Updated",
      );
      await interaction.reply({ embeds: [embed] });
    },
  };
}

export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  settingsService: ISettingsService,
  modelService: IModelService,
): Promise<void> {
  try {
    // disqord model setのみ処理
    if (
      interaction.commandName !== "disqord" ||
      interaction.options.getSubcommandGroup() !== "model" ||
      interaction.options.getSubcommand() !== "set"
    ) {
      await interaction.respond([]);
      return;
    }

    const focusedValue = interaction.options.getFocused().toLowerCase();
    const guildId = interaction.guildId;

    if (!guildId) {
      await interaction.respond([]);
      return;
    }

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
