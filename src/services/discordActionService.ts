import type { GuildMember, Message, TextChannel, ThreadChannel, VoiceChannel } from "discord.js";
import {
  ChannelType,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  PermissionFlagsBits,
  parseEmoji,
} from "discord.js";
import type { CreateEventArgs, DiscordToolContext } from "../llm/tools/registry";
import { DiscordRestBudget } from "./discordMessageReader";
import { type AuthorizationChannelLike, checkConversationAccess } from "./messageAuthorization";

type ActionChannel = TextChannel | ThreadChannel;
type ActionName = "reaction" | "poll" | "thread" | "pin";
const ACTION_LIMITS = { reaction: 3, poll: 1, thread: 1, pin: 1, event: 1 };
type Actor = "bot" | "user";
type Failure = { ok: false; reason: string; who?: Actor; permissions?: string[] };
type Authorization =
  | { channel: ActionChannel; user: GuildMember; bot: GuildMember; parent?: TextChannel }
  | Failure;

function result(value: { ok: true; url?: string } | Failure): string {
  return JSON.stringify(value);
}

function failure(reason: string, who?: Actor, permissions?: string[]): Failure {
  return { ok: false, reason, ...(who && { who }), ...(permissions && { permissions }) };
}

function isFailure(value: Authorization): value is Failure {
  return "ok" in value;
}

function classifyError(error: unknown, action: ActionName, channel: ActionChannel): Failure {
  if (
    typeof error === "object" &&
    error !== null &&
    "ok" in error &&
    (error as Failure).ok === false
  )
    return error as Failure;
  const value = error as { code?: number | string; status?: number };
  const code = Number(value?.code);
  if (code === 50001) return failure("missing_access", "bot");
  if (code === 50013) {
    return failure(
      "missing_permission",
      "bot",
      requiredPermissions(action, channel).map(([name]) => name),
    );
  }
  if (code === 90001) return failure("reaction_blocked");
  if (value?.status === 403) return failure("discord_forbidden");
  if (code === 160004) return failure("thread_exists");
  if ([10003, 10008, 10014].includes(code) || value?.status === 404) {
    return failure("not_found");
  }
  return failure("discord_failed");
}

function requiredPermissions(action: ActionName, channel: ActionChannel): [string, bigint][] {
  if (action === "reaction") return [["AddReactions", PermissionFlagsBits.AddReactions]];
  if (action === "thread")
    return [["CreatePublicThreads", PermissionFlagsBits.CreatePublicThreads]];
  if (action === "pin") return [["PinMessages", PermissionFlagsBits.PinMessages]];
  return [
    [
      channel.isThread() ? "SendMessagesInThreads" : "SendMessages",
      channel.isThread()
        ? PermissionFlagsBits.SendMessagesInThreads
        : PermissionFlagsBits.SendMessages,
    ],
    ["SendPolls", PermissionFlagsBits.SendPolls],
  ];
}

