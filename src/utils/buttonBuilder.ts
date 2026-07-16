import { ButtonBuilder, ButtonStyle } from "discord.js";
import type { MessageId } from "../types";

/**
 * 停止ボタン（単独 ButtonBuilder）を生成する。
 * Components V2 の Section accessory として使用するため ActionRow ではなく単独で返す。
 */
export function createStopButton(messageId: MessageId): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`stop_response_${messageId}`)
    .setLabel("停止")
    .setStyle(ButtonStyle.Danger)
    .setEmoji("🛑");
}
