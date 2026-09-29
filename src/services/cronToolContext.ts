import type { GuildMember, Message } from "discord.js";
import type { CronProposalArgs, CronToolContext } from "../llm/tools/registry";
import { buildCronProposalCard, CRON_CHANNEL_TYPES } from "../utils/cronPanel";
import { logger } from "../utils/logger";
import type { ICronService } from "./cronService";
import { canManageGuildSettings } from "./settingsAuthorization";
import type { ISettingsService } from "./settingsService";

function result(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

/**
 * The `propose_cron_job` window for one response. It allows one saved
 * proposal per response: the count is taken when a proposal is saved and is
 * never given back, so a retry after an interruption cannot post a second
 * card. Calls refused by authorization or schedule validation do not count,
 * so the model can rewrite its arguments and call again.
 */
export class CronToolSession implements CronToolContext {
  readonly channelType: number;
  private used = false;
  private busy = false;

  constructor(
    private readonly trigger: Message<true>,
    private readonly cronService: ICronService,
    private readonly settingsService: ISettingsService,
  ) {
    this.channelType = (CRON_CHANNEL_TYPES as readonly number[]).includes(trigger.channel.type)
      ? trigger.channel.type
      : -1;
  }

  async propose(args: CronProposalArgs, signal: AbortSignal): Promise<string> {
    // `busy` stops a parallel call in the same turn from saving a second proposal
    // while the first is still being validated.
    if (this.used || this.busy) return result({ ok: false, reason: "limit_reached" });
    if (signal.aborted) return result({ ok: false, reason: "cancelled" });
    this.busy = true;
    try {
      const guildId = this.trigger.guildId;
      const settings = await this.settingsService.getGuildSettings(guildId);
      // The guild can turn the feature off while the response runs; then nothing
      // is proposed and the schedule is not converted.
      if (!settings.cronEnabled) return result({ ok: false, reason: "disabled" });
      let member: GuildMember;
      try {
        // The response can run for minutes over several tool turns, so the
        // requester's permissions at its start may be stale.
        member = await this.trigger.guild.members.fetch({
          user: this.trigger.author.id,
          force: true,
          cache: false,
        });
      } catch {
        return result({ ok: false, reason: "requester_unavailable" });
      }
      const actor = { permissions: member.permissions, roleIds: [...member.roles.cache.keys()] };
      if (!canManageGuildSettings(actor, settings))
        return result({ ok: false, reason: "permission_denied" });
      if (signal.aborted) return result({ ok: false, reason: "cancelled" });
      const created = await this.cronService.createProposal(
        {
          guildId,
          channelId: this.trigger.channelId,
          userId: this.trigger.author.id,
          name: args.name,
          prompt: args.prompt,
          schedule: args.schedule,
          silent: args.postOnlyWhenNotable,
          signal,
        },
        actor,
      );
      // An interruption before the proposal is saved (the tool timeout during the schedule
      // conversion) saves nothing, so it is not counted either.
      if (!created.ok && signal.aborted) return result({ ok: false, reason: "cancelled" });
      if (!created.ok)
        return result({ ok: false, reason: "invalid", message: created.reason.slice(0, 80) });
      this.used = true;
      const { proposal, nextRuns } = created.value;
      if (signal.aborted) {
        this.cronService.rejectProposal(proposal.id, guildId, proposal.userId);
        return result({ ok: false, reason: "cancelled" });
      }
      try {
        await this.trigger.reply({
          ...buildCronProposalCard(proposal, { state: "pending", nextRuns }),
          allowedMentions: { parse: [], repliedUser: false },
        });
      } catch (error) {
        logger.warn("Cron proposal card failed", { guildId, proposalId: proposal.id, error });
        this.cronService.rejectProposal(proposal.id, guildId, proposal.userId);
        return result({ ok: false, reason: "discord_failed" });
      }
      return result({ ok: true, status: "awaiting_approval" });
    } finally {
      this.busy = false;
    }
  }
}