export async function authorizeDiscordRead(
  trigger: Message<true>,
  budget?: DiscordRestBudget,
  signal?: AbortSignal,
): Promise<Authorization> {
  const guild = trigger.guild;
  let user: GuildMember;
  let bot: GuildMember;
  let channel: ActionChannel;
  let parent: TextChannel | undefined;
  try {
    if (signal?.aborted) return failure("cancelled");
    if (budget && !budget.consume()) return failure("rest_budget_exhausted");
    user = await guild.members.fetch({ user: trigger.author.id, force: true, cache: false });
  } catch {
    return failure("requester_unavailable");
  }
  try {
    // Keep caching enabled so the REST response patches existing channel objects.
    if (signal?.aborted) return failure("cancelled");
    if (budget && !budget.consume()) return failure("rest_budget_exhausted");
    const fetched = await guild.channels.fetch(trigger.channelId, { force: true });
    if (
      !fetched ||
      ![ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread].includes(
        fetched.type,
      )
    ) {
      return failure("unsupported_channel");
    }
    channel = fetched as ActionChannel;
    if (channel.isThread()) {
      if (!channel.parentId) return failure("unsupported_channel");
      if (signal?.aborted) return failure("cancelled");
      if (budget && !budget.consume()) return failure("rest_budget_exhausted");
      const fetchedParent = await guild.channels.fetch(channel.parentId, { force: true });
      if (fetchedParent?.type !== ChannelType.GuildText) return failure("unsupported_channel");
      parent = fetchedParent;
    }
    if (signal?.aborted) return failure("cancelled");
    if (budget && !budget.consume()) return failure("rest_budget_exhausted");
    bot = await guild.members.fetch({
      user: trigger.client.user.id,
      force: true,
    });
  } catch {
    return failure("discord_failed");
  }
  if (signal?.aborted) return failure("cancelled");
  const readable = await checkConversationAccess(
    {
      channel: channel as unknown as AuthorizationChannelLike,
      author: trigger.author,
      member: user,
      client: { user: trigger.client.user },
    },
    bot,
    budget ?? new DiscordRestBudget(1),
  );
  if (signal?.aborted) return failure("cancelled");
  if (budget?.refused) return failure("rest_budget_exhausted");
  if (readable === "failed") return failure("conversation_access_failed");
  if (readable !== "allowed") {
    for (const [who, member] of [
      ["bot", bot],
      ["user", user],
    ] as const) {
      const permissions = channel.permissionsFor(member);
      const missing = [
        ["ViewChannel", PermissionFlagsBits.ViewChannel],
        ["ReadMessageHistory", PermissionFlagsBits.ReadMessageHistory],
      ] as const;
      const names = missing.filter(([, bit]) => !permissions?.has(bit)).map(([name]) => name);
      if (names.length > 0) return failure("missing_permission", who, names);
    }
    return failure("cannot_read_conversation");
  }
  return { channel, user, bot, ...(parent && { parent }) };
}

export class DiscordActionService implements DiscordToolContext {
  readonly channelType: number;
  private readonly counts = { reaction: 0, poll: 0, thread: 0, pin: 0, event: 0 };

  constructor(
    private readonly trigger: Message<true>,
    private readonly resolveMessageRef: (ref: string) => string | undefined,
  ) {
    this.channelType =
      trigger.channel.isThread() && trigger.channel.parent?.type !== ChannelType.GuildText
        ? -1
        : trigger.channel.type;
  }

  private async authorize(action?: ActionName): Promise<Authorization> {
    const auth = await authorizeDiscordRead(this.trigger);
    if (isFailure(auth) && auth.reason === "conversation_access_failed")
      return failure("cannot_read_conversation");
    if (isFailure(auth)) return auth;
    const { channel, user, bot } = auth;
    const guild = this.trigger.guild;
    const userPermissions = channel.permissionsFor(user);
    if (
      user.communicationDisabledUntilTimestamp &&
      user.communicationDisabledUntilTimestamp > Date.now() &&
      user.id !== guild.ownerId &&
      !userPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      return failure("requester_timed_out");
    }
    if (channel.isThread() && channel.locked) {
      for (const [who, member] of [
        ["bot", bot],
        ["user", user],
      ] as const) {
        if (!channel.permissionsFor(member)?.has(PermissionFlagsBits.ManageThreads)) {
          return failure("missing_permission", who, ["ManageThreads"]);
        }
      }
    }
    const required = action ? requiredPermissions(action, channel) : [];
    for (const [who, member] of [
      ["bot", bot],
      ["user", user],
    ] as const) {
      const permissions = channel.permissionsFor(member);
      const missing = required.filter(([, bit]) => !permissions?.has(bit)).map(([name]) => name);
      if (missing.length > 0) return failure("missing_permission", who, missing);
    }
    return { channel, user, bot };
  }

