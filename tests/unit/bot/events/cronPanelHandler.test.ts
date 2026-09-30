import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  ChannelType,
  type Interaction,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import {
  CRON_PROPOSAL_UNAVAILABLE_MESSAGE,
  CRON_STALE_MESSAGE,
} from "../../../../src/bot/events/cronPanelHandler";
import {
  type CommandHandlers,
  createInteractionCreateHandler,
} from "../../../../src/bot/events/interactionCreate";
import { type CronJob, CronRepository } from "../../../../src/db/repositories/cronRepository";
import { GuildSettingsRepository } from "../../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../../src/db/schema";
import type { IChatService } from "../../../../src/services/chatService";
import { CronService } from "../../../../src/services/cronService";
import type { IModelService } from "../../../../src/services/modelService";
import { SettingsService } from "../../../../src/services/settingsService";
import { CRON_INVALID_MESSAGE, cronCustomId } from "../../../../src/utils/cronPanel";
import { createMockLLMClient } from "../../../helpers/mockFactories";

const manager = {
  permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
  roleIds: [],
};

interface Options {
  kind?: "button" | "string" | "modal";
  values?: string[];
  user?: string;
  manage?: boolean;
  fields?: Record<string, string>;
}

function interaction(customId: string, options: Options = {}) {
  const kind = options.kind ?? "button";
  const fields = options.fields ?? {};
  const fixture = {
    customId,
    guildId: "guild",
    channelId: "here",
    channel: { type: ChannelType.GuildText },
    user: { id: options.user ?? "user" },
    values: options.values ?? [],
    member: { roles: [] as string[] },
    memberPermissions: new PermissionsBitField(
      options.manage === false ? [] : [PermissionFlagsBits.ManageGuild],
    ),
    fields: {
      getTextInputValue: (id: string): string => fields[id] ?? "",
      getStringSelectValues: (id: string): string[] => (fields[id] ? [fields[id]] : []),
      getSelectedChannels: (id: string) =>
        fields[id] ? { first: () => ({ id: fields[id] }) } : null,
    },
    isAutocomplete: () => false,
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "string",
    isChannelSelectMenu: () => false,
    isRoleSelectMenu: () => false,
    isModalSubmit: () => kind === "modal",
    // Panel modals are opened from the detail message.
    isFromMessage: () => kind === "modal",
    isChatInputCommand: () => false,
    replied: false,
    deferred: false,
    reply: mock(async (_payload: unknown): Promise<void> => {
      fixture.replied = true;
    }),
    followUp: mock(async (_payload: unknown): Promise<void> => {}),
    update: mock(async (_payload: unknown): Promise<void> => {
      fixture.replied = true;
    }),
    editReply: mock(async (_payload: unknown): Promise<void> => {}),
    deferUpdate: mock(async (): Promise<void> => {
      fixture.deferred = true;
    }),
    deferReply: mock(async (_options: unknown): Promise<void> => {
      fixture.deferred = true;
    }),
    showModal: mock(async (_modal: unknown): Promise<void> => {}),
  };
  return fixture;
}

type Fixture = ReturnType<typeof interaction>;

function text(payload: unknown): string {
  return JSON.stringify(payload);
}
function lastNotice(press: Fixture): string {
  const calls = [...press.reply.mock.calls, ...press.followUp.mock.calls];
  return text(calls.at(-1)?.[0]);
}

