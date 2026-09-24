import { describe, expect, mock, test } from "bun:test";
import {
  type APIInteractionGuildMember,
  type GuildMember,
  PermissionFlagsBits,
  type PermissionsBitField,
} from "discord.js";
import {
  canManageGuildSettings,
  settingsActorFromInteraction,
  settingsPermissionDeniedMessage,
} from "../../../src/services/settingsAuthorization";

function permissions(...values: bigint[]): Readonly<PermissionsBitField> {
  return {
    has: mock((permission: bigint) => values.includes(permission)),
  } as unknown as Readonly<PermissionsBitField>;
}

describe("canManageGuildSettings", () => {
  test("allows ManageGuild without a configured administrator role", () => {
    expect(
      canManageGuildSettings(
        { permissions: permissions(PermissionFlagsBits.ManageGuild), roleIds: [] },
        { adminRoleId: null },
      ),
    ).toBe(true);
  });

  test("allows an actor with the configured administrator role", () => {
    expect(
      canManageGuildSettings(
        { permissions: permissions(), roleIds: ["admin-role"] },
        { adminRoleId: "admin-role" },
      ),
    ).toBe(true);
  });

  test("rejects an actor without ManageGuild or the configured role", () => {
    expect(
      canManageGuildSettings(
        { permissions: permissions(), roleIds: ["other-role"] },
        { adminRoleId: "admin-role" },
      ),
    ).toBe(false);
  });

  test("rejects an actor without ManageGuild when no role is configured", () => {
    expect(
      canManageGuildSettings({ permissions: permissions(), roleIds: [] }, { adminRoleId: null }),
    ).toBe(false);
  });

  test("uses a matching role when member permissions are unavailable", () => {
    expect(
      canManageGuildSettings(
        { permissions: null, roleIds: ["admin-role"] },
        { adminRoleId: "admin-role" },
      ),
    ).toBe(true);
    expect(
      canManageGuildSettings({ permissions: null, roleIds: [] }, { adminRoleId: "admin-role" }),
    ).toBe(false);
  });
});

describe("settingsActorFromInteraction", () => {
  test("reads cached role IDs from a GuildMember", () => {
    const member = {
      roles: {
        cache: new Map([
          ["role-one", {}],
          ["role-two", {}],
        ]),
      },
    } as unknown as GuildMember;

    expect(settingsActorFromInteraction({ memberPermissions: null, member })).toEqual({
      permissions: null,
      roleIds: ["role-one", "role-two"],
    });
  });

  test("uses the roles array from an APIInteractionGuildMember", () => {
    const member = { roles: ["role-three", "role-four"] } as unknown as APIInteractionGuildMember;

    expect(settingsActorFromInteraction({ memberPermissions: null, member })).toEqual({
      permissions: null,
      roleIds: ["role-three", "role-four"],
    });
  });

  test("returns no roles when member data is absent", () => {
    expect(settingsActorFromInteraction({ memberPermissions: null, member: null })).toEqual({
      permissions: null,
      roleIds: [],
    });
  });
});

describe("settingsPermissionDeniedMessage", () => {
  test("includes the configured role mention when one is set", () => {
    expect(settingsPermissionDeniedMessage({ adminRoleId: "admin-role" })).toBe(
      "この設定の変更には「サーバーの管理」権限か <@&admin-role> ロールが必要です。",
    );
  });

  test("only requires ManageGuild when no role is configured", () => {
    expect(settingsPermissionDeniedMessage({ adminRoleId: null })).toBe(
      "この設定の変更には「サーバーの管理」権限が必要です。",
    );
  });
});
