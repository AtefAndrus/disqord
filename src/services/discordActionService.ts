import type { GuildMember, Message, TextChannel, ThreadChannel } from "discord.js";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { DiscordToolContext } from "../llm/tools/registry";
import { DiscordRestBudget } from "./discordMessageReader";
import { type AuthorizationChannelLike, canReadConversation } from "./messageAuthorization";

type ActionChannel = TextChannel | ThreadChannel;
type ActionName = "reaction" | "poll" | "thread" | "pin";
type Actor = "bot" | "user";
type Failure = { ok: false; reason: string; who?: Actor; permissions?: string[] };
type Authorization = { channel: ActionChannel; user: GuildMember; bot: GuildMember } | Failure;

function result(value: { ok: true } | Failure): string {
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
  if (code === 50013 || value?.status === 403) {
    return failure(
      "missing_permission",
      "bot",
      requiredPermissions(action, channel).map(([name]) => name),
    );
  }
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

export class DiscordActionService implements DiscordToolContext {
  readonly channelType: number;
  private readonly counts: Record<ActionName, number> = { reaction: 0, poll: 0, thread: 0, pin: 0 };

  constructor(
    private readonly trigger: Message<true>,
    private readonly resolveMessageRef: (ref: string) => string | undefined,
  ) {
    this.channelType = trigger.channel.type;
  }

  private async authorize(action: ActionName): Promise<Authorization> {
    const guild = this.trigger.guild;
    let user: GuildMember;
    let bot: GuildMember;
    let channel: ActionChannel;
    try {
      user = await guild.members.fetch({ user: this.trigger.author.id, force: true, cache: false });
    } catch {
      return failure("requester_unavailable");
    }
    try {
      // Keep caching enabled so the REST response patches existing channel objects.
      const fetched = await guild.channels.fetch(this.trigger.channelId, { force: true });
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
        const parent = await guild.channels.fetch(channel.parentId, { force: true });
        if (!parent) return failure("unsupported_channel");
      }
      bot = await guild.members.fetch({
        user: this.trigger.client.user.id,
        force: true,
      });
    } catch {
      return failure("discord_failed");
    }
    const readable = await canReadConversation(
      {
        channel: channel as unknown as AuthorizationChannelLike,
        author: this.trigger.author,
        member: user,
        client: { user: this.trigger.client.user },
      },
      bot,
      new DiscordRestBudget(1),
    );
    if (!readable) {
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
    const required = requiredPermissions(action, channel);
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
    const limits: Record<ActionName, number> = { reaction: 3, poll: 1, thread: 1, pin: 1 };
    if (this.counts[action] >= limits[action]) return result(failure("limit_reached"));
    if (signal.aborted) return result(failure("cancelled"));
    const targetId = ref === undefined ? this.trigger.id : this.resolveMessageRef(ref);
    if (!targetId) return result(failure("not_found"));
    try {
      const auth = await this.authorize(action);
      if (isFailure(auth)) return result(auth);
      if (signal.aborted) return result(failure("cancelled"));
      await perform(auth, targetId, () => {
        if (signal.aborted) throw failure("cancelled");
        if (this.counts[action] >= limits[action]) throw failure("limit_reached");
        this.counts[action] += 1;
      });
      return result({ ok: true });
    } catch (error) {
      return result(classifyError(error, action, this.trigger.channel as ActionChannel));
    }
  }

  addReaction(emoji: string, messageRef: string | undefined, signal: AbortSignal): Promise<string> {
    if (/[<>:]/u.test(emoji)) return Promise.resolve(result(failure("invalid_emoji")));
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
