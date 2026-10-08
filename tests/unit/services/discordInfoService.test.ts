import { expect, mock, test } from "bun:test";
import type { Message } from "discord.js";
import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";
import type { IReplyRecordRepository } from "../../../src/db/repositories/replyRecord";
import { estimateToolResultTokens } from "../../../src/llm/contextBudget";
import { ConversationWindowService } from "../../../src/services/conversationWindow";
import {
  authorizeDiscordRead,
  DiscordActionService,
} from "../../../src/services/discordActionService";
import { DiscordInfoService } from "../../../src/services/discordInfoService";
import type {
  DiscordMessageFetchResult,
  DiscordMessageListResult,
  DiscordRestBudget,
  IDiscordMessageReader,
} from "../../../src/services/discordMessageReader";
import type { RawDiscordMessage } from "../../../src/utils/discordMessageNormalizer";

const NOW = Date.parse("2026-10-09T00:00:00Z");
const signal = new AbortController().signal;
const raw = (id: string, overrides: Partial<RawDiscordMessage> = {}): RawDiscordMessage => ({
  id,
  channel_id: "channel",
  guild_id: "guild",
  timestamp: new Date(NOW - 1000).toISOString(),
  author: { id: "user", username: "user" },
  content: `message-${id}`,
  ...overrides,
});
const records = (): IReplyRecordRepository => ({
  createPending: mock(() => true),
  appendPage: mock(() => true),
  removePage: mock(() => true),
  finalize: mock(() => true),
  findByTrigger: mock(() => null),
  findByPage: mock(() => null),
  listPages: mock(() => []),
  markPendingFailed: mock(() => 0),
  deleteByGuild: mock(() => 0),
  deleteByChannel: mock(() => 0),
  deleteGuildsNotIn: mock(() => 0),
});
const event = (
  name: string,
  status = 1,
  start = NOW + 1000,
  channelId: string | null = null,
  entityType = 3,
) => ({
  name,
  status,
  entityType,
  channelId,
  description: "d".repeat(300),
  scheduledStartTimestamp: start,
  scheduledStartAt: new Date(start),
  scheduledEndAt: null,
  entityMetadata: { location: "park" },
  userCount: 7,
});
type IEventFixture = ReturnType<typeof event>;

