import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { CronJob, CronProposal } from "../db/repositories/cronRepository";
import { describeSearchBilling, type WebSearchEngine } from "../llm/tools/webSearch";
import { type CronSchedule, describeSchedule, formatScheduleInput } from "../services/cronSchedule";
import { EmbedColors } from "../types/embed";

export const CRON_PAGE_SIZE = 25;
export const CRON_INVALID_MESSAGE = "この操作は無効です。`/cron` から開き直してください。";
/** Channel types a job can post to; the delivery resolver accepts the same three. */
export const CRON_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
] as const;
export const CRON_MODAL_FIELDS = {
  name: "name",
  schedule: "schedule",
  prompt: "prompt",
  channel: "channel",
  silent: "silent",
} as const;

type JobAction =
  | "view"
  | "edit"
  | "run"
  | "pause"
  | "resume"
  | "delete"
  | "confirm-delete"
  | "search-on"
  | "confirm-search-on"
  | "search-off";
export type CronAction =
  | { action: "list"; page: number }
  | { action: "select"; page: number }
  | { action: "new" }
  | { action: JobAction; jobId: number; version: number }
  | { action: "modal-new" }
  | { action: "modal-edit"; jobId: number; version: number }
  | {
      action: "proposal";
      decision: "approve" | "reject" | "search";
      proposalId: number;
      shownWebSearch?: boolean;
    };

const JOB_ACTIONS: readonly string[] = [
  "view",
  "edit",
  "run",
  "pause",
  "resume",
  "delete",
  "confirm-delete",
  "search-on",
  "confirm-search-on",
  "search-off",
];

export function cronCustomId(action: CronAction): string {
  switch (action.action) {
    case "list":
    case "select":
      return `cron:${action.action}:${action.page}`;
    case "new":
      return "cron:new";
    case "modal-new":
      return "cron:modal:new";
    case "modal-edit":
      return `cron:modal:edit:${action.jobId}:${action.version}`;
    case "proposal":
      return `cron:proposal:${action.decision}:${action.proposalId}${action.shownWebSearch === undefined ? "" : `:${action.shownWebSearch ? 1 : 0}`}`;
    default:
      return `cron:${action.action}:${action.jobId}:${action.version}`;
  }
}

