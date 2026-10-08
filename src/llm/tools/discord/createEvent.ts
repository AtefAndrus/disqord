import { ChannelType } from "discord.js";
import type {
  CreateEventArgs,
  IClientTool,
  IToolContext,
  IToolHandlerResult,
  IToolInvocationMeta,
} from "../registry";
import { isOffsetDate } from "./listPins";

export class CreateEventTool implements IClientTool<CreateEventArgs> {
  readonly name = "create_event";
  readonly description =
    "Create a guild-only Discord scheduled event only when the user asks. Use external with location and end, or voice with channel_name (never a channel ID). start and end must be ISO 8601 with timezone offsets; start must be in the future and end after start. At most one event per response.";
  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["external", "voice"] },
      name: { type: "string", minLength: 1, maxLength: 100 },
      start: { type: "string", description: "ISO 8601 timestamp with timezone offset" },
      end: {
        type: "string",
        description: "ISO 8601 timestamp with timezone offset; required for external events",
      },
      location: {
        type: "string",
        minLength: 1,
        maxLength: 100,
        description: "Required for external; omit for voice",
      },
      channel_name: {
        type: "string",
        minLength: 1,
        description: "Voice channel name; required for voice, omit for external",
      },
      description: { type: "string", maxLength: 1000 },
    },
    required: ["kind", "name", "start"],
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

  validate(value: unknown): { ok: true; value: CreateEventArgs } | { ok: false; error: string } {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { ok: false, error: "arguments must be an object" };
    const args = value as Record<string, unknown>;
    if (
      Object.keys(args).some(
        (key) =>
          !["kind", "name", "start", "end", "location", "channel_name", "description"].includes(
            key,
          ),
      )
    )
      return { ok: false, error: "unknown argument" };
    if (args.kind !== "external" && args.kind !== "voice")
      return { ok: false, error: "kind must be external or voice" };
    if (typeof args.name !== "string" || args.name.length < 1 || args.name.length > 100)
      return { ok: false, error: "name must be 1-100 characters" };
    if (!isOffsetDate(args.start) || (args.end !== undefined && !isOffsetDate(args.end)))
      return { ok: false, error: "start and end must be ISO 8601 with timezone offset" };
    if (
      args.description !== undefined &&
      (typeof args.description !== "string" || args.description.length > 1000)
    )
      return { ok: false, error: "description must be 0-1000 characters" };
    const common = {
      name: args.name,
      start: args.start,
      ...(typeof args.end === "string" && { end: args.end }),
      ...(typeof args.description === "string" &&
        args.description.length > 0 && {
          description: args.description,
        }),
    };
    if (args.kind === "external") {
      if (
        typeof args.location !== "string" ||
        args.location.length < 1 ||
        args.location.length > 100 ||
        typeof args.end !== "string" ||
        args.channel_name !== undefined
      )
        return {
          ok: false,
          error: "external requires location (1-100 characters) and end; omit channel_name",
        };
      return {
        ok: true,
        value: { ...common, kind: "external", location: args.location, end: args.end },
      };
    }
    if (
      typeof args.channel_name !== "string" ||
      args.channel_name.length < 1 ||
      args.location !== undefined
    )
      return { ok: false, error: "voice requires channel_name; omit location" };
    return { ok: true, value: { ...common, kind: "voice", channel_name: args.channel_name } };
  }

  async handler(
    args: CreateEventArgs,
    ctx: IToolContext,
    signal: AbortSignal,
    _meta: IToolInvocationMeta,
  ): Promise<IToolHandlerResult> {
    return {
      llmResult: ctx.discord
        ? await ctx.discord.createEvent(args, signal)
        : '{"ok":false,"reason":"unavailable"}',
      terminal: true,
    };
  }
}

export function createCreateEventTool(): CreateEventTool {
  return new CreateEventTool();
}