async function fixture(
  options: {
    type?: ChannelType;
    locked?: boolean;
    timedOut?: boolean;
    repository?: IReplyRecordRepository;
    history?: RawDiscordMessage[];
    deadlineMs?: number;
  } = {},
) {
  let allowed = true;
  const user = {
    id: "user",
    communicationDisabledUntilTimestamp: options.timedOut ? Date.now() + 60_000 : null,
  };
  const bot = { id: "bot" };
  const parent = {
    id: "parent",
    type: ChannelType.GuildText,
    name: "fresh-parent",
    topic: "fresh-topic",
    parentId: "category",
    nsfw: true,
  };
  const channel = {
    id: "channel",
    type: options.type ?? ChannelType.GuildText,
    name: "fresh-channel",
    topic: "topic",
    nsfw: false,
    rateLimitPerUser: 5,
    createdAt: new Date(NOW),
    parentId: null as string | null,
    parent,
    isThread: (): boolean =>
      [ChannelType.PublicThread, ChannelType.PrivateThread].includes(channel.type),
    locked: options.locked ?? false,
    permissionsFor: (subject: { id?: string }) => ({
      has: (bit: bigint): boolean =>
        bit !== PermissionFlagsBits.ManageThreads && (subject.id !== "user" || allowed),
    }),
    members: { fetch: mock(async () => ({})) },
    messages: {
      fetchPins: mock(async (_options: unknown) => ({
        items: [] as { message: Message; pinnedAt: Date }[],
        hasMore: false,
      })),
      fetch: mock(async (_options: unknown) => ({ react: mock(async () => {}) })),
    },
  };
  if (channel.isThread()) channel.parentId = "parent";
  let events: IEventFixture[] = [];
  const guildChannels = new Collection<
    string,
    {
      type: ChannelType;
      name: string;
      permissionsFor: (member: unknown) => { has: (bit: bigint) => boolean };
    }
  >();
  const guild = {
    id: "guild",
    ownerId: "owner",
    members: {
      fetch: mock(async ({ user: id }: { user: string }) => (id === "user" ? user : bot)),
    },
    channels: {
      fetch: mock(async (id?: string, _options?: unknown) =>
        id === undefined
          ? guildChannels
          : id === "parent"
            ? parent
            : id === "category"
              ? { name: "fresh-category", type: ChannelType.GuildCategory }
              : channel,
      ),
    },
    scheduledEvents: {
      fetch: mock(
        async (_options?: unknown) => new Collection(events.map((item, i) => [String(i), item])),
      ),
    },
  };
  const trigger = {
    id: "999",
    channelId: "channel",
    channel,
    author: user,
    client: { user: bot },
    guild,
  } as unknown as Message<true>;
  const remote = new Map<string, RawDiscordMessage>();
  const reader: IDiscordMessageReader = {
    list: mock(
      async (
        _channel: string,
        _query: { before?: string; after?: string; limit: number },
        budget: DiscordRestBudget,
      ): Promise<DiscordMessageListResult> => {
        budget.consume();
        return { status: "ok", messages: options.history ?? [] };
      },
    ),
    fetch: mock(
      async (
        _channel: string,
        id: string,
        budget: DiscordRestBudget,
        fetchSignal?: AbortSignal,
      ): Promise<DiscordMessageFetchResult> => {
        if (!budget.consume()) return { status: "failed", error: new Error("budget") };
        if (fetchSignal?.aborted) return { status: "failed", error: new Error("aborted") };
        const message = remote.get(id);
        return message
          ? { status: "found", message }
          : { status: "failed", error: new Error("unknown") };
      },
    ),
  };
  const context = await new ConversationWindowService(
    reader,
    options.repository ?? records(),
    () => NOW,
    undefined,
    undefined,
    options.deadlineMs,
  ).build({
    current: raw("999", { timestamp: new Date(NOW).toISOString() }),
    guildId: "guild",
    userId: "user",
    botUserId: "bot",
    botUser: bot,
    channel: {},
    historyEnabled: true,
    authorize: async () => true,
    reauthorize: async (budget) => {
      const auth = await authorizeDiscordRead(trigger, budget);
      return !("ok" in auth)
        ? "allowed"
        : auth.reason === "rest_budget_exhausted"
          ? "rest_budget_exhausted"
          : "denied";
    },
  });
  if (!context) throw new Error("no context");
  const budget = context.toolRestBudget;
  if (!budget) throw new Error("missing tool budget");
  const service = new DiscordInfoService(
    trigger,
    context,
    (message) => message as unknown as RawDiscordMessage,
  );
  const setPins = (messages: RawDiscordMessage[], hasMore = false): void => {
    channel.messages.fetchPins.mockImplementation(async () => ({
      items: messages.map((message, i) => ({
        message: message as unknown as Message,
        pinnedAt: new Date(NOW - i * 1000),
      })),
      hasMore,
    }));
  };
  return {
    budget,
    service,
    context,
    trigger,
    channel,
    guild,
    guildChannels,
    reader,
    remote,
    setPins,
    deny: (): void => {
      allowed = false;
    },
    setEvents: (items: IEventFixture[]): void => {
      events = items;
    },
  };
}

test.each(["getChannelInfo", "listPins", "listEvents"] as const)(
  "%s refuses permissions lost mid-response before reading",
  async (method) => {
    const f = await fixture();
    expect(JSON.parse(await f.service.getChannelInfo(signal)).name).toBe("fresh-channel");
    f.deny();
    const result =
      method === "getChannelInfo"
        ? await f.service.getChannelInfo(signal)
        : method === "listPins"
          ? await f.service.listPins(undefined, signal)
          : await f.service.listEvents(undefined, undefined, signal);
    expect(JSON.parse(result)).toEqual({ error: "missing_permission" });
    expect(f.channel.messages.fetchPins).not.toHaveBeenCalled();
    expect(f.guild.scheduledEvents.fetch).not.toHaveBeenCalled();
  },
);

test.each([ChannelType.PublicThread, ChannelType.PrivateThread])(
  "locked thread and timed-out member can read (%s)",
  async (type) => {
    const f = await fixture({ type, locked: true, timedOut: true });
    const result = JSON.parse(await f.service.getChannelInfo(signal));
    expect(result.parent).toEqual({ name: "fresh-parent", topic: "fresh-topic" });
    expect(result.category_name).toBe("fresh-category");
    expect(f.guild.channels.fetch).toHaveBeenCalledWith("parent", { force: true });
    expect(f.guild.channels.fetch).toHaveBeenCalledWith("category", { force: true });
    expect(f.context.toolRestBudget?.used).toBe(type === ChannelType.PrivateThread ? 6 : 5);
  },
);

