import { CRON_CHANNEL_TYPES } from "../../utils/cronPanel";
import type {
  CronProposalArgs,
  IClientTool,
  IToolContext,
  IToolHandlerResult,
  IToolInvocationMeta,
} from "./registry";

export class ProposeCronJobTool implements IClientTool<CronProposalArgs> {
  readonly name = "propose_cron_job";
  readonly description =
    "Propose a scheduled job that runs a prompt on a schedule and posts the answer to this channel. " +
    "Only when the user asks for something recurring or at a later time. Nothing is registered until the user approves the confirmation card, so never say it is registered. " +
    "`prompt` runs later with no conversation context and no tools: write a self-contained instruction. " +
    "`schedule` should be a 5-field cron expression in Asia/Tokyo (0 9 * * 1-5), an interval of at least 5 minutes (30m, 2h, 1d), or an ISO 8601 date-time with an offset. " +
    "Set post_only_when_notable to post only when there is something to report.";
  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 50 },
      schedule: { type: "string", minLength: 1, maxLength: 100 },
      prompt: { type: "string", minLength: 1, maxLength: 2000 },
      post_only_when_notable: { type: "boolean", default: false },
    },
    required: ["name", "schedule", "prompt"],
    additionalProperties: false,
  };
  // Converting a natural-language schedule calls the LLM once before the card is sent.
  readonly timeoutMs = 60_000;

  isEnabled(ctx: IToolContext): boolean {
    return (
      ctx.guildId !== null &&
      ctx.toolsAllowed !== false &&
      !!ctx.cron &&
      (CRON_CHANNEL_TYPES as readonly number[]).includes(ctx.cron.channelType)
    );
  }

  validate(value: unknown): { ok: true; value: CronProposalArgs } | { ok: false; error: string } {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { ok: false, error: "arguments must be an object" };
    const args = value as Record<string, unknown>;
    const text = (key: string, max: number): string | undefined => {
      const field = args[key];
      return typeof field === "string" && field.trim().length > 0 && field.length <= max
        ? field
        : undefined;
    };
    const name = text("name", 50);
    const schedule = text("schedule", 100);
    const prompt = text("prompt", 2000);
    if (!name) return { ok: false, error: "name must be 1-50 characters" };
    if (!schedule) return { ok: false, error: "schedule must be 1-100 characters" };
    if (!prompt) return { ok: false, error: "prompt must be 1-2000 characters" };
    if (
      args.post_only_when_notable !== undefined &&
      typeof args.post_only_when_notable !== "boolean"
    )
      return { ok: false, error: "post_only_when_notable must be boolean" };
    return {
      ok: true,
      value: {
        name,
        schedule,
        prompt,
        postOnlyWhenNotable: args.post_only_when_notable === true,
      },
    };
  }

  async handler(
    args: CronProposalArgs,
    ctx: IToolContext,
    signal: AbortSignal,
    _meta: IToolInvocationMeta,
  ): Promise<IToolHandlerResult> {
    return {
      llmResult: ctx.cron
        ? await ctx.cron.propose(args, signal)
        : '{"ok":false,"reason":"unavailable"}',
      terminal: true,
    };
  }
}

export function createProposeCronJobTool(): ProposeCronJobTool {
  return new ProposeCronJobTool();
}
