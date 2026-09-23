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

/** The on/off settings `/status` can switch. The key is part of the button's custom ID. */
export const STATUS_SWITCHES = [
  "free_only",
  "llm_details",
  "web_search",
  "twitter_expand",
  "history",
  "reasoning_display",
] as const;
export type StatusSwitch = (typeof STATUS_SWITCHES)[number];

const STATUS_SET_PREFIX = "status_set:";

/**
 * The button names the value it sets rather than "toggle", so two quick
 * presses both land on that value instead of flipping it back.
 */
export function statusSetCustomId(key: StatusSwitch, enabled: boolean): string {
  return `${STATUS_SET_PREFIX}${key}:${enabled ? "on" : "off"}`;
}

export function parseStatusSetCustomId(
  customId: string,
): { key: StatusSwitch; enabled: boolean } | undefined {
  if (!customId.startsWith(STATUS_SET_PREFIX)) return undefined;
  const [key, value] = customId.slice(STATUS_SET_PREFIX.length).split(":");
  if (!STATUS_SWITCHES.includes(key as StatusSwitch)) return undefined;
  if (value !== "on" && value !== "off") return undefined;
  return { key: key as StatusSwitch, enabled: value === "on" };
}

interface SwitchRow {
  key: StatusSwitch;
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
  container.addTextDisplayComponents((td) =>
    td.setContent(
      [
        "## ステータス",
        `**バージョン** v${data.version}`,
        `**OpenRouter残高** ${remainingText}`,
        `**モデルキャッシュ** ${formatCache(data.cacheStatus)}`,
      ].join("\n"),
    ),
  );

  if (data.settings) {
    const settings = data.settings;
    container.addSeparatorComponents((sep) => sep.setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents((td) =>
      td.setContent(`**デフォルトモデル** \`${settings.defaultModel}\``),
    );
    for (const row of switchRows(settings, data.webSearchEngine)) {
      const state = row.enabled ? `有効${row.detail ? `（${row.detail}）` : ""}` : "無効";
      container.addSectionComponents((section) =>
        section
          .addTextDisplayComponents((td) => td.setContent(`**${row.label}** ${state}`))
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(statusSetCustomId(row.key, !row.enabled))
              .setLabel(row.enabled ? "無効にする" : "有効にする")
              .setStyle(row.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
          ),
      );
    }
    container.addSeparatorComponents((sep) => sep.setSpacing(SeparatorSpacingSize.Small));
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("status_model_refresh")
          .setLabel("モデルキャッシュ更新")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("status_auto_reply_list")
          .setLabel("自動応答チャンネル一覧")
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
