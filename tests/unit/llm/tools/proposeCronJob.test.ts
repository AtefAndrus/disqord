import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ChannelType, type Message, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { CronRepository } from "../../../../src/db/repositories/cronRepository";
import { GuildSettingsRepository } from "../../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../../src/db/schema";
import { createProposeCronJobTool } from "../../../../src/llm/tools/proposeCronJob";
import type { CronToolContext, IToolContext } from "../../../../src/llm/tools/registry";
import { CronService } from "../../../../src/services/cronService";
import { CronToolSession } from "../../../../src/services/cronToolContext";
import { SettingsService } from "../../../../src/services/settingsService";

const tool = createProposeCronJobTool();
const args = {
  name: "morning",
  schedule: "0 9 * * 1-5",
  prompt: "say hello",
  postOnlyWhenNotable: false,
};

describe("propose_cron_job tool", () => {
  const cron: CronToolContext = {
    channelType: ChannelType.GuildText,
    propose: mock(async () => '{"ok":true}'),
  };
  const context = (overrides: Partial<IToolContext> = {}): IToolContext => ({
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    cron,
    ...overrides,
  });

  test("is offered only with a cron window in a text, announcement, or public thread channel", () => {
    expect(tool.isEnabled(context())).toBe(true);
    expect(tool.isEnabled(context({ cron: undefined }))).toBe(false);
    expect(tool.isEnabled(context({ toolsAllowed: false }))).toBe(false);
    expect(tool.isEnabled(context({ guildId: null }))).toBe(false);
    for (const type of [ChannelType.GuildAnnouncement, ChannelType.PublicThread])
      expect(tool.isEnabled(context({ cron: { ...cron, channelType: type } }))).toBe(true);
    for (const type of [ChannelType.PrivateThread, ChannelType.GuildVoice, -1])
      expect(tool.isEnabled(context({ cron: { ...cron, channelType: type } }))).toBe(false);
  });

  test("validates arguments", () => {
    expect(tool.validate({ name: "n", schedule: "30m", prompt: "p" })).toEqual({
      ok: true,
      value: {
        name: "n",
        schedule: "30m",
        prompt: "p",
        postOnlyWhenNotable: false,
        webSearch: false,
      },
    });
    expect(tool.validate({ name: "", schedule: "30m", prompt: "p" }).ok).toBe(false);
    expect(tool.validate({ name: "x".repeat(51), schedule: "30m", prompt: "p" }).ok).toBe(false);
    expect(tool.validate({ name: "n", schedule: "30m", prompt: "p".repeat(2001) }).ok).toBe(false);
    expect(
      tool.validate({ name: "n", schedule: "30m", prompt: "p", post_only_when_notable: "yes" }).ok,
    ).toBe(false);
  });
});

