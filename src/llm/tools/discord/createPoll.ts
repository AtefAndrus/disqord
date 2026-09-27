import { ChannelType } from "discord.js";
import type {
  IClientTool,
  IToolContext,
  IToolHandlerResult,
  IToolInvocationMeta,
} from "../registry";

interface Arguments {
  question: string;
  answers: string[];
  duration_hours?: number;
  allow_multiselect?: boolean;
}

export class CreatePollTool implements IClientTool<Arguments> {
  readonly name = "create_poll";
  readonly description =
    "Create a Discord poll only when the user asks. The poll is a separate reply to the user's current message.";
  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      question: { type: "string", maxLength: 300 },
      answers: {
        type: "array",
        minItems: 2,
        maxItems: 10,
        items: { type: "string", maxLength: 55 },
      },
      duration_hours: { type: "integer", minimum: 1, maximum: 768, default: 24 },
      allow_multiselect: { type: "boolean", default: false },
    },
    required: ["question", "answers"],
    additionalProperties: false,
  };

  isEnabled(ctx: IToolContext): boolean {
    return (
      ctx.guildId !== null &&
      ctx.toolsAllowed !== false &&
      !!ctx.discord &&
      [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread].includes(
        ctx.discord.channelType,
      )
    );
  }

  validate(value: unknown): { ok: true; value: Arguments } | { ok: false; error: string } {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { ok: false, error: "arguments must be an object" };
    const args = value as Record<string, unknown>;
    if (typeof args.question !== "string" || args.question.length < 1 || args.question.length > 300)
      return { ok: false, error: "question must be 1-300 characters" };
    if (
      !Array.isArray(args.answers) ||
      args.answers.length < 2 ||
      args.answers.length > 10 ||
      args.answers.some(
        (answer) => typeof answer !== "string" || answer.length < 1 || answer.length > 55,
      )
    )
      return { ok: false, error: "answers must contain 2-10 texts of 1-55 characters" };
    if (
      args.duration_hours !== undefined &&
      (!Number.isInteger(args.duration_hours) ||
        (args.duration_hours as number) < 1 ||
        (args.duration_hours as number) > 768)
    )
      return { ok: false, error: "duration_hours must be 1-768" };
    if (args.allow_multiselect !== undefined && typeof args.allow_multiselect !== "boolean")
      return { ok: false, error: "allow_multiselect must be boolean" };
    return {
      ok: true,
      value: {
        question: args.question,
        answers: args.answers as string[],
        ...(args.duration_hours !== undefined && { duration_hours: args.duration_hours as number }),
        ...(args.allow_multiselect !== undefined && {
          allow_multiselect: args.allow_multiselect as boolean,
        }),
      },
    };
  }

  async handler(
    args: Arguments,
    ctx: IToolContext,
    signal: AbortSignal,
    _meta: IToolInvocationMeta,
  ): Promise<IToolHandlerResult> {
    return {
      llmResult: ctx.discord
        ? await ctx.discord.createPoll(
            args.question,
            args.answers,
            args.duration_hours ?? 24,
            args.allow_multiselect ?? false,
            signal,
          )
        : '{"ok":false,"reason":"unavailable"}',
      terminal: true,
    };
  }
}

export function createCreatePollTool(): CreatePollTool {
  return new CreatePollTool();
}
