import type {
  IClientTool,
  IToolContext,
  IToolHandlerResult,
  IToolInvocationMeta,
} from "./registry";

interface IReadXPostArguments {
  message_ref: string;
  post_index: number;
}

export class ReadXPostTool implements IClientTool<IReadXPostArguments> {
  readonly name = "read_x_post";
  readonly description =
    "Read one X (Twitter) post linked in a message already shown in this response.";
  readonly parameters: Record<string, unknown> = {
    type: "object",
    properties: {
      message_ref: { type: "string", pattern: "^m[0-9]+$" },
      post_index: {
        type: "integer",
        minimum: 1,
        default: 1,
        description:
          "1-based post index in message body order; links to the same post ID count only once, at their first occurrence.",
      },
    },
    required: ["message_ref"],
    additionalProperties: false,
  };

  isEnabled(ctx: IToolContext): boolean {
    return ctx.toolsAllowed !== false && ctx.conversation !== undefined && ctx.tweets !== undefined;
  }

  validate(args: unknown): { ok: true; value: IReadXPostArguments } | { ok: false; error: string } {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return { ok: false, error: "arguments must be an object" };
    }
    const value = args as { message_ref?: unknown; post_index?: unknown };
    if (typeof value.message_ref !== "string" || !/^m[0-9]+$/u.test(value.message_ref)) {
      return { ok: false, error: "message_ref must be a response reference such as m7" };
    }
    const postIndex = value.post_index ?? 1;
    if (!Number.isInteger(postIndex) || (postIndex as number) < 1 || value.post_index === null) {
      return { ok: false, error: "post_index must be a positive integer" };
    }
    return { ok: true, value: { message_ref: value.message_ref, post_index: postIndex as number } };
  }

  async handler(
    args: IReadXPostArguments,
    ctx: IToolContext,
    signal: AbortSignal,
    _meta: IToolInvocationMeta,
  ): Promise<IToolHandlerResult> {
    if (!ctx.tweets) return { llmResult: '{"error":"x_post_unavailable"}', terminal: true };
    const llmResult = await ctx.tweets.readPost(
      args.message_ref,
      args.post_index,
      signal,
      ctx.resultBudgetTokens,
    );
    // Fixed status and error strings use the dispatcher's finishing reserve.
    return { llmResult, terminal: typeof llmResult === "string" };
  }
}

export function createReadXPostTool(): ReadXPostTool {
  return new ReadXPostTool();
}
