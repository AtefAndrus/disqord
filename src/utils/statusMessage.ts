import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorSpacingSize,
} from "discord.js";
import type { GuildSettings } from "../types";
import { EmbedColors } from "../types/embed";

interface StatusMessageData {
  credits: { remaining: number };
  cacheStatus: { lastUpdatedAt: Date | null; modelCount: number };
  settings?: GuildSettings;
  webSearchEngine: string;
  version: string;
}

interface SwitchRow {
  key: string;
  label: string;
  enabled: boolean;
  /** Shown after 有効 when the setting is on. */
  detail?: string;
}

function switchRows(settings: GuildSettings, webSearchEngine: string): SwitchRow[] {
  return [
    { key: "free_only", label: "無料モデル限定", enabled: settings.freeModelsOnly },
    { key: "llm_details", label: "LLM詳細表示", enabled: settings.showLlmDetails },
    {
      key: "web_search",
      label: "Web検索",
      enabled: settings.webSearchEnabled,
      detail: webSearchEngine,
    },
    { key: "twitter_expand", label: "ツイート展開", enabled: settings.twitterExpandEnabled },
    { key: "history", label: "会話履歴", enabled: settings.historyEnabled },
    { key: "reasoning_display", label: "推論表示", enabled: settings.reasoningDisplayEnabled },
  ];
}

function formatCache(cacheStatus: StatusMessageData["cacheStatus"]): string {
  if (!cacheStatus.lastUpdatedAt) return "未取得";
  const unixSeconds = Math.floor(cacheStatus.lastUpdatedAt.getTime() / 1000);
  return `<t:${unixSeconds}:R> (${cacheStatus.modelCount}件)`;
}

export function buildStatusMessage(data: StatusMessageData): {
  components: ContainerBuilder[];
  flags: MessageFlags.IsComponentsV2;
  embeds: [];
  allowedMentions: { parse: [] };
} {
  const remainingText =
    data.credits.remaining === Number.POSITIVE_INFINITY
      ? "無制限"
      : `$${data.credits.remaining.toFixed(4)}`;

  const container = new ContainerBuilder().setAccentColor(EmbedColors.BLURPLE);
  // One TextDisplay per item, so each label and value pair gets its own spacing.
  for (const content of [
    "## ステータス",
    `**バージョン**\nv${data.version}`,
    `**OpenRouter残高**\n${remainingText}`,
    `**モデルキャッシュ**\n${formatCache(data.cacheStatus)}`,
  ]) {
    container.addTextDisplayComponents((td) => td.setContent(content));
  }

  if (data.settings) {
    const settings = data.settings;
    container.addTextDisplayComponents((td) =>
      td.setContent(
        `**リリース通知先**\n${settings.releaseAnnounceChannelId ? `<#${settings.releaseAnnounceChannelId}>` : "通知しない"}`,
      ),
    );
    container.addSeparatorComponents((sep) => sep.setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents((td) =>
      td.setContent(`**デフォルトモデル**\n\`${settings.defaultModel}\``),
    );
    for (const row of switchRows(settings, data.webSearchEngine)) {
      const state = row.enabled ? `有効${row.detail ? `（${row.detail}）` : ""}` : "無効";
      container.addTextDisplayComponents((td) => td.setContent(`**${row.label}**\n${state}`));
    }
    container.addSeparatorComponents((sep) => sep.setSpacing(SeparatorSpacingSize.Small));
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("status_model_refresh")
          .setLabel("モデルキャッシュ更新")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("cfg:open")
          .setLabel("設定を開く")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }

  // `embeds: []` clears the embed of a `/status` message posted before this
  // layout, which Discord requires when an edit turns a message into Components V2.
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    embeds: [],
    allowedMentions: { parse: [] },
  };
}
