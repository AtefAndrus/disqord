import {
  ChannelType,
  type GuildMember,
  type Message,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
} from "discord.js";
import type { DiscordRestBudget } from "./discordMessageReader";

export interface PermissionLike {
  has(permission: bigint): boolean;
}

export interface ThreadMemberLike {
  fetch?: (options: { member: string; force: true }) => Promise<unknown>;
}

export interface AuthorizationChannelLike {
  type?: ChannelType | number;
  permissionsFor?: (subject: unknown) => PermissionLike | null;
  members?: ThreadMemberLike;
}

export interface AuthorizationMessageLike {
  channel: AuthorizationChannelLike;
  author: { id: string };
  member?: unknown | null;
  client: { user?: { id: string } | null };
}

function hasReadPermissions(channel: AuthorizationChannelLike, subject: unknown): boolean {
  const permissions = channel.permissionsFor?.(subject);
  return (
    permissions?.has(PermissionFlagsBits.ViewChannel) === true &&
    permissions.has(PermissionFlagsBits.ReadMessageHistory)
  );
}

export type ConversationAccess = "allowed" | "denied" | "rest_budget_exhausted" | "failed";

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

async function privateThreadAccess(
  channel: AuthorizationChannelLike,
  userId: string,
  userPermissions: PermissionLike | null,
  budget: DiscordRestBudget,
  signal?: AbortSignal,
): Promise<ConversationAccess> {
  if (userPermissions?.has(PermissionFlagsBits.ManageThreads)) return "allowed";
  if (!channel.members?.fetch) return "denied";
  if (signal?.aborted) return "failed";
  if (!budget.consume()) return "rest_budget_exhausted";
  try {
    await channel.members.fetch({ member: userId, force: true });
    return "allowed";
  } catch (error) {
    // Discord answers 404 (Unknown Member) for a user who is not in the thread.
    return statusOf(error) === 404 ? "denied" : "failed";
  }
}

/**
 * Confirms both the bot and the invoking user can read the channel history,
 * and tells a refusal apart from a check that could not be made. A private
 * thread needs a REST call, which takes `budget` and cannot be cancelled.
 */
export async function checkConversationAccess(
  message: AuthorizationMessageLike,
  botUser: unknown,
  budget: DiscordRestBudget,
  signal?: AbortSignal,
): Promise<ConversationAccess> {
  if (signal?.aborted) return "failed";
  const userSubject = message.member ?? message.author;
  if (!hasReadPermissions(message.channel, botUser)) return "denied";
  if (!hasReadPermissions(message.channel, userSubject)) return "denied";

  if (message.channel.type !== ChannelType.PrivateThread) return "allowed";
  const userPermissions = message.channel.permissionsFor?.(userSubject) ?? null;
  return privateThreadAccess(message.channel, message.author.id, userPermissions, budget, signal);
}

export async function reauthorizeConversationAccess(
  trigger: Message<true>,
  budget: DiscordRestBudget,
  signal: AbortSignal,
): Promise<ConversationAccess> {
  try {
    if (signal.aborted) return "failed";
    if (!budget.consume()) return "rest_budget_exhausted";
    let user: GuildMember;
    try {
      user = await trigger.guild.members.fetch({
        user: trigger.author.id,
        force: true,
        cache: false,
      });
    } catch (error) {
      // A requester who left the server is a denial, not a transient failure worth retrying.
      return (error as { code?: unknown })?.code === RESTJSONErrorCodes.UnknownMember
        ? "denied"
        : "failed";
    }
    if (signal.aborted) return "failed";
    if (!budget.consume()) return "rest_budget_exhausted";
    const channel = await trigger.guild.channels.fetch(trigger.channelId, { force: true });
    if (!channel) return "failed";
    // Thread permissions use the parent, so refresh it without restricting its type.
    if (channel.isThread()) {
      if (!channel.parentId) return "failed";
      if (signal.aborted) return "failed";
      if (!budget.consume()) return "rest_budget_exhausted";
      if (!(await trigger.guild.channels.fetch(channel.parentId, { force: true }))) return "failed";
    }
    if (signal.aborted) return "failed";
    if (!budget.consume()) return "rest_budget_exhausted";
    const bot = await trigger.guild.members.fetch({ user: trigger.client.user.id, force: true });
    return checkConversationAccess(
      {
        channel: channel as unknown as AuthorizationChannelLike,
        author: trigger.author,
        member: user,
        client: { user: trigger.client.user },
      },
      bot,
      budget,
      signal,
    );
  } catch {
    return "failed";
  }
}

/** Confirms both the bot and the invoking user can read the channel history. */
export async function canReadConversation(
  message: AuthorizationMessageLike,
  botUser: unknown,
  budget: DiscordRestBudget,
): Promise<boolean> {
  return (await checkConversationAccess(message, botUser, budget)) === "allowed";
}
