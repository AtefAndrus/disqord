import type { FunctionTool } from "../../types";

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
}

/** Identifiers for a single tool invocation, used for idempotency/reconciliation. */
export interface IToolInvocationMeta {
  requestId: string;
  toolCallId: string;
  /** Unique per dispatch attempt (even for the same toolCallId). */
  invocationId: string;
}

export interface IToolHandlerResult {
  llmResult: string;
  render?: ToolRenderPayload;
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
