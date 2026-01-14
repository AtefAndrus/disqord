import { type Message, MessageType, type ThreadChannel } from "discord.js";
import { AppError } from "../../errors";
import type { IChatService } from "../../services/chatService";
import type { IModelService } from "../../services/modelService";
import type { ISettingsService } from "../../services/settingsService";
import type { StreamFinalResult } from "../../types";
import { createStopButton } from "../../utils/buttonBuilder";
import {
  createErrorEmbed,
  createStreamingEmbed,
  getColorForModel,
  splitTextIntoChunks,
  splitTextToMultipleMessages,
} from "../../utils/embedBuilder";
import { logger } from "../../utils/logger";

const STREAM_UPDATE_INTERVAL = 2000; // 2秒
const EMBED_DESC_LIMIT = 4096; // Embed description制限

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

export function createMessageCreateHandler(
  chatService: IChatService,
  settingsService: ISettingsService,
  modelService: IModelService,
) {
  return async function onMessageCreate(message: Message): Promise<void> {
    if (message.author.bot) {
      return;
    }

    // システムメッセージ（スレッド作成通知等）を無視
    if (message.type !== MessageType.Default && message.type !== MessageType.Reply) {
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

    // 事前にモデル情報を取得
    const modelName =
      (await modelService.getModelName(settings.defaultModel)) ?? settings.defaultModel;
    const color = getColorForModel(settings.defaultModel);

    try {
      // 初期メッセージ送信（Embed形式、停止ボタン付き）
      const initialEmbed = createStreamingEmbed("生成中...", modelName, color, "生成中...");
      const botMessages: Message[] = [
        await message.channel.send({
          embeds: [initialEmbed],
          components: [createStopButton(message.id)],
        }),
      ];

      let fullText = "";
      let lastUpdate = Date.now();
      let finalResult: StreamFinalResult | null = null;
      const startTime = Date.now();

      try {
        const stream = chatService.generateResponseStream(message.guild.id, content, message.id);

        for await (const chunk of stream) {
          if (chunk.done) {
            finalResult = chunk;
            break;
          }

          fullText += chunk.content;

          const now = Date.now();
          if (now - lastUpdate >= STREAM_UPDATE_INTERVAL) {
            await updateStreamingMessages(
              botMessages,
              fullText,
              modelName,
              color,
              message,
              "生成中...",
            );
            lastUpdate = now;
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          // 停止時: フッター付きEmbedで表示
          const elapsedMs = Date.now() - startTime;
          const footerText = `${modelName} | ${(elapsedMs / 1000).toFixed(1)}s | Stopped`;

          await updateStreamingMessages(
            botMessages,
            fullText || "（応答なし）",
            modelName,
            color,
            message,
            footerText,
            true, // 停止ボタンを削除
          );
          return;
        }
        throw error;
      }

      // 最終更新（Embed形式、フッター付き、ボタン削除）
      const latency = Date.now() - startTime;

      const messageGroups = splitTextToMultipleMessages(
        finalResult?.fullText ?? fullText,
        {
          color,
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

      // 既存メッセージを更新し、必要に応じて新しいメッセージを追加
      for (let i = 0; i < messageGroups.length; i++) {
        if (i < botMessages.length) {
          await botMessages[i].edit({
            embeds: messageGroups[i],
            components: [],
          });
        } else {
          await message.channel.send({ embeds: messageGroups[i] });
        }
      }

      // 余分なメッセージを削除（生成途中で複数メッセージになったが、最終的に少なくなった場合）
      for (let i = messageGroups.length; i < botMessages.length; i++) {
        try {
          await botMessages[i].delete();
        } catch {
          // 削除失敗は無視
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

/**
 * ストリーミング中のメッセージを更新
 * 長文の場合は複数メッセージに分割
 */
async function updateStreamingMessages(
  botMessages: Message[],
  fullText: string,
  modelName: string,
  color: number,
  originalMessage: Message,
  footer: string,
  removeButtons = false,
): Promise<void> {
  const chunks = splitTextIntoChunks(fullText, EMBED_DESC_LIMIT);
  const stopButton = removeButtons ? [] : [createStopButton(originalMessage.id)];

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const chunkFooter = chunks.length > 1 ? `ページ ${i + 1}/${chunks.length} | ${footer}` : footer;
    const embed = createStreamingEmbed(chunks[i], modelName, color, chunkFooter);

    if (i < botMessages.length) {
      // 既存メッセージを更新
      await botMessages[i].edit({
        embeds: [embed],
        components: isLast ? stopButton : [],
      });
    } else if ("send" in originalMessage.channel) {
      // 新しいメッセージを追加
      const newMessage = await originalMessage.channel.send({
        embeds: [embed],
        components: isLast ? stopButton : [],
      });
      botMessages.push(newMessage);
    }
  }
}
