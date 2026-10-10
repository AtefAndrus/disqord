import type { Message, TextChannel } from "discord.js";
import {
  ChannelType,
  GuildScheduledEventEntityType,
  GuildScheduledEventStatus,
  PermissionFlagsBits,
} from "discord.js";
import { estimateToolResultTokens } from "../llm/contextBudget";
import type { DiscordInfoContext } from "../llm/tools/registry";
import type { RawDiscordMessage } from "../utils/discordMessageNormalizer";
import type { ConversationWindowContext } from "./conversationWindow";
import { untilAborted } from "./conversationWindow";
import { authorizeDiscordRead } from "./discordActionService";
import type { DiscordRestBudget } from "./discordMessageReader";

/** One response shares the window's REST budget, references and eligibility checks. */
export class DiscordInfoService implements DiscordInfoContext {
  readonly channelType: number;

  constructor(
    private readonly trigger: Message<true>,
    private readonly conversation: ConversationWindowContext,
    private readonly rawMessage: (message: Message) => RawDiscordMessage,
    private readonly now: () => number = Date.now,
  ) {
    this.channelType =
      trigger.channel.isThread() && trigger.channel.parent?.type !== ChannelType.GuildText
        ? -1
        : trigger.channel.type;
  }

  private async authorize(signal: AbortSignal): Promise<
    | (Exclude<Awaited<ReturnType<typeof authorizeDiscordRead>>, { ok: false }> & {
        budget: DiscordRestBudget;
      })
    | { ok: false; reason: string }
  > {
    const budget = this.conversation.toolRestBudget;
    if (!budget) return { ok: false, reason: "history_unavailable" };
    const auth = (await untilAborted(
      authorizeDiscordRead(this.trigger, budget, signal),
      signal,
    )) ?? {
      ok: false,
      reason: "cancelled",
    };
    return "ok" in auth ? auth : { ...auth, budget };
  }

  async listPins(
    before: string | undefined,
    signal: AbortSignal,
    budgetTokens = Number.POSITIVE_INFINITY,
  ): Promise<string> {
    const { readPins, toolRestBudget: budget } = this.conversation;
    if (!readPins || !budget) return '{"error":"history_unavailable"}';
    return readPins(
      async (fetchSignal) => {
        const auth = await this.authorize(fetchSignal);
        if ("ok" in auth) return { items: [], hasMore: false, error: auth.reason };
        if (fetchSignal.aborted || !budget.consume()) throw new Error("Pin read stopped");
        const page = await auth.channel.messages.fetchPins({
          limit: 50,
          cache: false,
          ...(before && { before }),
        });
        return {
          hasMore: page.hasMore,
          items: page.items.map((pin) => ({
            message: this.rawMessage(pin.message),
            pinnedAt: pin.pinnedAt.toISOString(),
          })),
        };
      },
      signal,
      budgetTokens,
    );
  }

