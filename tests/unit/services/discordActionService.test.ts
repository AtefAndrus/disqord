import { describe, expect, mock, test } from "bun:test";
import type { Message } from "discord.js";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { DiscordActionService } from "../../../src/services/discordActionService";

const READ = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
const ALL = [
  ...READ,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.SendPolls,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.PinMessages,
  PermissionFlagsBits.ManageThreads,
];

function fixture(
  options: {
    userPermissions?: bigint[];
    botPermissions?: bigint[];
    type?: ChannelType;
    locked?: boolean;
    timedOut?: boolean;
    owner?: boolean;
    memberFetchFails?: boolean;
    privateMemberFails?: boolean;
    pinAllowed?: boolean;
    systemMessage?: boolean;
    emojiRoles?: string[];
  } = {},
) {
  const user = {
    id: "user",
    communicationDisabledUntilTimestamp: options.timedOut ? Date.now() + 60_000 : null,
    roles: { cache: { has: (id: string) => id === "user-role" } },
  };
  const bot = {
    id: "bot",
    roles: { cache: { has: (id: string) => id === "bot-role" } },
  };
  const actions = {
    react: mock(async () => {}),
    pin: mock(async () => {}),
    startThread: mock(async () => {}),
    send: mock(async () => {}),
  };
  const message = {
    pinnable: options.pinAllowed ?? true,
    system: options.systemMessage ?? false,
    react: actions.react,
    pin: actions.pin,
    startThread: actions.startThread,
  };
  const channel = {
    type: options.type ?? ChannelType.GuildText,
    parentId:
      options.type === ChannelType.PublicThread || options.type === ChannelType.PrivateThread
        ? "parent"
        : null,
    locked: options.locked ?? false,
    isThread: () =>
      options.type === ChannelType.PublicThread || options.type === ChannelType.PrivateThread,
    members: {
      fetch: mock(async () => {
        if (options.privateMemberFails) throw { status: 404 };
        return {};
      }),
    },
    permissionsFor: (subject: { id: string }) => ({
      has: (bit: bigint) =>
        (subject.id === "bot"
          ? (options.botPermissions ?? ALL)
          : (options.userPermissions ?? ALL)
        ).includes(bit),
    }),
    messages: { fetch: mock(async () => message) },
    send: actions.send,
  };
  const guild = {
    ownerId: options.owner ? "user" : "owner",
    members: {
      fetch: mock(async ({ user: id }: { user: string }) => {
        if (id === "user" && options.memberFetchFails) throw { status: 404 };
        return id === "user" ? user : bot;
      }),
    },
    channels: { fetch: mock(async () => channel) },
    emojis: {
      fetch: mock(async () => ({
        find: (predicate: (emoji: unknown) => boolean) => {
          const emoji = {
            name: "party",
            identifier: "party:123",
            _roles: options.emojiRoles ?? [],
          };
          return predicate(emoji) ? emoji : undefined;
        },
      })),
    },
  };
  const trigger = {
    id: "trigger",
    channelId: "channel",
    channel,
    author: user,
    client: { user: bot },
    guild,
  } as unknown as Message<true>;
  const service = new DiscordActionService(trigger, (ref) => (ref === "m7" ? "older" : undefined));
  return { service, actions, channel, guild };
}

const signal = new AbortController().signal;
const parsed = async (promise: Promise<string>): Promise<Record<string, unknown>> =>
  JSON.parse(await promise);

