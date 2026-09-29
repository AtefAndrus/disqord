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
    const first = repo.approveProposal(input.id, "guild", "user", actor, NOW);
    expect(first.ok).toBe(true);
    expect(repo.approveProposal(input.id, "guild", "user", actor, NOW).ok).toBe(false);
    expect(repo.countJobs("guild")).toBe(1);
  });
  test("approval rejects another user, missing permissions, disabled guild and past once", async () => {
    const p = proposal();
    expect(repo.approveProposal(p.id, "guild", "other", actor, NOW).ok).toBe(false);
    expect(repo.approveProposal(p.id, "guild", "user", stranger, NOW).ok).toBe(false);
    await settings.setCronEnabled("guild", false);
    expect(repo.approveProposal(p.id, "guild", "user", actor, NOW).ok).toBe(false);
    await settings.setCronEnabled("guild", true);
    const once = proposal({ kind: "once", expr: new Date(NOW + 1_000).toISOString() });
    expect(repo.approveProposal(once.id, "guild", "user", actor, NOW + 2_000).ok).toBe(false);
  });
  test("guild and user limits count active and paused but not done", () => {
    for (let i = 0; i < 10; i++) {
      const p = proposal();
      expect(repo.approveProposal(p.id, "guild", "user", actor, NOW).ok).toBe(true);
    }
    expect(repo.approveProposal(proposal().id, "guild", "user", actor, NOW).ok).toBe(false);
    expect(
      repo.approveProposal(proposal({ userId: "other" }).id, "guild", "other", actor, NOW).ok,
    ).toBe(true);
  });
  test("guild limit rejects the fifty-first active job", () => {
    for (let i = 0; i < 50; i++) {
      const p = proposal({ userId: `user-${i}` });
      expect(repo.approveProposal(p.id, "guild", `user-${i}`, actor, NOW).ok).toBe(true);
    }
    const extra = proposal({ userId: "last" });
    expect(repo.approveProposal(extra.id, "guild", "last", actor, NOW).ok).toBe(false);
  });
  test("edit checks version and keeps paused status", () => {
    const created = repo.approveProposal(proposal().id, "guild", "user", actor, NOW);
    if (!created.ok) throw new Error(created.reason);
    const job = created.value;
    expect(repo.setStatus(job.id, job.version, "paused", null, NOW)).toBe(true);
    const stale = proposal({ targetJobId: job.id, targetVersion: job.version });
    expect(repo.approveProposal(stale.id, "guild", "user", actor, NOW).ok).toBe(false);
    const edit = proposal({
      targetJobId: job.id,
      targetVersion: job.version + 1,
      prompt: "changed",
    });
    const result = repo.approveProposal(edit.id, "guild", "user", actor, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("paused");
      expect(result.value.nextRunAt).toBeNull();
    }
  });
  test("time is consumed before execution and conditional updates reject a changed version", () => {
    const result = repo.approveProposal(proposal().id, "guild", "user", actor, NOW);
    if (!result.ok) throw new Error(result.reason);
    const job = result.value;
    expect(repo.consume(job, NOW + 600_000, NOW + 300_000)).toBe(true);
    expect(repo.consume(job, NOW + 600_000, NOW + 300_000)).toBe(false);
    expect(repo.getJob(job.id)?.lastRunAt).toBe(NOW + 300_000);
    expect(repo.setStatus(job.id, job.version, "paused", null, NOW + 300_001)).toBe(true);
    expect(repo.saveSuccess(job.id, job.version, NOW + 300_002)).toBe(false);
  });
  test("three failures pause recurring jobs and increment version", () => {
    const result = repo.approveProposal(proposal().id, "guild", "user", actor, NOW);
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
    const result = repo.approveProposal(proposal().id, "guild", "user", actor, NOW);
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
