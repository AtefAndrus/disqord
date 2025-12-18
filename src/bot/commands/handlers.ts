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
- \`/disqord status\` - Bot状態（残高等）を表示
- \`/disqord model current\` - 現在のモデルを表示
- \`/disqord model set <model>\` - モデルを変更
- \`/disqord model list\` - OpenRouterのモデル一覧ページへ`;

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

      const availableModels = await llmClient.listModels();
      if (availableModels.length > 0 && !availableModels.includes(model)) {
        await interaction.reply(
          `モデル \`${model}\` は見つかりませんでした。\`/disqord model list\` で利用可能なモデルを確認してください。`,
        );
        return;
      }

      await settingsService.setGuildModel(interaction.guildId, model);
      await interaction.reply(`モデルを \`${model}\` に変更しました。`);
    },

    async modelList(interaction: ChatInputCommandInteraction): Promise<void> {
      const message = `モデル一覧はOpenRouterのサイトで確認できます:
https://openrouter.ai/models

モデルを変更するには \`/disqord model set <model>\` を使用してください。`;

      await interaction.reply(message);
    },

    async status(interaction: ChatInputCommandInteraction): Promise<void> {
      await interaction.deferReply();

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