function toId(value: string | undefined): number | undefined {
  if (value === undefined || !/^(0|[1-9]\d*)$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

export function parseCronCustomId(value: string): CronAction | undefined {
  if (value.length > 100) return undefined;
  const parts = value.split(":");
  const [prefix, action, first, second, third] = parts;
  if (prefix !== "cron") return undefined;
  if (action === "new" && parts.length === 2) return { action };
  if ((action === "list" || action === "select") && parts.length === 3) {
    const page = toId(first);
    return page === undefined ? undefined : { action, page };
  }
  if (action === "modal") {
    if (first === "new" && parts.length === 3) return { action: "modal-new" };
    const jobId = toId(second);
    const version = toId(third);
    return first === "edit" && parts.length === 5 && jobId !== undefined && version !== undefined
      ? { action: "modal-edit", jobId, version }
      : undefined;
  }
  if (
    action === "proposal" &&
    (parts.length === 4 || parts.length === 5) &&
    (first === "approve" || first === "reject" || first === "search")
  ) {
    const proposalId = toId(second);
    if (
      proposalId === undefined ||
      (parts.length === 5 && third !== "0" && third !== "1") ||
      (first === "search" && parts.length !== 5)
    )
      return undefined;
    return {
      action,
      decision: first,
      proposalId,
      ...(parts.length === 5 && { shownWebSearch: third === "1" }),
    };
  }
  if (action !== undefined && JOB_ACTIONS.includes(action) && parts.length === 4) {
    const jobId = toId(first);
    const version = toId(second);
    return jobId === undefined || version === undefined
      ? undefined
      : { action: action as JobAction, jobId, version };
  }
  return undefined;
}

type PanelPayload = {
  components: ContainerBuilder[];
  flags: MessageFlags.IsComponentsV2;
  allowedMentions: { parse: [] };
};

function payload(container: ContainerBuilder): PanelPayload {
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

const jstFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function timestamp(ms: number | null): string {
  return ms === null ? "なし" : `<t:${Math.floor(ms / 1000)}:f>`;
}

export function statusLabel(job: Pick<CronJob, "status" | "lastRunAt">): string {
  if (job.status === "active") return "有効";
  if (job.status === "paused") return "停止中";
  return job.lastRunAt === null ? "実行されずに終了" : "完了";
}

/** Shows the stored expression next to the reading, so a cron expression can be checked as written. */
export function formatSchedule(schedule: CronSchedule, forProposal = false): string {
  if (schedule.kind === "interval" && !forProposal)
    return `${Number(schedule.expr) / 60_000} 分ごと`;
  const reading = describeSchedule(schedule);
  return schedule.kind === "cron" && reading !== schedule.expr
    ? `${reading}（\`${schedule.expr}\`）`
    : schedule.kind === "cron"
      ? `\`${schedule.expr}\``
      : reading;
}

function deliveryLabel(silent: boolean): string {
  return silent ? "伝えることがあるときだけ投稿する" : "毎回投稿する";
}

export function buildCronList(jobs: readonly CronJob[], page: number): PanelPayload {
  const maxPage = Math.max(0, Math.ceil(jobs.length / CRON_PAGE_SIZE) - 1);
  const index = Math.max(0, Math.min(maxPage, Math.floor(page)));
  const visible = jobs.slice(index * CRON_PAGE_SIZE, (index + 1) * CRON_PAGE_SIZE);
  const container = new ContainerBuilder()
    .setAccentColor(EmbedColors.BLURPLE)
    .addTextDisplayComponents((text) =>
      text.setContent(
        `## 定期実行（${jobs.length} 件）\n${jobs.length ? "ジョブを選ぶと詳細を表示します。" : "登録されたジョブはありません。"}`,
      ),
    );
  if (visible.length) {
    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(cronCustomId({ action: "select", page: index }))
          .setPlaceholder("ジョブを選択")
          .addOptions(
            visible.map((job) => ({
              label: job.name.slice(0, 100),
              value: String(job.id),
              description:
                `${statusLabel(job)} · 次回 ${job.nextRunAt === null ? "なし" : jstFormat.format(job.nextRunAt)}`.slice(
                  0,
                  100,
                ),
            })),
          ),
      ),
    );
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cronCustomId({ action: "new" }))
      .setLabel("追加")
      .setStyle(ButtonStyle.Primary),
  );
  if (maxPage > 0) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(cronCustomId({ action: "list", page: Math.max(0, index - 1) }))
        .setLabel("前へ")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(index === 0),
      new ButtonBuilder()
        // The page number keeps the two buttons' ids distinct on the first and last page.
        .setCustomId(cronCustomId({ action: "list", page: Math.min(maxPage, index + 1) }))
        .setLabel(`次へ (${index + 1}/${maxPage + 1})`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(index === maxPage),
    );
  }
  container.addActionRowComponents(row);
  return payload(container);
}

