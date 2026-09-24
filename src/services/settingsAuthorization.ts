import {
  type APIInteractionGuildMember,
  type GuildMember,
  PermissionFlagsBits,
  type PermissionsBitField,
} from "discord.js";
import type { GuildSettings } from "../types";

export interface SettingsActor {
  permissions: Readonly<PermissionsBitField> | null;
  roleIds: readonly string[];
}

export function canManageGuildSettings(
  actor: SettingsActor,
  settings: Pick<GuildSettings, "adminRoleId">,
): boolean {
  return (
    actor.permissions?.has(PermissionFlagsBits.ManageGuild) === true ||
    (settings.adminRoleId !== null && actor.roleIds.includes(settings.adminRoleId))
  );
}

export function settingsActorFromInteraction(interaction: {
  memberPermissions: Readonly<PermissionsBitField> | null;
  member: GuildMember | APIInteractionGuildMember | null;
}): SettingsActor {
  const member = interaction.member;
  const roleIds = !member
    ? []
    : Array.isArray(member.roles)
      ? member.roles
      : [...member.roles.cache.keys()];

  return { permissions: interaction.memberPermissions, roleIds };
}

export function settingsPermissionDeniedMessage(
  settings: Pick<GuildSettings, "adminRoleId">,
): string {
  return settings.adminRoleId === null
    ? "この設定の変更には「サーバーの管理」権限が必要です。"
    : `この設定の変更には「サーバーの管理」権限か <@&${settings.adminRoleId}> ロールが必要です。`;
}
