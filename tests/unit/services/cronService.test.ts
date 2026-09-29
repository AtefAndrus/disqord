import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { PermissionFlagsBits, PermissionsBitField, RESTJSONErrorCodes } from "discord.js";
import { type CronJob, CronRepository } from "../../../src/db/repositories/cronRepository";
import { GuildSettingsRepository } from "../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../src/db/schema";
import { CronService, type ICronChat, type ICronDelivery } from "../../../src/services/cronService";
import { SettingsService } from "../../../src/services/settingsService";

const START = Date.parse("2026-09-29T00:00:00Z");
const actor = {
  permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
  roleIds: [],
};

describe("cron service", () => {
  let db: Database;
  let repo: CronRepository;
  let settings: SettingsService;
  let now: number;
  let send: ReturnType<typeof mock>;
  let notify: ReturnType<typeof mock>;
  let generate: ReturnType<typeof mock>;
  let resolve: ReturnType<typeof mock>;
  let service: CronService;
  beforeEach(async () => {
    db = new Database(":memory:");
    applyMigrations(db);
    repo = new CronRepository(db);
    settings = new SettingsService(new GuildSettingsRepository(db, "free/model"));
    await settings.setCronEnabled("guild", true);
    now = START;
    send = mock(async () => {});
    notify = mock(async () => {});
    generate = mock(async () => ({ text: "hello", model: "free/model" }));
    resolve = mock(async () => ({ parentId: null, send, notifyPaused: notify }));
    service = new CronService(
      repo,
      settings,
      {
        generateScheduledResponse: generate,
        interpretCronSchedule: mock(async () => "30m"),
      } satisfies ICronChat,
      { resolve } satisfies ICronDelivery,
      () => now,
    );
  });
  afterEach(async () => {
    await service.stop();
    db.close();
  });
  async function add(schedule = "5m", silent = false): Promise<CronJob> {
    const p = await service.createProposal(
      {
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        name: "name",
        prompt: "prompt",
        schedule,
        silent,
      },
      actor,
    );
    if (!p.ok) throw new Error(p.reason);
    const approved = await service.approveProposal(p.value.proposal.id, "guild", "user", actor);
    if (!approved.ok) throw new Error(approved.reason);
    return approved.value;
  }
  test("tick consumes time before model call and retains five minute cadence", async () => {
    const job = await add();
    now += 5 * 60_000 + 20_000;
    generate.mockImplementation(async () => {
      expect(repo.getJob(job.id)?.nextRunAt).toBe(now + 5 * 60_000);
      expect(repo.getJob(job.id)?.lastRunAt).toBe(now);
      return { text: "hello", model: "free/model" };
    });
    await service.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(repo.getJob(job.id)?.failCount).toBe(0);
  });
  test("disabled guild skips a due run without calling the model", async () => {
    const job = await add();
    const once = await add("2026-09-29T00:05:00Z");
    await settings.setCronEnabled("guild", false);
    now += 5 * 60_000;
    await service.tick();
    expect(generate).not.toHaveBeenCalled();
    expect(repo.getJob(job.id)?.lastRunAt).toBeNull();
    expect(repo.getJob(job.id)?.nextRunAt).toBeGreaterThan(now);
    expect(repo.getJob(once.id)?.status).toBe("done");
    expect(repo.getJob(once.id)?.nextRunAt).toBeNull();
  });
  test("startup skips old interval and marks old once done, preserving lastRunAt", async () => {
    const recurring = await add();
    const once = await add("2026-09-29T00:05:00Z");
    now += 16 * 60_000;
    await service.catchUpOnStartup();
    expect(repo.getJob(recurring.id)?.nextRunAt).toBeGreaterThan(now);
    expect(repo.getJob(once.id)?.status).toBe("done");
    expect(repo.getJob(once.id)?.lastRunAt).toBeNull();
  });
  test("a run inside the ten minute grace executes once", async () => {
    await add();
    now += 9 * 60_000;
    await service.catchUpOnStartup();
    await service.tick();
    expect(generate).toHaveBeenCalledTimes(1);
  });
  test("SILENT is a success without a post", async () => {
    const job = await add("5m", true);
    now += 5 * 60_000;
    generate.mockImplementation(async () => ({ text: "[SILENT]", model: "free/model" }));
    await service.tick();
    expect(send).not.toHaveBeenCalled();
    expect(repo.getJob(job.id)?.failCount).toBe(0);
  });
  test("later page failure does not count as a failed execution", async () => {
    const job = await add();
    now += 5 * 60_000;
    generate.mockImplementation(async () => ({
      text: "long text ".repeat(900),
      model: "free/model",
    }));
    let page = 0;
    send.mockImplementation(async () => {
      if (++page === 2) throw new Error("page two failed");
    });
    await service.tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(repo.getJob(job.id)?.failCount).toBe(0);
  });
  test("first page failures accumulate and pause after three attempts", async () => {
    const job = await add();
    send.mockImplementation(async () => {
      throw new Error("send failed");
    });
    for (let i = 0; i < 3; i++) {
      now += 5 * 60_000;
      await service.tick();
    }
    expect(repo.getJob(job.id)?.status).toBe("paused");
    expect(repo.getJob(job.id)?.failCount).toBe(3);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  test("Unknown Channel deletes jobs and proposals for that destination", async () => {
    const job = await add();
    const pending = await service.createProposal(
      {
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        name: "pending",
        prompt: "prompt",
        schedule: "5m",
        silent: false,
      },
      actor,
    );
    if (!pending.ok) throw new Error(pending.reason);
    resolve.mockImplementation(async () => {
      throw { code: RESTJSONErrorCodes.UnknownChannel };
    });
    now += 5 * 60_000;
    await service.tick();
    expect(repo.getJob(job.id)).toBeNull();
    expect(repo.getProposal(pending.value.proposal.id)).toBeNull();
  });
  test("a schedule conversion cannot save a proposal after the guild is disabled", async () => {
    service = new CronService(
      repo,
      settings,
      {
        generateScheduledResponse: generate,
        interpretCronSchedule: async () => {
          await settings.setCronEnabled("guild", false);
          return "5m";
        },
      },
      { resolve },
      () => now,
    );
    const result = await service.createProposal(
      {
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        name: "name",
        prompt: "prompt",
        schedule: "毎朝九時",
        silent: false,
      },
      actor,
    );
    expect(result.ok).toBe(false);
    expect(repo.listJobs("guild")).toHaveLength(0);
  });
  test("an already aborted proposal does not call schedule interpretation or save", async () => {
    const interpret = mock(async () => "30m");
    service = new CronService(
      repo,
      settings,
      { generateScheduledResponse: generate, interpretCronSchedule: interpret },
      { resolve },
      () => now,
    );
    const controller = new AbortController();
    controller.abort();
    const result = await service.createProposal(
      {
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        name: "name",
        prompt: "prompt",
        schedule: "every weekday morning",
        silent: false,
        signal: controller.signal,
      },
      actor,
    );
    expect(result).toEqual({
      ok: false,
      reason: "スケジュールを解釈できませんでした: 中断されました。",
    });
    expect(interpret).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
  test("schedule interpretation uses the caller signal and stops at sixty seconds without saving", async () => {
    const interpret = mock(
      (_guildId: string, _input: string, _signal?: AbortSignal) => new Promise<string>(() => {}),
    );
    service = new CronService(
      repo,
      settings,
      { generateScheduledResponse: generate, interpretCronSchedule: interpret },
      { resolve },
      () => now,
    );
    const controller = new AbortController();
    const original = globalThis.setTimeout;
    globalThis.setTimeout = ((...args: Parameters<typeof original>) => {
      const [handler, delay, ...rest] = args;
      return original(handler, delay === 60_000 ? 0 : delay, ...rest);
    }) as typeof globalThis.setTimeout;
    try {
      const result = await service.createProposal(
        {
          guildId: "guild",
          channelId: "channel",
          userId: "user",
          name: "name",
          prompt: "prompt",
          schedule: "every weekday morning",
          silent: false,
          signal: controller.signal,
        },
        actor,
      );
      expect(result.ok).toBe(false);
      const passedSignal = interpret.mock.calls[0]?.[2];
      expect(passedSignal).toBeInstanceOf(AbortSignal);
      expect(passedSignal?.aborted).toBe(true);
      expect(
        db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM cron_proposals").get()
          ?.count,
      ).toBe(0);
    } finally {
      globalThis.setTimeout = original;
    }
  });
  test("aborting the caller during interpretation returns without saving", async () => {
    const controller = new AbortController();
    const interpret = mock(() => {
      controller.abort();
      return new Promise<string>(() => {});
    });
    service = new CronService(
      repo,
      settings,
      { generateScheduledResponse: generate, interpretCronSchedule: interpret },
      { resolve },
      () => now,
    );
    const result = await service.createProposal(
      {
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        name: "name",
        prompt: "prompt",
        schedule: "every weekday morning",
        silent: false,
        signal: controller.signal,
      },
      actor,
    );
    expect(result.ok).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM cron_proposals").get()?.count,
    ).toBe(0);
  });
  test("an abort after destination resolution prevents generation", async () => {
    const job = await add();
    resolve.mockImplementation(async () => {
      void service.stop();
      return { parentId: null, send, notifyPaused: notify };
    });
    now += 5 * 60_000;
    await service.tick();
    expect(generate).not.toHaveBeenCalled();
    expect(repo.getJob(job.id)?.failCount).toBe(0);
  });
  test("a manual run starting during settings lookup leaves the due time unconsumed", async () => {
    const job = await add();
    now += 5 * 60_000;
    const dueTime = repo.getJob(job.id)?.nextRunAt;
    const original = settings.getGuildSettings.bind(settings);
    let releaseSettings: (() => void) | undefined;
    let block = true;
    settings.getGuildSettings = mock(async (guildId: string) => {
      if (block) {
        block = false;
        await new Promise<void>((resolvePromise) => {
          releaseSettings = resolvePromise;
        });
      }
      return original(guildId);
    });
    let releaseGeneration: (() => void) | undefined;
    generate.mockImplementation(
      () =>
        new Promise((resolvePromise) => {
          releaseGeneration = () => resolvePromise({ text: "hello", model: "free/model" });
        }),
    );
    const tick = service.tick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    const manual = service.runNow(job.id, "guild", actor, job.version);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    releaseSettings?.();
    await tick;
    expect(repo.getJob(job.id)?.nextRunAt).toBe(dueTime);
    expect(repo.getJob(job.id)?.lastRunAt).toBeNull();
    releaseGeneration?.();
    await manual;
  });
  test("an invalid due expression is logged and the next job still runs", async () => {
    const broken = await add();
    const valid = await add();
    db.query("UPDATE cron_jobs SET expr='bad expression' WHERE id=?").run(broken.id);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      now += 5 * 60_000;
      await service.tick();
      expect(consoleError).toHaveBeenCalled();
      expect(generate).toHaveBeenCalledTimes(1);
      expect(generate.mock.calls[0]?.[0]).toMatchObject({ id: valid.id });
    } finally {
      consoleError.mockRestore();
    }
  });
  test("a scheduled version change during generation prevents post and outcome writes", async () => {
    const job = await add();
    const success = spyOn(repo, "saveSuccess");
    const failure = spyOn(repo, "saveFailure");
    generate.mockImplementation(async () => {
      repo.setStatus(job.id, job.version, "paused", null, now);
      return { text: "hello", model: "free/model" };
    });
    now += 5 * 60_000;
    await service.tick();
    expect(send).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  });
  test("a generation timeout records one failure", async () => {
    const job = await add();
    const original = globalThis.setTimeout;
    globalThis.setTimeout = ((...args: Parameters<typeof original>) => {
      const [handler, delay, ...rest] = args;
      return original(handler, delay === 120_000 ? 0 : delay, ...rest);
    }) as typeof globalThis.setTimeout;
    generate.mockImplementation(() => new Promise(() => {}));
    try {
      now += 5 * 60_000;
      await service.tick();
      expect(repo.getJob(job.id)?.failCount).toBe(1);
      expect(repo.getJob(job.id)?.lastError).toContain("タイムアウト");
    } finally {
      globalThis.setTimeout = original;
    }
  });
  test("run now preserves all scheduling and failure fields", async () => {
    const job = await add();
    repo.saveFailure(job.id, job.version, now, "previous failure");
    const before = repo.getJob(job.id);
    expect((await service.runNow(job.id, "guild", actor, job.version)).ok).toBe(true);
    const after = repo.getJob(job.id);
    for (const field of ["nextRunAt", "lastRunAt", "failCount", "lastError", "status"] as const)
      expect(after?.[field]).toBe(before?.[field]);
  });
  test("stop during a scheduled generation does not record failure", async () => {
    const job = await add();
    generate.mockImplementation(
      async (_job: CronJob, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    now += 5 * 60_000;
    const tick = service.tick();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    await service.stop();
    await tick;
    expect(repo.getJob(job.id)?.failCount).toBe(0);
  });
  test("pause, resume, edit and deletion invalidate a running version before posting", async () => {
    for (const operation of ["pause", "resume", "edit", "delete"] as const) {
      const job = await add();
      let release: (() => void) | undefined;
      generate.mockImplementation(
        () =>
          new Promise((resolvePromise) => {
            release = () => resolvePromise({ text: "hello", model: "free/model" });
          }),
      );
      const execution = service.runNow(job.id, "guild", actor, job.version);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
      if (operation === "pause")
        await service.pauseJob(job.id, "guild", "user", actor, job.version);
      if (operation === "resume") {
        await service.pauseJob(job.id, "guild", "user", actor, job.version);
        await service.resumeJob(job.id, "guild", actor, job.version + 1);
      }
      if (operation === "edit") {
        const p = await service.createProposal(
          {
            guildId: "guild",
            channelId: "channel",
            userId: "user",
            name: "new",
            prompt: "new",
            schedule: "5m",
            silent: false,
            targetJobId: job.id,
            targetVersion: job.version,
          },
          actor,
        );
        if (!p.ok) throw new Error(p.reason);
        await service.approveProposal(p.value.proposal.id, "guild", "user", actor);
      }
      if (operation === "delete")
        await service.deleteJob(job.id, "guild", "user", actor, job.version);
      release?.();
      await execution;
      expect(send).not.toHaveBeenCalled();
    }
  });
  test("stop aborts work and prevents a new manual run", async () => {
    const job = await add();
    generate.mockImplementation(
      async (_job: CronJob, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const execution = service.runNow(job.id, "guild", actor, job.version);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    await service.stop();
    await execution;
    expect((await service.runNow(job.id, "guild", actor, job.version)).ok).toBe(false);
    now += 5 * 60_000;
    await service.tick();
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