describe("cron tool session", () => {
  let db: Database;
  let repo: CronRepository;
  let settings: SettingsService;
  let cron: CronService;
  let interpret: ReturnType<typeof mock>;
  let reply: ReturnType<typeof mock>;
  let fetchMember: ReturnType<typeof mock>;
  let manage: boolean;
  let trigger: Message<true>;
  beforeEach(async () => {
    db = new Database(":memory:");
    applyMigrations(db);
    repo = new CronRepository(db);
    settings = new SettingsService(new GuildSettingsRepository(db, "free/model"));
    await settings.setCronEnabled("guild", true);
    interpret = mock(async () => "30m");
    cron = new CronService(
      repo,
      settings,
      {
        generateScheduledResponse: mock(async () => ({ text: "", model: "m" })),
        interpretCronSchedule: interpret,
      },
      {
        resolve: mock(async () => ({
          parentId: null,
          send: mock(async () => {}),
          notifyPaused: mock(async () => {}),
        })),
      },
    );
    manage = true;
    reply = mock(async () => ({}));
    fetchMember = mock(async () => ({
      permissions: new PermissionsBitField(manage ? [PermissionFlagsBits.ManageGuild] : []),
      roles: { cache: new Map<string, unknown>() },
    }));
    trigger = {
      guildId: "guild",
      channelId: "channel",
      channel: { type: ChannelType.GuildText },
      author: { id: "user" },
      guild: { members: { fetch: fetchMember } },
      reply,
    } as unknown as Message<true>;
  });
  afterEach(async () => {
    await cron.stop();
    db.close();
  });
  const proposals = (): number =>
    (db.query("SELECT COUNT(*) AS c FROM cron_proposals").get() as { c: number }).c;

  test("posts one public card as a reply and allows one proposal per response", async () => {
    const session = new CronToolSession(trigger, cron, settings);
    const signal = new AbortController().signal;
    expect(JSON.parse(await session.propose(args, signal))).toEqual({
      ok: true,
      status: "awaiting_approval",
    });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain("cron:proposal:approve:");
    expect(JSON.parse(await session.propose(args, signal))).toEqual({
      ok: false,
      reason: "limit_reached",
    });
    expect(proposals()).toBe(1);
    expect(reply).toHaveBeenCalledTimes(1);
  });
  test("tool web_search true reaches the saved proposal", async () => {
    const tool = createProposeCronJobTool();
    const parsed = tool.validate({
      name: "news",
      schedule: "30m",
      prompt: "news",
      web_search: true,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const session = new CronToolSession(trigger, cron, settings);
    expect(JSON.parse(await session.propose(parsed.value, new AbortController().signal)).ok).toBe(
      true,
    );
    const stored = db
      .query<{ web_search: number }, []>("SELECT web_search FROM cron_proposals")
      .get();
    expect(stored?.web_search).toBe(1);
    // The guild has web search off: the first card says the search will not run yet, and
    // still shows what it would cost, since the guild can turn search on without a new card.
    const card = JSON.stringify(reply.mock.calls[0]?.[0]);
    expect(card).toContain("ギルドの設定が無効のため使われない");
    expect(card).toContain("ギルドの設定で Web 検索が有効になると: 検索の費用");
  });

  test("refused calls do not count, so the model can call again", async () => {
    const session = new CronToolSession(trigger, cron, settings);
    const signal = new AbortController().signal;
    const invalid = JSON.parse(await session.propose({ ...args, schedule: "* * * * * *" }, signal));
    expect(invalid.ok).toBe(false);
    expect(invalid.reason).toBe("invalid");
    manage = false;
    expect(JSON.parse(await session.propose(args, signal)).reason).toBe("permission_denied");
    manage = true;
    expect(JSON.parse(await session.propose(args, signal)).ok).toBe(true);
    expect(proposals()).toBe(1);
  });

  test("re-reads the requester's permissions on every call", async () => {
    const session = new CronToolSession(trigger, cron, settings);
    manage = false;
    await session.propose(args, new AbortController().signal);
    expect(fetchMember).toHaveBeenCalledWith({ user: "user", force: true, cache: false });
    expect(proposals()).toBe(0);
    expect(reply).not.toHaveBeenCalled();
  });

  test("disabling the guild mid-response stops the proposal and the schedule conversion", async () => {
    const session = new CronToolSession(trigger, cron, settings);
    await settings.setCronEnabled("guild", false);
    const result = JSON.parse(
      await session.propose({ ...args, schedule: "毎朝 9 時" }, new AbortController().signal),
    );
    expect(result).toEqual({ ok: false, reason: "disabled" });
    expect(interpret).not.toHaveBeenCalled();
    expect(fetchMember).not.toHaveBeenCalled();
    expect(proposals()).toBe(0);
  });

  test("a timeout while the schedule is being converted saves nothing and does not count", async () => {
    const session = new CronToolSession(trigger, cron, settings);
    const controller = new AbortController();
    let converting: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      converting = resolve;
    });
    // The converter answers only when its request is aborted, like a model that never replies.
    interpret.mockImplementation(
      (_guildId: string, _input: string, signal: AbortSignal) =>
        new Promise<string>((_, reject) => {
          converting();
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const pending = session.propose({ ...args, schedule: "毎朝 9 時" }, controller.signal);
    await started;
    controller.abort();
    expect(JSON.parse(await pending)).toEqual({ ok: false, reason: "cancelled" });
    expect(proposals()).toBe(0);
    expect(reply).not.toHaveBeenCalled();
    expect(JSON.parse(await session.propose(args, new AbortController().signal))).toEqual({
      ok: true,
      status: "awaiting_approval",
    });
    expect(proposals()).toBe(1);
  });

  test("an interruption after saving keeps the count and posts no card", async () => {
    const session = new CronToolSession(trigger, cron, settings);
    const controller = new AbortController();
    const save = repo.createProposal.bind(repo);
    const saved = spyOn(repo, "createProposal").mockImplementation((input) => {
      const proposal = save(input);
      controller.abort();
      return proposal;
    });
    const result = JSON.parse(await session.propose(args, controller.signal));
    saved.mockRestore();
    expect(result.reason).toBe("cancelled");
    expect(reply).not.toHaveBeenCalled();
    expect(proposals()).toBe(0);
    expect(JSON.parse(await session.propose(args, new AbortController().signal)).reason).toBe(
      "limit_reached",
    );
  });

  test("a channel outside the supported types is reported as unsupported", () => {
    const voice = {
      ...trigger,
      channel: { type: ChannelType.GuildVoice },
    } as unknown as Message<true>;
    expect(new CronToolSession(voice, cron, settings).channelType).toBe(-1);
  });
});
