import { type Message, MessageType, type ThreadChannel } from "discord.js";
import { AppError } from "../../errors";
import { parseAttachments } from "../../services/attachmentParser";
import type { IChatService } from "../../services/chatService";
import type { IModelService } from "../../services/modelService";
import type { ISettingsService } from "../../services/settingsService";
import type { StreamFinalResult } from "../../types";
import {
  badgeText,
  buildErrorContainer,
  buildFinalContainer,
  buildStoppedContainer,
  buildStoppedFooterText,
  buildStreamingContainer,
  estimateFinalFooterChars,
  type FinalMetadata,
  STREAMING_LABEL,
  splitTextIntoMessages,
  toComponentsV2EditPayload,
  toComponentsV2Payload,
  toComponentsV2ReplyPayload,
} from "../../utils/chatContainerBuilder";
import { getColorForModel } from "../../utils/embedBuilder";
import { logger } from "../../utils/logger";

const STREAM_UPDATE_INTERVAL = 2000; // 2秒

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

    // 添付ファイルをパース（画像はそのまま、PDF は data URL 化）
    const attachmentResult = await parseAttachments(message.attachments);

    if (attachmentResult.rejected.length > 0) {
      const rejectionLines = attachmentResult.rejected
        .map((r) => {
          switch (r.reason) {
            case "MISSING_MIME":
              return `- ${r.filename}: MIME を判定できませんでした`;
            case "FETCH_FAILED":
              return `- ${r.filename}: ファイルの取得に失敗しました`;
            case "FILE_TOO_LARGE":
              return `- ${r.filename}: PDF のサイズ上限 (1ファイル 20MB / 合計 40MB) を超えています`;
            default:
              return `- ${r.filename}: サポート外の形式です`;
          }
        })
        .join("\n");
      const errorContainer = buildErrorContainer(
        `添付ファイルを処理できませんでした。\n対応形式: 画像 (PNG / JPEG / GIF / WebP) と PDF (application/pdf)\n\n${rejectionLines}`,
        "添付ファイルエラー",
      );
      await message.reply(toComponentsV2ReplyPayload(errorContainer));
      return;
    }

    if (!content && attachmentResult.parts.length === 0) {
      const errorContainer = buildErrorContainer("メッセージを入力してください。", "入力エラー");
      await message.reply(toComponentsV2ReplyPayload(errorContainer));
      return;
    }

    if (!("send" in message.channel)) {
      return;
    }

    // 事前にモデル情報を取得
    const modelName =
      (await modelService.getModelName(settings.defaultModel)) ?? settings.defaultModel;
    const color = getColorForModel(settings.defaultModel);

    // 画像添付がある場合、モデルが画像入力に対応するかを事前判定
    // null（メタ取得不可 / architecture 欠落）は判定不能のため透過し OpenRouter 側に委ねる
    if (attachmentResult.hasImage) {
      const capable = await modelService.isMultimodalCapable(settings.defaultModel, "image");
      if (capable === false) {
        const errorContainer = buildErrorContainer(
          `現在のモデル \`${settings.defaultModel}\` は画像入力に対応していません。\n\`/disqord model set\` で画像対応モデルに切り替えてください。`,
          "モデル非対応",
        );
        await message.reply(toComponentsV2ReplyPayload(errorContainer));
        return;
      }
    }

    // 致命的エラー時のクリーンアップで参照するため、外側 catch と共有できるようにホイストする
    let botMessages: Message[] = [];
    let fullText = "";

    try {
      // 初期メッセージ送信（Components V2、停止ボタン付き Section）
      const initialContainer = buildStreamingContainer({
        text: "生成中...",
        modelName,
        color,
        isFirst: true,
        isLast: true,
        triggerMessageId: message.id,
      });
      botMessages = [await message.channel.send(toComponentsV2Payload(initialContainer))];

      let lastUpdate = Date.now();
      let finalResult: StreamFinalResult | null = null;
      const startTime = Date.now();

      try {
        const stream = chatService.generateResponseStream(
          message.guild.id,
          { text: content, parts: attachmentResult.parts },
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
            await updateStreamingMessages(botMessages, fullText, modelName, color, message);
            lastUpdate = now;
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          // 停止時: Section を外し、経過秒数の footer TextDisplay を表示
          const elapsedSeconds = (Date.now() - startTime) / 1000;
          await updateStoppedMessages(
            botMessages,
            fullText || "（応答なし）",
            modelName,
            color,
            elapsedSeconds,
            message,
          );
          return;
        }
        throw error;
      }

      // 最終更新（Components V2、footer 付き、Section なし）
      const latency = Date.now() - startTime;
      const metadata: FinalMetadata = {
        showDetails: settings.showLlmDetails,
        model: finalResult?.model,
        provider: finalResult?.provider,
        latency,
        usage: finalResult?.usage,
      };
      // OpenRouter が空文字列で完了した場合、setContent("") の同期 throw を避けるためフォールバックする
      const finalText = (finalResult?.fullText ?? fullText) || "（応答なし）";
      const footerChars = estimateFinalFooterChars(metadata);
      const chunks = splitTextIntoMessages(finalText, badgeText(modelName).length, footerChars);

      // 既存メッセージを更新し、必要に応じて新しいメッセージを追加
      for (let i = 0; i < chunks.length; i++) {
        const isFirst = i === 0;
        const isLast = i === chunks.length - 1;
        const container = buildFinalContainer({
          text: chunks[i],
          modelName,
          color,
          isFirst,
          isLast,
          metadata,
          pageInfo: { page: i + 1, total: chunks.length },
        });

        if (i < botMessages.length) {
          await botMessages[i].edit(toComponentsV2EditPayload(container));
        } else {
          // 致命的エラー時のクリーンアップが送信済みmessageを再取得できるよう、streaming/stopped経路と
          // 同様にbotMessagesへ追跡する（追跡しないと後続chunkのsend失敗時に既送信分が重複送信されうる）
          const newMessage = await message.channel.send(toComponentsV2Payload(container));
          botMessages.push(newMessage);
        }
      }

      // 余分なメッセージを削除（生成途中で複数メッセージになったが、最終的に少なくなった場合）
      for (let i = chunks.length; i < botMessages.length; i++) {
        await deleteOrNeutralize(botMessages[i], modelName, color);
      }
    } catch (error) {
      logger.error("Failed to generate response", { error, guildId: message.guild.id });

      // 「生成中...」+ 停止ボタンが残置されないよう best-effort でクリーンアップする
      await cleanupBotMessagesOnFatalError(botMessages, fullText, modelName, color, message);

      const userMessage =
        error instanceof AppError
          ? error.userMessage
          : "予期しないエラーが発生しました。問題が続く場合は管理者にお問い合わせください。";

      try {
        const errorContainer = buildErrorContainer(userMessage);
        await message.reply(toComponentsV2ReplyPayload(errorContainer));
      } catch (replyError) {
        logger.error("Failed to send error message", { replyError, guildId: message.guild.id });
      }
    }
  };
}

