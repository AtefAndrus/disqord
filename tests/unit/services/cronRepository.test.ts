import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { type CronProposal, CronRepository } from "../../../src/db/repositories/cronRepository";
import { GuildSettingsRepository } from "../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../src/db/schema";
import { SettingsService } from "../../../src/services/settingsService";

const NOW = Date.parse("2026-09-29T00:00:00Z");
const actor = {
  permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
  roleIds: [],
};
const stranger = { permissions: new PermissionsBitField(), roleIds: [] };

describe("cron repository", () => {
  let db: Database;
  let repo: CronRepository;
  let settings: SettingsService;
  beforeEach(async () => {
    db = new Database(":memory:");
    applyMigrations(db);
    repo = new CronRepository(db);
    settings = new SettingsService(new GuildSettingsRepository(db, "free/model"));
    await settings.setCronEnabled("guild", true);
  });
  afterEach(() => db.close());
  function proposal(overrides: Partial<Omit<CronProposal, "id">> = {}): CronProposal {
    return repo.createProposal({
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      targetJobId: null,
      targetVersion: null,
      webSearch: false,
      name: "name",
      prompt: "prompt",
      kind: "interval",
      expr: "300000",
      silent: false,
      expiresAt: NOW + 86_400_000,
      createdAt: NOW,
      ...overrides,
    });
  }
  test("approval is atomic, rejects a second click and consumed proposals", () => {
    const input = proposal();
    const first = repo.approveProposal(input.id, "guild", "user", actor, null, NOW);
    expect(first.ok).toBe(true);
    expect(repo.approveProposal(input.id, "guild", "user", actor, null, NOW).ok).toBe(false);
    expect(repo.countJobs("guild")).toBe(1);
  });
  test("approval refuses a card whose shown search value changed", () => {
    const input = proposal();
    expect(repo.setProposalWebSearch(input.id, false)).toBe(true);
    expect(repo.approveProposal(input.id, "guild", "user", actor, null, NOW, false).ok).toBe(false);
    expect(repo.countJobs("guild")).toBe(0);
    const approved = repo.approveProposal(input.id, "guild", "user", actor, null, NOW, true);
    expect(approved.ok && approved.value.webSearch).toBe(true);
  });

  test("search columns migrate existing cron tables and remain stable on a second run", () => {
    const old = new Database(":memory:");
    try {
      old.run(
        "CREATE TABLE cron_jobs (id INTEGER PRIMARY KEY, status TEXT, next_run_at INTEGER, guild_id TEXT)",
      );
      old.run("CREATE TABLE cron_proposals (id INTEGER PRIMARY KEY)");
      applyMigrations(old);
      applyMigrations(old);
      for (const table of ["cron_jobs", "cron_proposals"]) {
        const columns = old.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
        expect(columns.filter((column) => column.name === "web_search")).toHaveLength(1);
      }
    } finally {
      old.close();
    }
  });
  test("approval rejects another user, missing permissions, disabled guild and past once", async () => {
    const p = proposal();
    expect(repo.approveProposal(p.id, "guild", "other", actor, null, NOW).ok).toBe(false);
    expect(repo.approveProposal(p.id, "guild", "user", stranger, null, NOW).ok).toBe(false);
    await settings.setCronEnabled("guild", false);
    expect(repo.approveProposal(p.id, "guild", "user", actor, null, NOW).ok).toBe(false);
    await settings.setCronEnabled("guild", true);
    const once = proposal({ kind: "once", expr: new Date(NOW + 1_000).toISOString() });
    expect(repo.approveProposal(once.id, "guild", "user", actor, null, NOW + 2_000).ok).toBe(false);
  });
  test("guild and user limits count active and paused but not done", () => {
    for (let i = 0; i < 10; i++) {
      const p = proposal();
      expect(repo.approveProposal(p.id, "guild", "user", actor, null, NOW).ok).toBe(true);
    }
    expect(repo.approveProposal(proposal().id, "guild", "user", actor, null, NOW).ok).toBe(false);
    expect(
      repo.approveProposal(proposal({ userId: "other" }).id, "guild", "other", actor, null, NOW).ok,
    ).toBe(true);
  });
  test("guild limit rejects the fifty-first active job", () => {
    for (let i = 0; i < 50; i++) {
      const p = proposal({ userId: `user-${i}` });
      expect(repo.approveProposal(p.id, "guild", `user-${i}`, actor, null, NOW).ok).toBe(true);
    }
    const extra = proposal({ userId: "last" });
    expect(repo.approveProposal(extra.id, "guild", "last", actor, null, NOW).ok).toBe(false);
  });
  test("edit checks version and keeps paused status", () => {
    const created = repo.approveProposal(proposal().id, "guild", "user", actor, null, NOW);
    if (!created.ok) throw new Error(created.reason);
    const job = created.value;
    expect(repo.setStatus(job.id, job.version, "paused", null, NOW)).toBe(true);
    const stale = proposal({ targetJobId: job.id, targetVersion: job.version });
    expect(repo.approveProposal(stale.id, "guild", "user", actor, null, NOW).ok).toBe(false);
    const edit = proposal({
      targetJobId: job.id,
      targetVersion: job.version + 1,
      prompt: "changed",
    });
    const result = repo.approveProposal(edit.id, "guild", "user", actor, null, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("paused");
      expect(result.value.nextRunAt).toBeNull();
    }
  });
  test("approval reads the allowed channels in its transaction and passes a thread by its parent", async () => {
    await settings.addAllowedChannel("guild", "parent");
    const p = proposal();
    expect(repo.approveProposal(p.id, "guild", "user", actor, null, NOW)).toEqual({
      ok: false,
      reason: "許可チャンネル外です。",
    });
    expect(repo.approveProposal(p.id, "guild", "user", actor, "parent", NOW).ok).toBe(true);
  });
  test("time is consumed before execution and conditional updates reject a changed version", () => {
    const result = repo.approveProposal(proposal().id, "guild", "user", actor, null, NOW);
    if (!result.ok) throw new Error(result.reason);
    const job = result.value;
    expect(repo.consume(job, NOW + 600_000, NOW + 300_000)).toBe(true);
    expect(repo.consume(job, NOW + 600_000, NOW + 300_000)).toBe(false);
    expect(repo.getJob(job.id)?.lastRunAt).toBe(NOW + 300_000);
    expect(repo.setStatus(job.id, job.version, "paused", null, NOW + 300_001)).toBe(true);
    expect(repo.saveSuccess(job.id, job.version, NOW + 300_002)).toBe(false);
  });
  test("three failures pause recurring jobs and increment version", () => {
    const result = repo.approveProposal(proposal().id, "guild", "user", actor, null, NOW);
    if (!result.ok) throw new Error(result.reason);
    const job = result.value;
    repo.saveFailure(job.id, job.version, NOW, "error");
    repo.saveFailure(job.id, job.version, NOW, "error");
    const failed = repo.saveFailure(job.id, job.version, NOW, "error");
    expect(failed?.status).toBe("paused");
    expect(failed?.failCount).toBe(3);
    expect(failed?.version).toBe(job.version + 1);
  });
  test("a completed recurring job stays done when a late failure is recorded", () => {
    const result = repo.approveProposal(proposal().id, "guild", "user", actor, null, NOW);
    if (!result.ok) throw new Error(result.reason);
    const job = result.value;
    db.query("UPDATE cron_jobs SET status='done', next_run_at=NULL, fail_count=2 WHERE id=?").run(
      job.id,
    );
    const failed = repo.saveFailure(job.id, job.version, NOW, "late error");
    expect(failed?.status).toBe("done");
    expect(failed?.nextRunAt).toBeNull();
    expect(failed?.failCount).toBe(3);
    expect(failed?.version).toBe(job.version);
  });
});
