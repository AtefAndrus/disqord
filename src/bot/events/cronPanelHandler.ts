import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ContainerBuilder,
  MessageFlags,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { CronJob } from "../../db/repositories/cronRepository";
import type { ICronService } from "../../services/cronService";
import {
  canManageGuildSettings,
  type SettingsActor,
  settingsActorFromInteraction,
  settingsPermissionDeniedMessage,
} from "../../services/settingsAuthorization";
import type { ISettingsService } from "../../services/settingsService";
import { buildErrorContainer, toNoticePayload } from "../../utils/chatContainerBuilder";
import {
  buildCronDetail,
  buildCronList,
  buildCronModal,
  buildCronProposalCard,
  CRON_CHANNEL_TYPES,
  CRON_INVALID_MESSAGE,
  CRON_MODAL_FIELDS,
  type CronAction,
  parseCronCustomId,
} from "../../utils/cronPanel";
import { logger } from "../../utils/logger";

export const CRON_STALE_MESSAGE =
  "パネルを表示した後にジョブが変わったため、操作しませんでした。最新の表示を確かめてからもう一度操作してください。";
export const CRON_PROPOSAL_UNAVAILABLE_MESSAGE =
  "この提案は提案者本人だけが操作できます。処理済みか期限切れの提案も操作できません。";

type CronInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;
type Payload = {
  components: ContainerBuilder[];
  flags: MessageFlags.IsComponentsV2;
  allowedMentions: { parse: [] };
};

function ephemeral(payload: Payload): {
  components: ContainerBuilder[];
  flags: number;
  allowedMentions: { parse: [] };
} {
  return { ...payload, flags: payload.flags | MessageFlags.Ephemeral };
}

/** Why adding, editing, approving, running now, or resuming is refused, or undefined when allowed. */
async function refusal(
  settingsService: ISettingsService,
  guildId: string,
  actor: SettingsActor,
): Promise<string | undefined> {
  const settings = await settingsService.getGuildSettings(guildId);
  if (!settings.cronEnabled)
    return "このサーバーでは定期実行が無効です。`/config` の「機能」ページで有効にできます。";
  return canManageGuildSettings(actor, settings)
    ? undefined
    : settingsPermissionDeniedMessage(settings);
}

export async function openCronPanel(
  interaction: ChatInputCommandInteraction,
  cronService: ICronService,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply(
      toNoticePayload(buildErrorContainer("このコマンドはサーバー内でのみ使用できます。"), true),
    );
    return;
  }
  // Ephemeral: which jobs are listed depends on the viewer's permissions.
  const jobs = await cronService.listJobs(
    interaction.guildId,
    interaction.user.id,
    settingsActorFromInteraction(interaction),
  );
  await interaction.reply(ephemeral(buildCronList(jobs, 0)));
}

