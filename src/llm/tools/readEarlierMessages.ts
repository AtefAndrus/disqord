import type { IClientTool, IToolContext, IToolInvocationMeta, ToolLlmResult } from "./registry";

interface ReadEarlierArguments {
  count?: number;
}

export class ReadEarlierMessagesTool implements IClientTool<ReadEarlierArguments> {
  readonly name = "read_earlier_messages";
  readonly description =
    "Read eligible messages older than the quoted conversation window. Use this for past context that is not shown.";
  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 1, maximum: 20, default: 5 },
    },
    additionalProperties: false,
  };

  isEnabled(ctx: IToolContext): boolean {
    return ctx.toolsAllowed !== false && ctx.conversation !== undefined;
  }

  validate(
    args: unknown,
  ): { ok: true; value: ReadEarlierArguments } | { ok: false; error: string } {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return { ok: false, error: "arguments must be an object" };
    }
    const count = (args as { count?: unknown }).count;
    if (
      count !== undefined &&
      (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 20)
    ) {
      return { ok: false, error: "count must be an integer from 1 to 20" };
    }
    return { ok: true, value: { ...(count !== undefined && { count: count as number }) } };
  }

  async handler(
    args: ReadEarlierArguments,
    ctx: IToolContext,
    _signal: AbortSignal,
    _meta: IToolInvocationMeta,
  ): Promise<{ llmResult: ToolLlmResult }> {
    if (!ctx.conversation) return { llmResult: '{"error":"history_unavailable"}' };
    return { llmResult: await ctx.conversation.readEarlierMessages(args.count ?? 5) };
  }
}

export function createReadEarlierMessagesTool(): ReadEarlierMessagesTool {
  return new ReadEarlierMessagesTool();
}
