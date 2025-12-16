import type { Message } from "discord.js";
import type { IChatService } from "../../services/chatService";
import { logger } from "../../utils/logger";
import { splitIntoChunks } from "../../utils/message";

export function createMessageCreateHandler(chatService: IChatService) {
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
      await message.reply("メッセージを入力してください。");
      return;
    }

    try {
      if ("sendTyping" in message.channel) {
        await message.channel.sendTyping();
      }

      const response = await chatService.generateResponse(message.guild.id, content);

      const chunks = splitIntoChunks(response);
      for (const chunk of chunks) {
        if ("send" in message.channel) {
          await message.channel.send(chunk);
        }
      }
    } catch (error) {
      logger.error("Failed to generate response", { error, guildId: message.guild.id });
      await message.reply("エラーが発生しました。しばらくしてから再度お試しください。");
    }
  };
}
