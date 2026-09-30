import type { ContainerBuilder, MessageCreateOptions } from "discord.js";
import { RESTJSONErrorCodes } from "discord.js";
import {
  type CronJob,
  type CronProposal,
  type CronResult,
  type ICronRepository,
  isChannelAllowed,
} from "../db/repositories/cronRepository";
import { AppError } from "../errors";
import { formatSearchResultLinks } from "../llm/tools/webSearch";
import type { ChatCompletionResponse, GuildSettings, WebSearchTrace } from "../types";
import { EmbedColors } from "../types/embed";
import {
  badgeText,
  buildFinalContainer,
  estimateFinalFooterBudget,
  type FinalMetadata,
  measureTextBudget,
  splitTextIntoMessages,
  toComponentsV2Payload,
} from "../utils/chatContainerBuilder";
import { logger } from "../utils/logger";
import {
  describeSchedule,
  firstRunAfter,
  nextRunAfter,
  nextThreeRuns,
  parseSchedule,
  validateSchedule,
} from "./cronSchedule";
import { canManageGuildSettings, type SettingsActor } from "./settingsAuthorization";
import type { ISettingsService } from "./settingsService";

const PROPOSAL_TTL_MS = 24 * 60 * 60_000;
const TICK_MS = 60_000;
const GENERATION_TIMEOUT_MS = 120_000;
const INTERPRET_TIMEOUT_MS = 60_000;
const PAGE_TIMEOUT_MS = 15_000;
const STARTUP_GRACE_MS = 10 * 60_000;
const MAX_SCHEDULE_LENGTH = 200;

