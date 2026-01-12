import type { Message, ThreadChannel } from "discord.js";
import { AppError } from "../../errors";
import type { IChatService } from "../../services/chatService";
import type { IModelService } from "../../services/modelService";
import type { ISettingsService } from "../../services/settingsService";
import type { StreamFinalResult } from "../../types";
import { createStopButton } from "../../utils/buttonBuilder";
import {
  createErrorEmbed,
  getColorForModel,
  splitTextToMultipleMessages,
} from "../../utils/embedBuilder";
import { logger } from "../../utils/logger";

const STREAM_UPDATE_INTERVAL = 2000; // 2秒
const MAX_CONTENT_LENGTH = 1900; // Discord制限2000文字より余裕を持たせる

function shouldRespond(
  message: Message,
  botId: string,
  autoReplyChannels: string[],
): { respond: boolean; isMention: boolean } {
  // メンションがある場合は応答
  if (message.mentions.has(botId)) {
    return { respond: true, isMention: true };
  }

  // 自動応答チャンネルが設定されていない場合は応答しない
  if (autoReplyChannels.length === 0) {
    return { respond: false, isMention: false };
  }

  const channelId = message.channel.id;

  // 現在のチャンネルが自動応答チャンネルに含まれている場合
  if (autoReplyChannels.includes(channelId)) {
    return { respond: true, isMention: false };
  }

  // スレッドの場合、親チャンネルが自動応答チャンネルに含まれているかチェック
  if (message.channel.isThread()) {
    const parentId = (message.channel as ThreadChannel).parentId;
    if (parentId && autoReplyChannels.includes(parentId)) {
      return { respond: true, isMention: false };
    }
  }

  return { respond: false, isMention: false };
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

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
    if (!botId) {
      return;
    }

    // Guild設定を取得して応答判定
    const settings = await settingsService.getGuildSettings(message.guild.id);
    const { respond, isMention } = shouldRespond(message, botId, settings.autoReplyChannels);

    if (!respond) {
      return;
    }

    // メンションの場合のみメンション部分を除去
    const content = isMention ? message.content.replace(/<@!?\d+>/g, "").trim() : message.content;

    if (!content) {
      const errorEmbed = createErrorEmbed("メッセージを入力してください。", "入力エラー");
      await message.reply({
        embeds: [errorEmbed],
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    if (!("send" in message.channel)) {
      return;
    }

    try {
      // 初期メッセージ送信（停止ボタン付き）
      const botMessage = await message.channel.send({
        content: "生成中...",
        components: [createStopButton(message.id)],
      });

      let fullText = "";
      let lastUpdate = Date.now();
      let cancelled = false;
      let finalResult: StreamFinalResult | null = null;
      const startTime = Date.now();

      try {
        const stream = chatService.generateResponseStream(
          message.guild.id,
          content,
          message.id,
        );

        for await (const chunk of stream) {
          if (chunk.done) {
            finalResult = chunk;
            break;
          }

          fullText += chunk.content;

          const now = Date.now();
          if (now - lastUpdate >= STREAM_UPDATE_INTERVAL) {
            await botMessage.edit({
              content: truncateText(fullText, MAX_CONTENT_LENGTH),
              components: [createStopButton(message.id)],
            });
            lastUpdate = now;
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          cancelled = true;
          await botMessage.edit({
            content: fullText ? `${truncateText(fullText, MAX_CONTENT_LENGTH - 20)}\n\n⏹️ **生成を停止しました**` : "⏹️ 生成を停止しました",
            components: [],
          });
          return;
        }
        throw error;
      }

      // 最終更新（Embed形式、ボタン削除）
      const latency = Date.now() - startTime;
      const modelName =
        (await modelService.getModelName(settings.defaultModel)) ?? settings.defaultModel;

      const messageGroups = splitTextToMultipleMessages(
        finalResult?.fullText ?? fullText,
        {
          color: getColorForModel(settings.defaultModel),
          timestamp: new Date(),
          author: {
            name: modelName,
          },
        },
        {
          showDetails: settings.showLlmDetails,
          model: finalResult?.model,
          provider: finalResult?.provider,
          latency,
          usage: finalResult?.usage,
        },
      );

      // 最初のEmbedグループでbotMessageを更新
      if (messageGroups.length > 0) {
        await botMessage.edit({
          content: "",
          embeds: messageGroups[0],
          components: [],
        });

        // 残りのEmbedグループは新しいメッセージとして送信
        for (let i = 1; i < messageGroups.length; i++) {
          await message.channel.send({ embeds: messageGroups[i] });
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
    }
  };
}
