import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { GuildSettings } from "../types";

export const CONFIG_PAGES = {
  response: "応答",
  features: "機能",
  channels: "チャンネル",
  admin: "管理",
} as const;
export type ConfigPage = keyof typeof CONFIG_PAGES;
export const CONFIG_SWITCHES = {
  free_only: {
    page: "response",
    field: "freeModelsOnly",
    label: "無料モデル限定",
    description: "無料モデルだけを利用します。",
  },
  llm_details: {
    page: "response",
    field: "showLlmDetails",
    label: "LLM 詳細表示",
    description: "モデル名、使用量と費用を応答に表示します。",
  },
  reasoning_display: {
    page: "response",
    field: "reasoningDisplayEnabled",
    label: "推論表示",
    description: "モデルの推論内容をチャンネルに公開します。",
  },
  twitter_expand: {
    page: "response",
    field: "twitterExpandEnabled",
    label: "ツイート展開",
    description: "ツイートのリンク先を取得してモデルに渡します。",
  },
  web_search: {
    page: "features",
    field: "webSearchEnabled",
    label: "Web 検索",
    description: "最新情報を検索します。検索ごとに費用が発生します。",
  },
  history: {
    page: "features",
    field: "historyEnabled",
    label: "会話履歴",
    description: "チャンネルの会話履歴をモデルに渡します。",
  },
} as const;
export type ConfigSwitch = keyof typeof CONFIG_SWITCHES;
export type ChannelList = "auto" | "allowed";
export type ConfigAction =
  | { action: "open" | "page" }
  | { action: "set"; page: "response" | "features"; key: ConfigSwitch; enabled: boolean }
  | { action: "add" | "remove"; page: "channels"; list: ChannelList }
  | { action: "list"; page: "channels"; list: ChannelList; index: number }
  | { action: "role" | "clear"; page: "admin" };

export function isConfigPage(value: string): value is ConfigPage {
  return Object.hasOwn(CONFIG_PAGES, value);
}

export function configCustomId(action: ConfigAction): string {
  if (action.action === "open" || action.action === "page") return `cfg:${action.action}`;
  if (action.action === "set")
    return `cfg:${action.page}:set:${action.key}:${action.enabled ? "on" : "off"}`;
  if (action.action === "list") return `cfg:channels:list:${action.list}:${action.index}`;
  if (action.action === "add" || action.action === "remove")
    return `cfg:channels:${action.action}:${action.list}`;
  return `cfg:admin:${action.action}`;
}

export function parseConfigCustomId(value: string): ConfigAction | undefined {
  if (value.length > 100) return undefined;
  if (value === "cfg:open") return { action: "open" };
  if (value === "cfg:page") return { action: "page" };
  const parts = value.split(":");
  const [prefix, page, action, key, state] = parts;
  if (prefix !== "cfg") return undefined;
  if (
    (page === "response" || page === "features") &&
    action === "set" &&
    parts.length === 5 &&
    Object.hasOwn(CONFIG_SWITCHES, key) &&
    (state === "on" || state === "off")
  ) {
    const typedKey = key as ConfigSwitch;
    if (CONFIG_SWITCHES[typedKey].page !== page) return undefined;
    return { page, action, key: typedKey, enabled: state === "on" };
  }
  if (page === "channels" && (key === "auto" || key === "allowed")) {
    if ((action === "add" || action === "remove") && parts.length === 4)
      return { page, action, list: key };
    if (
      action === "list" &&
      parts.length === 5 &&
      /^(0|[1-9]\d*)$/.test(state) &&
      Number.isSafeInteger(Number(state))
    )
      return { page, action, list: key, index: Number(state) };
  }
  if (page === "admin" && (action === "role" || action === "clear") && parts.length === 3)
    return { page, action };
  return undefined;
}

export interface IConfigPanelOptions {
  autoPage?: number;
  allowedPage?: number;
  channel?: (id: string) => { name: string; parentId: string | null } | undefined;
}

