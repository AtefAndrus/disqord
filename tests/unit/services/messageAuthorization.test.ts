import { describe, expect, mock, test } from "bun:test";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { DiscordRestBudget } from "../../../src/services/discordMessageReader";
import {
  type AuthorizationMessageLike,
  canReadConversation,
} from "../../../src/services/messageAuthorization";

function permission(values: bigint[]): { has: (value: bigint) => boolean } {
  return { has: (value) => values.includes(value) };
}

function message(channel: AuthorizationMessageLike["channel"]): AuthorizationMessageLike {
  return {
    channel,
    author: { id: "user" },
    member: { id: "user" },
    client: { user: { id: "bot" } },
  };
}

const read = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

describe("canReadConversation", () => {
  test("requires a private-thread participant", async () => {
    const channel = {
      type: ChannelType.PrivateThread,
      permissionsFor: mock(() => permission(read)),
      members: {
        cache: { has: () => false },
        fetch: mock(async () => {
          throw new Error("not a member");
        }),
      },
    };

    expect(await canReadConversation(message(channel), {}, new DiscordRestBudget())).toBe(false);
  });

  test("accepts a private-thread participant or ManageThreads holder", async () => {
    const participantChannel = {
      type: ChannelType.PrivateThread,
      permissionsFor: mock(() => permission(read)),
      members: {
        cache: { has: () => false },
        fetch: mock(async (options: { member: string; force: true }) => {
          expect(options).toEqual({ member: "user", force: true });
          return {};
        }),
      },
    };
    expect(
      await canReadConversation(message(participantChannel), {}, new DiscordRestBudget()),
    ).toBe(true);

    const manageThreads = {
      type: ChannelType.PrivateThread,
      permissionsFor: mock((subject: unknown) =>
        subject === undefined
          ? permission(read)
          : permission([...read, PermissionFlagsBits.ManageThreads]),
      ),
      members: {
        cache: { has: () => false },
        fetch: mock(async () => {
          throw new Error("not called for ManageThreads");
        }),
      },
    };
    expect(await canReadConversation(message(manageThreads), {}, new DiscordRestBudget())).toBe(
      true,
    );
  });

  test("does not trust a stale private-thread cache when a forced fetch rejects", async () => {
    const channel = {
      type: ChannelType.PrivateThread,
      permissionsFor: mock(() => permission(read)),
      members: {
        cache: { has: () => true },
        fetch: mock(async () => {
          throw new Error("no longer a member");
        }),
      },
    };

    expect(await canReadConversation(message(channel), {}, new DiscordRestBudget())).toBe(false);
  });

  test("does not fetch private-thread membership after the REST budget is exhausted", async () => {
    const fetch = mock(async () => ({}));
    const channel = {
      type: ChannelType.PrivateThread,
      permissionsFor: mock(() => permission(read)),
      members: { fetch },
    };

    expect(await canReadConversation(message(channel), {}, new DiscordRestBudget(0))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
