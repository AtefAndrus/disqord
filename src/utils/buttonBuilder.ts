import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { MessageId } from "../types";

export function createStopButton(messageId: MessageId): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`stop_response_${messageId}`)
      .setLabel("停止")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🛑"),
  );
}