export function buildConfigPanel(
  page: ConfigPage,
  settings: GuildSettings,
  options: IConfigPanelOptions = {},
): {
  components: ContainerBuilder[];
  flags: MessageFlags.IsComponentsV2;
  allowedMentions: { parse: [] };
} {
  const container = new ContainerBuilder().addActionRowComponents(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(configCustomId({ action: "page" }))
        .setPlaceholder("設定ページを選択")
        .addOptions(
          Object.entries(CONFIG_PAGES).map(([value, label]) => ({
            value,
            label,
            default: value === page,
          })),
        ),
    ),
  );
  const changedAt = Math.floor(new Date(settings.updatedAt).getTime() / 1000);
  container.addTextDisplayComponents((text) =>
    text.setContent(
      `最終変更: ${settings.updatedBy ? `<@${settings.updatedBy}> ` : ""}（<t:${changedAt}:R>）\n## 設定 · ${CONFIG_PAGES[page]}`,
    ),
  );
  for (const key of Object.keys(CONFIG_SWITCHES) as ConfigSwitch[]) {
    const entry = CONFIG_SWITCHES[key];
    if (entry.page !== page) continue;
    const enabled = settings[entry.field];
    container.addSectionComponents((section) =>
      section
        .addTextDisplayComponents((text) =>
          text.setContent(`**${entry.label}: ${enabled ? "有効" : "無効"}**\n${entry.description}`),
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(
              configCustomId({ action: "set", page: entry.page, key, enabled: !enabled }),
            )
            .setLabel(`${entry.label}を${enabled ? "無効" : "有効"}にする`)
            .setStyle(enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
        ),
    );
  }
  if (page === "channels") {
    for (const list of ["auto", "allowed"] as const) {
      const label = list === "auto" ? "自動応答チャンネル" : "許可チャンネル";
      const channels =
        list === "auto" ? settings.autoReplyChannels : (settings.allowedChannels ?? []);
      const maxPage = Math.max(0, Math.ceil(channels.length / 25) - 1);
      const index = Math.max(
        0,
        Math.min(
          maxPage,
          Math.floor((list === "auto" ? options.autoPage : options.allowedPage) ?? 0),
        ),
      );
      const visible = channels.slice(index * 25, (index + 1) * 25);
      const lines = visible.map((id) => {
        const parentId = options.channel?.(id)?.parentId;
        const outside =
          list === "auto" &&
          settings.allowedChannels !== null &&
          !settings.allowedChannels.includes(id) &&
          !(parentId && settings.allowedChannels.includes(parentId));
        return `<#${id}>${outside ? " — 許可チャンネル外のため応答しない" : ""}`;
      });
      container.addTextDisplayComponents((text) =>
        text.setContent(
          `### ${label}（${channels.length} 件）\n${lines.join("\n") || (list === "auto" ? "自動応答なし" : "全チャンネルで応答")}\n${list === "allowed" ? "最後の 1 件を削除すると全チャンネルで応答します。" : "メンションがなくても応答します。"}`,
        ),
      );
      container.addActionRowComponents(
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId(configCustomId({ page, action: "add", list }))
            .setPlaceholder(`${label}を追加`)
            .setChannelTypes(ChannelType.GuildText, ChannelType.PublicThread)
            .setMinValues(1)
            .setMaxValues(1),
        ),
      );
      if (visible.length) {
        container.addActionRowComponents(
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(configCustomId({ page, action: "remove", list }))
              .setPlaceholder(`${label}を削除`)
              .addOptions(
                visible.map((id) => ({
                  label: (options.channel?.(id)?.name ?? `ID: ${id}`).slice(0, 100),
                  value: id,
                })),
              ),
          ),
        );
      }
      if (maxPage > 0) {
        container.addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(
                configCustomId({ page, action: "list", list, index: Math.max(0, index - 1) }),
              )
              .setLabel(`${label}: 前へ`)
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(index === 0),
            new ButtonBuilder()
              .setCustomId(configCustomId({ page, action: "list", list, index: index + 1 }))
              .setLabel(`${label}: 次へ (${index + 1}/${maxPage + 1})`)
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(index === maxPage),
          ),
        );
      }
    }
  }
  if (page === "admin") {
    container.addTextDisplayComponents((text) =>
      text.setContent(
        `### 管理ロール\n${settings.adminRoleId ? `<@&${settings.adminRoleId}>` : "`ManageGuild` の持ち主だけが変更できる"}\n管理ロールの変更と解除には「サーバーの管理」権限が必要です。`,
      ),
    );
    container.addActionRowComponents(
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(configCustomId({ page, action: "role" }))
          .setPlaceholder("管理ロールを選択")
          .setMinValues(1)
          .setMaxValues(1),
      ),
    );
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(configCustomId({ page, action: "clear" }))
          .setLabel("管理ロールを解除")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(settings.adminRoleId === null),
      ),
    );
  }
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}