export function buildCronDetail(
  job: CronJob,
  options: {
    confirmDelete?: boolean;
    confirmSearchOn?: boolean;
    guildWebSearchEnabled?: boolean;
    webSearchEngine?: WebSearchEngine;
  } = {},
): PanelPayload {
  const lines = [
    `## ${job.name}`,
    `**状態:** ${statusLabel(job)}`,
    `**スケジュール:** ${formatSchedule(job)}`,
    `**次回:** ${timestamp(job.nextRunAt)}`,
    `**直近の実行:** ${timestamp(job.lastRunAt)}`,
    `**配信先:** <#${job.channelId}>`,
    `**投稿の条件:** ${deliveryLabel(job.silent)}`,
    `**Web 検索:** ${job.webSearch ? (options.guildWebSearchEnabled === false ? "オン（ギルドの設定が無効のため使われない）" : "オン") : "オフ"}`,
    ...(options.confirmSearchOn
      ? [describeSearchBilling(options.webSearchEngine ?? "perplexity")]
      : []),
    `**登録者:** <@${job.userId}>`,
    ...(job.lastError ? [`**直近のエラー:** ${job.lastError}`] : []),
  ];
  const container = new ContainerBuilder()
    .setAccentColor(EmbedColors.BLURPLE)
    .addTextDisplayComponents((text) => text.setContent(lines.join("\n")))
    .addTextDisplayComponents((text) => text.setContent(`### プロンプト\n${job.prompt}`));
  const ids = { jobId: job.id, version: job.version };
  const button = (
    action: JobAction | "list",
    label: string,
    style: ButtonStyle = ButtonStyle.Secondary,
  ): ButtonBuilder =>
    new ButtonBuilder()
      .setCustomId(cronCustomId(action === "list" ? { action, page: 0 } : { action, ...ids }))
      .setLabel(label)
      .setStyle(style);
  const buttons: ButtonBuilder[] = [];
  // A done job never returns to active or paused (design: done を再開しない), so it has no edit either.
  if (job.status !== "done") {
    buttons.push(button("edit", "編集"));
    buttons.push(
      job.webSearch
        ? button("search-off", "Web 検索をオフにする")
        : options.confirmSearchOn
          ? button("confirm-search-on", "Web 検索をオンにする（確定）", ButtonStyle.Success)
          : button("search-on", "Web 検索をオンにする"),
    );
  }
  buttons.push(button("run", "今すぐ実行"));
  if (job.status === "active") buttons.push(button("pause", "停止"));
  if (job.status === "paused") buttons.push(button("resume", "再開", ButtonStyle.Success));
  buttons.push(
    options.confirmDelete
      ? button("confirm-delete", "削除を確定", ButtonStyle.Danger)
      : button("delete", "削除", ButtonStyle.Danger),
  );
  buttons.push(button("list", "一覧へ戻る"));
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(0, 5)),
  );
  if (buttons.length > 5)
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(5)),
    );
  return payload(container);
}

export function buildCronModal(job?: CronJob, defaultChannelId?: string): ModalBuilder {
  const channelId = job?.channelId ?? defaultChannelId;
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(CRON_MODAL_FIELDS.channel)
    .setChannelTypes(...CRON_CHANNEL_TYPES)
    .setMinValues(1)
    .setMaxValues(1)
    .setRequired(true);
  if (channelId) channelSelect.setDefaultChannels(channelId);
  return new ModalBuilder()
    .setCustomId(
      cronCustomId(
        job
          ? { action: "modal-edit", jobId: job.id, version: job.version }
          : { action: "modal-new" },
      ),
    )
    .setTitle(job ? "定期実行を編集" : "定期実行を追加")
    .addLabelComponents(
      new LabelBuilder().setLabel("名前").setTextInputComponent(
        new TextInputBuilder()
          .setCustomId(CRON_MODAL_FIELDS.name)
          .setStyle(TextInputStyle.Short)
          .setMaxLength(50)
          .setRequired(true)
          .setValue(job?.name ?? ""),
      ),
      new LabelBuilder()
        .setLabel("スケジュール")
        .setDescription(
          "cron 式（0 9 * * 1-5）、間隔（30m）、日時（2026-10-01T09:00+09:00）、または自然文",
        )
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(CRON_MODAL_FIELDS.schedule)
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setRequired(true)
            .setValue(job ? formatScheduleInput(job) : ""),
        ),
      new LabelBuilder()
        .setLabel("プロンプト")
        .setDescription("会話の文脈なしで実行されます。単独で意味の通る文にしてください。")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(CRON_MODAL_FIELDS.prompt)
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(2000)
            .setRequired(true)
            .setValue(job?.prompt ?? ""),
        ),
      new LabelBuilder().setLabel("配信先").setChannelSelectMenuComponent(channelSelect),
      new LabelBuilder().setLabel("投稿の条件").setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId(CRON_MODAL_FIELDS.silent)
          .setMinValues(1)
          .setMaxValues(1)
          .setRequired(true)
          .addOptions(
            { label: deliveryLabel(false), value: "always", default: !job?.silent },
            { label: deliveryLabel(true), value: "notable", default: job?.silent === true },
          ),
      ),
    );
}