test.each([0, 1, 2, 3, 4])(
  "check REST cap at %s refuses a private-thread read without fetching pins",
  async (limit) => {
    const f = await fixture({ type: ChannelType.PrivateThread });
    const budget = f.budget;
    while (budget.used < budget.limit - limit) budget.consume();
    expect(JSON.parse(await f.service.listPins(undefined, signal))).toEqual({
      error: "rest_budget_exhausted",
    });
    expect(f.channel.messages.fetchPins).not.toHaveBeenCalled();
  },
);

test("REST cap after authorization returns a stopped read", async () => {
  const f = await fixture();
  const budget = f.budget;
  while (budget.used < budget.limit - 3) budget.consume();
  expect(JSON.parse(await f.service.listPins(undefined, signal))).toMatchObject({
    pins: [],
    has_more: true,
    stop_reason: "rest_budget_exhausted",
  });
  expect(f.channel.messages.fetchPins).not.toHaveBeenCalled();
});

test("view_attachment rechecks permissions and spends the same cap before attachment REST", async () => {
  const pinned = raw("100", {
    attachments: [
      {
        id: "a",
        filename: "file.png",
        url: "https://cdn.discordapp.com/a.png",
        content_type: "image/png",
        size: 1,
      },
    ],
  });
  const f = await fixture({ history: [pinned] });
  f.deny();
  expect(await f.context.toolContext.viewAttachment("m1", 1, "model", signal)).toBe(
    '{"error":"no_permission"}',
  );
  expect(f.context.toolRestBudget?.used).toBe(3);
  expect(f.reader.fetch).not.toHaveBeenCalled();
});

test("view_attachment refuses when shared cap runs out during recheck", async () => {
  const f = await fixture();
  const budget = f.budget;
  while (budget.used < budget.limit - 1) budget.consume();
  expect(await f.context.toolContext.viewAttachment("m1", 1, "model", signal)).toBe(
    '{"error":"rest_budget_exhausted"}',
  );
  expect(f.reader.fetch).not.toHaveBeenCalled();
});

test.each([ChannelType.GuildVoice, ChannelType.GuildStageVoice])(
  "event visibility requires requester, bot and everyone; missing channel is hidden (%s)",
  async (type) => {
    const f = await fixture();
    for (const who of ["user", "bot", "guild", "missing", "visible"]) {
      if (who !== "missing")
        f.guildChannels.set(who, {
          name: who,
          type,
          permissionsFor: (subject: unknown) => ({
            has: (): boolean =>
              (typeof subject === "string" ? subject : (subject as { id: string }).id) !== who,
          }),
        });
    }
    f.setEvents([
      event("external"),
      ...["user", "bot", "guild", "missing", "visible"].map((id) =>
        event(id, 1, NOW + 1000, id, type === ChannelType.GuildVoice ? 2 : 1),
      ),
    ]);
    const result = JSON.parse(await f.service.listEvents(undefined, undefined, signal));
    expect(result.scheduled.events.map((item: { name: string }) => item.name)).toEqual([
      "external",
      "visible",
    ]);
    expect(JSON.stringify(result)).not.toContain("missing");
    expect(f.guild.scheduledEvents.fetch).toHaveBeenCalledWith({ withUserCount: true });
    expect(f.guild.channels.fetch.mock.calls.filter((call) => call[0] === undefined)).toHaveLength(
      1,
    );
  },
);

test("events filter scheduled period, default from now, and retain active regardless of period", async () => {
  const f = await fixture();
  f.setEvents([
    event("active", 2, NOW - 5000),
    event("past", 1, NOW - 5000),
    event("start", 1, NOW + 1000),
    event("middle", 1, NOW + 2000),
    event("end", 1, NOW + 3000),
    event("done", 3),
    event("cancelled", 4),
  ]);
  const result = JSON.parse(
    await f.service.listEvents(
      new Date(NOW + 1000).toISOString(),
      new Date(NOW + 3000).toISOString(),
      signal,
    ),
  );
  expect(result.active.events.map((item: { name: string }) => item.name)).toEqual(["active"]);
  expect(result.scheduled.events.map((item: { name: string }) => item.name)).toEqual([
    "start",
    "middle",
  ]);
  const now = Date.now();
  f.setEvents([event("yesterday", 1, now - 86_400_000), event("tomorrow", 1, now + 86_400_000)]);
  expect(
    JSON.parse(await f.service.listEvents(undefined, undefined, signal)).scheduled.events.map(
      (item: { name: string }) => item.name,
    ),
  ).toEqual(["tomorrow"]);
});

