import { ChannelType, PermissionFlagsBits } from "discord.js";

export interface PermissionLike {
  has(permission: bigint): boolean;
}

export interface ThreadMemberLike {
  cache?: { has(userId: string): boolean };
  fetch?: (userId: string) => Promise<unknown>;
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

async function isPrivateThreadParticipant(
  channel: AuthorizationChannelLike,
  userId: string,
  userPermissions: PermissionLike | null,
): Promise<boolean> {
  if (userPermissions?.has(PermissionFlagsBits.ManageThreads)) return true;
  if (channel.members?.cache?.has(userId)) return true;
  if (!channel.members?.fetch) return false;
  try {
    await channel.members.fetch(userId);
    return true;
  } catch {
    return false;
  }
}

/** Confirms both the bot and the invoking user can read the channel history. */
export async function canReadConversation(
  message: AuthorizationMessageLike,
  botUser: unknown,
): Promise<boolean> {
  const userSubject = message.member ?? message.author;
  if (!hasReadPermissions(message.channel, botUser)) return false;
  if (!hasReadPermissions(message.channel, userSubject)) return false;

  if (message.channel.type !== ChannelType.PrivateThread) return true;
  const userPermissions = message.channel.permissionsFor?.(userSubject) ?? null;
  return isPrivateThreadParticipant(message.channel, message.author.id, userPermissions);
}