export interface CronDestination {
  parentId: string | null;
  send(payload: MessageCreateOptions): Promise<void>;
  notifyPaused(userId: string, name: string): Promise<void>;
}
export interface ICronDelivery {
  resolve(guildId: string, channelId: string, userId?: string): Promise<CronDestination>;
}
export interface ICronChat {
  generateScheduledResponse(
    job: CronJob,
    signal: AbortSignal,
  ): Promise<{
    text: string;
    usage?: ChatCompletionResponse["usage"];
    model: string;
    webSearch?: WebSearchTrace;
    webSearchSkipped?: true;
  }>;
  interpretCronSchedule(guildId: string, input: string, signal?: AbortSignal): Promise<string>;
}
export interface CronProposalInput {
  guildId: string;
  channelId: string;
  userId: string;
  name: string;
  prompt: string;
  schedule: string;
  silent: boolean;
  webSearch?: boolean;
  targetJobId?: number;
  targetVersion?: number;
  signal?: AbortSignal;
}
export interface ICronService {
  createProposal(
    input: CronProposalInput,
    actor: SettingsActor,
  ): Promise<CronResult<{ proposal: CronProposal; nextRuns: number[]; description: string }>>;
  approveProposal(
    id: number,
    guildId: string,
    userId: string,
    actor: SettingsActor,
    shownWebSearch?: boolean,
  ): Promise<CronResult<CronJob>>;
  toggleProposalWebSearch(
    id: number,
    guildId: string,
    userId: string,
    actor: SettingsActor,
    shownWebSearch: boolean,
  ): Promise<CronResult<CronProposal>>;
  setJobWebSearch(
    id: number,
    guildId: string,
    actor: SettingsActor,
    version: number,
    webSearch: boolean,
  ): Promise<CronResult<CronJob>>;
  getProposal(id: number, guildId: string, userId: string): CronProposal | null;
  /** Whether the proposal is still stored for the guild, whoever proposed it. */
  hasProposal(id: number, guildId: string): boolean;
  getJob(
    id: number,
    guildId: string,
    userId: string,
    actor: SettingsActor,
  ): Promise<CronJob | null>;
  checkLimits(
    guildId: string,
    userId: string,
  ): { guildCount: number; userCount: number; guildRemaining: number; userRemaining: number };
  rejectProposal(id: number, guildId: string, userId: string): boolean;
  pauseJob(
    id: number,
    guildId: string,
    userId: string,
    actor: SettingsActor,
    version: number,
  ): Promise<CronResult<CronJob>>;
  resumeJob(
    id: number,
    guildId: string,
    actor: SettingsActor,
    version: number,
  ): Promise<CronResult<CronJob>>;
  deleteJob(
    id: number,
    guildId: string,
    userId: string,
    actor: SettingsActor,
    version: number,
  ): Promise<boolean>;
  runNow(
    id: number,
    guildId: string,
    actor: SettingsActor,
    version: number,
  ): Promise<CronResult<void>>;
  listJobs(guildId: string, userId: string, actor: SettingsActor): Promise<CronJob[]>;
  countJobs(guildId: string): number;
  catchUpOnStartup(): Promise<void>;
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

function failure(reason: string): CronResult<never> {
  return { ok: false, reason };
}
function errorText(error: unknown): string {
  return error instanceof AppError
    ? error.userMessage
    : error instanceof Error
      ? error.message
      : String(error);
}
function isUnknownChannel(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === RESTJSONErrorCodes.UnknownChannel
  );
}
async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parent: AbortSignal,
): Promise<T> {
  if (parent.aborted) throw new Error("中断されました。");
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, ms);
  try {
    const interrupted = new Promise<T>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error(parent.aborted ? "中断されました。" : "タイムアウトしました。")),
        { once: true },
      );
    });
    return await Promise.race([operation(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
  }
}

const OMITTED_NOTE = "\n-# 以降のページは省略しました。";

/** A scheduled answer as the chat's final pages, headed by the job name and cut at five pages. */
export function buildScheduledPages(
  name: string,
  text: string,
  model: string,
  metadata: FinalMetadata,
  extras: { notice?: string; links?: string } = {},
): ContainerBuilder[] {
  const footer = estimateFinalFooterBudget(metadata);
  const note = measureTextBudget(OMITTED_NOTE);
  const links = extras.links ? `\n${extras.links}` : "";
  const linksBudget = measureTextBudget(links);
  const chunks = splitTextIntoMessages(
    `-# 定期実行「${name}」\n${extras.notice ? `${extras.notice}\n` : ""}${text}`,
    measureTextBudget(badgeText(model)),
    {
      chars: footer.chars + note.chars + linksBudget.chars,
      bytes: footer.bytes + note.bytes + linksBudget.bytes,
    },
  );
  const pages = chunks.slice(0, 5);
  if (chunks.length > 5) pages[4] = `${pages[4]}${OMITTED_NOTE}`;
  pages[pages.length - 1] += links;
  return pages.map((page, index) =>
    buildFinalContainer({
      text: page,
      color: EmbedColors.BLURPLE,
      modelName: model,
      isFirst: index === 0,
      isLast: index === pages.length - 1,
      metadata,
      pageInfo: { page: index + 1, total: pages.length },
    }),
  );
}

/**
 * Startup: drop the jobs of guilds left while stopped, carry over missed
 * times, then start the ticker. A failed step is logged and the next still
 * runs, because without `start()` no job would run until the next restart.
 */
export async function startCronService(
  cron: Pick<ICronService, "catchUpOnStartup" | "start">,
  reconcileGuilds: () => Promise<void>,
): Promise<void> {
  try {
    await reconcileGuilds();
  } catch (error) {
    logger.error("Guild reconciliation failed", { error });
  }
  try {
    await cron.catchUpOnStartup();
  } catch (error) {
    logger.error("Cron startup catch-up failed", { error });
  }
  cron.start();
}

export class CronService implements ICronService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private closing = false;
  private ticking = false;
  private tickCompletion: Promise<void> | null = null;
  private finishTick: (() => void) | null = null;
  private readonly running = new Map<number, AbortController>();
  private readonly work = new Set<Promise<unknown>>();

  constructor(
    private readonly repo: ICronRepository,
    private readonly settings: ISettingsService,
    private readonly chat: ICronChat,
    private readonly delivery: ICronDelivery,
    private readonly now: () => number = Date.now,
  ) {}

  async createProposal(
    input: CronProposalInput,
    actor: SettingsActor,
  ): Promise<CronResult<{ proposal: CronProposal; nextRuns: number[]; description: string }>> {
    const settings = await this.settings.getGuildSettings(input.guildId);
    if (!settings.cronEnabled || !canManageGuildSettings(actor, settings))
      return failure("定期実行が無効か、操作権限がありません。");
    const name = input.name.trim();
    if (
      !name ||
      name.length > 50 ||
      /[\r\n]/u.test(name) ||
      !input.prompt.trim() ||
      input.prompt.length > 2000
    )
      return failure("名前（1 行、50 字まで）またはプロンプトの長さが無効です。");
    // Checked before parsing so that an empty or oversized schedule never reaches the LLM.
    const schedule = input.schedule.trim();
    if (!schedule || schedule.length > MAX_SCHEDULE_LENGTH)
      return failure(`スケジュールは 1〜${MAX_SCHEDULE_LENGTH} 字で指定してください。`);
    const targetChanged = (): boolean => {
      if (input.targetJobId === undefined) return false;
      const target = this.repo.getJob(input.targetJobId);
      return (
        !target ||
        target.guildId !== input.guildId ||
        target.version !== input.targetVersion ||
        target.status === "done"
      );
    };
    if (targetChanged()) return failure("編集対象のジョブが変更されました。");
    const targetWebSearch =
      input.targetJobId === undefined ? undefined : this.repo.getJob(input.targetJobId)?.webSearch;
    let parsed = parseSchedule(schedule, this.now());
    if (!parsed.ok && parsed.reason === "natural_language") {
      try {
        parsed = parseSchedule(
          await withTimeout(
            (signal) => this.chat.interpretCronSchedule(input.guildId, schedule, signal),
            INTERPRET_TIMEOUT_MS,
            input.signal ?? new AbortController().signal,
          ),
          this.now(),
        );
      } catch (error) {
        return failure(
          error instanceof AppError
            ? error.userMessage
            : `スケジュールを解釈できませんでした: ${errorText(error)}`,
        );
      }
      if (!parsed.ok && parsed.reason === "natural_language")
        return failure("スケジュールを解釈できませんでした。");
    }
    if (!parsed.ok) return failure(parsed.reason);
    if (input.signal?.aborted) return failure("中断されました。");
    let parentId: string | null;
    try {
      parentId = (await this.delivery.resolve(input.guildId, input.channelId, input.userId))
        .parentId;
    } catch (error) {
      return failure(errorText(error));
    }
    // The checks above only spare a doomed conversion. What decides the save is
    // read here, after the last await, and nothing is awaited until the INSERT:
    // converting the schedule and resolving the destination can take a minute.
    const current = await this.settings.getGuildSettings(input.guildId);
    if (input.signal?.aborted) return failure("中断されました。");
    if (!current.cronEnabled || !canManageGuildSettings(actor, current))
      return failure("定期実行が無効か、操作権限がありません。");
    if (!isChannelAllowed(current.allowedChannels, input.channelId, parentId))
      return failure("許可チャンネル外です。");
    if (targetChanged()) return failure("編集対象のジョブが変更されました。");
    const now = this.now();
    // A date a few seconds ahead can pass while the destination is resolved.
    const checked = validateSchedule(parsed.schedule, now);
    if (!checked.ok) return failure(checked.reason);
    const proposal = this.repo.createProposal({
      guildId: input.guildId,
      channelId: input.channelId,
      userId: input.userId,
      targetJobId: input.targetJobId ?? null,
      targetVersion: input.targetVersion ?? null,
      name,
      prompt: input.prompt.trim(),
      kind: parsed.schedule.kind,
      expr: parsed.schedule.expr,
      silent: input.silent,
      webSearch: targetWebSearch ?? input.webSearch ?? false,
      createdAt: now,
      expiresAt: now + PROPOSAL_TTL_MS,
    });
    return {
      ok: true,
      value: {
        proposal,
        nextRuns: nextThreeRuns(parsed.schedule, now),
        description: describeSchedule(parsed.schedule),
      },
    };
  }

  async approveProposal(
    id: number,
    guildId: string,
    userId: string,
    actor: SettingsActor,
    shownWebSearch = false,
  ): Promise<CronResult<CronJob>> {
    const proposal = this.repo.getProposal(id);
    if (!proposal || proposal.guildId !== guildId || proposal.userId !== userId)
      return failure("提案が無効です。");
    let parentId: string | null;
    try {
      parentId = (await this.delivery.resolve(guildId, proposal.channelId, userId)).parentId;
    } catch (error) {
      return failure(errorText(error));
    }
    // The settings are judged only inside the approval's transaction, after the
    // REST call, not from a read taken before it: `/config` can change meanwhile.
    return this.repo.approveProposal(
      id,
      guildId,
      userId,
      actor,
      parentId,
      this.now(),
      shownWebSearch,
    );
  }
  async toggleProposalWebSearch(
    id: number,
    guildId: string,
    userId: string,
    actor: SettingsActor,
    shownWebSearch: boolean,
  ): Promise<CronResult<CronProposal>> {
    const settings = await this.settings.getGuildSettings(guildId);
    const proposal = this.getProposal(id, guildId, userId);
    if (
      !settings.cronEnabled ||
      !canManageGuildSettings(actor, settings) ||
      !proposal ||
      proposal.expiresAt <= this.now()
    )
      return failure("提案が無効か、操作権限がありません。");
    if (!this.repo.setProposalWebSearch(id, shownWebSearch))
      return failure("提案が変更されました。");
    return { ok: true, value: this.repo.getProposal(id) as CronProposal };
  }
  async setJobWebSearch(
    id: number,
    guildId: string,
    actor: SettingsActor,
    version: number,
    webSearch: boolean,
  ): Promise<CronResult<CronJob>> {
    const settings = await this.settings.getGuildSettings(guildId);
    if (!settings.cronEnabled || !canManageGuildSettings(actor, settings))
      return failure("定期実行が無効か、操作権限がありません。");
    const job = this.repo.getJob(id);
    if (
      !job ||
      job.guildId !== guildId ||
      job.version !== version ||
      job.status === "done" ||
      job.webSearch === webSearch
    )
      return failure("ジョブが変更されました。");
    if (!this.repo.setJobWebSearch(id, version, webSearch, this.now()))
      return failure("ジョブが変更されました。");
    return { ok: true, value: this.repo.getJob(id) as CronJob };
  }
  rejectProposal(id: number, guildId: string, userId: string): boolean {
    return this.repo.rejectProposal(id, guildId, userId);
  }
  getProposal(id: number, guildId: string, userId: string): CronProposal | null {
    const proposal = this.repo.getProposal(id);
    return proposal?.guildId === guildId && proposal.userId === userId ? proposal : null;
  }
  hasProposal(id: number, guildId: string): boolean {
    return this.repo.getProposal(id)?.guildId === guildId;
  }
  async getJob(
    id: number,
    guildId: string,
    userId: string,
    actor: SettingsActor,
  ): Promise<CronJob | null> {
    const job = this.repo.getJob(id);
    if (!job || job.guildId !== guildId) return null;
    const settings = await this.settings.getGuildSettings(guildId);
    return job.userId === userId || canManageGuildSettings(actor, settings) ? job : null;
  }
  checkLimits(
    guildId: string,
    userId: string,
  ): { guildCount: number; userCount: number; guildRemaining: number; userRemaining: number } {
    const guildCount = this.repo.countJobs(guildId);
    const userCount = this.repo.countUserJobs(guildId, userId);
    return {
      guildCount,
      userCount,
      guildRemaining: Math.max(0, 50 - guildCount),
      userRemaining: Math.max(0, 10 - userCount),
    };
  }
  async listJobs(guildId: string, userId: string, actor: SettingsActor): Promise<CronJob[]> {
    const settings = await this.settings.getGuildSettings(guildId);
    return this.repo.listJobs(
      guildId,
      canManageGuildSettings(actor, settings) ? undefined : userId,
    );
  }
  countJobs(guildId: string): number {
    return this.repo.countJobs(guildId);
  }

  async pauseJob(
    id: number,
    guildId: string,
    userId: string,
    actor: SettingsActor,
    version: number,
  ): Promise<CronResult<CronJob>> {
    const job = this.repo.getJob(id);
    if (!job || job.guildId !== guildId || job.version !== version || job.status !== "active")
      return failure("ジョブが変更されました。");
    const settings = await this.settings.getGuildSettings(guildId);
    if (job.userId !== userId && !canManageGuildSettings(actor, settings))
      return failure("操作権限がありません。");
    if (!this.repo.setStatus(id, version, "paused", null, this.now()))
      return failure("ジョブが変更されました。");
    return { ok: true, value: this.repo.getJob(id) as CronJob };
  }
  async resumeJob(
    id: number,
    guildId: string,
    actor: SettingsActor,
    version: number,
  ): Promise<CronResult<CronJob>> {
    const settings = await this.settings.getGuildSettings(guildId);
    if (!settings.cronEnabled || !canManageGuildSettings(actor, settings))
      return failure("定期実行が無効か、操作権限がありません。");
    const job = this.repo.getJob(id);
    if (!job || job.guildId !== guildId || job.version !== version || job.status !== "paused")
      return failure("ジョブが変更されました。");
    let next: number | null;
    try {
      next = firstRunAfter(job, this.now());
    } catch (error) {
      // A stored cron expression that cannot be built, from a row written outside the panel.
      logger.error("Cron job has an unusable schedule", { jobId: job.id, error });
      next = null;
    }
    if (next === null) return failure("次の実行時刻がありません。");
    if (!this.repo.setStatus(id, version, "active", next, this.now()))
      return failure("ジョブが変更されました。");
    return { ok: true, value: this.repo.getJob(id) as CronJob };
  }
  async deleteJob(
    id: number,
    guildId: string,
    userId: string,
    actor: SettingsActor,
    version: number,
  ): Promise<boolean> {
    const job = this.repo.getJob(id);
    if (!job || job.guildId !== guildId || job.version !== version) return false;
    const settings = await this.settings.getGuildSettings(guildId);
    if (job.userId !== userId && !canManageGuildSettings(actor, settings)) return false;
    return this.repo.deleteJob(id, version);
  }
  async runNow(
    id: number,
    guildId: string,
    actor: SettingsActor,
    version: number,
  ): Promise<CronResult<void>> {
    if (this.closing) return failure("終了中です。");
    const settings = await this.settings.getGuildSettings(guildId);
    if (!settings.cronEnabled || !canManageGuildSettings(actor, settings))
      return failure("定期実行が無効か、操作権限がありません。");
    const job = this.repo.getJob(id);
    if (!job || job.guildId !== guildId || job.version !== version || this.running.has(id))
      return failure("ジョブが変更されたか実行中です。");
    return this.run(job, false, actor);
  }

  async catchUpOnStartup(): Promise<void> {
    const now = this.now();
    for (const job of this.repo.allActiveJobs()) {
      // One job's failure must not leave the jobs after it unadvanced.
      try {
        if (job.nextRunAt !== null && job.nextRunAt < now - STARTUP_GRACE_MS) {
          const next = this.nextOrPause(job, job.nextRunAt, now + 1, now);
          if (next !== undefined) this.repo.skip(job, next, now);
        }
      } catch (error) {
        logger.error("Cron startup catch-up failed for a job", { jobId: job.id, error });
      }
    }
  }
  /**
   * The next time from the stored expression, or undefined after pausing a
   * repeating job whose expression cannot give one (a row written outside the
   * panel). Left active, such a job would stay due and be picked first on
   * every tick.
   */
  private nextOrPause(
    job: CronJob,
    scheduledAt: number,
    from: number,
    now: number,
  ): number | null | undefined {
    let next: number | null;
    try {
      next = nextRunAfter(job, scheduledAt, from);
      if (next !== null && !Number.isFinite(next)) throw new Error(`not a time: ${next}`);
      // Croner returns null rather than throwing for an expression that builds
      // but never matches again (`0 0 30 2 *`); consumed as-is it would run once
      // and end as `done` with no error. Only `once` ends by design.
      if (next === null && job.kind === "cron")
        throw new Error("今後一致する実行時刻がありません。");
    } catch (error) {
      logger.error("Cron job has an unusable schedule", { jobId: job.id, error });
      this.repo.pauseInvalid(
        job,
        now,
        `スケジュールから次の実行時刻を計算できません: ${errorText(error)}`,
      );
      return undefined;
    }
    return next;
  }
  start(): void {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    this.timer.unref();
  }
  async tick(): Promise<void> {
    if (this.ticking || this.closing) return;
    this.ticking = true;
    this.tickCompletion = new Promise((resolve) => {
      this.finishTick = resolve;
    });
    try {
      this.repo.deleteExpiredProposals(this.now());
      for (const job of this.repo.dueJobs(this.now())) {
        if (this.closing) break;
        try {
          if (this.running.has(job.id)) continue;
          const settings = await this.settings.getGuildSettings(job.guildId);
          if (this.closing) break;
          const now = this.now();
          const next = this.nextOrPause(job, job.nextRunAt ?? now, now, now);
          if (next === undefined) continue;
          if (!settings.cronEnabled) {
            this.repo.skip(
              job,
              job.kind === "once" ? null : nextRunAfter(job, job.nextRunAt ?? now, now + 1),
              now,
            );
            continue;
          }
          if (this.closing) break;
          if (this.running.has(job.id)) continue;
          if (!this.repo.consume(job, next, now)) continue;
          await this.run(job, true);
        } catch (error) {
          logger.error("Cron job failed during tick", { jobId: job.id, error });
        }
      }
    } catch (error) {
      logger.error("Cron tick failed", { error });
    } finally {
      this.ticking = false;
      this.finishTick?.();
      this.finishTick = null;
      this.tickCompletion = null;
    }
  }

  /** `actor` is who pressed 今すぐ実行; a scheduled run has none. */
  private async run(
    job: CronJob,
    scheduled: boolean,
    actor?: SettingsActor,
  ): Promise<CronResult<void>> {
    if (this.closing || this.running.has(job.id)) return failure("終了中か実行中です。");
    const controller = new AbortController();
    this.running.set(job.id, controller);
    const promise = this.perform(job, scheduled, controller.signal, actor);
    this.work.add(promise);
    try {
      return await promise;
    } finally {
      this.running.delete(job.id);
      this.work.delete(promise);
    }
  }

  private async perform(
    job: CronJob,
    scheduled: boolean,
    signal: AbortSignal,
    actor?: SettingsActor,
  ): Promise<CronResult<void>> {
    let destination: CronDestination | undefined;
    try {
      if (this.closing || signal.aborted) return failure("中断されました。");
      destination = await this.delivery.resolve(job.guildId, job.channelId);
      const channel = destination;
      const settings = await this.checkRunnable(job, channel, actor);
      // withTimeout also refuses an already aborted signal before generation starts; this
      // check stays so that a stop during resolve does not depend on that helper alone.
      if (this.closing || signal.aborted) return failure("中断されました。");
      if (!settings) return failure("定期実行が無効になりました。");
      const response = await withTimeout(
        (s) => this.chat.generateScheduledResponse(job, s),
        GENERATION_TIMEOUT_MS,
        signal,
      );
      if (this.closing || signal.aborted || !this.current(job)) return failure("中断されました。");
      if (!job.silent || response.text.trim() !== "[SILENT]") {
        const metadata: FinalMetadata = {
          showDetails: settings.showLlmDetails,
          model: response.model,
          usage: response.usage,
        };
        for (const [index, container] of buildScheduledPages(
          job.name,
          response.text,
          response.model,
          metadata,
          {
            ...(response.webSearchSkipped && {
              notice: "Web 検索に失敗したため検索なしで答えました。",
            }),
            ...(response.webSearch && {
              links: formatSearchResultLinks(response.webSearch.results),
            }),
          },
        ).entries()) {
          if (this.closing || signal.aborted || !this.current(job))
            return failure("中断されました。");
          try {
            await withTimeout(
              () => channel.send(toComponentsV2Payload(container)),
              PAGE_TIMEOUT_MS,
              signal,
            );
          } catch (error) {
            if (index === 0) throw error;
            logger.error("Cron later page failed", { jobId: job.id, page: index + 1, error });
            break;
          }
          // The run succeeds once the first page is out; what happens to the later pages
          // (an interruption or a failure) is not counted against the job.
          if (index === 0 && scheduled) this.repo.saveSuccess(job.id, job.version, this.now());
        }
      } else if (scheduled && !this.closing && !signal.aborted && this.current(job))
        this.repo.saveSuccess(job.id, job.version, this.now());
      return { ok: true, value: undefined };
    } catch (error) {
      if (this.closing || signal.aborted || !this.current(job)) return failure("中断されました。");
      if (isUnknownChannel(error)) {
        this.repo.deleteByChannel(job.channelId);
        return failure("配信先が削除されました。");
      }
      const reason = errorText(error);
      if (scheduled) {
        const updated = this.repo.saveFailure(job.id, job.version, this.now(), reason);
        if (updated?.status === "paused" && updated.failCount === 3 && destination) {
          try {
            // A destination taken off the allowed channels is not posted to even for this
            // notice; the panel's status and last error are left to tell the owner.
            const settings = await this.settings.getGuildSettings(job.guildId);
            if (isChannelAllowed(settings.allowedChannels, job.channelId, destination.parentId))
              await destination.notifyPaused(job.userId, job.name);
          } catch (notifyError) {
            logger.error("Cron pause notice failed", { jobId: job.id, error: notifyError });
          }
        }
      }
      return failure(reason);
    }
  }
  /**
   * The one check before generation, placed after the destination is resolved
   * over REST so that a `/config` change made during that call is seen. Returns
   * the settings the run uses (the footer too), or null when the feature was
   * turned off, which is an interruption rather than a failure; a destination
   * outside the allowed channels throws and counts as a failure. A manual run
   * also rechecks its actor against the admin role read here; the actor's own
   * roles stay as they were when the button was pressed.
   */
  private async checkRunnable(
    job: CronJob,
    destination: CronDestination,
    actor?: SettingsActor,
  ): Promise<GuildSettings | null> {
    const settings = await this.settings.getGuildSettings(job.guildId);
    if (!settings.cronEnabled) return null;
    if (actor && !canManageGuildSettings(actor, settings))
      throw new Error("操作権限がありません。");
    if (!isChannelAllowed(settings.allowedChannels, job.channelId, destination.parentId))
      throw new Error("許可チャンネル外です。");
    return settings;
  }
  private current(job: CronJob): boolean {
    return this.repo.getJob(job.id)?.version === job.version;
  }
  async stop(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.running.values()) controller.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.work, ...(this.tickCompletion ? [this.tickCompletion] : [])]),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 5_000);
        timeout.unref();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  }
}