describe("DiscordActionService", () => {
  test("runs all four operations and resolves a shown reference", async () => {
    const { service, actions, channel, guild } = fixture();
    expect(await parsed(service.addReaction("👍", "m7", signal))).toEqual({ ok: true });
    expect(guild.members.fetch).toHaveBeenCalledWith({ user: "user", force: true, cache: false });
    expect(guild.channels.fetch).toHaveBeenCalledWith("channel", { force: true });
    expect(guild.members.fetch).toHaveBeenCalledWith({ user: "bot", force: true });
    expect(channel.messages.fetch).toHaveBeenCalledWith({
      message: "older",
      cache: false,
      force: true,
    });
    expect(await parsed(service.createPoll("Question?", ["Yes", "No"], 24, false, signal))).toEqual(
      { ok: true },
    );
    expect(actions.send).toHaveBeenCalledWith(
      expect.objectContaining({ reply: { messageReference: "trigger" } }),
    );
    expect(await parsed(service.createThread("topic", undefined, signal))).toEqual({ ok: true });
    expect(await parsed(service.pinMessage(undefined, signal))).toEqual({ ok: true });
    expect(guild.members.fetch).toHaveBeenCalledTimes(8);
    expect(guild.channels.fetch).toHaveBeenCalledTimes(4);
  });

  test("refuses when the requester cannot be refetched", async () => {
    const { service, actions } = fixture({ memberFetchFails: true });
    expect(await parsed(service.addReaction("👍", undefined, signal))).toEqual({
      ok: false,
      reason: "requester_unavailable",
    });
    expect(actions.react).not.toHaveBeenCalled();
  });

  test("refuses missing read permissions and private thread membership", async () => {
    const botNoHistory = fixture({
      botPermissions: ALL.filter((bit) => bit !== PermissionFlagsBits.ReadMessageHistory),
    });
    expect(await parsed(botNoHistory.service.addReaction("👍", undefined, signal))).toEqual({
      ok: false,
      reason: "missing_permission",
      who: "bot",
      permissions: ["ReadMessageHistory"],
    });
    const noView = fixture({
      userPermissions: ALL.filter((bit) => bit !== PermissionFlagsBits.ViewChannel),
    });
    expect(await parsed(noView.service.addReaction("👍", undefined, signal))).toEqual({
      ok: false,
      reason: "missing_permission",
      who: "user",
      permissions: ["ViewChannel"],
    });
    const privateThread = fixture({
      type: ChannelType.PrivateThread,
      userPermissions: ALL.filter((bit) => bit !== PermissionFlagsBits.ManageThreads),
      privateMemberFails: true,
    });
    expect(await parsed(privateThread.service.addReaction("👍", undefined, signal))).toEqual({
      ok: false,
      reason: "cannot_read_conversation",
    });
  });

  test("blocks timed out requester except administrator or owner", async () => {
    const timedOut = fixture({ timedOut: true });
    expect(await parsed(timedOut.service.addReaction("👍", undefined, signal))).toEqual({
      ok: false,
      reason: "requester_timed_out",
    });
    const owner = fixture({ timedOut: true, owner: true });
    expect(await parsed(owner.service.addReaction("👍", undefined, signal))).toEqual({ ok: true });
    const administrator = fixture({
      timedOut: true,
      userPermissions: [...ALL, PermissionFlagsBits.Administrator],
    });
    expect(await parsed(administrator.service.addReaction("👍", undefined, signal))).toEqual({
      ok: true,
    });
  });

  test("requires ManageThreads on locked threads for both actors", async () => {
    const botMissing = fixture({
      type: ChannelType.PublicThread,
      locked: true,
      botPermissions: ALL.filter((bit) => bit !== PermissionFlagsBits.ManageThreads),
    });
    expect(await parsed(botMissing.service.addReaction("👍", undefined, signal))).toEqual({
      ok: false,
      reason: "missing_permission",
      who: "bot",
      permissions: ["ManageThreads"],
    });
    const userMissing = fixture({
      type: ChannelType.PublicThread,
      locked: true,
      userPermissions: ALL.filter((bit) => bit !== PermissionFlagsBits.ManageThreads),
    });
    expect(await parsed(userMissing.service.addReaction("👍", undefined, signal))).toEqual({
      ok: false,
      reason: "missing_permission",
      who: "user",
      permissions: ["ManageThreads"],
    });
  });

  test("refetches the parent of a thread for permission checks", async () => {
    const { service, guild } = fixture({ type: ChannelType.PublicThread });
    expect(await parsed(service.addReaction("👍", undefined, signal))).toEqual({ ok: true });
    expect(guild.channels.fetch).toHaveBeenNthCalledWith(1, "channel", { force: true });
    expect(guild.channels.fetch).toHaveBeenNthCalledWith(2, "parent", { force: true });
  });

  test("does not send after authorization if the call was cancelled", async () => {
    const { service, guild, channel, actions } = fixture();
    const controller = new AbortController();
    guild.channels.fetch.mockImplementationOnce(async () => {
      controller.abort();
      return channel;
    });
    expect(await parsed(service.addReaction("👍", undefined, controller.signal))).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(channel.messages.fetch).not.toHaveBeenCalled();
    expect(actions.react).not.toHaveBeenCalled();
  });

  test("checks each operation's permissions for bot and user", async () => {
    for (const [bit, invoke, name] of [
      [
        PermissionFlagsBits.AddReactions,
        (service: DiscordActionService) => service.addReaction("👍", undefined, signal),
        "AddReactions",
      ],
      [
        PermissionFlagsBits.SendPolls,
        (service: DiscordActionService) => service.createPoll("Q", ["A", "B"], 24, false, signal),
        "SendPolls",
      ],
      [
        PermissionFlagsBits.CreatePublicThreads,
        (service: DiscordActionService) => service.createThread("name", undefined, signal),
        "CreatePublicThreads",
      ],
      [
        PermissionFlagsBits.PinMessages,
        (service: DiscordActionService) => service.pinMessage(undefined, signal),
        "PinMessages",
      ],
    ] as const) {
      for (const who of ["bot", "user"] as const) {
        const permissions = ALL.filter((permission) => permission !== bit);
        const { service } = fixture({
          [who === "bot" ? "botPermissions" : "userPermissions"]: permissions,
        });
        expect(await parsed(invoke(service))).toEqual({
          ok: false,
          reason: "missing_permission",
          who,
          permissions: [name],
        });
      }
    }
    const manageOnly = fixture({
      userPermissions: [
        ...ALL.filter((bit) => bit !== PermissionFlagsBits.PinMessages),
        PermissionFlagsBits.ManageMessages,
      ],
    });
    expect((await parsed(manageOnly.service.pinMessage(undefined, signal))).permissions).toEqual([
      "PinMessages",
    ]);
    const threadSend = fixture({
      type: ChannelType.PublicThread,
      userPermissions: ALL.filter((bit) => bit !== PermissionFlagsBits.SendMessagesInThreads),
    });
    expect(
      (await parsed(threadSend.service.createPoll("Q", ["A", "B"], 24, false, signal))).permissions,
    ).toEqual(["SendMessagesInThreads"]);
  });

  test("checks custom emoji role restrictions for both actors", async () => {
    const deniedBot = fixture({ emojiRoles: ["user-role"] });
    expect((await parsed(deniedBot.service.addReaction("party", undefined, signal))).reason).toBe(
      "missing_emoji_role",
    );
    const deniedUser = fixture({ emojiRoles: ["bot-role"] });
    expect((await parsed(deniedUser.service.addReaction("party", undefined, signal))).who).toBe(
      "user",
    );
    const allowed = fixture({ emojiRoles: ["bot-role", "user-role"] });
    expect(await parsed(allowed.service.addReaction("party", undefined, signal))).toEqual({
      ok: true,
    });
    expect(allowed.actions.react).toHaveBeenCalledWith("party:123");
  });

  test("enforces per-response limits, including a failed poll send", async () => {
    const { service, actions } = fixture();
    for (let i = 0; i < 3; i++)
      expect((await parsed(service.addReaction("👍", undefined, signal))).ok).toBe(true);
    expect((await parsed(service.addReaction("👍", undefined, signal))).reason).toBe(
      "limit_reached",
    );
    expect(actions.react).toHaveBeenCalledTimes(3);
    actions.send.mockImplementationOnce(async () => {
      throw { code: 10008 };
    });
    expect((await parsed(service.createPoll("Q", ["A", "B"], 24, false, signal))).reason).toBe(
      "not_found",
    );
    expect((await parsed(service.createPoll("Q", ["A", "B"], 24, false, signal))).reason).toBe(
      "limit_reached",
    );
  });

  test("counts an interrupted poll after Discord received the send request", async () => {
    const { service, actions } = fixture();
    const controller = new AbortController();
    actions.send.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("request interrupted");
    });
    expect(
      (await parsed(service.createPoll("Q", ["A", "B"], 24, false, controller.signal))).reason,
    ).toBe("discord_failed");
    expect((await parsed(service.createPoll("Q", ["A", "B"], 24, false, signal))).reason).toBe(
      "limit_reached",
    );
    expect(actions.send).toHaveBeenCalledTimes(1);
  });

  test("does not count failures before a Discord mutation", async () => {
    const { service, actions } = fixture();
    expect((await parsed(service.addReaction("unknown", undefined, signal))).reason).toBe(
      "emoji_unavailable",
    );
    expect((await parsed(service.pinMessage("m999", signal))).reason).toBe("not_found");
    expect(await parsed(service.pinMessage(undefined, signal))).toEqual({ ok: true });
    expect(actions.pin).toHaveBeenCalledTimes(1);
  });

  test("classifies Discord errors and non-pinnable messages", async () => {
    const missing = fixture();
    missing.actions.react.mockImplementationOnce(async () => {
      throw { code: 50013 };
    });
    expect(await parsed(missing.service.addReaction("👍", undefined, signal))).toEqual({
      ok: false,
      reason: "missing_permission",
      who: "bot",
      permissions: ["AddReactions"],
    });
    const missingAccess = fixture();
    missingAccess.actions.react.mockImplementationOnce(async () => {
      throw { code: 50001 };
    });
    expect(await parsed(missingAccess.service.addReaction("👍", undefined, signal))).toEqual({
      ok: false,
      reason: "missing_access",
      who: "bot",
    });
    const generic = fixture();
    generic.actions.react.mockImplementationOnce(async () => {
      throw new Error("network");
    });
    expect((await parsed(generic.service.addReaction("👍", undefined, signal))).reason).toBe(
      "discord_failed",
    );
    const notPinnable = fixture({ pinAllowed: false });
    expect((await parsed(notPinnable.service.pinMessage(undefined, signal))).reason).toBe(
      "not_pinnable",
    );
    const systemMessage = fixture({ pinAllowed: false, systemMessage: true });
    expect((await parsed(systemMessage.service.pinMessage(undefined, signal))).reason).toBe(
      "system_message",
    );
    const invalidRef = fixture();
    expect((await parsed(invalidRef.service.pinMessage("m999", signal))).reason).toBe("not_found");
  });
});