test("active and scheduled have separate 20-item limits and budget trimming flags", async () => {
  const f = await fixture();
  f.setEvents(Array.from({ length: 42 }, (_, i) => event(`e${i}`, i < 21 ? 2 : 1, NOW + i * 1000)));
  const from = new Date(NOW).toISOString();
  const whole = JSON.parse(await f.service.listEvents(from, undefined, signal));
  for (const group of [whole.active, whole.scheduled]) {
    expect(group.events).toHaveLength(20);
    expect(group.has_more).toBe(true);
    expect(group.events[0].description).toHaveLength(200);
  }
  f.setEvents([event("a", 2), event("s")]);
  const trimmed = await f.service.listEvents(from, undefined, signal, 100);
  const result = JSON.parse(trimmed);
  expect(estimateToolResultTokens(trimmed)).toBeLessThanOrEqual(100);
  expect(result.active.has_more || result.scheduled.has_more).toBe(true);
  expect(result.stop_reason).toBe("result_budget_exhausted");
});

test("events stop safely when cap is hit after channel list but before events fetch", async () => {
  const f = await fixture();
  f.setEvents([event("hidden", 1, NOW, "private", 2), event("external")]);
  const budget = f.budget;
  while (budget.used < budget.limit - 4) budget.consume();
  const result = JSON.parse(await f.service.listEvents(undefined, undefined, signal));
  expect(result).toMatchObject({
    active: { events: [], has_more: true },
    scheduled: { events: [], has_more: true },
    stop_reason: "rest_budget_exhausted",
  });
  expect(f.guild.channels.fetch.mock.calls.filter((call) => call[0] === undefined)).toHaveLength(1);
  expect(f.guild.scheduledEvents.fetch).not.toHaveBeenCalled();
});

test("pins honor Discord has_more and before paging, skip bots and assign usable refs", async () => {
  const f = await fixture();
  f.setPins(
    [raw("100"), raw("101", { author: { id: "other-bot", username: "other", bot: true } })],
    true,
  );
  const result = JSON.parse(await f.service.listPins("2026-10-08T12:00:00+09:00", signal));
  expect(result).toMatchObject({
    pins: [{ ref: "m1", pinned_at: new Date(NOW).toISOString() }],
    skipped_count: 1,
    has_more: true,
  });
  expect(f.channel.messages.fetchPins).toHaveBeenCalledWith({
    before: "2026-10-08T12:00:00+09:00",
    limit: 50,
    cache: false,
  });
  expect(f.context.toolContext.resolveMessageRef("m1")).toBe("100");
});

test("pins trimmed by result budget are omitted without committing refs", async () => {
  const f = await fixture();
  f.setPins([raw("100", { content: "a".repeat(5000) })]);
  expect(JSON.parse(await f.service.listPins(undefined, signal, 150))).toMatchObject({
    pins: [],
    has_more: true,
    stop_reason: "result_budget_exhausted",
  });
  expect(f.context.toolContext.resolveMessageRef("m1")).toBeUndefined();
});

function replyRepository(): IReplyRecordRepository {
  const repository = records();
  const record = {
    triggerMsgId: "100",
    channelId: "channel",
    guildId: "guild",
    status: "completed" as const,
    pageCount: 2,
    createdAt: NOW - 2000,
    finalizedAt: NOW - 500,
  };
  repository.findByTrigger = mock((id) => (id === "100" ? record : null));
  repository.findByPage = mock((id) => (["101", "102"].includes(id) ? record : null));
  repository.listPages = mock(() =>
    [0, 1].map((seq) => ({ triggerMsgId: "100", pageMsgId: String(101 + seq), seq })),
  );
  return repository;
}
function replyPage(id: string, body: string, badge = false): RawDiscordMessage {
  return raw(id, {
    author: { id: "bot", username: "bot", bot: true },
    content: "",
    components: [
      {
        type: 17,
        components: [
          ...(badge ? [{ type: 10, content: "**Model:** model" }] : []),
          { type: 10, content: body },
          { type: 14, divider: false },
          { type: 10, content: "footer" },
        ],
      },
    ],
  });
}