describe("cron panel interactions", () => {
  let db: Database;
  let repo: CronRepository;
  let settings: SettingsService;
  let cron: CronService;
  let generate: ReturnType<typeof mock>;
  let handler: (value: Interaction) => Promise<void>;
  beforeEach(async () => {
    db = new Database(":memory:");
    applyMigrations(db);
    repo = new CronRepository(db);
    settings = new SettingsService(new GuildSettingsRepository(db, "free/model"));
    await settings.setCronEnabled("guild", true);
    generate = mock(async () => ({ text: "hello", model: "free/model" }));
    cron = new CronService(
      repo,
      settings,
      {
        generateScheduledResponse: generate,
        interpretCronSchedule: mock(async () => "30m"),
      },
      {
        resolve: mock(async () => ({
          parentId: null,
          send: mock(async () => {}),
          notifyPaused: mock(async () => {}),
        })),
      },
    );
    handler = createInteractionCreateHandler(
      {} as CommandHandlers,
      settings,
      {} as IModelService,
      createMockLLMClient(),
      {} as IChatService,
      "perplexity",
      cron,
    );
  });
  afterEach(async () => {
    await cron.stop();
    db.close();
  });

  async function add(userId = "user", schedule = "30m"): Promise<CronJob> {
    const proposal = await cron.createProposal(
      {
        guildId: "guild",
        channelId: "channel",
        userId,
        name: `job of ${userId}`,
        prompt: "prompt",
        schedule,
        silent: false,
      },
      manager,
    );
    if (!proposal.ok) throw new Error(proposal.reason);
    const approved = await cron.approveProposal(
      proposal.value.proposal.id,
      "guild",
      userId,
      manager,
    );
    if (!approved.ok) throw new Error(approved.reason);
    return approved.value;
  }
  async function press(customId: string, options?: Options): Promise<Fixture> {
    const fixture = interaction(customId, options);
    await handler(fixture as unknown as Interaction);
    return fixture;
  }

  test.each(["cron:unknown", "cron:pause:x:1", "cron:proposal:maybe:1"])(
    "answers an unreadable custom id %s with the invalid notice",
    async (customId) => {
      const fixture = await press(customId);
      expect(lastNotice(fixture)).toContain(CRON_INVALID_MESSAGE.slice(0, 10));
      expect(fixture.update).not.toHaveBeenCalled();
    },
  );

  test("a missing job is invalid", async () => {
    const fixture = await press(cronCustomId({ action: "pause", jobId: 99, version: 1 }));
    expect(lastNotice(fixture)).toContain("この操作は無効です");
  });

  test("a version mismatch redraws the detail without acting", async () => {
    const job = await add();
    const fixture = await press(
      cronCustomId({ action: "pause", jobId: job.id, version: job.version + 1 }),
    );
    expect(repo.getJob(job.id)?.status).toBe("active");
    expect(text(fixture.update.mock.calls[0]?.[0])).toContain(
      `cron:pause:${job.id}:${job.version}`,
    );
    expect(lastNotice(fixture)).toContain(CRON_STALE_MESSAGE.slice(0, 20));
  });

  test("pause and resume raise the version and redraw", async () => {
    const job = await add();
    await press(cronCustomId({ action: "pause", jobId: job.id, version: job.version }));
    const paused = repo.getJob(job.id);
    expect(paused?.status).toBe("paused");
    expect(paused?.version).toBe(job.version + 1);
    await press(cronCustomId({ action: "resume", jobId: job.id, version: job.version + 1 }));
    expect(repo.getJob(job.id)?.status).toBe("active");
  });

  test("delete asks to confirm before removing the job", async () => {
    const job = await add();
    const first = await press(
      cronCustomId({ action: "delete", jobId: job.id, version: job.version }),
    );
    expect(text(first.update.mock.calls[0]?.[0])).toContain("削除を確定");
    expect(repo.getJob(job.id)).not.toBeNull();
    const second = await press(
      cronCustomId({ action: "confirm-delete", jobId: job.id, version: job.version }),
    );
    expect(repo.getJob(job.id)).toBeNull();
    expect(text(second.update.mock.calls[0]?.[0])).toContain("定期実行（0 件）");
  });

  test("the list shows every job to a manager and only their own to others", async () => {
    await add("user");
    await add("other");
    const managerList = await press(cronCustomId({ action: "list", page: 0 }));
    expect(text(managerList.update.mock.calls[0]?.[0])).toContain("定期実行（2 件）");
    const ownList = await press(cronCustomId({ action: "list", page: 0 }), { manage: false });
    const own = text(ownList.update.mock.calls[0]?.[0]);
    expect(own).toContain("定期実行（1 件）");
    expect(own).toContain("job of user");
    expect(own).not.toContain("job of other");
  });

  test("another member without permission cannot open someone else's job", async () => {
    const job = await add("other");
    const fixture = await press(cronCustomId({ action: "select", page: 0 }), {
      kind: "string",
      values: [String(job.id)],
      manage: false,
    });
    expect(lastNotice(fixture)).toContain("この操作は無効です");
  });

  test("the registrant may pause and delete without permission, but not resume", async () => {
    const job = await add("user");
    await press(cronCustomId({ action: "pause", jobId: job.id, version: job.version }), {
      manage: false,
    });
    expect(repo.getJob(job.id)?.status).toBe("paused");
    const resume = await press(
      cronCustomId({ action: "resume", jobId: job.id, version: job.version + 1 }),
      { manage: false },
    );
    expect(repo.getJob(job.id)?.status).toBe("paused");
    expect(lastNotice(resume)).toContain("サーバーの管理");
  });

  test("a disabled guild keeps list, pause and delete but refuses add, edit, run and resume", async () => {
    const job = await add();
    await settings.setCronEnabled("guild", false);
    const list = await press(cronCustomId({ action: "list", page: 0 }));
    expect(text(list.update.mock.calls[0]?.[0])).toContain("定期実行（1 件）");
    for (const customId of [
      cronCustomId({ action: "new" }),
      cronCustomId({ action: "edit", jobId: job.id, version: job.version }),
      cronCustomId({ action: "run", jobId: job.id, version: job.version }),
    ]) {
      const refused = await press(customId);
      expect(refused.showModal).not.toHaveBeenCalled();
      expect(lastNotice(refused)).toContain("定期実行が無効です");
    }
    expect(generate).not.toHaveBeenCalled();
    await press(cronCustomId({ action: "pause", jobId: job.id, version: job.version }));
    expect(repo.getJob(job.id)?.status).toBe("paused");
    const resume = await press(
      cronCustomId({ action: "resume", jobId: job.id, version: job.version + 1 }),
    );
    expect(repo.getJob(job.id)?.status).toBe("paused");
    expect(lastNotice(resume)).toContain("定期実行が無効です");
    await press(cronCustomId({ action: "delete", jobId: job.id, version: job.version + 1 }));
    await press(
      cronCustomId({ action: "confirm-delete", jobId: job.id, version: job.version + 1 }),
    );
    expect(repo.getJob(job.id)).toBeNull();
  });

  test("add opens the modal defaulting to this channel", async () => {
    const fixture = await press(cronCustomId({ action: "new" }));
    const modal = text(fixture.showModal.mock.calls[0]?.[0]);
    expect(modal).toContain("cron:modal:new");
    expect(modal).toContain('"id":"here"');
  });

  test("a modal submission answers with an ephemeral confirmation card", async () => {
    const fixture = await press("cron:modal:new", {
      kind: "modal",
      fields: {
        name: "morning",
        schedule: "0 9 * * 1-5",
        prompt: "say hello",
        channel: "channel",
        silent: "notable",
      },
    });
    expect(fixture.deferReply).toHaveBeenCalledTimes(1);
    const card = text(fixture.editReply.mock.calls[0]?.[0]);
    expect(card).toContain("cron:proposal:approve:");
    expect(card).toContain("毎週平日 9:00");
    expect(card).toContain("伝えることがあるときだけ投稿する");
  });

  test("a modal submission with an invalid schedule answers with the reason", async () => {
    const fixture = await press("cron:modal:new", {
      kind: "modal",
      fields: { name: "n", schedule: "* * * * * *", prompt: "p", channel: "channel" },
    });
    expect(text(fixture.editReply.mock.calls[0]?.[0])).toContain("5 フィールド");
    expect(db.query("SELECT COUNT(*) AS c FROM cron_proposals").get()).toEqual({ c: 0 });
  });

  async function proposal(userId = "user"): Promise<number> {
    const created = await cron.createProposal(
      {
        guildId: "guild",
        channelId: "channel",
        userId,
        name: "n",
        prompt: "p",
        schedule: "30m",
        silent: false,
      },
      manager,
    );
    if (!created.ok) throw new Error(created.reason);
    return created.value.proposal.id;
  }

  test("only the proposer can approve, and a second press finds nothing", async () => {
    const id = await proposal("user");
    const approve = cronCustomId({
      action: "proposal",
      decision: "approve",
      proposalId: id,
      shownWebSearch: false,
    });
    const stranger = await press(approve, { user: "other" });
    expect(lastNotice(stranger)).toContain(CRON_PROPOSAL_UNAVAILABLE_MESSAGE.slice(0, 15));
    expect(repo.listJobs("guild")).toHaveLength(0);
    const owner = await press(approve);
    expect(text(owner.editReply.mock.calls[0]?.[0])).toContain("登録しました");
    expect(repo.listJobs("guild")).toHaveLength(1);
    const again = await press(approve);
    expect(text(again.update.mock.calls[0]?.[0])).toContain("この提案は無効か期限切れです");
    expect(repo.listJobs("guild")).toHaveLength(1);
  });
  test("old approval id redraws without registering", async () => {
    const id = await proposal();
    const fixture = await press(`cron:proposal:approve:${id}`);
    expect(repo.listJobs("guild")).toHaveLength(0);
    expect(text(fixture.update.mock.calls[0]?.[0])).toContain(`cron:proposal:approve:${id}:0`);
  });
  test("proposal search toggle changes the card and requires its shown value", async () => {
    const created = await cron.createProposal(
      {
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        name: "daily",
        prompt: "news",
        schedule: "0 9 * * *",
        silent: false,
      },
      manager,
    );
    if (!created.ok) throw new Error(created.reason);
    const id = created.value.proposal.id;
    const first = await press(`cron:proposal:search:${id}:0`);
    expect(repo.getProposal(id)?.webSearch).toBe(true);
    expect(text(first.update.mock.calls[0]?.[0])).toContain(`cron:proposal:approve:${id}:1`);
    expect(text(first.update.mock.calls[0]?.[0])).toContain("次回から 3 回分");
    const stale = await press(`cron:proposal:search:${id}:0`);
    expect(repo.getProposal(id)?.webSearch).toBe(true);
    expect(lastNotice(stale)).toContain("提案が変更されました");
  });
  test("a search proposal explains when the guild setting is off", async () => {
    const id = await proposal();
    const first = await press(`cron:proposal:search:${id}:0`);
    expect(text(first.update.mock.calls[0]?.[0])).toContain("ギルドの設定が無効のため使われない");
  });
  test("job search enable requires confirmation and bumps version", async () => {
    const job = await add();
    const first = await press(`cron:search-on:${job.id}:${job.version}`);
    expect(repo.getJob(job.id)?.webSearch).toBe(false);
    expect(text(first.update.mock.calls[0]?.[0])).toContain("Web 検索をオンにする（確定）");
    const second = await press(`cron:confirm-search-on:${job.id}:${job.version}`);
    expect(repo.getJob(job.id)).toMatchObject({ webSearch: true, version: job.version + 1 });
    expect(text(second.update.mock.calls[0]?.[0])).toContain("Web 検索:** オン");
  });

  test("a card whose proposal the ticker dropped loses its buttons, whoever presses it", async () => {
    const id = await proposal("user");
    repo.deleteExpiredProposals(Date.now() + 25 * 60 * 60_000);
    const fixture = await press(
      cronCustomId({
        action: "proposal",
        decision: "approve",
        proposalId: id,
        shownWebSearch: false,
      }),
      { user: "other" },
    );
    const card = text(fixture.update.mock.calls[0]?.[0]);
    expect(card).toContain("この提案は無効か期限切れです");
    expect(card).not.toContain("cron:proposal:");
    expect(fixture.reply).not.toHaveBeenCalled();
    expect(repo.listJobs("guild")).toHaveLength(0);
  });

  test("a proposal that lapses while its approval waits loses its buttons", async () => {
    const id = await proposal("user");
    const approve = spyOn(cron, "approveProposal").mockImplementation(async () => {
      repo.deleteExpiredProposals(Date.now() + 25 * 60 * 60_000);
      return { ok: false, reason: "提案が無効か期限切れです。" };
    });
    const fixture = await press(
      cronCustomId({
        action: "proposal",
        decision: "approve",
        proposalId: id,
        shownWebSearch: false,
      }),
    );
    approve.mockRestore();
    const card = text(fixture.editReply.mock.calls[0]?.[0]);
    expect(card).toContain("この提案は無効か期限切れです");
    expect(card).not.toContain("cron:proposal:");
    expect(lastNotice(fixture)).toContain("提案が無効か期限切れです");
    expect(repo.listJobs("guild")).toHaveLength(0);
  });

  test("a proposer without permission cannot approve", async () => {
    const id = await proposal("user");
    const fixture = await press(
      cronCustomId({
        action: "proposal",
        decision: "approve",
        proposalId: id,
        shownWebSearch: false,
      }),
      { manage: false },
    );
    expect(lastNotice(fixture)).toContain("サーバーの管理");
    expect(repo.listJobs("guild")).toHaveLength(0);
    expect(repo.getProposal(id)).not.toBeNull();
  });

  test("approval is refused in a disabled guild", async () => {
    const id = await proposal("user");
    await settings.setCronEnabled("guild", false);
    const fixture = await press(
      cronCustomId({ action: "proposal", decision: "approve", proposalId: id }),
    );
    expect(lastNotice(fixture)).toContain("定期実行が無効");
    expect(repo.listJobs("guild")).toHaveLength(0);
  });

  test("reject removes the proposal and the buttons", async () => {
    const id = await proposal("user");
    const fixture = await press(
      cronCustomId({ action: "proposal", decision: "reject", proposalId: id }),
    );
    const card = text(fixture.update.mock.calls[0]?.[0]);
    expect(card).toContain("取り消しました");
    expect(card).not.toContain("cron:proposal:");
    expect(repo.getProposal(id)).toBeNull();
  });

  test("an edit modal for a changed version redraws the detail and saves nothing", async () => {
    const job = await add();
    const fixture = await press(`cron:modal:edit:${job.id}:${job.version + 1}`, {
      kind: "modal",
      fields: { name: "n", schedule: "毎朝", prompt: "p", channel: "channel", silent: "always" },
    });
    expect(text(fixture.update.mock.calls[0]?.[0])).toContain(
      `cron:pause:${job.id}:${job.version}`,
    );
    expect(lastNotice(fixture)).toContain(CRON_STALE_MESSAGE.slice(0, 20));
    expect(fixture.deferReply).not.toHaveBeenCalled();
    expect(db.query("SELECT COUNT(*) AS c FROM cron_proposals").get()).toEqual({ c: 0 });
  });

  test("an edit modal for a one-off job that has run redraws the detail before deferring", async () => {
    const job = await add("user", new Date(Date.now() + 60 * 60_000).toISOString());
    repo.consume(job, null, Date.now());
    expect(repo.getJob(job.id)).toMatchObject({ status: "done", version: job.version });
    const fixture = await press(`cron:modal:edit:${job.id}:${job.version}`, {
      kind: "modal",
      fields: { name: "n", schedule: "1h", prompt: "p", channel: "channel", silent: "always" },
    });
    expect(fixture.deferReply).not.toHaveBeenCalled();
    const panel = text(fixture.update.mock.calls[0]?.[0]);
    expect(panel).toContain(`cron:run:${job.id}:${job.version}`);
    expect(panel).not.toContain(`cron:edit:${job.id}`);
    expect(lastNotice(fixture)).toContain(CRON_STALE_MESSAGE.slice(0, 20));
    expect(db.query("SELECT COUNT(*) AS c FROM cron_proposals").get()).toEqual({ c: 0 });
  });

  test("an edit modal whose job changes after deferring answers only in the reply", async () => {
    const job = await add();
    const fixture = interaction(`cron:modal:edit:${job.id}:${job.version}`, {
      kind: "modal",
      fields: { name: "n", schedule: "1h", prompt: "p", channel: "channel", silent: "always" },
    });
    fixture.deferReply.mockImplementation(async () => {
      repo.setStatus(job.id, job.version, "paused", null, Date.now());
      fixture.deferred = true;
    });
    await handler(fixture as unknown as Interaction);
    expect(db.query("SELECT COUNT(*) AS c FROM cron_proposals").get()).toEqual({ c: 0 });
    const reply = text(fixture.editReply.mock.calls[0]?.[0]);
    expect(reply).toContain(CRON_STALE_MESSAGE.slice(0, 20));
    expect(reply).not.toContain(`cron:resume:${job.id}`);
    expect(fixture.update).not.toHaveBeenCalled();
  });

  test("run now that meets a changed version redraws the detail", async () => {
    const job = await add();
    const run = cron.runNow.bind(cron);
    cron.runNow = mock(async (...args: Parameters<CronService["runNow"]>) => {
      repo.setStatus(job.id, job.version, "paused", null, Date.now());
      return run(...args);
    });
    const fixture = await press(
      cronCustomId({ action: "run", jobId: job.id, version: job.version }),
    );
    expect(generate).not.toHaveBeenCalled();
    expect(text(fixture.editReply.mock.calls[0]?.[0])).toContain(
      `cron:resume:${job.id}:${job.version + 1}`,
    );
    expect(lastNotice(fixture)).toContain(CRON_STALE_MESSAGE.slice(0, 20));
  });
});
