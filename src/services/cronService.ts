import type { ContainerBuilder, MessageCreateOptions } from "discord.js";
import { RESTJSONErrorCodes } from "discord.js";
import type {
  CronJob,
  CronProposal,
  CronResult,
  ICronRepository,
} from "../db/repositories/cronRepository";
import { AppError } from "../errors";
import type { ChatCompletionResponse } from "../types";
import { EmbedColors } from "../types/embed";
import {
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
} from "./cronSchedule";
import { canManageGuildSettings, type SettingsActor } from "./settingsAuthorization";
import type { ISettingsService } from "./settingsService";

const PROPOSAL_TTL_MS = 24 * 60 * 60_000;
const TICK_MS = 60_000;
const GENERATION_TIMEOUT_MS = 120_000;
const PAGE_TIMEOUT_MS = 15_000;
const STARTUP_GRACE_MS = 10 * 60_000;

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
  ): Promise<{ text: string; usage?: ChatCompletionResponse["usage"]; model: string }>;
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
  targetJobId?: number;
  targetVersion?: number;
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
  ): Promise<CronResult<CronJob>>;
  getProposal(id: number, guildId: string, userId: string): CronProposal | null;
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
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, ms);
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error(parent.aborted ? "中断されました。" : "タイムアウトしました。")),
          { once: true },
        );
      }),
    ]);
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
): ContainerBuilder[] {
  const footer = estimateFinalFooterBudget(metadata);
  const note = measureTextBudget(OMITTED_NOTE);
  const chunks = splitTextIntoMessages(
    `-# 定期実行「${name}」\n${text}`,
    measureTextBudget(model),
    {
      chars: footer.chars + note.chars,
      bytes: footer.bytes + note.bytes,
    },
  );
  const pages = chunks.slice(0, 5);
  if (chunks.length > 5) pages[4] = `${pages[4]}${OMITTED_NOTE}`;
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
    if (
      !input.name.trim() ||
      input.name.length > 50 ||
      !input.prompt.trim() ||
      input.prompt.length > 2000
    )
      return failure("名前またはプロンプトの長さが無効です。");
    if (input.targetJobId !== undefined) {
      const target = this.repo.getJob(input.targetJobId);
      if (
        !target ||
        target.guildId !== input.guildId ||
        target.version !== input.targetVersion ||
        target.status === "done"
      )
        return failure("編集対象のジョブが変更されました。");
    }
    let parsed = parseSchedule(input.schedule, this.now());
    if (!parsed.ok && parsed.reason === "natural_language") {
      try {
        parsed = parseSchedule(
          await this.chat.interpretCronSchedule(input.guildId, input.schedule),
          this.now(),
        );
      } catch (error) {
        return failure(`スケジュールを解釈できませんでした: ${errorText(error)}`);
      }
      if (!parsed.ok && parsed.reason === "natural_language")
        return failure("スケジュールを解釈できませんでした。");
    }
    if (!parsed.ok) return failure(parsed.reason);
    const latestSettings = await this.settings.getGuildSettings(input.guildId);
    if (!latestSettings.cronEnabled || !canManageGuildSettings(actor, latestSettings))
      return failure("定期実行が無効か、操作権限がありません。");
    try {
      const destination = await this.delivery.resolve(input.guildId, input.channelId, input.userId);
      const currentSettings = await this.settings.getGuildSettings(input.guildId);
      if (!currentSettings.cronEnabled || !canManageGuildSettings(actor, currentSettings))
        return failure("定期実行が無効か、操作権限がありません。");
      if (
        currentSettings.allowedChannels !== null &&
        !currentSettings.allowedChannels.includes(input.channelId) &&
        !(destination.parentId && currentSettings.allowedChannels.includes(destination.parentId))
      )
        return failure("許可チャンネル外です。");
    } catch (error) {
      return failure(errorText(error));
    }
    const now = this.now();
    const proposal = this.repo.createProposal({
      guildId: input.guildId,
      channelId: input.channelId,
      userId: input.userId,
      targetJobId: input.targetJobId ?? null,
      targetVersion: input.targetVersion ?? null,
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      kind: parsed.schedule.kind,
      expr: parsed.schedule.expr,
      silent: input.silent,
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
  ): Promise<CronResult<CronJob>> {
    const proposal = this.repo.getProposal(id);
    if (!proposal || proposal.guildId !== guildId || proposal.userId !== userId)
      return failure("提案が無効です。");
    try {
      const settings = await this.settings.getGuildSettings(guildId);
      const destination = await this.delivery.resolve(guildId, proposal.channelId, userId);
      if (
        settings.allowedChannels !== null &&
        !settings.allowedChannels.includes(proposal.channelId) &&
        !(destination.parentId && settings.allowedChannels.includes(destination.parentId))
      )
        return failure("許可チャンネル外です。");
    } catch (error) {
      return failure(errorText(error));
    }
    return this.repo.approveProposal(id, guildId, userId, actor, this.now());
  }
  rejectProposal(id: number, guildId: string, userId: string): boolean {
    return this.repo.rejectProposal(id, guildId, userId);
  }
  getProposal(id: number, guildId: string, userId: string): CronProposal | null {
    const proposal = this.repo.getProposal(id);
    return proposal?.guildId === guildId && proposal.userId === userId ? proposal : null;
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
    const next = firstRunAfter(job, this.now());
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
    return this.run(job, false);
  }

  async catchUpOnStartup(): Promise<void> {
    const now = this.now();
    for (const job of this.repo.allActiveJobs()) {
      if (job.nextRunAt !== null && job.nextRunAt < now - STARTUP_GRACE_MS) {
        this.repo.skip(
          job,
          job.kind === "once" ? null : nextRunAfter(job, job.nextRunAt, now + 1),
          now,
        );
      }
    }
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
        if (this.running.has(job.id)) continue;
        const settings = await this.settings.getGuildSettings(job.guildId);
        if (this.closing) break;
        const now = this.now();
        const next = nextRunAfter(job, job.nextRunAt ?? now, now);
        if (!settings.cronEnabled) {
          this.repo.skip(
            job,
            job.kind === "once" ? null : nextRunAfter(job, job.nextRunAt ?? now, now + 1),
            now,
          );
          continue;
        }
        if (!this.repo.consume(job, next, now)) continue;
        await this.run(job, true);
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

  private async run(job: CronJob, scheduled: boolean): Promise<CronResult<void>> {
    if (this.closing || this.running.has(job.id)) return failure("終了中か実行中です。");
    const controller = new AbortController();
    this.running.set(job.id, controller);
    const promise = this.perform(job, scheduled, controller.signal);
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
  ): Promise<CronResult<void>> {
    let destination: CronDestination | undefined;
    try {
      const settings = await this.settings.getGuildSettings(job.guildId);
      if (this.closing || signal.aborted) return failure("中断されました。");
      destination = await this.delivery.resolve(job.guildId, job.channelId);
      const channel = destination;
      if (
        settings.allowedChannels !== null &&
        !settings.allowedChannels.includes(job.channelId) &&
        !(destination.parentId && settings.allowedChannels.includes(destination.parentId))
      )
        throw new Error("許可チャンネル外です。");
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
        }
      }
      if (scheduled && !this.closing && !signal.aborted && this.current(job))
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
            await destination.notifyPaused(job.userId, job.name);
          } catch (notifyError) {
            logger.error("Cron pause notice failed", { jobId: job.id, error: notifyError });
          }
        }
      }
      return failure(reason);
    }
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
