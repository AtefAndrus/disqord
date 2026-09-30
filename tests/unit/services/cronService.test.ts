import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { PermissionFlagsBits, PermissionsBitField, RESTJSONErrorCodes } from "discord.js";
import { type CronJob, CronRepository } from "../../../src/db/repositories/cronRepository";
import { GuildSettingsRepository } from "../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../src/db/schema";
import { WebSearchFailedError } from "../../../src/errors";
import { ToolRegistry } from "../../../src/llm/tools/registry";
import { ChatService } from "../../../src/services/chatService";
import {
  buildScheduledPages,
  CronService,
  type ICronChat,
  type ICronDelivery,
  startCronService,
} from "../../../src/services/cronService";
import { ModelService } from "../../../src/services/modelService";
import { SettingsService } from "../../../src/services/settingsService";
import {
  MAX_TOTAL_BYTES_PER_MESSAGE,
  MAX_TOTAL_CHARS_PER_MESSAGE,
} from "../../../src/utils/chatContainerBuilder";
import { createMockLLMClient, createMockTweetService } from "../../helpers/mockFactories";

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
  test("modal edit inherits the job search value and approval keeps it", async () => {
    const job = await add();
    const enabled = await service.setJobWebSearch(job.id, "guild", actor, job.version, true);
    if (!enabled.ok) throw new Error(enabled.reason);
    const edit = await service.createProposal(
      {
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        name: "renamed",
        prompt: "prompt",
        schedule: "5m",
        silent: false,
        targetJobId: job.id,
        targetVersion: enabled.value.version,
      },
      actor,
    );
    if (!edit.ok) throw new Error(edit.reason);
    expect(edit.value.proposal.webSearch).toBe(true);
    const approved = await service.approveProposal(
      edit.value.proposal.id,
      "guild",
      "user",
      actor,
      true,
    );
    expect(approved.ok && approved.value.webSearch).toBe(true);
  });
  test("search setting changes only an editable job at its current version", async () => {
    const job = await add();
    const changed = await service.setJobWebSearch(job.id, "guild", actor, job.version, true);
    expect(changed.ok).toBe(true);
    expect(repo.getJob(job.id)).toMatchObject({ webSearch: true, version: job.version + 1 });
    expect((await service.setJobWebSearch(job.id, "guild", actor, job.version, false)).ok).toBe(
      false,
    );
    const once = await add("2026-09-29T00:05:00Z");
    db.query("UPDATE cron_jobs SET status='done',next_run_at=NULL WHERE id=?").run(once.id);
    expect((await service.setJobWebSearch(once.id, "guild", actor, once.version, true)).ok).toBe(
      false,
    );
  });
  test("search failure notice is on page one and links survive the five-page cut", () => {
    const pages = buildScheduledPages(
      "news",
      "本文".repeat(12_000),
      "free/model",
      { showDetails: false },
      { notice: "検索なしで回答しました", links: "-# 検索結果\n- [source](<https://example.com>)" },
    );
    expect(pages).toHaveLength(5);
    const first = JSON.stringify(pages[0]?.toJSON());
    const last = JSON.stringify(pages.at(-1)?.toJSON());
    expect(first).toContain("定期実行「news」\\n検索なしで回答しました");
    expect(last).toContain("-# 検索結果");
    expect(last).toContain("https://example.com");
  });
  test("links that do not fit the last page split the body again within the page limits", () => {
    const texts = (node: unknown): string[] => {
      if (Array.isArray(node)) return node.flatMap(texts);
      if (typeof node !== "object" || node === null) return [];
      const record = node as Record<string, unknown>;
      return [
        ...(typeof record.content === "string" ? [record.content] : []),
        ...Object.values(record).flatMap(texts),
      ];
    };
    const links = `-# 検索結果\n${Array.from({ length: 5 }, (_, i) => `- [${"t".repeat(80)} (example.com)](<https://example.com/${"p".repeat(250)}${i}>)`).join("\n")}`;
    const metadata = { showDetails: false };
    // Two pages without links, the second nearly full, so the links cannot join it.
    const body = "漢".repeat(5_500);
    expect(buildScheduledPages("news", body, "free/model", metadata)).toHaveLength(2);
    const pages = buildScheduledPages("news", body, "free/model", metadata, { links });
    for (const page of pages) {
      const content = texts(page.toJSON()).join("");
      expect(content.length).toBeLessThanOrEqual(MAX_TOTAL_CHARS_PER_MESSAGE);
      expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(
        MAX_TOTAL_BYTES_PER_MESSAGE,
      );
    }
    expect(JSON.stringify(pages.at(-1)?.toJSON())).toContain("https://example.com/");
  });
  test("body fitting in five pages without search still fits with short links", () => {
    const metadata = { showDetails: false };
    const links = "-# 検索結果\n- [source](<https://example.com>)";
    const body = "x".repeat(18_500);
    expect(buildScheduledPages("news", body, "free/model", metadata)).toHaveLength(5);
    const pages = buildScheduledPages("news", body, "free/model", metadata, { links });
    expect(pages).toHaveLength(5);
    expect(JSON.stringify(pages[4]?.toJSON())).toContain("https://example.com");
    expect(JSON.stringify(pages[4]?.toJSON())).not.toContain("以降のページは省略");
  });
  test.each(["second page rejects", "version changes after page one"])(
    "no-search notice is delivered on page one when %s",
    async (interruption) => {
      const job = await add();
      generate.mockImplementation(async () => ({
        text: "long text ".repeat(900),
        model: "free/model",
        webSearchSkipped: true as const,
      }));
      let page = 0;
      send.mockImplementation(async () => {
        page++;
        if (page === 1 && interruption === "version changes after page one")
          repo.setStatus(job.id, job.version, "paused", null, now);
        if (page === 2 && interruption === "second page rejects")
          throw new Error("page two failed");
      });
      now += 5 * 60_000;
      await service.tick();
      expect(JSON.stringify(send.mock.calls[0]?.[0])).toContain(
        "定期実行「name」\\nWeb 検索に失敗したため検索なしで答えました。",
      );
      expect(send).toHaveBeenCalledTimes(interruption === "second page rejects" ? 2 : 1);
    },
  );
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
  test("SILENT after search fallback remains a success without a post", async () => {
    const job = await add("5m", true);
    now += 5 * 60_000;
    generate.mockImplementation(async () => ({
      text: "[SILENT]",
      model: "free/model",
      webSearchSkipped: true,
      webSearch: { calls: [{ query: "news", sources: [] }], results: [] },
    }));
    await service.tick();
    expect(send).not.toHaveBeenCalled();
    expect(repo.getJob(job.id)?.failCount).toBe(0);
  });
  test("a successful search fallback clears the prior failure", async () => {
    const job = await add();
    repo.saveFailure(job.id, job.version, now, "prior");
    generate.mockImplementation(async () => ({
      text: "answer",
      model: "free/model",
      webSearchSkipped: true,
    }));
    now += 5 * 60_000;
    await service.tick();
    expect(repo.getJob(job.id)).toMatchObject({ failCount: 0, lastError: null });
    expect(JSON.stringify(send.mock.calls[0]?.[0])).toContain("検索なしで答えました");
  });
  test("a failed search retry counts as one failed execution", async () => {
    const job = await add();
    generate.mockRejectedValueOnce(new Error("retry failed"));
    now += 5 * 60_000;
    await service.tick();
    expect(repo.getJob(job.id)).toMatchObject({ failCount: 1, lastError: "retry failed" });
  });
  test("a non-search failure still counts when guild search is off", async () => {
    const job = await add();
    expect(repo.setJobWebSearch(job.id, job.version, true, now)).toBe(true);
    await settings.setWebSearchEnabled("guild", false);
    const llm = createMockLLMClient();
    const chat = new ChatService(
      llm,
      settings,
      new ToolRegistry(),
      "perplexity",
      createMockTweetService(),
      new ModelService(llm),
    );
    const modelCall = spyOn(llm, "chat").mockImplementation(async (request) => {
      expect(request.tools).toBeUndefined();
      throw new Error("model failed");
    });
    service = new CronService(
      repo,
      settings,
      {
        generateScheduledResponse: (current, signal) =>
          chat.generateScheduledResponse(current, signal),
        interpretCronSchedule: mock(async () => "30m"),
      },
      { resolve },
      () => now,
    );
    now += 5 * 60_000;
    await service.tick();
    expect(modelCall).toHaveBeenCalledTimes(1);
    expect(repo.getJob(job.id)).toMatchObject({ failCount: 1, lastError: "model failed" });
  });
  test("an edit during the no-search retry prevents the old version from posting or saving", async () => {
    const job = await add();
    expect(repo.setJobWebSearch(job.id, job.version, true, now)).toBe(true);
    await settings.setWebSearchEnabled("guild", true);
    const success = spyOn(repo, "saveSuccess");
    const failure = spyOn(repo, "saveFailure");
    const llm = createMockLLMClient();
    let releaseRetry: (() => void) | undefined;
    let retryStarted: (() => void) | undefined;
    const waitingForRetry = new Promise<void>((resolvePromise) => {
      retryStarted = resolvePromise;
    });
    const modelCall = spyOn(llm, "chat").mockImplementation(async (request) => {
      if (request.tools) throw new WebSearchFailedError("search failed");
      retryStarted?.();
      return new Promise((resolvePromise) => {
        releaseRetry = () =>
          resolvePromise({
            id: "retry",
            choices: [{ message: { role: "assistant", content: "answer" } }],
          });
      });
    });
    const chat = new ChatService(
      llm,
      settings,
      new ToolRegistry(),
      "perplexity",
      createMockTweetService(),
      new ModelService(llm),
    );
    service = new CronService(
      repo,
      settings,
      {
        generateScheduledResponse: (current, signal) =>
          chat.generateScheduledResponse(current, signal),
        interpretCronSchedule: mock(async () => "30m"),
      },
      { resolve },
      () => now,
    );
    now += 5 * 60_000;
    const ticking = service.tick();
    await waitingForRetry;
    const current = repo.getJob(job.id);
    if (!current) throw new Error("job disappeared");
    expect(repo.setJobWebSearch(job.id, current.version, false, now)).toBe(true);
    releaseRetry?.();
    await ticking;
    expect(modelCall).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
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
  test("a job paused for running outside the allowed channels is not announced there", async () => {
    const job = await add();
    await settings.addAllowedChannel("guild", "other");
    for (let i = 0; i < 3; i++) {
      now += 5 * 60_000;
      await service.tick();
    }
    expect(repo.getJob(job.id)).toMatchObject({ status: "paused", failCount: 3 });
    expect(generate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
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
  test("an invalid due expression pauses its job and the next job still runs", async () => {
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
      const paused = repo.getJob(broken.id);
      expect(paused).toMatchObject({
        status: "paused",
        nextRunAt: null,
        version: broken.version + 1,
      });
      expect(paused?.lastError).toContain("次の実行時刻を計算できません");
      // No longer due, so it is not picked first on every later tick.
      expect(repo.dueJobs(now + 24 * 60 * 60_000).map((job) => job.id)).not.toContain(broken.id);
    } finally {
      consoleError.mockRestore();
    }
  });
  for (const expr of ["0", "60000"]) {
    test(`a stored interval of ${expr} ms pauses its job on a tick without calling the model`, async () => {
      const broken = await add();
      db.query("UPDATE cron_jobs SET expr=? WHERE id=?").run(expr, broken.id);
      const consoleError = spyOn(console, "error").mockImplementation(() => {});
      try {
        now += 5 * 60_000;
        await service.tick();
        await service.tick();
        expect(generate).not.toHaveBeenCalled();
        expect(repo.getJob(broken.id)).toMatchObject({ status: "paused", nextRunAt: null });
        expect(repo.getJob(broken.id)?.lastError).toContain("5 分以上");
      } finally {
        consoleError.mockRestore();
      }
    });
    test(`startup pauses a job whose stored interval is ${expr} ms`, async () => {
      const broken = await add();
      db.query("UPDATE cron_jobs SET expr=? WHERE id=?").run(expr, broken.id);
      const consoleError = spyOn(console, "error").mockImplementation(() => {});
      try {
        now += 16 * 60_000;
        await service.catchUpOnStartup();
        now += 60_000;
        await service.tick();
        expect(generate).not.toHaveBeenCalled();
        expect(repo.getJob(broken.id)).toMatchObject({ status: "paused", nextRunAt: null });
        expect(repo.getJob(broken.id)?.lastError).toContain("5 分以上");
      } finally {
        consoleError.mockRestore();
      }
    });
  }
  test("startup pauses a job whose stored cron expression is invalid", async () => {
    const broken = await add("0 9 * * *");
    const valid = await add();
    db.query("UPDATE cron_jobs SET expr='61 25 * * *' WHERE id=?").run(broken.id);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      now = Date.parse("2026-09-30T03:00:00Z");
      await service.catchUpOnStartup();
      expect(repo.getJob(broken.id)).toMatchObject({
        status: "paused",
        nextRunAt: null,
        version: broken.version + 1,
      });
      expect(repo.getJob(broken.id)?.lastError).toContain("次の実行時刻を計算できません");
      expect(repo.getJob(valid.id)?.nextRunAt).toBeGreaterThan(now);
    } finally {
      consoleError.mockRestore();
    }
  });
  test("startup starts the ticker even when reconciliation or catch-up fails", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const start = mock(() => {});
      const catchUpOnStartup = mock(async () => {
        throw new Error("catch-up failed");
      });
      await startCronService({ catchUpOnStartup, start }, async () => {
        throw new Error("reconcile failed");
      });
      expect(catchUpOnStartup).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });
  test("startup catch-up still advances the other jobs when one fails", async () => {
    const failing = await add();
    const other = await add();
    const skip = repo.skip.bind(repo);
    spyOn(repo, "skip").mockImplementation((job, next, at) => {
      if (job.id === failing.id) throw new Error("database is locked");
      return skip(job, next, at);
    });
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      now += 16 * 60_000;
      await service.catchUpOnStartup();
      expect(repo.getJob(other.id)?.nextRunAt).toBeGreaterThan(now);
    } finally {
      consoleError.mockRestore();
    }
  });
  test("startup runs a time 9:59 late and advances one 10:01 late without running it", async () => {
    const job = await add();
    const due = START + 5 * 60_000;
    now = due + 9 * 60_000 + 59_000;
    await service.catchUpOnStartup();
    expect(repo.getJob(job.id)?.nextRunAt).toBe(due);
    now = due + 10 * 60_000 + 1_000;
    await service.catchUpOnStartup();
    expect(repo.getJob(job.id)?.nextRunAt).toBeGreaterThan(now);
    expect(repo.getJob(job.id)?.lastRunAt).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });
  test("startup carries a cron job over to its next matching time", async () => {
    const job = await add("0 9 * * *");
    expect(job.nextRunAt).toBe(Date.parse("2026-09-30T00:00:00Z"));
    now = Date.parse("2026-09-30T03:00:00Z");
    await service.catchUpOnStartup();
    expect(repo.getJob(job.id)?.nextRunAt).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(repo.getJob(job.id)?.lastRunAt).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });
  test("the run succeeds once the first page is posted, even if a stop cuts the rest", async () => {
    const job = await add();
    repo.saveFailure(job.id, job.version, now, "previous failure");
    generate.mockImplementation(async () => ({ text: "long text ".repeat(900), model: "m" }));
    let page = 0;
    send.mockImplementation(async () => {
      if (++page === 2) {
        void service.stop();
        await new Promise(() => {});
      }
    });
    now += 5 * 60_000;
    await service.tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(repo.getJob(job.id)).toMatchObject({ failCount: 0, lastError: null });
  });
  test("a stop, pause, edit, or deletion between the first and second page posts nothing more", async () => {
    for (const operation of ["pause", "edit", "delete", "stop"] as const) {
      const job = await add();
      send.mockClear();
      generate.mockImplementation(async () => ({ text: "long text ".repeat(900), model: "m" }));
      send.mockImplementation(async () => {
        if (send.mock.calls.length !== 1) return;
        if (operation === "pause") repo.setStatus(job.id, job.version, "paused", null, now);
        if (operation === "delete") repo.deleteJob(job.id, job.version);
        if (operation === "stop") void service.stop();
        if (operation === "edit") {
          const edit = await service.createProposal(
            {
              guildId: "guild",
              channelId: "channel",
              userId: "user",
              name: "edited",
              prompt: "edited",
              schedule: "10m",
              silent: false,
              targetJobId: job.id,
              targetVersion: job.version,
            },
            actor,
          );
          if (!edit.ok) throw new Error(edit.reason);
          await service.approveProposal(edit.value.proposal.id, "guild", "user", actor);
        }
      });
      await service.runNow(job.id, "guild", actor, job.version);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
  test("posts at most five pages, headed by the job name, with a note on the last", async () => {
    await add();
    generate.mockImplementation(async () => ({ text: "long text ".repeat(5_000), model: "m" }));
    now += 5 * 60_000;
    await service.tick();
    expect(send).toHaveBeenCalledTimes(5);
    const pages = send.mock.calls.map((call) => JSON.stringify(call[0]));
    expect(pages[0]).toContain("-# 定期実行「name」");
    expect(pages.slice(1).some((page) => page.includes("定期実行「"))).toBe(false);
    expect(pages[4]).toContain("以降のページは省略しました");
    expect(pages.slice(0, 4).some((page) => page.includes("以降のページは省略しました"))).toBe(
      false,
    );
  });
  test("allowed channels gate runs, proposals, and approvals, and a thread passes by its parent", async () => {
    const job = await add();
    const input = {
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      name: "name",
      prompt: "prompt",
      schedule: "5m",
      silent: false,
    };
    const pending = await service.createProposal(input, actor);
    if (!pending.ok) throw new Error(pending.reason);
    await settings.addAllowedChannel("guild", "parent");

    now += 5 * 60_000;
    await service.tick();
    expect(generate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(repo.getJob(job.id)?.lastError).toContain("許可チャンネル外");
    expect(await service.createProposal(input, actor)).toEqual({
      ok: false,
      reason: "許可チャンネル外です。",
    });
    expect(
      await service.approveProposal(pending.value.proposal.id, "guild", "user", actor),
    ).toEqual({ ok: false, reason: "許可チャンネル外です。" });

    resolve.mockImplementation(async () => ({ parentId: "parent", send, notifyPaused: notify }));
    expect((await service.createProposal(input, actor)).ok).toBe(true);
    expect(
      (await service.approveProposal(pending.value.proposal.id, "guild", "user", actor)).ok,
    ).toBe(true);
    expect((await service.runNow(job.id, "guild", actor, job.version)).ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
  test("a channel removed from the allowed channels while the destination is resolved is not approved", async () => {
    const pending = await service.createProposal(
      {
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        name: "name",
        prompt: "prompt",
        schedule: "5m",
        silent: false,
      },
      actor,
    );
    if (!pending.ok) throw new Error(pending.reason);
    resolve.mockImplementation(async () => {
      await settings.addAllowedChannel("guild", "other");
      return { parentId: null, send, notifyPaused: notify };
    });
    expect(
      await service.approveProposal(pending.value.proposal.id, "guild", "user", actor),
    ).toEqual({ ok: false, reason: "許可チャンネル外です。" });
    expect(repo.listJobs("guild")).toHaveLength(0);
  });
  test("a channel removed from the allowed channels while the destination is resolved is not proposed", async () => {
    resolve.mockImplementation(async () => {
      await settings.addAllowedChannel("guild", "other");
      return { parentId: null, send, notifyPaused: notify };
    });
    const result = await service.createProposal(
      {
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        name: "name",
        prompt: "prompt",
        schedule: "5m",
        silent: false,
      },
      actor,
    );
    expect(result).toEqual({ ok: false, reason: "許可チャンネル外です。" });
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM cron_proposals").get()?.count,
    ).toBe(0);
  });
  test("a channel removed from the allowed channels while the destination is resolved is neither generated nor posted", async () => {
    const job = await add();
    resolve.mockImplementation(async () => {
      await settings.addAllowedChannel("guild", "other");
      return { parentId: null, send, notifyPaused: notify };
    });
    now += 5 * 60_000;
    await service.tick();
    expect(generate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(repo.getJob(job.id)).toMatchObject({ failCount: 1 });
    expect(repo.getJob(job.id)?.lastError).toContain("許可チャンネル外");
  });
  test("a guild disabled while the destination is resolved does not run and is not a failure", async () => {
    const job = await add();
    resolve.mockImplementation(async () => {
      await settings.setCronEnabled("guild", false);
      return { parentId: null, send, notifyPaused: notify };
    });
    now += 5 * 60_000;
    await service.tick();
    expect(generate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(repo.getJob(job.id)).toMatchObject({ failCount: 0, lastError: null });
  });
  test("run now by an admin role holder whose role stops being the admin role while the destination is resolved is neither generated nor posted", async () => {
    const job = await add();
    await settings.setAdminRoleId("guild", "admin");
    const roleHolder = { permissions: new PermissionsBitField(), roleIds: ["admin"] };
    resolve.mockImplementation(async () => {
      await settings.setAdminRoleId("guild", "other");
      return { parentId: null, send, notifyPaused: notify };
    });
    const result = await service.runNow(job.id, "guild", roleHolder, job.version);
    expect(resolve).toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "操作権限がありません。" });
    expect(generate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(repo.getJob(job.id)).toMatchObject({ failCount: 0, lastError: null });
  });
  test("a scheduled run does not depend on the admin role", async () => {
    await add();
    await settings.setAdminRoleId("guild", "other");
    now += 5 * 60_000;
    await service.tick();
    expect(send).toHaveBeenCalledTimes(1);
  });
  test("a date that passes while the destination is resolved is not proposed", async () => {
    resolve.mockImplementation(async () => {
      now += 10_000;
      return { parentId: null, send, notifyPaused: notify };
    });
    const result = await service.createProposal(
      {
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        name: "name",
        prompt: "prompt",
        schedule: new Date(now + 5_000).toISOString(),
        silent: false,
      },
      actor,
    );
    expect(result).toEqual({ ok: false, reason: "日時は現在より後を指定してください。" });
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM cron_proposals").get()?.count,
    ).toBe(0);
  });
  test("resuming a job whose stored cron expression cannot be built reports no next time", async () => {
    const job = await add("0 9 * * *");
    await service.pauseJob(job.id, "guild", "user", actor, job.version);
    db.query("UPDATE cron_jobs SET expr='61 25 * * *' WHERE id=?").run(job.id);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await service.resumeJob(job.id, "guild", actor, job.version + 1)).toEqual({
        ok: false,
        reason: "次の実行時刻がありません。",
      });
      expect(repo.getJob(job.id)?.status).toBe("paused");
    } finally {
      consoleError.mockRestore();
    }
  });
  test("a stored cron expression that never matches again pauses on a tick without calling the model", async () => {
    const broken = await add("0 9 * * *");
    db.query("UPDATE cron_jobs SET expr='0 0 30 2 *' WHERE id=?").run(broken.id);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      now = Date.parse("2026-09-30T00:00:00Z");
      await service.tick();
      expect(generate).not.toHaveBeenCalled();
      expect(repo.getJob(broken.id)).toMatchObject({
        status: "paused",
        nextRunAt: null,
        version: broken.version + 1,
      });
      expect(repo.getJob(broken.id)?.lastError).toContain("今後一致する実行時刻がありません");
    } finally {
      consoleError.mockRestore();
    }
  });
  test("startup pauses a job whose stored cron expression never matches again", async () => {
    const broken = await add("0 9 * * *");
    db.query("UPDATE cron_jobs SET expr='0 0 30 2 *' WHERE id=?").run(broken.id);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      now = Date.parse("2026-09-30T03:00:00Z");
      await service.catchUpOnStartup();
      expect(repo.getJob(broken.id)).toMatchObject({
        status: "paused",
        nextRunAt: null,
        version: broken.version + 1,
      });
      expect(repo.getJob(broken.id)?.lastError).toContain("今後一致する実行時刻がありません");
    } finally {
      consoleError.mockRestore();
    }
  });
  test("a disabled guild refuses run now and resume", async () => {
    const job = await add();
    await service.pauseJob(job.id, "guild", "user", actor, job.version);
    await settings.setCronEnabled("guild", false);
    expect((await service.runNow(job.id, "guild", actor, job.version + 1)).ok).toBe(false);
    expect((await service.resumeJob(job.id, "guild", actor, job.version + 1)).ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(repo.getJob(job.id)?.status).toBe("paused");
  });
  test.each([
    ["an empty schedule", { schedule: "   " }],
    ["a schedule over 200 characters", { schedule: "毎".repeat(201) }],
    ["a name with a line break", { name: "first\nsecond" }],
    ["a name over 50 characters after trimming", { name: "x".repeat(51) }],
  ])("refuses %s without converting the schedule", async (_label, overrides) => {
    const interpret = mock(async () => "30m");
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
        schedule: "毎朝九時",
        silent: false,
        ...overrides,
      },
      actor,
    );
    expect(result.ok).toBe(false);
    expect(interpret).not.toHaveBeenCalled();
  });
  test("an edit whose job changes during schedule conversion is not saved", async () => {
    const job = await add();
    service = new CronService(
      repo,
      settings,
      {
        generateScheduledResponse: generate,
        interpretCronSchedule: async () => {
          repo.setStatus(job.id, job.version, "paused", null, now);
          return "30m";
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
        name: "new",
        prompt: "new",
        schedule: "毎朝九時",
        silent: false,
        targetJobId: job.id,
        targetVersion: job.version,
      },
      actor,
    );
    expect(result).toEqual({ ok: false, reason: "編集対象のジョブが変更されました。" });
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM cron_proposals").get()?.count,
    ).toBe(0);
  });
  test("a name is measured after trimming", async () => {
    const result = await service.createProposal(
      {
        guildId: "guild",
        channelId: "channel",
        userId: "user",
        name: `  ${"x".repeat(50)}  `,
        prompt: "prompt",
        schedule: " 5m ",
        silent: false,
      },
      actor,
    );
    expect(result.ok && result.value.proposal.name).toBe("x".repeat(50));
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
    expect(repo.setJobWebSearch(job.id, job.version, true, now)).toBe(true);
    repo.saveFailure(job.id, job.version, now, "previous failure");
    const before = repo.getJob(job.id);
    expect((await service.runNow(job.id, "guild", actor, job.version + 1)).ok).toBe(true);
    expect(generate.mock.calls[0]?.[0]).toMatchObject({ webSearch: true });
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