export async function handleCronPanelInteraction(
  interaction: CronInteraction,
  cronService: ICronService,
  settingsService: ISettingsService,
): Promise<void> {
  const notice = async (message: string): Promise<void> => {
    const payload = toNoticePayload(buildErrorContainer(message, "定期実行"), true);
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  };
  try {
    const action = parseCronCustomId(interaction.customId);
    const guildId = interaction.guildId;
    if (!action || !guildId) {
      await notice(CRON_INVALID_MESSAGE);
      return;
    }
    const actor = settingsActorFromInteraction(interaction);
    const userId = interaction.user.id;
    if (interaction.isModalSubmit()) {
      if (action.action !== "modal-new" && action.action !== "modal-edit") {
        await notice(CRON_INVALID_MESSAGE);
        return;
      }
      await submitModal(interaction, action, guildId, actor, cronService);
      return;
    }
    const show = async (payload: Payload): Promise<void> => {
      if (interaction.deferred) await interaction.editReply(payload);
      else await interaction.update(payload);
    };

    if (action.action === "proposal") {
      if (!interaction.isButton()) {
        await notice(CRON_INVALID_MESSAGE);
        return;
      }
      const proposal = cronService.getProposal(action.proposalId, guildId, userId);
      if (!proposal) {
        await notice(CRON_PROPOSAL_UNAVAILABLE_MESSAGE);
        return;
      }
      if (proposal.expiresAt <= Date.now()) {
        cronService.rejectProposal(proposal.id, guildId, userId);
        await show(buildCronProposalCard(proposal, { state: "expired" }));
        return;
      }
      if (action.decision === "reject") {
        cronService.rejectProposal(proposal.id, guildId, userId);
        await show(buildCronProposalCard(proposal, { state: "rejected" }));
        return;
      }
      // Approval re-reads the destination and the proposer over REST first.
      await interaction.deferUpdate();
      const approved = await cronService.approveProposal(proposal.id, guildId, userId, actor);
      if (!approved.ok) {
        await notice(approved.reason);
        return;
      }
      await show(
        buildCronProposalCard(proposal, {
          state: "approved",
          nextRuns: approved.value.nextRunAt === null ? [] : [approved.value.nextRunAt],
        }),
      );
      return;
    }

    if (action.action === "list") {
      if (!interaction.isButton()) {
        await notice(CRON_INVALID_MESSAGE);
        return;
      }
      await show(buildCronList(await cronService.listJobs(guildId, userId, actor), action.page));
      return;
    }
    if (action.action === "new") {
      if (!interaction.isButton()) {
        await notice(CRON_INVALID_MESSAGE);
        return;
      }
      const reason = await refusal(settingsService, guildId, actor);
      if (reason) {
        await notice(reason);
        return;
      }
      const here =
        interaction.channel &&
        (CRON_CHANNEL_TYPES as readonly number[]).includes(interaction.channel.type)
          ? interaction.channelId
          : undefined;
      await interaction.showModal(buildCronModal(undefined, here ?? undefined));
      return;
    }
    if (action.action === "modal-new" || action.action === "modal-edit") {
      await notice(CRON_INVALID_MESSAGE);
      return;
    }

    let job: CronJob | null;
    if (action.action === "select") {
      const value = interaction.isStringSelectMenu() ? interaction.values : [];
      const jobId = value.length === 1 && /^[1-9]\d*$/u.test(value[0] ?? "") ? Number(value[0]) : 0;
      job = jobId ? await cronService.getJob(jobId, guildId, userId, actor) : null;
      if (!job) {
        await notice(CRON_INVALID_MESSAGE);
        return;
      }
      await show(buildCronDetail(job));
      return;
    }
    if (!interaction.isButton()) {
      await notice(CRON_INVALID_MESSAGE);
      return;
    }
    job = await cronService.getJob(action.jobId, guildId, userId, actor);
    if (!job) {
      await notice(CRON_INVALID_MESSAGE);
      return;
    }
    if (action.action === "view") {
      await show(buildCronDetail(job));
      return;
    }
    if (job.version !== action.version) {
      await show(buildCronDetail(job));
      await notice(CRON_STALE_MESSAGE);
      return;
    }
    const redraw = async (reason: string): Promise<void> => {
      const current = await cronService.getJob(action.jobId, guildId, userId, actor);
      if (current) await show(buildCronDetail(current));
      await notice(reason);
    };
    switch (action.action) {
      case "edit": {
        if (job.status === "done") {
          await notice(CRON_INVALID_MESSAGE);
          return;
        }
        const reason = await refusal(settingsService, guildId, actor);
        if (reason) {
          await notice(reason);
          return;
        }
        await interaction.showModal(buildCronModal(job));
        return;
      }
      case "run": {
        const reason = await refusal(settingsService, guildId, actor);
        if (reason) {
          await notice(reason);
          return;
        }
        // One run waits for the LLM for up to two minutes.
        await interaction.deferUpdate();
        const result = await cronService.runNow(job.id, guildId, actor, job.version);
        if (!result.ok) {
          await notice(`実行できませんでした: ${result.reason}`);
          return;
        }
        const current = await cronService.getJob(job.id, guildId, userId, actor);
        if (current) await show(buildCronDetail(current));
        return;
      }
      case "pause": {
        const result = await cronService.pauseJob(job.id, guildId, userId, actor, job.version);
        if (result.ok) await show(buildCronDetail(result.value));
        else await redraw(result.reason);
        return;
      }
      case "resume": {
        const reason = await refusal(settingsService, guildId, actor);
        if (reason) {
          await notice(reason);
          return;
        }
        const result = await cronService.resumeJob(job.id, guildId, actor, job.version);
        if (result.ok) await show(buildCronDetail(result.value));
        else await redraw(result.reason);
        return;
      }
      case "delete":
        await show(buildCronDetail(job, { confirmDelete: true }));
        return;
      case "confirm-delete": {
        if (await cronService.deleteJob(job.id, guildId, userId, actor, job.version)) {
          await show(buildCronList(await cronService.listJobs(guildId, userId, actor), 0));
          return;
        }
        const current = await cronService.getJob(job.id, guildId, userId, actor);
        if (current) {
          await show(buildCronDetail(current));
          await notice(CRON_STALE_MESSAGE);
        } else await notice(CRON_INVALID_MESSAGE);
        return;
      }
    }
  } catch (error) {
    logger.error("Cron panel interaction failed", { error, customId: interaction.customId });
    try {
      await notice("操作中にエラーが発生しました。");
    } catch (replyError) {
      logger.error("Failed to send error message", { replyError });
    }
  }
}

async function submitModal(
  interaction: ModalSubmitInteraction,
  action: Extract<CronAction, { action: "modal-new" | "modal-edit" }>,
  guildId: string,
  actor: SettingsActor,
  cronService: ICronService,
): Promise<void> {
  // Converting a natural-language schedule calls the LLM, which can pass Discord's 3 seconds.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const fail = async (message: string): Promise<void> => {
    await interaction.editReply({
      components: [buildErrorContainer(message, "定期実行")],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  };
  const channelId = interaction.fields.getSelectedChannels(CRON_MODAL_FIELDS.channel)?.first()?.id;
  if (!channelId) {
    await fail("配信先を選んでください。");
    return;
  }
  const created = await cronService.createProposal(
    {
      guildId,
      channelId,
      userId: interaction.user.id,
      name: interaction.fields.getTextInputValue(CRON_MODAL_FIELDS.name),
      schedule: interaction.fields.getTextInputValue(CRON_MODAL_FIELDS.schedule),
      prompt: interaction.fields.getTextInputValue(CRON_MODAL_FIELDS.prompt),
      silent: interaction.fields.getStringSelectValues(CRON_MODAL_FIELDS.silent)[0] === "notable",
      ...(action.action === "modal-edit" && {
        targetJobId: action.jobId,
        targetVersion: action.version,
      }),
    },
    actor,
  );
  if (!created.ok) {
    await fail(created.reason);
    return;
  }
  await interaction.editReply(
    buildCronProposalCard(created.value.proposal, {
      state: "pending",
      nextRuns: created.value.nextRuns,
    }),
  );
}