/**
 * message の delete を試み、失敗したら「Section なしの中立プレースホルダー」への edit にフォールバックする。
 * Section 付き stale メッセージ（「生成中...」+ 死んだ停止ボタン等）が恒久残置しないための best-effort 処理。
 * どちらも失敗した場合は warn ログのみで諦める。
 */
async function deleteOrNeutralize(
  botMessage: Message,
  modelName: string,
  color: number,
): Promise<void> {
  try {
    await botMessage.delete();
  } catch (deleteError) {
    logger.warn("Failed to delete bot message, attempting to neutralize instead", {
      deleteError,
      messageId: botMessage.id,
    });
    try {
      const neutralContainer = buildFinalContainer({
        text: "（このメッセージは不要になりました）",
        modelName,
        color,
        isFirst: false,
        isLast: false,
        metadata: { showDetails: false },
      });
      await botMessage.edit(toComponentsV2EditPayload(neutralContainer));
    } catch (neutralizeError) {
      logger.warn("Failed to neutralize bot message", {
        neutralizeError,
        messageId: botMessage.id,
      });
    }
  }
}

/**
 * ストリーミング中に AbortError 以外の致命的エラーが発生した場合、
 * 「生成中...」プレースホルダー + 停止ボタン（Section）が残置されないよう best-effort でクリーンアップする。
 * 部分テキストは splitTextIntoMessages で再分割した chunks 全体を Section なしの Container として保持し
 * （footer なし）、既存 message は edit、不足分は新規 send する。chunks より botMessages が多い場合の
 * 余剰は delete（失敗時は中立プレースホルダーへ edit）。fullText が空なら全 message を削除する。
 * クリーンアップ自体の失敗は warn ログのみで無視する（エラー reply は呼び出し元が別途送る）。
 */
async function cleanupBotMessagesOnFatalError(
  botMessages: Message[],
  fullText: string,
  modelName: string,
  color: number,
  originalMessage: Message,
): Promise<void> {
  if (botMessages.length === 0) {
    return;
  }

  if (!fullText) {
    for (const botMessage of botMessages) {
      await deleteOrNeutralize(botMessage, modelName, color);
    }
    return;
  }

  const metadata: FinalMetadata = { showDetails: false };
  const chunks = splitTextIntoMessages(fullText, badgeText(modelName).length, 0);
  const messageCount = Math.max(chunks.length, botMessages.length);

  for (let i = 0; i < messageCount; i++) {
    if (i < chunks.length) {
      const isFirst = i === 0;
      const isLast = i === chunks.length - 1;
      const container = buildFinalContainer({
        text: chunks[i],
        modelName,
        color,
        isFirst,
        isLast,
        metadata,
      });
      try {
        if (i < botMessages.length) {
          await botMessages[i].edit(toComponentsV2EditPayload(container));
        } else if ("send" in originalMessage.channel) {
          await originalMessage.channel.send(toComponentsV2Payload(container));
        }
      } catch (error) {
        logger.warn("Failed to clean up bot message after fatal error", { error, index: i });
      }
    } else {
      await deleteOrNeutralize(botMessages[i], modelName, color);
    }
  }
}