export type CronProposalState = "pending" | "approved" | "rejected" | "expired";

export function buildCronProposalCard(
  proposal: CronProposal,
  options: {
    state: CronProposalState;
    nextRuns?: readonly number[];
    webSearchEngine?: WebSearchEngine;
  },
): PanelPayload {
  const heading = {
    pending: proposal.targetJobId === null ? "定期実行の登録の確認" : "定期実行の編集の確認",
    approved: "登録しました",
    rejected: "取り消しました",
    expired: "期限切れのため取り消しました",
  }[options.state];
  const lines = [
    `## ${heading}`,
    `**名前:** ${proposal.name}`,
    `**スケジュール:** ${formatSchedule(proposal, true)}`,
    // An interval's first run is counted from approval, so a time computed at proposal would be
    // wrong; the schedule line already reads 「承認から 30 分後、以後 30 分ごと」.
    ...(options.nextRuns && !(options.state === "pending" && proposal.kind === "interval")
      ? [
          `**${options.state === "pending" ? `次回から ${options.nextRuns.length} 回分` : "次回"}:** ${options.nextRuns.map((run) => timestamp(run)).join("、") || "なし"}`,
        ]
      : []),
    `**配信先:** <#${proposal.channelId}>`,
    `**投稿の条件:** ${deliveryLabel(proposal.silent)}`,
    `**Web 検索:** ${proposal.webSearch ? `使う（${describeSearchBilling(options.webSearchEngine ?? "perplexity")}）` : "使わない"}`,
    `**提案者:** <@${proposal.userId}>`,
  ];
  const container = new ContainerBuilder()
    .setAccentColor(options.state === "approved" ? EmbedColors.GREEN : EmbedColors.BLURPLE)
    .addTextDisplayComponents((text) => text.setContent(lines.join("\n")))
    .addTextDisplayComponents((text) => text.setContent(`### プロンプト\n${proposal.prompt}`));
  if (options.state === "pending") {
    container
      .addTextDisplayComponents((text) =>
        text.setContent(
          `-# 提案者だけが操作できます。<t:${Math.floor(proposal.expiresAt / 1000)}:R> に期限切れになります。`,
        ),
      )
      .addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(
              cronCustomId({
                action: "proposal",
                decision: "approve",
                proposalId: proposal.id,
                shownWebSearch: proposal.webSearch,
              }),
            )
            .setLabel("登録する")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(
              cronCustomId({
                action: "proposal",
                decision: "search",
                proposalId: proposal.id,
                shownWebSearch: proposal.webSearch,
              }),
            )
            .setLabel(`Web 検索: ${proposal.webSearch ? "オン" : "オフ"}`)
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(
              cronCustomId({ action: "proposal", decision: "reject", proposalId: proposal.id }),
            )
            .setLabel("取り消す")
            .setStyle(ButtonStyle.Secondary),
        ),
      );
  }
  return payload(container);
}

/** A confirmation card whose proposal is no longer stored, so nothing of it can be shown. */
export function buildCronProposalGoneCard(): PanelPayload {
  return payload(
    new ContainerBuilder()
      .setAccentColor(EmbedColors.BLURPLE)
      .addTextDisplayComponents((text) => text.setContent("## この提案は無効か期限切れです")),
  );
}
