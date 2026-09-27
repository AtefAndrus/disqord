import { ChannelType } from "discord.js";
import type {
  IClientTool,
  IToolContext,
  IToolHandlerResult,
  IToolInvocationMeta,
} from "../registry";

interface Arguments {
  name: string;
  message_ref?: string;
}

export class CreateThreadTool implements IClientTool<Arguments> {
  readonly name = "create_thread";
  readonly description =
    "Create a public thread from a conversation message only when the user asks. Omit message_ref for the current message.";
  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 100 },
      message_ref: { type: "string", pattern: "^m[0-9]+$" },
    },
    required: ["name"],
    additionalProperties: false,
  };

  isEnabled(ctx: IToolContext): boolean {
    return (
      ctx.guildId !== null &&
      ctx.toolsAllowed !== false &&
      ctx.discord?.channelType === ChannelType.GuildText
    );
  }

  validate(value: unknown): { ok: true; value: Arguments } | { ok: false; error: string } {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { ok: false, error: "arguments must be an object" };
    const args = value as Record<string, unknown>;
    if (typeof args.name !== "string" || args.name.length < 1 || args.name.length > 100)
      return { ok: false, error: "name must be 1-100 characters" };
    if (
      args.message_ref !== undefined &&
      (typeof args.message_ref !== "string" || !/^m[0-9]+$/u.test(args.message_ref))
    )
      return { ok: false, error: "invalid message_ref" };
    return {
      ok: true,
      value: {
        name: args.name,
        ...(typeof args.message_ref === "string" && { message_ref: args.message_ref }),
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
        ? await ctx.discord.createThread(args.name, args.message_ref, signal)
        : '{"ok":false,"reason":"unavailable"}',
      terminal: true,
    };
  }
}

export function createCreateThreadTool(): CreateThreadTool {
  return new CreateThreadTool();
}