/**
 * message の Section（停止ボタン）を isLast: true で再 edit し、復元を試みる。
 * message 増加遷移中に send/edit が失敗し、停止ボタンがどこにも無い状態のまま次 chunk 到着まで
 * 固まる（無期限にキャンセル不能になる）のを防ぐための best-effort 処理。
 * 復元自体の失敗も warn ログのみで無視する（次サイクルで自己修復を試みる）。
 */
async function restoreStreamingSection(
  botMessage: Message,
  text: string,
  isFirst: boolean,
  modelName: string,
  color: number,
  triggerMessageId: string,
): Promise<void> {
  try {
    const container = buildStreamingContainer({
      text,
      modelName,
      color,
      isFirst,
      isLast: true,
      triggerMessageId,
    });
    await botMessage.edit(toComponentsV2EditPayload(container));
  } catch (restoreError) {
    logger.warn("Failed to restore stop button section on stripped message", {
      restoreError,
      messageId: botMessage.id,
    });
  }
}

/**
 * ストリーミング中のメッセージを更新する。
 * 長文の場合は複数メッセージに分割し、停止ボタン（Section）は最新メッセージのみに配置する。
 * edit/send の失敗（429 等）は throw させず、当該サイクルの残り処理を break で打ち切って次サイクルへ
 * 委ねる（discord.js 内蔵の rate limit queue に基本委ねる）。失敗した message より後ろを触らずに
 * 打ち切ることで「停止ボタンは常に高々 1 個」の不変条件を守る（例: message[0] の Section 除去 edit が
 * 失敗した状態で message[1] の send だけ成功すると停止ボタンが 2 個になってしまう）。次サイクルで全
 * message が再 edit されるため自己修復する。
 *
 * message 増加遷移（1→2 等）では、旧末尾 message から Section を先に外してから新 message を send する
 * ため、その send が失敗すると停止ボタンがどこにも無い状態になり、次 chunk 到着まで（ストールすれば
 * 無期限に）キャンセル不能になってしまう。これを避けるため、旧末尾 message 以降で「isLast: false へ
 * edit/send 済み（＝ Section を失ったまま）」の最新 index を追跡し、break する前に best-effort で
 * その message へ Section を復元する。edit 自体の失敗による break（旧末尾 message にまだ触れていない
 * ケース）は対象外とする — 実末尾 message には前サイクルの Section が残っており、ボタンは可用のまま。
 */
async function updateStreamingMessages(
  botMessages: Message[],
  fullText: string,
  modelName: string,
  color: number,
  originalMessage: Message,
): Promise<void> {
  const chunks = splitTextIntoMessages(
    fullText,
    badgeText(modelName).length,
    STREAMING_LABEL.length,
  );

  // 前サイクルまで Section（停止ボタン）を保持していた message の index
  const oldLastIndex = botMessages.length - 1;
  // 旧末尾以降で Section を失ったまま留まっている最新の message index（未発生なら null）
  let sectionLostAtIndex: number | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    const container = buildStreamingContainer({
      text: chunks[i],
      modelName,
      color,
      isFirst,
      isLast,
      triggerMessageId: originalMessage.id,
    });

    try {
      if (i < botMessages.length) {
        await botMessages[i].edit(toComponentsV2EditPayload(container));
      } else if ("send" in originalMessage.channel) {
        const newMessage = await originalMessage.channel.send(toComponentsV2Payload(container));
        botMessages.push(newMessage);
      }

      if (i >= oldLastIndex) {
        sectionLostAtIndex = isLast ? null : i;
      }
    } catch (error) {
      logger.warn("Failed to update streaming message, aborting this cycle to retry next cycle", {
        error,
        index: i,
      });

      if (sectionLostAtIndex !== null && sectionLostAtIndex < botMessages.length) {
        await restoreStreamingSection(
          botMessages[sectionLostAtIndex],
          chunks[sectionLostAtIndex],
          sectionLostAtIndex === 0,
          modelName,
          color,
          originalMessage.id,
        );
      }
      break;
    }
  }
}

/**
 * 停止（AbortError）時のメッセージを更新する。
 * Section を持たず、経過秒数の footer TextDisplay のみを末尾メッセージに表示する。
 */
async function updateStoppedMessages(
  botMessages: Message[],
  fullText: string,
  modelName: string,
  color: number,
  elapsedSeconds: number,
  originalMessage: Message,
): Promise<void> {
  const footerText = buildStoppedFooterText(elapsedSeconds);
  const chunks = splitTextIntoMessages(fullText, badgeText(modelName).length, footerText.length);

  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    const container = buildStoppedContainer({
      text: chunks[i],
      modelName,
      color,
      isFirst,
      isLast,
      elapsedSeconds,
    });

    if (i < botMessages.length) {
      await botMessages[i].edit(toComponentsV2EditPayload(container));
    } else if ("send" in originalMessage.channel) {
      const newMessage = await originalMessage.channel.send(toComponentsV2Payload(container));
      botMessages.push(newMessage);
    }
  }
}
