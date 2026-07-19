import { type Message, MessageType, type ThreadChannel } from "discord.js";
import { AppError } from "../../errors";
import { parseAttachments } from "../../services/attachmentParser";
import type { IChatService } from "../../services/chatService";
import type { IModelService } from "../../services/modelService";
import type { ISettingsService } from "../../services/settingsService";
import {
  badgeText,
  buildErrorContainer,
  buildFinalContainer,
  buildStoppedContainer,
  buildStoppedFooterText,
  buildStreamingContainer,
  estimateFinalFooterBudget,
  type FinalMetadata,
  measureTextBudget,
  splitTextIntoMessages,
  toComponentsV2EditPayload,
  toComponentsV2Payload,
  toComponentsV2ReplyPayload,
  ZERO_TEXT_BUDGET,
} from "../../utils/chatContainerBuilder";
import { getColorForModel } from "../../utils/embedBuilder";
import { logger } from "../../utils/logger";
import { DiscordStreamingUpdater } from "./streamingUpdater";

function shouldRespond(
  message: Message,
  botId: string,
  autoReplyChannels: string[],
): { respond: boolean; isMention: boolean } {
  // メンションがある場合は応答（@everyone/@here は discord.js 仕様で has() が true を返してしまうため除外）
  if (message.mentions.has(botId, { ignoreEveryone: true })) {
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

/**
 * finishReason が "stop" 以外（打ち切り/モデレーション）で終わった最終応答に付ける短い注記。
 * 履歴に積む raw content 自体は変えず、UI 表示にだけ付加する（設計「終了判定マトリクス」）。
 */
function buildFinishReasonNote(
  finishReason: "stop" | "length" | "content_filter",
): string | undefined {
  switch (finishReason) {
    case "length":
      return "応答が最大出力長に達したため途中で打ち切られました";
    case "content_filter":
      return "プロバイダのコンテンツフィルタにより応答が制限されました";
    default:
      return undefined;
  }
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
    // （初期メッセージ送信前に例外が起きた場合は undefined のまま — cleanupBotMessagesOnFatalError は
    // 空配列を渡されると何もしない）
    let updater: DiscordStreamingUpdater | undefined;

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
      const initialBotMessage = await message.channel.send(toComponentsV2Payload(initialContainer));
      updater = new DiscordStreamingUpdater(message, initialBotMessage, modelName, color);

      const startTime = Date.now();
      const result = await chatService.generateChatResponse(
        message.guild.id,
        { text: content, parts: attachmentResult.parts },
        message.id,
        updater,
        { channelId: message.channel.id, userId: message.author.id },
      );

      if (result.status === "cancelled") {
        // 最終描画の直前に必ず finalize する: 放棄された（timeout/cancel で await が打ち切られた）
        // updater 呼び出しがこの後に遅れて解決しても、停止表示を stale な内容で上書きさせない。
        updater.markFinalized();
        // 停止時: Section を外し、経過秒数 + 受信済み文字数の footer TextDisplay を表示
        // （usage チャンクは届かず GET /api/v1/generation も 404 のため、確定情報として文字数を使う）
        const elapsedSeconds = updater.elapsedSeconds;
        // コードポイント数（UTF-16 コードユニット数だと絵文字等が 2 字以上に数えられる）
        const receivedChars = Array.from(updater.text).length;
        await updateStoppedMessages(
          updater.messages,
          updater.text || "（応答なし）",
          modelName,
          color,
          elapsedSeconds,
          receivedChars,
          message,
        );
        return;
      }

      if (result.status === "error") {
        throw result.error;
      }

      // 最終更新（Components V2、footer 付き、Section なし）
      const latency = Date.now() - startTime;
      const metadata: FinalMetadata = {
        showDetails: settings.showLlmDetails,
        model: result.model,
        provider: result.provider,
        latency,
        usage: result.usage,
        note: buildFinishReasonNote(result.finishReason),
      };
      // 表示には updater が保持する全表示テキスト（commit 済み過去ターンの preamble + 最終ターンの
      // content）を使う。result.text は最終ターンの content のみのため、tool_calls を挟んだ場合に
      // 使うと commit 済み preamble が最終描画から消えてしまう（tool 未登録時は preamble が無く
      // updater.text === result.text になるため挙動は変わらない）。
      // OpenRouter が空文字列で完了した場合、setContent("") の同期 throw を避けるためフォールバックする
      const finalText = updater.text || "（応答なし）";
      const footerBudget = estimateFinalFooterBudget(metadata);
      const chunks = splitTextIntoMessages(
        finalText,
        measureTextBudget(badgeText(modelName)),
        footerBudget,
      );

      const botMessages = updater.messages;

      // 最終描画の直前に必ず finalize する: 放棄された updater 呼び出しがこの後に遅れて解決しても、
      // これから送る確定表示を停止ボタン付きの stale な内容で上書きさせない。
      updater.markFinalized();

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
      // ログ検索とユーザーからの問い合わせ突合用の短いID（先頭8桁の16進数）
      const errorId = crypto.randomUUID().slice(0, 8);
      logger.error("Failed to generate response", { errorId, error, guildId: message.guild.id });

      // 最終描画の直前に必ず finalize する: 放棄された updater 呼び出しがこの後に遅れて解決しても、
      // これから行うクリーンアップ表示を停止ボタン付きの stale な内容で上書きさせない。
      updater?.markFinalized();

      // 「生成中...」+ 停止ボタンが残置されないよう best-effort でクリーンアップする
      await cleanupBotMessagesOnFatalError(
        updater?.messages ?? [],
        updater?.text ?? "",
        modelName,
        color,
        message,
      );

      const userMessage =
        error instanceof AppError
          ? error.userMessage
          : "予期しないエラーが発生しました。問題が続く場合は管理者にお問い合わせください。";

      try {
        const errorContainer = buildErrorContainer(`${userMessage}\n\nエラーID: \`${errorId}\``);
        await message.reply(toComponentsV2ReplyPayload(errorContainer));
      } catch (replyError) {
        logger.error("Failed to send error message", {
          replyError,
          errorId,
          guildId: message.guild.id,
        });
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
  const chunks = splitTextIntoMessages(
    fullText,
    measureTextBudget(badgeText(modelName)),
    ZERO_TEXT_BUDGET,
  );
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
 * 停止（キャンセル）時のメッセージを更新する。
 * Section を持たず、経過秒数 + 受信済み文字数の footer TextDisplay のみを末尾メッセージに表示する。
 */
async function updateStoppedMessages(
  botMessages: Message[],
  fullText: string,
  modelName: string,
  color: number,
  elapsedSeconds: number,
  receivedChars: number,
  originalMessage: Message,
): Promise<void> {
  const footerText = buildStoppedFooterText(elapsedSeconds, receivedChars);
  const chunks = splitTextIntoMessages(
    fullText,
    measureTextBudget(badgeText(modelName)),
    measureTextBudget(footerText),
  );

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
      receivedChars,
    });

    if (i < botMessages.length) {
      await botMessages[i].edit(toComponentsV2EditPayload(container));
    } else if ("send" in originalMessage.channel) {
      const newMessage = await originalMessage.channel.send(toComponentsV2Payload(container));
      botMessages.push(newMessage);
    }
  }
}
