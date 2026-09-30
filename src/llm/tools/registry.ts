import type { FunctionTool, ResponsesInputContentPart } from "../../types";

export type ToolLlmResult = string | ResponsesInputContentPart[];

/** `budgetTokens` is `IToolContext.resultBudgetTokens` of the call; absent means unlimited. */
export interface ConversationToolContext {
  resolveMessageRef(ref: string): string | undefined;
  readEarlierMessages(
    count: number,
    signal: AbortSignal,
    budgetTokens?: number,
  ): Promise<ToolLlmResult>;
  viewAttachment(
    messageRef: string,
    attachmentIndex: number,
    model: string,
    signal: AbortSignal,
    budgetTokens?: number,
  ): Promise<ToolLlmResult>;
}

export interface DiscordToolContext {
  channelType: number;
  addReaction(emoji: string, messageRef: string | undefined, signal: AbortSignal): Promise<string>;
  createPoll(
    question: string,
    answers: string[],
    durationHours: number,
    allowMultiselect: boolean,
    signal: AbortSignal,
  ): Promise<string>;
  createThread(name: string, messageRef: string | undefined, signal: AbortSignal): Promise<string>;
  pinMessage(messageRef: string | undefined, signal: AbortSignal): Promise<string>;
}

export interface CronProposalArgs {
  name: string;
  schedule: string;
  prompt: string;
  postOnlyWhenNotable: boolean;
  webSearch?: boolean;
}

/** Built per response, only in guilds with scheduled jobs enabled. */
export interface CronToolContext {
  channelType: number;
  propose(args: CronProposalArgs, signal: AbortSignal): Promise<string>;
}

/**
 * Opaque render fragment interpreted by the chat-response-v2 updater. This
 * foundation only passes it through untouched — the shape is owned by each
 * tool change.
 */
export type ToolRenderPayload = unknown;

export interface IToolContext {
  guildId: string | null;
  channelId: string;
  userId: string;
  model?: string;
  toolsAllowed?: boolean;
  conversation?: ConversationToolContext;
  discord?: DiscordToolContext;
  cron?: CronToolContext;
  /**
   * Tokens this call's result may add to the request, as estimated by
   * `estimateToolResultTokens()`. Set by the tool loop per call. A tool
   * confirms its result fits before committing any state; a larger result
   * is replaced with `result_too_large` and stops every client tool for the
   * rest of the response.
   */
  resultBudgetTokens?: number;
}

/** Identifiers for a single tool invocation, used for idempotency/reconciliation. */
export interface IToolInvocationMeta {
  requestId: string;
  toolCallId: string;
  /** Unique per dispatch attempt (even for the same toolCallId). */
  invocationId: string;
}

export interface IToolHandlerResult {
  llmResult: ToolLlmResult;
  render?: ToolRenderPayload;
  /**
   * A fixed-length string result that reports the tool stopped or could not
   * fit anything (such as `read_earlier_messages` with no messages). The
   * dispatcher takes it out of the loop's finishing reserve even when
   * `resultBudgetTokens` is exhausted, as long as it is no larger than
   * `FIXED_RESULT_TOKENS`.
   */
  terminal?: boolean;
}

export interface IClientTool<Args = unknown> {
  name: string;
  description: string;
  /** JSON Schema for `function.parameters`. */
  parameters: Record<string, unknown>;
  /** Per-tool timeout override. Clamped to [MIN_TOOL_TIMEOUT_MS, MAX_TOOL_TIMEOUT_MS] by the dispatcher. */
  timeoutMs?: number;
  /** Evaluated both when building the request's `tools` array and again at dispatch time. */
  isEnabled(ctx: IToolContext): boolean;
  /** Runtime validation of the parsed JSON arguments (JSON Schema / zod / hand-written). */
  validate(args: unknown): { ok: true; value: Args } | { ok: false; error: string };
  /**
   * Executes the tool. `signal` fires on request cancellation or per-tool
   * timeout — the handler is responsible for its own abort-aware safety
   * (killable isolation / idempotency), since the dispatcher cannot prove
   * that no side effect occurred after an abort (see design "handler 失敗時 /
   * timeout").
   */
  handler(
    args: Args,
    ctx: IToolContext,
    signal: AbortSignal,
    meta: IToolInvocationMeta,
  ): Promise<IToolHandlerResult>;
}

/** Mirrors OpenRouter's function-name constraints; also keeps names id-safe for logging. */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export class ToolRegistry {
  private readonly tools = new Map<string, IClientTool>();

  register(tool: IClientTool): void {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(`Invalid tool name "${tool.name}": must match /^[a-zA-Z0-9_-]{1,64}$/`);
    }
    if (tool.description.trim().length === 0) {
      throw new Error(`Tool "${tool.name}" must have a non-empty description`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): IClientTool | undefined {
    return this.tools.get(name);
  }

  /** Only tools whose `isEnabled(ctx)` is true. Returns `[]` when none apply. */
  buildTools(ctx: IToolContext): FunctionTool[] {
    const result: FunctionTool[] = [];
    for (const tool of this.tools.values()) {
      if (!tool.isEnabled(ctx)) continue;
      result.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      });
    }
    return result;
  }
}
