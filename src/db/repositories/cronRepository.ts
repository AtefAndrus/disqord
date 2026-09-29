import type { Database } from "bun:sqlite";
import { type CronSchedule, firstRunAfter, validateSchedule } from "../../services/cronSchedule";
import { canManageGuildSettings, type SettingsActor } from "../../services/settingsAuthorization";

export interface CronJob {
  id: number;
  guildId: string;
  channelId: string;
  userId: string;
  name: string;
  prompt: string;
  kind: CronSchedule["kind"];
  expr: string;
  silent: boolean;
  status: "active" | "paused" | "done";
  nextRunAt: number | null;
  lastRunAt: number | null;
  failCount: number;
  lastError: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}
export interface CronProposal {
  id: number;
  guildId: string;
  channelId: string;
  userId: string;
  targetJobId: number | null;
  targetVersion: number | null;
  name: string;
  prompt: string;
  kind: CronSchedule["kind"];
  expr: string;
  silent: boolean;
  expiresAt: number;
  createdAt: number;
}
export type NewCronProposal = Omit<CronProposal, "id">;
export type CronResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const JOB_COLUMNS = `id, guild_id AS guildId, channel_id AS channelId, user_id AS userId, name, prompt,
  kind, expr, silent, status, next_run_at AS nextRunAt, last_run_at AS lastRunAt,
  fail_count AS failCount, last_error AS lastError, version, created_at AS createdAt, updated_at AS updatedAt`;
const PROPOSAL_COLUMNS = `id, guild_id AS guildId, channel_id AS channelId, user_id AS userId,
  target_job_id AS targetJobId, target_version AS targetVersion, name, prompt,
  kind, expr, silent, expires_at AS expiresAt, created_at AS createdAt`;
type RawJob = Omit<CronJob, "silent"> & { silent: number };
type RawProposal = Omit<CronProposal, "silent"> & { silent: number };
const jobFrom = (row: RawJob): CronJob => ({ ...row, silent: Boolean(row.silent) });
const proposalFrom = (row: RawProposal): CronProposal => ({ ...row, silent: Boolean(row.silent) });

export interface ICronRepository {
  createProposal(input: NewCronProposal): CronProposal;
  getProposal(id: number): CronProposal | null;
  approveProposal(
    id: number,
    guildId: string,
    userId: string,
    actor: SettingsActor,
    now: number,
  ): CronResult<CronJob>;
  rejectProposal(id: number, guildId: string, userId: string): boolean;
  getJob(id: number): CronJob | null;
  listJobs(guildId: string, userId?: string): CronJob[];
  countJobs(guildId: string): number;
  countUserJobs(guildId: string, userId: string): number;
  dueJobs(now: number): CronJob[];
  allActiveJobs(): CronJob[];
  consume(job: CronJob, next: number | null, now: number): boolean;
  skip(job: CronJob, next: number | null, now: number): boolean;
  /** Pauses an active job whose stored schedule gives no next time, keeping the reason. */
  pauseInvalid(job: CronJob, now: number, error: string): boolean;
  saveSuccess(id: number, version: number, now: number): boolean;
  saveFailure(id: number, version: number, now: number, error: string): CronJob | null;
  setStatus(
    id: number,
    version: number,
    status: "active" | "paused",
    next: number | null,
    now: number,
  ): boolean;
  deleteJob(id: number, version: number): boolean;
  deleteByGuild(guildId: string): number;
  deleteByChannel(channelId: string): number;
  deleteGuildsNotIn(guildIds: readonly string[]): number;
  deleteExpiredProposals(now: number): number;
}

export class CronRepository implements ICronRepository {
  constructor(private readonly db: Database) {}

