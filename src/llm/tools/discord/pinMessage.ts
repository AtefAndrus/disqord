import { ChannelType } from "discord.js";
import type {
  IClientTool,
  IToolContext,
  IToolHandlerResult,
  IToolInvocationMeta,
} from "../registry";

interface Arguments {
  message_ref?: string;
}

export class PinMessageTool implements IClientTool<Arguments> {
  readonly name = "pin_message";
  readonly description =
    "Pin a conversation message only when the user asks. Omit message_ref for the current message.";
  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: { message_ref: { type: "string", pattern: "^m[0-9]+$" } },
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
    if (
      args.message_ref !== undefined &&
      (typeof args.message_ref !== "string" || !/^m[0-9]+$/u.test(args.message_ref))
    )
      return { ok: false, error: "invalid message_ref" };
    return {
      ok: true,
      value: { ...(typeof args.message_ref === "string" && { message_ref: args.message_ref }) },
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
        ? await ctx.discord.pinMessage(args.message_ref, signal)
        : '{"ok":false,"reason":"unavailable"}',
      terminal: true,
    };
  }
}

export function createPinMessageTool(): PinMessageTool {
  return new PinMessageTool();
}