  private consume(action: keyof typeof ACTION_LIMITS): void {
    if (this.counts[action] >= ACTION_LIMITS[action]) throw failure("limit_reached");
    this.counts[action] += 1;
  }

  private async execute(
    action: ActionName,
    ref: string | undefined,
    signal: AbortSignal,
    perform: (
      auth: Exclude<Authorization, Failure>,
      targetId: string,
      consume: () => void,
    ) => Promise<void>,
  ): Promise<string> {
    if (this.counts[action] >= ACTION_LIMITS[action]) return result(failure("limit_reached"));
    if (signal.aborted) return result(failure("cancelled"));
    const targetId = ref === undefined ? this.trigger.id : this.resolveMessageRef(ref);
    if (!targetId) return result(failure("not_found"));
    try {
      const auth = await this.authorize(action);
      if (isFailure(auth)) return result(auth);
      if (signal.aborted) return result(failure("cancelled"));
      await perform(auth, targetId, () => {
        if (signal.aborted) throw failure("cancelled");
        this.consume(action);
      });
      return result({ ok: true });
    } catch (error) {
      return result(classifyError(error, action, this.trigger.channel as ActionChannel));
    }
  }

  async createEvent(args: CreateEventArgs, signal: AbortSignal): Promise<string> {
    const required: [string, bigint][] = [
      ["CreateEvents", PermissionFlagsBits.CreateEvents],
      ...(args.kind === "voice"
        ? ([
            ["ViewChannel", PermissionFlagsBits.ViewChannel],
            ["Connect", PermissionFlagsBits.Connect],
          ] satisfies [string, bigint][])
        : []),
    ];
    try {
      // Refuse early once the limit is spent, but count only right before the create request
      // below: a call refused by a check (wrong channel name, past start) must leave room for
      // the corrected call, while one aborted after the request was sent must not.
      if (this.counts.event >= ACTION_LIMITS.event) throw failure("limit_reached");
      if (signal.aborted) return result(failure("cancelled"));
      const auth = await this.authorize();
      if (isFailure(auth)) return result(auth);
      if (signal.aborted) return result(failure("cancelled"));
      let voice: VoiceChannel | undefined;
      if (args.kind === "voice") {
        const channels = await this.trigger.guild.channels.fetch();
        if (signal.aborted) return result(failure("cancelled"));
        const candidates = channels.filter(
          (channel): channel is VoiceChannel =>
            channel?.type === ChannelType.GuildVoice &&
            !!channel.permissionsFor(auth.bot)?.has(PermissionFlagsBits.ViewChannel) &&
            !!channel.permissionsFor(auth.user)?.has(PermissionFlagsBits.ViewChannel) &&
            channel.name === args.channel_name,
        );
        if (candidates.size === 0) return result(failure("channel_not_found"));
        if (candidates.size > 1) return result(failure("channel_ambiguous"));
        voice = candidates.first();
      }
      for (const [who, member] of [
        ["bot", auth.bot],
        ["user", auth.user],
      ] as const) {
        const permissions = voice ? voice.permissionsFor(member) : member.permissions;
        const missing = required.filter(([, bit]) => !permissions?.has(bit)).map(([name]) => name);
        if (missing.length > 0) return result(failure("missing_permission", who, missing));
      }
      const start = Date.parse(args.start);
      const end = args.end === undefined ? undefined : Date.parse(args.end);
      if (!Number.isFinite(start) || start <= Date.now()) return result(failure("invalid_start"));
      if (
        (args.kind === "external" && end === undefined) ||
        (end !== undefined && (!Number.isFinite(end) || end <= start))
      )
        return result(failure("invalid_end"));
      if (signal.aborted) return result(failure("cancelled"));
      this.consume("event");
      const event = await this.trigger.guild.scheduledEvents.create({
        name: args.name,
        scheduledStartTime: start,
        ...(end !== undefined && { scheduledEndTime: end }),
        ...(args.description && { description: args.description }),
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        ...(args.kind === "external"
          ? {
              entityType: GuildScheduledEventEntityType.External,
              entityMetadata: { location: args.location },
            }
          : { entityType: GuildScheduledEventEntityType.Voice, channel: voice }),
      });
      return result({
        ok: true,
        url: `https://discord.com/events/${this.trigger.guild.id}/${event.id}`,
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "ok" in error &&
        (error as Failure).ok === false
      )
        return result(error as Failure);
      const value = error as { code?: number | string; status?: number };
      const code = Number(value?.code);
      if (code === 50013)
        return result(
          failure(
            "missing_permission",
            "bot",
            required.map(([name]) => name),
          ),
        );
      if (code === 50001) return result(failure("missing_access", "bot"));
      if (value?.status === 403) return result(failure("discord_forbidden"));
      if (code === 10003 || value?.status === 404) return result(failure("not_found"));
      return result(failure("discord_failed"));
    }
  }

  addReaction(emoji: string, messageRef: string | undefined, signal: AbortSignal): Promise<string> {
    if (/[<>:%]/u.test(emoji)) return Promise.resolve(result(failure("invalid_emoji")));
    return this.execute(
      "reaction",
      messageRef,
      signal,
      async ({ channel, user, bot }, targetId, consume) => {
        let reaction: string = emoji;
        if (/^[a-zA-Z0-9_]{2,32}$/u.test(emoji)) {
          const emojis = await this.trigger.guild.emojis.fetch();
          const match = emojis.find((item) => item.name === emoji);
          if (!match) throw failure("emoji_unavailable");
          // roles.cache omits restriction IDs whose roles are absent from the guild cache.
          const roleIds = (match as unknown as { _roles?: string[] })._roles;
          if (!Array.isArray(roleIds)) throw failure("emoji_unavailable");
          if (roleIds.length > 0 && !roleIds.some((id) => bot.roles.cache.has(id))) {
            throw failure("missing_emoji_role", "bot");
          }
          if (roleIds.length > 0 && !roleIds.some((id) => user.roles.cache.has(id))) {
            throw failure("missing_emoji_role", "user");
          }
          reaction = match.identifier;
        } else if (parseEmoji(emoji)?.id) {
          // Unreachable while addReaction rejects `%` and `:`, which is how
          // parseEmoji builds an id. Kept so that loosening that check cannot
          // send a custom emoji past the name lookup and role check above.
          throw failure("invalid_emoji");
        }
        const message = await channel.messages.fetch({
          message: targetId,
          cache: false,
          force: true,
        });
        consume();
        await message.react(reaction);
      },
    );
  }

  createPoll(
    question: string,
    answers: string[],
    durationHours: number,
    allowMultiselect: boolean,
    signal: AbortSignal,
  ): Promise<string> {
    return this.execute("poll", undefined, signal, async ({ channel }, _targetId, consume) => {
      consume();
      await channel.send({
        poll: {
          question: { text: question },
          answers: answers.map((text) => ({ text })),
          duration: durationHours,
          allowMultiselect,
        },
        reply: { messageReference: this.trigger.id },
      });
    });
  }

  createThread(name: string, messageRef: string | undefined, signal: AbortSignal): Promise<string> {
    return this.execute("thread", messageRef, signal, async ({ channel }, targetId, consume) => {
      if (channel.type !== ChannelType.GuildText) throw { code: 10003 };
      const message = await channel.messages.fetch({
        message: targetId,
        cache: false,
        force: true,
      });
      consume();
      await message.startThread({ name });
    });
  }

  pinMessage(messageRef: string | undefined, signal: AbortSignal): Promise<string> {
    return this.execute("pin", messageRef, signal, async ({ channel }, targetId, consume) => {
      const message = await channel.messages.fetch({
        message: targetId,
        cache: false,
        force: true,
      });
      if (!message.pinnable) throw failure(message.system ? "system_message" : "not_pinnable");
      consume();
      await message.pin();
    });
  }
}
