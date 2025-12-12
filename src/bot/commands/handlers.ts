import type { ChatInputCommandInteraction } from "discord.js";
import type { ILLMClient } from "../../llm/openrouter";
import type { ISettingsService } from "../../services/settingsService";
import type { CommandHandlers } from "../events/interactionCreate";

export function createCommandHandlers(
  llmClient: ILLMClient,
  settingsService: ISettingsService,
): CommandHandlers {
  return {
    async help(interaction: ChatInputCommandInteraction): Promise<void> {
      const helpText = `**DisQord - LLM会話Bot**

**使い方:**
- Botにメンションして話しかけると、LLMが応答します
- 例: \`@DisQord こんにちは\`

**コマンド:**
- \`/disqord help\` - このヘルプを表示
- \`/disqord-model current\` - 現在のモデルを表示
- \`/disqord-model set <model>\` - モデルを変更
- \`/disqord-models\` - 利用可能なモデル一覧
- \`/disqord-status\` - Bot状態（残高等）を表示`;

      await interaction.reply({ content: helpText, ephemeral: true });
    },

    async modelCurrent(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "このコマンドはサーバー内でのみ使用できます。",
          ephemeral: true,
        });
        return;
      }

      const settings = await settingsService.getGuildSettings(interaction.guildId);
      await interaction.reply({
        content: `現在のモデル: \`${settings.defaultModel}\``,
        ephemeral: true,
      });
    },

    async modelSet(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "このコマンドはサーバー内でのみ使用できます。",
          ephemeral: true,
        });
        return;
      }

      const model = interaction.options.getString("model", true);

      const availableModels = await llmClient.listModels();
      if (availableModels.length > 0 && !availableModels.includes(model)) {
        await interaction.reply({
          content: `モデル \`${model}\` は見つかりませんでした。\`/disqord-models\` で利用可能なモデルを確認してください。`,
          ephemeral: true,
        });
        return;
      }

      await settingsService.setGuildModel(interaction.guildId, model);
      await interaction.reply({
        content: `モデルを \`${model}\` に変更しました。`,
        ephemeral: true,
      });
    },

    async models(interaction: ChatInputCommandInteraction): Promise<void> {
      await interaction.deferReply({ ephemeral: true });

      const models = await llmClient.listModels();
      if (models.length === 0) {
        await interaction.editReply("モデル一覧を取得できませんでした。");
        return;
      }

      const displayModels = models.slice(0, 20);
      const modelList = displayModels.map((m) => `- \`${m}\``).join("\n");
      const suffix = models.length > 20 ? `\n\n...他 ${models.length - 20} 件` : "";

      await interaction.editReply(`**利用可能なモデル:**\n${modelList}${suffix}`);
    },

    async status(interaction: ChatInputCommandInteraction): Promise<void> {
      await interaction.deferReply({ ephemeral: true });

      const credits = await llmClient.getCredits();
      const rateLimited = llmClient.isRateLimited();

      const remainingText =
        credits.remaining === Number.POSITIVE_INFINITY
          ? "無制限"
          : `$${credits.remaining.toFixed(4)}`;

      const statusText = `**DisQord Status**
- OpenRouter残高: ${remainingText}
- レート制限: ${rateLimited ? "制限中" : "正常"}`;

      await interaction.editReply(statusText);
    },
  };
}
