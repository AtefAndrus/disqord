import { ChannelType } from "discord.js";
import type {
  IClientTool,
  IToolContext,
  IToolHandlerResult,
  IToolInvocationMeta,
} from "../registry";

interface Arguments {
  emoji: string;
  message_ref?: string;
}

export class AddReactionTool implements IClientTool<Arguments> {
  readonly name = "add_reaction";
  readonly description =
    "Add a reaction only when the user asks. Use a Unicode emoji or this guild's custom emoji name, without colons or an ID. message_ref is an m-number from this conversation; omit it for the user's current message.";
  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      emoji: { type: "string", minLength: 1 },
      message_ref: { type: "string", pattern: "^m[0-9]+$" },
    },
    required: ["emoji"],
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
    if (typeof args.emoji !== "string" || args.emoji.length === 0 || args.emoji.length > 100)
      return { ok: false, error: "emoji is required" };
    if (/[<>:%]/u.test(args.emoji))
      return { ok: false, error: "emoji must be Unicode or a guild emoji name" };
    if (
      args.message_ref !== undefined &&
      (typeof args.message_ref !== "string" || !/^m[0-9]+$/u.test(args.message_ref))
    )
      return { ok: false, error: "invalid message_ref" };
    return {
      ok: true,
      value: {
        emoji: args.emoji,
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
        ? await ctx.discord.addReaction(args.emoji, args.message_ref, signal)
        : '{"ok":false,"reason":"unavailable"}',
      terminal: true,
    };
  }
}

export function createAddReactionTool(): AddReactionTool {
  return new AddReactionTool();
}
