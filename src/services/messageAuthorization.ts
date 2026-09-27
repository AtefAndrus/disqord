import { ChannelType, PermissionFlagsBits } from "discord.js";
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
): Promise<ConversationAccess> {
  if (userPermissions?.has(PermissionFlagsBits.ManageThreads)) return "allowed";
  if (!channel.members?.fetch) return "denied";
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
): Promise<ConversationAccess> {
  const userSubject = message.member ?? message.author;
  if (!hasReadPermissions(message.channel, botUser)) return "denied";
  if (!hasReadPermissions(message.channel, userSubject)) return "denied";

  if (message.channel.type !== ChannelType.PrivateThread) return "allowed";
  const userPermissions = message.channel.permissionsFor?.(userSubject) ?? null;
  return privateThreadAccess(message.channel, message.author.id, userPermissions, budget);
}

/** Confirms both the bot and the invoking user can read the channel history. */
export async function canReadConversation(
  message: AuthorizationMessageLike,
  botUser: unknown,
  budget: DiscordRestBudget,
): Promise<boolean> {
  return (await checkConversationAccess(message, botUser, budget)) === "allowed";
}