  createProposal(input: NewCronProposal): CronProposal {
    const result = this.db
      .query(`INSERT INTO cron_proposals
      (guild_id,channel_id,user_id,target_job_id,target_version,name,prompt,kind,expr,silent,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        input.guildId,
        input.channelId,
        input.userId,
        input.targetJobId,
        input.targetVersion,
        input.name,
        input.prompt,
        input.kind,
        input.expr,
        input.silent ? 1 : 0,
        input.expiresAt,
        input.createdAt,
      );
    const proposal = this.getProposal(Number(result.lastInsertRowid));
    if (!proposal) throw new Error("Created proposal could not be read");
    return proposal;
  }

  getProposal(id: number): CronProposal | null {
    const row = this.db
      .query<RawProposal, [number]>(`SELECT ${PROPOSAL_COLUMNS} FROM cron_proposals WHERE id=?`)
      .get(id);
    return row ? proposalFrom(row) : null;
  }

  approveProposal(
    id: number,
    guildId: string,
    userId: string,
    actor: SettingsActor,
    now: number,
  ): CronResult<CronJob> {
    const tx = this.db.transaction((): CronResult<CronJob> => {
      const proposal = this.getProposal(id);
      if (
        !proposal ||
        proposal.guildId !== guildId ||
        proposal.userId !== userId ||
        proposal.expiresAt <= now
      )
        return { ok: false, reason: "提案が無効か期限切れです。" };
      const settings = this.db
        .query<{ cronEnabled: number; adminRoleId: string | null }, [string]>(
          "SELECT cron_enabled AS cronEnabled, admin_role_id AS adminRoleId FROM guild_settings WHERE guild_id=?",
        )
        .get(guildId);
      if (!settings?.cronEnabled || !canManageGuildSettings(actor, settings))
        return { ok: false, reason: "定期実行が無効か、操作権限がありません。" };
      const schedule: CronSchedule = { kind: proposal.kind, expr: proposal.expr };
      const validation = validateSchedule(schedule, now);
      const first = firstRunAfter(schedule, now);
      if (!validation.ok || first === null)
        return {
          ok: false,
          reason: "実行日時が過ぎたか、スケジュールが無効です。提案し直してください。",
        };
      let jobId: number;
      if (proposal.targetJobId === null) {
        const counts = this.db
          .query<{ guildCount: number; userCount: number }, [string, string]>(
            `SELECT COUNT(*) AS guildCount, SUM(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS userCount
           FROM cron_jobs WHERE guild_id=? AND status IN ('active','paused')`,
          )
          .get(userId, guildId);
        if ((counts?.guildCount ?? 0) >= 50 || (counts?.userCount ?? 0) >= 10)
          return { ok: false, reason: "登録数の上限に達しています。" };
        const result = this.db
          .query(`INSERT INTO cron_jobs
          (guild_id,channel_id,user_id,name,prompt,kind,expr,silent,status,next_run_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?, 'active',?,?,?)`)
          .run(
            guildId,
            proposal.channelId,
            userId,
            proposal.name,
            proposal.prompt,
            proposal.kind,
            proposal.expr,
            proposal.silent ? 1 : 0,
            first,
            now,
            now,
          );
        jobId = Number(result.lastInsertRowid);
      } else {
        const old = this.getJob(proposal.targetJobId);
        if (
          !old ||
          old.guildId !== guildId ||
          old.version !== proposal.targetVersion ||
          old.status === "done"
        )
          return { ok: false, reason: "編集対象のジョブが変更されました。" };
        jobId = old.id;
        const result = this.db
          .query(`UPDATE cron_jobs SET channel_id=?,name=?,prompt=?,kind=?,expr=?,silent=?,
          next_run_at=?,last_run_at=?,fail_count=0,last_error=NULL,version=version+1,updated_at=?
          WHERE id=? AND version=? AND status IN ('active','paused')`)
          .run(
            proposal.channelId,
            proposal.name,
            proposal.prompt,
            proposal.kind,
            proposal.expr,
            proposal.silent ? 1 : 0,
            old.status === "active" ? first : null,
            old.kind === proposal.kind && old.expr === proposal.expr ? old.lastRunAt : null,
            now,
            old.id,
            old.version,
          );
        if (!result.changes) return { ok: false, reason: "編集対象のジョブが変更されました。" };
      }
      this.db.query("DELETE FROM cron_proposals WHERE id=?").run(id);
      const job = this.getJob(jobId);
      if (!job) throw new Error("Approved job could not be read");
      return { ok: true, value: job };
    });
    return tx.immediate();
  }

  rejectProposal(id: number, guildId: string, userId: string): boolean {
    return (
      this.db
        .query("DELETE FROM cron_proposals WHERE id=? AND guild_id=? AND user_id=?")
        .run(id, guildId, userId).changes > 0
    );
  }

  getJob(id: number): CronJob | null {
    const row = this.db
      .query<RawJob, [number]>(`SELECT ${JOB_COLUMNS} FROM cron_jobs WHERE id=?`)
      .get(id);
    return row ? jobFrom(row) : null;
  }
  listJobs(guildId: string, userId?: string): CronJob[] {
    const rows =
      userId === undefined
        ? this.db
            .query<RawJob, [string]>(
              `SELECT ${JOB_COLUMNS} FROM cron_jobs WHERE guild_id=? ORDER BY id DESC`,
            )
            .all(guildId)
        : this.db
            .query<RawJob, [string, string]>(
              `SELECT ${JOB_COLUMNS} FROM cron_jobs WHERE guild_id=? AND user_id=? ORDER BY id DESC`,
            )
            .all(guildId, userId);
    return rows.map(jobFrom);
  }
  countJobs(guildId: string): number {
    return (
      this.db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM cron_jobs WHERE guild_id=? AND status IN ('active','paused')",
        )
        .get(guildId)?.count ?? 0
    );
  }
  countUserJobs(guildId: string, userId: string): number {
    return (
      this.db
        .query<{ count: number }, [string, string]>(
          "SELECT COUNT(*) AS count FROM cron_jobs WHERE guild_id=? AND user_id=? AND status IN ('active','paused')",
        )
        .get(guildId, userId)?.count ?? 0
    );
  }
  dueJobs(now: number): CronJob[] {
    return this.db
      .query<RawJob, [number]>(
        `SELECT ${JOB_COLUMNS} FROM cron_jobs WHERE status='active' AND next_run_at<=? ORDER BY next_run_at,id`,
      )
      .all(now)
      .map(jobFrom);
  }
  allActiveJobs(): CronJob[] {
    return this.db
      .query<RawJob, []>(`SELECT ${JOB_COLUMNS} FROM cron_jobs WHERE status='active'`)
      .all()
      .map(jobFrom);
  }
  consume(job: CronJob, next: number | null, now: number): boolean {
    return (
      this.db
        .query(`UPDATE cron_jobs SET next_run_at=?,last_run_at=?,status=?,updated_at=?
      WHERE id=? AND version=? AND status='active' AND next_run_at=?`)
        .run(next, now, next === null ? "done" : "active", now, job.id, job.version, job.nextRunAt)
        .changes > 0
    );
  }
  skip(job: CronJob, next: number | null, now: number): boolean {
    return (
      this.db
        .query(`UPDATE cron_jobs SET next_run_at=?,status=?,updated_at=?
      WHERE id=? AND version=? AND status='active' AND next_run_at=?`)
        .run(next, next === null ? "done" : "active", now, job.id, job.version, job.nextRunAt)
        .changes > 0
    );
  }
  pauseInvalid(job: CronJob, now: number, error: string): boolean {
    return (
      this.db
        .query(`UPDATE cron_jobs SET status='paused',next_run_at=NULL,version=version+1,
      last_error=?,updated_at=? WHERE id=? AND version=? AND status='active'`)
        .run(error.slice(0, 500), now, job.id, job.version).changes > 0
    );
  }
  saveSuccess(id: number, version: number, now: number): boolean {
    return (
      this.db
        .query(
          "UPDATE cron_jobs SET fail_count=0,last_error=NULL,updated_at=? WHERE id=? AND version=?",
        )
        .run(now, id, version).changes > 0
    );
  }
  saveFailure(id: number, version: number, now: number, error: string): CronJob | null {
    const tx = this.db.transaction((): CronJob | null => {
      const job = this.getJob(id);
      if (!job || job.version !== version) return null;
      const pause = job.status === "active" && job.kind !== "once" && job.failCount + 1 >= 3;
      this.db
        .query(`UPDATE cron_jobs SET fail_count=fail_count+1,last_error=?,status=?,next_run_at=?,
        version=version+?,updated_at=? WHERE id=? AND version=?`)
        .run(
          error.slice(0, 500),
          pause ? "paused" : job.status,
          pause ? null : job.nextRunAt,
          pause ? 1 : 0,
          now,
          id,
          version,
        );
      return this.getJob(id);
    });
    return tx.immediate();
  }
  setStatus(
    id: number,
    version: number,
    status: "active" | "paused",
    next: number | null,
    now: number,
  ): boolean {
    return (
      this.db
        .query(`UPDATE cron_jobs SET status=?,next_run_at=?,fail_count=?,version=version+1,updated_at=?
      WHERE id=? AND version=? AND status=?`)
        .run(
          status,
          next,
          status === "active" ? 0 : (this.getJob(id)?.failCount ?? 0),
          now,
          id,
          version,
          status === "active" ? "paused" : "active",
        ).changes > 0
    );
  }
  deleteJob(id: number, version: number): boolean {
    return (
      this.db.query("DELETE FROM cron_jobs WHERE id=? AND version=?").run(id, version).changes > 0
    );
  }
  deleteByGuild(guildId: string): number {
    const a = this.db.query("DELETE FROM cron_jobs WHERE guild_id=?").run(guildId).changes;
    const b = this.db.query("DELETE FROM cron_proposals WHERE guild_id=?").run(guildId).changes;
    return a + b;
  }
  deleteByChannel(channelId: string): number {
    const a = this.db.query("DELETE FROM cron_jobs WHERE channel_id=?").run(channelId).changes;
    const b = this.db.query("DELETE FROM cron_proposals WHERE channel_id=?").run(channelId).changes;
    return a + b;
  }
  deleteGuildsNotIn(guildIds: readonly string[]): number {
    const condition = guildIds.length
      ? `NOT IN (${guildIds.map(() => "?").join(",")})`
      : "IS NOT NULL";
    const a = this.db
      .query(`DELETE FROM cron_jobs WHERE guild_id ${condition}`)
      .run(...guildIds).changes;
    const b = this.db
      .query(`DELETE FROM cron_proposals WHERE guild_id ${condition}`)
      .run(...guildIds).changes;
    return a + b;
  }
  deleteExpiredProposals(now: number): number {
    return this.db.query("DELETE FROM cron_proposals WHERE expires_at<=?").run(now).changes;
  }
}
