import { describe, expect, mock, spyOn, test } from "bun:test";
import type { Message } from "discord.js";
import {
  ChannelType,
  Collection,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  PermissionFlagsBits,
} from "discord.js";
import type { CreateEventArgs } from "../../../src/llm/tools/registry";
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
    parentType?: ChannelType;
    locked?: boolean;
    timedOut?: boolean;
    owner?: boolean;
    memberFetchFails?: boolean;
    privateMemberFails?: boolean;
    pinAllowed?: boolean;
    systemMessage?: boolean;
    emojiRoles?: string[];
    userEventPermissions?: bigint[];
    botEventPermissions?: bigint[];
    voiceChannels?: {
      id: string;
      name: string;
      type?: ChannelType;
      userPermissions?: bigint[];
      botPermissions?: bigint[];
    }[];
  } = {},
) {
  const user = {
    id: "user",
    permissions: {
      has: (bit: bigint) =>
        (options.userEventPermissions ?? [PermissionFlagsBits.CreateEvents]).includes(bit),
    },
    communicationDisabledUntilTimestamp: options.timedOut ? Date.now() + 60_000 : null,
    roles: { cache: { has: (id: string) => id === "user-role" } },
  };
  const bot = {
    id: "bot",
    permissions: {
      has: (bit: bigint) =>
        (options.botEventPermissions ?? [PermissionFlagsBits.CreateEvents]).includes(bit),
    },
    roles: { cache: { has: (id: string) => id === "bot-role" } },
  };
  const actions = {
    react: mock(async () => {}),
    pin: mock(async () => {}),
    startThread: mock(async () => {}),
    send: mock(async () => {}),
    createEvent: mock(async () => ({ id: "event" })),
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
    parent: { type: options.parentType ?? ChannelType.GuildText },
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
    id: "guild",
    ownerId: options.owner ? "user" : "owner",
    members: {
      fetch: mock(async ({ user: id }: { user: string }) => {
        if (id === "user" && options.memberFetchFails) throw { status: 404 };
        return id === "user" ? user : bot;
      }),
    },
    channels: {
      fetch: mock(async (id?: string) =>
        id === undefined
          ? new Collection(
              (options.voiceChannels ?? [{ id: "voice", name: "Meeting" }]).map((voice) => [
                voice.id,
                {
                  id: voice.id,
                  name: voice.name,
                  type: voice.type ?? ChannelType.GuildVoice,
                  permissionsFor: (member: { id: string }) => ({
                    has: (bit: bigint) =>
                      (member.id === "bot"
                        ? voice.botPermissions
                        : voice.userPermissions
                      )?.includes(bit) ??
                      [
                        PermissionFlagsBits.CreateEvents,
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.Connect,
                      ].includes(bit),
                  }),
                },
              ]),
            )
          : id === "parent"
            ? { type: options.parentType ?? ChannelType.GuildText }
            : channel,
      ),
    },
    scheduledEvents: { create: actions.createEvent },
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

const EVENT_START = new Date(Date.now() + 3_600_000).toISOString();
const EVENT_END = new Date(Date.now() + 7_200_000).toISOString();
const EXTERNAL: CreateEventArgs = {
  kind: "external",
  name: "Meet",
  start: EVENT_START,
  end: EVENT_END,
  location: "Park",
};
const VOICE: CreateEventArgs = {
  kind: "voice",
  name: "Meet",
  start: EVENT_START,
  channel_name: "Meeting",
};
const VOICE_PERMISSIONS = [
  PermissionFlagsBits.CreateEvents,
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
];

describe("DiscordActionService create_event", () => {
  test.each([EXTERNAL, VOICE])(
    "creates a guild-only $kind event when both actors have permissions",
    async (args) => {
      const { service, guild, actions, channel } = fixture();
      expect(await service.createEvent(args, signal)).toBe(
        '{"ok":true,"url":"https://discord.com/events/guild/event"}',
      );
      expect(actions.createEvent).toHaveBeenCalledWith({
        name: args.name,
        scheduledStartTime: Date.parse(args.start),
        ...(args.end && { scheduledEndTime: Date.parse(args.end) }),
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        ...(args.kind === "external"
          ? {
              entityType: GuildScheduledEventEntityType.External,
              entityMetadata: { location: "Park" },
            }
          : {
              entityType: GuildScheduledEventEntityType.Voice,
              channel: expect.objectContaining({ id: "voice" }),
            }),
      });
      expect(guild.channels.fetch).toHaveBeenCalledWith("channel", { force: true });
      if (args.kind === "voice") expect(guild.channels.fetch).toHaveBeenCalledWith();
      expect(channel.messages.fetch).not.toHaveBeenCalled();
    },
  );

  test.each(["bot", "user"] as const)(
    "external rejects when only %s has CreateEvents",
    async (holder) => {
      const { service, actions } = fixture({
        [holder === "bot" ? "userEventPermissions" : "botEventPermissions"]: [],
      });
      expect(await parsed(service.createEvent(EXTERNAL, signal))).toEqual({
        ok: false,
        reason: "missing_permission",
        who: holder === "bot" ? "user" : "bot",
        permissions: ["CreateEvents"],
      });
      expect(actions.createEvent).not.toHaveBeenCalled();
    },
  );

  test.each(["bot", "user"] as const)(
    "voice rejects when only %s has CreateEvents and Connect",
    async (holder) => {
      const { service, actions } = fixture({
        voiceChannels: [
          {
            id: "voice",
            name: "Meeting",
            [holder === "bot" ? "userPermissions" : "botPermissions"]: [
              PermissionFlagsBits.ViewChannel,
            ],
          },
        ],
      });
      expect(await parsed(service.createEvent(VOICE, signal))).toEqual({
        ok: false,
        reason: "missing_permission",
        who: holder === "bot" ? "user" : "bot",
        permissions: ["CreateEvents", "Connect"],
      });
      expect(actions.createEvent).not.toHaveBeenCalled();
    },
  );

  test.each(["bot", "user"] as const)(
    "voice requires Connect for %s even with guild CreateEvents",
    async (who) => {
      const { service, actions } = fixture({
        voiceChannels: [
          {
            id: "voice",
            name: "Meeting",
            [who === "bot" ? "botPermissions" : "userPermissions"]: VOICE_PERMISSIONS.filter(
              (bit) => bit !== PermissionFlagsBits.Connect,
            ),
          },
        ],
      });
      expect(await parsed(service.createEvent(VOICE, signal))).toEqual({
        ok: false,
        reason: "missing_permission",
        who,
        permissions: ["Connect"],
      });
      expect(actions.createEvent).not.toHaveBeenCalled();
    },
  );

  test.each(["bot", "user"] as const)(
    "excludes same-name voice channels invisible to %s",
    async (who) => {
      const { service, actions } = fixture({
        voiceChannels: [
          {
            id: "hidden",
            name: "Meeting",
            [who === "bot" ? "botPermissions" : "userPermissions"]: VOICE_PERMISSIONS.filter(
              (bit) => bit !== PermissionFlagsBits.ViewChannel,
            ),
          },
          { id: "visible", name: "Meeting" },
        ],
      });
      expect((await parsed(service.createEvent(VOICE, signal))).ok).toBe(true);
      expect(actions.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ channel: expect.objectContaining({ id: "visible" }) }),
      );
    },
  );

  test.each(
    [
      [],
      [{ id: "hidden", name: "Meeting", userPermissions: [] }],
      [{ id: "hidden", name: "Meeting", botPermissions: [] }],
      [{ id: "text", name: "Meeting", type: ChannelType.GuildText }],
      [{ id: "stage", name: "Meeting", type: ChannelType.GuildStageVoice }],
      [{ id: "other", name: "Other" }],
    ].map((channels) => [channels] as const),
  )(
    "returns channel_not_found for missing or invisible voice candidates %p",
    async (voiceChannels) => {
      const { service, actions } = fixture({ voiceChannels });
      expect(await parsed(service.createEvent(VOICE, signal))).toEqual({
        ok: false,
        reason: "channel_not_found",
      });
      expect(actions.createEvent).not.toHaveBeenCalled();
    },
  );

  test("returns channel_ambiguous without candidate names", async () => {
    const { service, actions } = fixture({
      voiceChannels: [
        { id: "one", name: "Meeting" },
        { id: "two", name: "Meeting" },
      ],
    });
    expect(await service.createEvent(VOICE, signal)).toBe(
      '{"ok":false,"reason":"channel_ambiguous"}',
    );
    expect(actions.createEvent).not.toHaveBeenCalled();
  });

  test.each([
    { ...EXTERNAL, start: new Date(Date.now() - 1000).toISOString() },
    { ...VOICE, start: new Date(Date.now() - 1000).toISOString() },
    { ...EXTERNAL, end: EVENT_START },
    { ...VOICE, end: new Date(Date.parse(EVENT_START) - 1000).toISOString() },
  ])("rejects invalid time ordering at execution for %p", async (args) => {
    const { service, actions } = fixture();
    expect((await parsed(service.createEvent(args, signal))).reason).toBe(
      Date.parse(args.start) <= Date.now() ? "invalid_start" : "invalid_end",
    );
    expect(actions.createEvent).not.toHaveBeenCalled();
  });

  test.each([EXTERNAL, VOICE])("50013 reports $kind event permission names", async (args) => {
    const { service, actions } = fixture();
    actions.createEvent.mockImplementationOnce(async () => {
      throw { code: 50013 };
    });
    expect(await parsed(service.createEvent(args, signal))).toEqual({
      ok: false,
      reason: "missing_permission",
      who: "bot",
      permissions:
        args.kind === "external" ? ["CreateEvents"] : ["CreateEvents", "ViewChannel", "Connect"],
    });
  });

  test("checks start against the execution time after authorization", async () => {
    const { service, actions, guild, channel } = fixture();
    const start = Date.now() + 1000;
    const clock = spyOn(Date, "now");
    guild.channels.fetch.mockImplementationOnce(async () => {
      clock.mockReturnValue(start + 1);
      return channel;
    });
    try {
      expect(
        await parsed(
          service.createEvent({ ...EXTERNAL, start: new Date(start).toISOString() }, signal),
        ),
      ).toEqual({ ok: false, reason: "invalid_start" });
      expect(actions.createEvent).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  test("counts an aborted create_event call toward the per-response limit", async () => {
    const { service, actions } = fixture();
    const controller = new AbortController();
    actions.createEvent.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("interrupted");
    });
    expect((await parsed(service.createEvent(EXTERNAL, controller.signal))).reason).toBe(
      "discord_failed",
    );
    expect(await parsed(service.createEvent(EXTERNAL, signal))).toEqual({
      ok: false,
      reason: "limit_reached",
    });
    expect(actions.createEvent).toHaveBeenCalledTimes(1);
  });

  test("a call cancelled before the create request leaves the limit for the next call", async () => {
    const early = fixture();
    const cancelled = AbortSignal.abort();
    expect((await parsed(early.service.createEvent(EXTERNAL, cancelled))).reason).toBe("cancelled");
    expect((await parsed(early.service.createEvent(EXTERNAL, signal))).ok).toBe(true);
    expect(early.actions.createEvent).toHaveBeenCalledTimes(1);
    const later = fixture();
    const controller = new AbortController();
    const fetchChannels = later.guild.channels.fetch.getMockImplementation();
    later.guild.channels.fetch.mockImplementation(async (id) => {
      const channels = await fetchChannels?.(id);
      if (id === undefined && !controller.signal.aborted) controller.abort();
      return channels as Awaited<ReturnType<NonNullable<typeof fetchChannels>>>;
    });
    expect((await parsed(later.service.createEvent(VOICE, controller.signal))).reason).toBe(
      "cancelled",
    );
    expect(later.actions.createEvent).not.toHaveBeenCalled();
    expect((await parsed(later.service.createEvent(VOICE, signal))).ok).toBe(true);
  });

  test("a call refused by a check leaves the limit for the corrected call", async () => {
    const { service, actions } = fixture();
    expect(
      (await parsed(service.createEvent({ ...VOICE, channel_name: "no-such-channel" }, signal)))
        .reason,
    ).toBe("channel_not_found");
    expect((await parsed(service.createEvent(VOICE, signal))).ok).toBe(true);
    expect((await parsed(service.createEvent(EXTERNAL, signal))).reason).toBe("limit_reached");
    expect(actions.createEvent).toHaveBeenCalledTimes(1);
  });

  test("requires common current-channel authorization before creating events", async () => {
    for (const [options, reason] of [
      [{ timedOut: true }, "requester_timed_out"],
      [{ memberFetchFails: true }, "requester_unavailable"],
      [
        { type: ChannelType.PublicThread, locked: true, userPermissions: READ },
        "missing_permission",
      ],
      [{ botPermissions: [] as bigint[] }, "missing_permission"],
    ] as const) {
      const { service, actions } = fixture(options);
      expect((await parsed(service.createEvent(EXTERNAL, signal))).reason).toBe(reason);
      expect(actions.createEvent).not.toHaveBeenCalled();
    }
  });

  test("passes description and optional voice end without message mutation limits interfering", async () => {
    const { service, actions } = fixture();
    await service.createPoll("Q", ["A", "B"], 24, false, signal);
    expect(
      (
        await parsed(
          service.createEvent({ ...VOICE, end: EVENT_END, description: "Details" }, signal),
        )
      ).ok,
    ).toBe(true);
    expect(actions.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledEndTime: Date.parse(EVENT_END), description: "Details" }),
    );
    expect((await parsed(service.createEvent(EXTERNAL, signal))).reason).toBe("limit_reached");
  });
});

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

  test.each([ChannelType.GuildForum, ChannelType.GuildMedia])(
    "rejects threads whose refetched parent has type %p",
    async (parentType) => {
      const { service, actions } = fixture({ type: ChannelType.PublicThread, parentType });
      expect(service.channelType).toBe(-1);
      expect(await parsed(service.addReaction("👍", undefined, signal))).toEqual({
        ok: false,
        reason: "unsupported_channel",
      });
      expect(actions.react).not.toHaveBeenCalled();
    },
  );

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

  test("does not pin when cancelled during target message fetch", async () => {
    const { service, channel, actions } = fixture();
    const controller = new AbortController();
    channel.messages.fetch.mockImplementationOnce(async () => {
      controller.abort();
      return {
        pinnable: true,
        system: false,
        react: actions.react,
        pin: actions.pin,
        startThread: actions.startThread,
      };
    });
    expect(await parsed(service.pinMessage(undefined, controller.signal))).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(actions.pin).not.toHaveBeenCalled();
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

  test("rejects percent-encoded custom emoji before sending a reaction", async () => {
    const { service, actions, guild } = fixture({ emojiRoles: ["bot-role"] });
    expect(
      await parsed(service.addReaction("blob%3A123456789012345678", undefined, signal)),
    ).toEqual({
      ok: false,
      reason: "invalid_emoji",
    });
    expect(actions.react).not.toHaveBeenCalled();
    expect(guild.emojis.fetch).not.toHaveBeenCalled();
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
    for (let i = 0; i < 4; i++) {
      expect((await parsed(service.addReaction("unknown", undefined, signal))).reason).toBe(
        "emoji_unavailable",
      );
    }
    expect(await parsed(service.addReaction("👍", undefined, signal))).toEqual({ ok: true });
    expect(actions.react).toHaveBeenCalledTimes(1);
    const { service: pinService, channel, actions: pinActions } = fixture();
    channel.messages.fetch.mockImplementationOnce(async () => {
      throw { status: 404 };
    });
    expect((await parsed(pinService.pinMessage(undefined, signal))).reason).toBe("not_found");
    expect(await parsed(pinService.pinMessage(undefined, signal))).toEqual({ ok: true });
    expect(pinActions.pin).toHaveBeenCalledTimes(1);
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
    const blocked = fixture();
    blocked.actions.react.mockImplementationOnce(async () => {
      throw { code: 90001, status: 403 };
    });
    expect(await parsed(blocked.service.addReaction("👍", undefined, signal))).toEqual({
      ok: false,
      reason: "reaction_blocked",
    });
    const forbidden = fixture();
    forbidden.actions.react.mockImplementationOnce(async () => {
      throw { status: 403 };
    });
    expect(await parsed(forbidden.service.addReaction("👍", undefined, signal))).toEqual({
      ok: false,
      reason: "discord_forbidden",
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
