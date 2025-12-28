import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type EmbedBuilder } from "discord.js";
import type { GuildSettings } from "../types";
import { EmbedColors } from "../types/embed";
import { createEmbed } from "./embedBuilder";

interface StatusMessageData {
  credits: { remaining: number };
  rateLimited: boolean;
  cacheStatus: { lastUpdatedAt: Date | null; modelCount: number };
  settings?: GuildSettings;
  version: string;
}

export function buildStatusMessage(data: StatusMessageData): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  // Embed構築
  const remainingText =
    data.credits.remaining === Number.POSITIVE_INFINITY
      ? "無制限"
      : `$${data.credits.remaining.toFixed(4)}`;

  let cacheText: string;
  if (data.cacheStatus.lastUpdatedAt) {
    const unixSeconds = Math.floor(data.cacheStatus.lastUpdatedAt.getTime() / 1000);
    cacheText = `<t:${unixSeconds}:R> (${data.cacheStatus.modelCount}件)`;
  } else {
    cacheText = "未取得";
  }

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "バージョン", value: `v${data.version}`, inline: true },
    { name: "OpenRouter残高", value: remainingText, inline: true },
    { name: "レート制限", value: data.rateLimited ? "制限中" : "正常", inline: true },
    { name: "モデルキャッシュ", value: cacheText, inline: true },
  ];

  if (data.settings) {
    const releaseChannelText = data.settings.releaseChannelId
      ? `<#${data.settings.releaseChannelId}>`
      : "未設定";

    fields.push(
      { name: "デフォルトモデル", value: `\`${data.settings.defaultModel}\``, inline: true },
      {
        name: "無料モデル限定",
        value: data.settings.freeModelsOnly ? "有効" : "無効",
        inline: true,
      },
      { name: "LLM詳細表示", value: data.settings.showLlmDetails ? "ON" : "OFF", inline: true },
      { name: "リリース通知先", value: releaseChannelText, inline: true },
    );
  }

  const embed = createEmbed({
    color: EmbedColors.BLURPLE,
    title: "ステータス",
    fields,
    timestamp: null,
  });

  // ボタン構築（Guild内のみ）
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (data.settings) {
    const freeOnlyButton = new ButtonBuilder()
      .setCustomId("status_toggle_free_only")
      .setLabel(`無料モデル限定: ${data.settings.freeModelsOnly ? "ON" : "OFF"}`)
      .setStyle(data.settings.freeModelsOnly ? ButtonStyle.Success : ButtonStyle.Secondary);

    const llmDetailsButton = new ButtonBuilder()
      .setCustomId("status_toggle_llm_details")
      .setLabel(`LLM詳細: ${data.settings.showLlmDetails ? "ON" : "OFF"}`)
      .setStyle(data.settings.showLlmDetails ? ButtonStyle.Success : ButtonStyle.Secondary);

    const refreshButton = new ButtonBuilder()
      .setCustomId("status_model_refresh")
      .setLabel("モデルキャッシュ更新")
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      freeOnlyButton,
      llmDetailsButton,
      refreshButton,
    );

    components.push(row);
  }

  return { embeds: [embed], components };
}
