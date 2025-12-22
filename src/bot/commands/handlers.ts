import type { ChatInputCommandInteraction } from "discord.js";
import type { ILLMClient } from "../../llm/openrouter";
import type { IModelService } from "../../services/modelService";
import type { ISettingsService } from "../../services/settingsService";
import type { CommandHandlers } from "../events/interactionCreate";

export function createCommandHandlers(
  llmClient: ILLMClient,
  settingsService: ISettingsService,
  modelService: IModelService,
): CommandHandlers {
  return {
    async help(interaction: ChatInputCommandInteraction): Promise<void> {
      const helpText = `**DisQord - LLM会話Bot**

**使い方:**
- Botにメンションして話しかけると、LLMが応答します
- 例: \`@DisQord こんにちは\`

**コマンド:**
- \`/disqord help\` - このヘルプを表示
- \`/disqord status\` - Bot状態（残高等）を表示
- \`/disqord model current\` - 現在のモデルを表示
- \`/disqord model set <model>\` - モデルを変更
- \`/disqord model list\` - OpenRouterのモデル一覧ページへ
- \`/disqord model refresh\` - モデルキャッシュを更新
- \`/disqord config free-only <on|off>\` - 無料モデル限定の切り替え`;

      await interaction.reply(helpText);
    },

    async modelCurrent(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply("このコマンドはサーバー内でのみ使用できます。");
        return;
      }

      const settings = await settingsService.getGuildSettings(interaction.guildId);
      await interaction.reply(`現在のモデル: \`${settings.defaultModel}\``);
    },

    async modelSet(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply("このコマンドはサーバー内でのみ使用できます。");
        return;
      }

      const model = interaction.options.getString("model", true);
      const settings = await settingsService.getGuildSettings(interaction.guildId);

      const validation = await modelService.validateModelSelection(model, settings.freeModelsOnly);
      if (!validation.valid) {
        if (validation.error === "MODEL_NOT_FOUND") {
          await interaction.reply(
            `モデル \`${model}\` は見つかりませんでした。\`/disqord model list\` で利用可能なモデルを確認してください。`,
          );
        } else if (validation.error === "MODEL_NOT_FREE") {
          await interaction.reply(
            `このサーバーは無料モデル限定に設定されています。モデル \`${model}\` は無料モデルではありません。`,
          );
        }
        return;
      }

      await settingsService.setGuildModel(interaction.guildId, model);
      await interaction.reply(`モデルを \`${model}\` に変更しました。`);
    },

    async modelList(interaction: ChatInputCommandInteraction): Promise<void> {
      const message = `モデル一覧はOpenRouterのサイトで確認できます:
<https://openrouter.ai/models>

モデルを変更するには \`/disqord model set <model>\` を使用してください。`;

      await interaction.reply(message);
    },

    async modelRefresh(interaction: ChatInputCommandInteraction): Promise<void> {
      await interaction.deferReply();
      await modelService.refreshCache();
      const cacheStatus = modelService.getCacheStatus();
      await interaction.editReply(
        `モデルキャッシュを更新しました。${cacheStatus.modelCount}件のモデルを取得しました。`,
      );
    },

    async status(interaction: ChatInputCommandInteraction): Promise<void> {
      await interaction.deferReply();

      const credits = await llmClient.getCredits();
      const rateLimited = llmClient.isRateLimited();
      const cacheStatus = modelService.getCacheStatus();

      const remainingText =
        credits.remaining === Number.POSITIVE_INFINITY
          ? "無制限"
          : `$${credits.remaining.toFixed(4)}`;

      let cacheText: string;
      if (cacheStatus.lastUpdatedAt) {
        const elapsed = Date.now() - cacheStatus.lastUpdatedAt.getTime();
        const minutes = Math.floor(elapsed / 60000);
        const timeAgo = minutes < 1 ? "1分未満前" : `${minutes}分前`;
        cacheText = `${timeAgo} (${cacheStatus.modelCount}件)`;
      } else {
        cacheText = "未取得";
      }

      const statusText = `**DisQord Status**
- OpenRouter残高: ${remainingText}
- レート制限: ${rateLimited ? "制限中" : "正常"}
- モデルキャッシュ: ${cacheText}`;

      await interaction.editReply(statusText);
    },

    async configFreeOnly(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply("このコマンドはサーバー内でのみ使用できます。");
        return;
      }

      const enabled = interaction.options.getString("enabled", true) === "on";

      if (enabled) {
        const settings = await settingsService.getGuildSettings(interaction.guildId);
        const isFree = await modelService.isFreeModel(settings.defaultModel);
        if (!isFree) {
          await interaction.reply(
            `現在のモデル \`${settings.defaultModel}\` は無料モデルではありません。先に無料モデルに変更してから有効化してください。`,
          );
          return;
        }
      }

      await settingsService.setFreeModelsOnly(interaction.guildId, enabled);
      await interaction.reply(
        enabled ? "無料モデル限定を有効にしました。" : "無料モデル限定を無効にしました。",
      );
    },
  };
}
