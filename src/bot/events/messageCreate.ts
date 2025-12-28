import type { Message } from "discord.js";
import { AppError } from "../../errors";
import type { IChatService } from "../../services/chatService";
import type { IModelService } from "../../services/modelService";
import type { ISettingsService } from "../../services/settingsService";
import { EmbedColors } from "../../types/embed";
import { createErrorEmbed, splitTextToMultipleMessages } from "../../utils/embedBuilder";
import { logger } from "../../utils/logger";

export function createMessageCreateHandler(
  chatService: IChatService,
  settingsService: ISettingsService,
  modelService: IModelService,
) {
  return async function onMessageCreate(message: Message): Promise<void> {
    if (message.author.bot) {
      return;
    }

    if (!message.guild) {
      return;
    }

    const botId = message.client.user?.id;
    if (!botId || !message.mentions.has(botId)) {
      return;
    }

    const content = message.content.replace(/<@!?\d+>/g, "").trim();
    if (!content) {
      const errorEmbed = createErrorEmbed("メッセージを入力してください。", "入力エラー");
      await message.reply({
        embeds: [errorEmbed],
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    let typingInterval: ReturnType<typeof setInterval> | undefined;

    try {
      if ("sendTyping" in message.channel) {
        await message.channel.sendTyping();
        // 8秒間隔でTyping継続（Discordは約10秒で表示が消えるため）
        typingInterval = setInterval(() => {
          if ("sendTyping" in message.channel) {
            message.channel.sendTyping().catch(() => {});
          }
        }, 8000);
      }

      const response = await chatService.generateResponse(message.guild.id, content);

      const settings = await settingsService.getGuildSettings(message.guild.id);
      const modelName =
        (await modelService.getModelName(settings.defaultModel)) ?? settings.defaultModel;
      const messageGroups = splitTextToMultipleMessages(response, {
        color: EmbedColors.BLURPLE,
        timestamp: new Date(),
        author: {
          name: modelName,
        },
      });

      if ("send" in message.channel) {
        for (const embeds of messageGroups) {
          await message.channel.send({ embeds });
        }
      }
    } catch (error) {
      logger.error("Failed to generate response", { error, guildId: message.guild.id });

      const userMessage =
        error instanceof AppError
          ? error.userMessage
          : "予期しないエラーが発生しました。問題が続く場合は管理者にお問い合わせください。";

      try {
        const errorEmbed = createErrorEmbed(userMessage);
        await message.reply({
          embeds: [errorEmbed],
          allowedMentions: { repliedUser: false },
        });
      } catch (replyError) {
        logger.error("Failed to send error message", { replyError, guildId: message.guild.id });
      }
    } finally {
      if (typingInterval) {
        clearInterval(typingInterval);
      }
    }
  };
}
