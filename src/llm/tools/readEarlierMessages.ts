import type {
  IClientTool,
  IToolContext,
  IToolHandlerResult,
  IToolInvocationMeta,
} from "./registry";

export const READ_EARLIER_MAX_COUNT = 100;

interface ReadEarlierArguments {
  count?: number;
}

export class ReadEarlierMessagesTool implements IClientTool<ReadEarlierArguments> {
  readonly name = "read_earlier_messages";
  readonly description =
    "Read eligible messages older than the quoted conversation window, newest first, returned oldest first. " +
    "Call again to go further back. has_more tells whether older history remains. " +
    "stop_reason explains an early stop: fetch_deadline (call again to continue), " +
    "rest_budget_exhausted or result_budget_exhausted (no more history can be read in this response), " +
    "no_permission, or fetch_failed.";
  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 1, maximum: READ_EARLIER_MAX_COUNT, default: 5 },
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
      (!Number.isInteger(count) ||
        (count as number) < 1 ||
        (count as number) > READ_EARLIER_MAX_COUNT)
    ) {
      return { ok: false, error: `count must be an integer from 1 to ${READ_EARLIER_MAX_COUNT}` };
    }
    return { ok: true, value: { ...(count !== undefined && { count: count as number }) } };
  }

  async handler(
    args: ReadEarlierArguments,
    ctx: IToolContext,
    signal: AbortSignal,
    _meta: IToolInvocationMeta,
  ): Promise<IToolHandlerResult> {
    if (!ctx.conversation) return { llmResult: '{"error":"history_unavailable"}', terminal: true };
    const llmResult = await ctx.conversation.readEarlierMessages(
      args.count ?? 5,
      signal,
      ctx.resultBudgetTokens,
    );
    return { llmResult, terminal: isEmptyResult(llmResult) };
  }
}

/** A result without messages is a fixed-shape stop report, which the dispatcher takes from its reserve. */
function isEmptyResult(result: IToolHandlerResult["llmResult"]): boolean {
  if (typeof result !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(result);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { messages?: unknown }).messages) &&
      (parsed as { messages: unknown[] }).messages.length === 0
    );
  } catch {
    return false;
  }
}

export function createReadEarlierMessagesTool(): ReadEarlierMessagesTool {
  return new ReadEarlierMessagesTool();
}