test.each(["first-in-window", "later-in-window", "outside-window"])(
  "multi-page pin returns just its page and the exact action target (%s)",
  async (location) => {
    const pages = [
      replyPage("101", "first answer", true),
      replyPage("102", "second answer"),
    ] as const;
    const f = await fixture({
      repository: replyRepository(),
      history: location === "outside-window" ? [] : [raw("100"), ...pages],
    });
    f.remote.set("100", raw("100"));
    f.remote.set("101", pages[0]);
    f.remote.set("102", pages[1]);
    const pin = location === "later-in-window" ? pages[1] : pages[0];
    const existing = f.context.messages.find((message) => message.id === "101")?.ref;
    f.setPins([pin]);
    const result = JSON.parse(await f.service.listPins(undefined, signal));
    expect(result.pins).toHaveLength(1);
    expect(result.pins[0].text).toBe(
      location === "later-in-window" ? "second answer" : "first answer",
    );
    if (location === "first-in-window") expect(result.pins[0].ref).toBe(existing);
    if (location === "later-in-window") expect(result.pins[0].ref).not.toBe(existing);
    const action = new DiscordActionService(f.trigger, f.context.toolContext.resolveMessageRef);
    expect(await action.addReaction("👍", result.pins[0].ref, signal)).toBe('{"ok":true}');
    expect(f.channel.messages.fetch).toHaveBeenCalledWith({
      message: pin.id,
      cache: false,
      force: true,
    });
  },
);

test("unconfirmable human pins are only counted, not returned", async () => {
  const f = await fixture({ repository: replyRepository() });
  f.setPins([raw("200"), raw("100")]);
  const result = JSON.parse(await f.service.listPins(undefined, signal));
  expect(result.pins).toHaveLength(1);
  expect(result.pins[0].text).toBe("message-200");
  expect(result.skipped_count).toBe(1);
  expect(result.has_more).toBe(false);
});

test("pin judgment stops at REST cap and keeps only completed judgments", async () => {
  const f = await fixture({ repository: replyRepository() });
  f.setPins([raw("200"), raw("100"), raw("201")]);
  const budget = f.budget;
  while (budget.used < budget.limit - 5) budget.consume();
  const result = JSON.parse(await f.service.listPins(undefined, signal));
  expect(result.pins).toHaveLength(1);
  expect(result.pins[0].text).toBe("message-200");
  expect(result).toMatchObject({
    has_more: true,
    stop_reason: "rest_budget_exhausted",
    skipped_count: 0,
  });
});

test("pin judgment deadline keeps completed ones and does not count an interrupted judgment", async () => {
  const f = await fixture({ repository: replyRepository(), deadlineMs: 10 });
  f.setPins([raw("200"), raw("100"), raw("201")]);
  f.reader.fetch = mock(async (): Promise<DiscordMessageFetchResult> => new Promise(() => {}));
  const result = JSON.parse(await f.service.listPins(undefined, signal));
  expect(result.pins).toHaveLength(1);
  expect(result.pins[0].text).toBe("message-200");
  expect(result).toMatchObject({ has_more: true, stop_reason: "fetch_deadline", skipped_count: 0 });
  expect(f.context.toolContext.resolveMessageRef("m2")).toBeUndefined();
});

test("get_channel_info trims topics to fit result budget", async () => {
  const f = await fixture();
  f.channel.topic = "x".repeat(2000);
  const result = await f.service.getChannelInfo(signal, 200);
  expect(estimateToolResultTokens(result)).toBeLessThanOrEqual(200);
  expect(JSON.parse(result)).toMatchObject({ name: "fresh-channel", truncated: true });
});

test("pins deadline includes permission REST rechecks", async () => {
  const f = await fixture({ deadlineMs: 10 });
  f.guild.members.fetch.mockImplementation(async () => new Promise(() => {}));
  const result = JSON.parse(await f.service.listPins(undefined, signal));
  expect(result).toMatchObject({ pins: [], has_more: true, stop_reason: "fetch_deadline" });
  expect(f.channel.messages.fetchPins).not.toHaveBeenCalled();
});