  async getChannelInfo(
    signal: AbortSignal,
    budgetTokens = Number.POSITIVE_INFINITY,
  ): Promise<string> {
    const auth = await this.authorize(signal);
    if ("ok" in auth) return JSON.stringify({ error: auth.reason });
    const budget = auth.budget;
    const channel = auth.channel;
    const value: Record<string, unknown> = {
      name: channel.name,
      type: ChannelType[channel.type],
      topic: channel.isThread() ? null : (channel as TextChannel).topic,
      nsfw: channel.isThread() ? (auth.parent?.nsfw ?? false) : (channel as TextChannel).nsfw,
      slowmode_seconds: channel.rateLimitPerUser,
      created_at: channel.createdAt?.toISOString() ?? null,
      category_name: null,
    };
    let stopped = false;
    const categoryId = channel.isThread() ? auth.parent?.parentId : channel.parentId;
    if (channel.isThread()) {
      value.parent = { name: auth.parent?.name, topic: auth.parent?.topic };
    }
    if (categoryId) {
      if (!budget.consume()) {
        stopped = true;
        value.category_unavailable = true;
      } else {
        try {
          const category = await untilAborted(
            this.trigger.guild.channels.fetch(categoryId, { force: true }),
            signal,
          );
          // The bot may see the channel but not its category; keep what was read, and
          // flag it so a null name is not read as "no category".
          if (category && !signal.aborted) value.category_name = category.name;
          else value.category_unavailable = true;
        } catch {
          value.category_unavailable = true;
        }
      }
    }
    if (stopped) {
      value.stop_reason = "rest_budget_exhausted";
      value.has_more = true;
    }
    // Topics dominate the result size; preserve the other channel metadata.
    const parent = value.parent as { topic?: string | null } | undefined;
    if (estimateToolResultTokens(JSON.stringify(value)) > budgetTokens) {
      value.truncated = true;
      const topic = typeof value.topic === "string" ? value.topic : "";
      const parentTopic = parent?.topic ?? "";
      let low = 0;
      let high = Math.max(topic.length, parentTopic.length);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (topic) value.topic = topic.slice(0, mid);
        if (parent && parentTopic) parent.topic = parentTopic.slice(0, mid);
        if (estimateToolResultTokens(JSON.stringify(value)) <= budgetTokens) low = mid;
        else high = mid - 1;
      }
      if (topic) value.topic = topic.slice(0, low);
      if (parent && parentTopic) parent.topic = parentTopic.slice(0, low);
    }
    const result = JSON.stringify(value);
    return estimateToolResultTokens(result) <= budgetTokens
      ? result
      : '{"error":"result_budget_exhausted"}';
  }

  async listEvents(
    from: string | undefined,
    until: string | undefined,
    signal: AbortSignal,
    budgetTokens = Number.POSITIVE_INFINITY,
  ): Promise<string> {
    const auth = await this.authorize(signal);
    if ("ok" in auth) return JSON.stringify({ error: auth.reason });
    const budget = auth.budget;
    const empty = (reason: string): string =>
      JSON.stringify({
        active: { events: [], has_more: true },
        scheduled: { events: [], has_more: true },
        stop_reason: reason,
      });
    try {
      if (!budget.consume()) return empty("rest_budget_exhausted");
      const channels = await untilAborted(this.trigger.guild.channels.fetch(), signal);
      if (!channels || signal.aborted) return empty("fetch_failed");
      if (!budget.consume()) return empty("rest_budget_exhausted");
      const events = await untilAborted(
        this.trigger.guild.scheduledEvents.fetch({ withUserCount: true }),
        signal,
      );
      if (!events || signal.aborted) return empty("fetch_failed");
      const visible = [...events.values()]
        .filter((event) => {
          if (
            ![GuildScheduledEventStatus.Active, GuildScheduledEventStatus.Scheduled].includes(
              event.status,
            )
          )
            return false;
          if (event.entityType === GuildScheduledEventEntityType.External) return true;
          const channel = event.channelId ? channels.get(event.channelId) : undefined;
          return (
            !!channel &&
            [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type) &&
            [auth.user, auth.bot, this.trigger.guild.id].every((member) =>
              channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel),
            )
          );
        })
        .sort((a, b) => (a.scheduledStartTimestamp ?? 0) - (b.scheduledStartTimestamp ?? 0));
      const start = from ? Date.parse(from) : this.now();
      const end = until ? Date.parse(until) : Number.POSITIVE_INFINITY;
      const format = (event: (typeof visible)[number]): Record<string, unknown> => ({
        name: event.name,
        description: event.description?.slice(0, 200) ?? null,
        start: event.scheduledStartAt?.toISOString() ?? null,
        end: event.scheduledEndAt?.toISOString() ?? null,
        status: GuildScheduledEventStatus[event.status],
        ...(event.entityType === GuildScheduledEventEntityType.External
          ? { location: event.entityMetadata?.location ?? null }
          : { channel_name: event.channelId ? channels.get(event.channelId)?.name : null }),
        user_count: event.userCount,
      });
      const active = visible.filter((event) => event.status === GuildScheduledEventStatus.Active);
      const scheduled = visible.filter(
        (event) =>
          event.status === GuildScheduledEventStatus.Scheduled &&
          event.scheduledStartTimestamp !== null &&
          event.scheduledStartTimestamp >= start &&
          event.scheduledStartTimestamp < end,
      );
      const result = {
        active: { events: active.slice(0, 20).map(format), has_more: active.length > 20 },
        scheduled: { events: scheduled.slice(0, 20).map(format), has_more: scheduled.length > 20 },
        stop_reason: null as string | null,
      };
      if (result.active.events.length === 0 && result.scheduled.events.length === 0) {
        return JSON.stringify(result);
      }
      while (estimateToolResultTokens(JSON.stringify(result)) > budgetTokens) {
        const group = result.scheduled.events.length > 0 ? result.scheduled : result.active;
        if (group.events.length === 0) return empty("result_budget_exhausted");
        group.events.pop();
        group.has_more = true;
        result.stop_reason = "result_budget_exhausted";
      }
      return JSON.stringify(result);
    } catch {
      return empty("fetch_failed");
    }
  }
}
