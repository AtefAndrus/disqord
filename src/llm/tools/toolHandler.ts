import type { ResponsesInputContentPart, ToolChatMessage } from "../../types";
import {
  CALL_ID_TOKEN_ALLOWANCE,
  estimateToolResultTokens,
  FIXED_RESULT_TOKENS,
  MAX_TOOL_ERROR_RESULT_BYTES,
} from "../contextBudget";
import type {
  IClientTool,
  IToolContext,
  IToolHandlerResult,
  IToolInvocationMeta,
  ToolRegistry,
  ToolRenderPayload,
} from "./registry";

/**
 * One tool call as normalized by the tool loop (Phase 3) from accumulated
 * stream deltas: index/id assignment, synthetic-id allocation for
 * missing/duplicate ids, and argument-string concatenation are the loop's
 * responsibility, not the dispatcher's.
 */
export interface INormalizedToolCall {
  /** Model declaration order. */
  index: number;
  /** Synthetic-id-resolved; always present by the time it reaches the dispatcher. */
  id: string;
  name: string;
  /** Concatenated `function.arguments` JSON string (may be empty). */
  rawArguments: string;
  /**
   * Set by the loop's normalization stage when it already knows this call
   * cannot be executed (e.g. "too many tool calls"). When set, `dispatch()`
   * turns it directly into an error result without invoking the tool.
   */
  precomputedError?: string;
}

export type ToolDispatchStatus = "ok" | "error" | "timeout" | "cancelled";

export interface IToolDispatchOutcome {
  status: ToolDispatchStatus;
  /** Always produced, on every code path — `tool_call_id` always equals `call.id`. */
  toolMessage: ToolChatMessage;
  /** Only present when `status === "ok"`. */
  render?: ToolRenderPayload;
  /**
   * The result exceeded `ctx.resultBudgetTokens` and was replaced with
   * `result_too_large`. The tool may already have committed state for the
   * result that never reached the model, and the conversation tools share
   * that state, so the loop runs no client tool for the rest of the response.
   */
  resultTooLarge?: true;
}

export interface IToolDispatchOptions {
  ctx: IToolContext;
  /** Aborts when the whole request (not just this tool) is cancelled. */
  requestSignal?: AbortSignal;
  /** Client-tool names actually offered to the model for this request (frozen snapshot). */
  frozenToolNames: ReadonlySet<string>;
  requestId: string;
}

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const MIN_TOOL_TIMEOUT_MS = 1_000;
export const MAX_TOOL_TIMEOUT_MS = 120_000;
/** Backstop for binary tool parts; attachment tools enforce their smaller per-format limits. */
export const MAX_TOOL_RESULT_PART_BYTES = 32 * 1024 * 1024;

/**
 * Absolute last resort: returned only when producing/serializing a normal
 * error message itself throws. Fixed ASCII so it can never fail to encode or
 * need clipping.
 */
const FALLBACK_ERROR_MESSAGE =
  "Tool execution failed and the error detail could not be serialized.";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Largest byte-length prefix of `bytes` that decodes as valid UTF-8. */
function sliceFromHeadByBytes(bytes: Uint8Array, maxBytes: number): string {
  let end = Math.min(Math.max(maxBytes, 0), bytes.length);
  while (end > 0) {
    try {
      return utf8Decoder.decode(bytes.subarray(0, end));
    } catch {
      end--;
    }
  }
  return "";
}

/** Largest byte-length suffix of `bytes` that decodes as valid UTF-8. */
function sliceFromTailByBytes(bytes: Uint8Array, maxBytes: number): string {
  let start = Math.max(bytes.length - Math.max(maxBytes, 0), 0);
  while (start < bytes.length) {
    try {
      return utf8Decoder.decode(bytes.subarray(start));
    } catch {
      start++;
    }
  }
  return "";
}

/**
 * UTF-8-safe head+tail clip to at most `maxBytes` bytes, never splitting a
 * multi-byte character. The dispatcher uses it only for the error texts it
 * generates. A normal result is never clipped here: a marker in the middle
 * keeps neither JSON structure nor whole messages, so a result over budget
 * is refused instead. A future tool whose output reads fine with its middle
 * cut out (a log, a fetched page) can call this itself with a byte count
 * derived from `ctx.resultBudgetTokens`, then check the clipped text with
 * `estimateToolResultTokens()`.
 */
export function clipToolResultBytes(text: string, maxBytes: number): string {
  const bytes = utf8Encoder.encode(text);
  if (bytes.length <= maxBytes) return text;

  const marker = (omittedBytes: number): string => `\n...[truncated ${omittedBytes} bytes]...\n`;
  // Reserve worst-case marker size (all-9s placeholder string with the same
  // digit count as the true omitted-byte count) so the final result never
  // exceeds maxBytes regardless of how many bytes end up omitted. Kept as a
  // string (not `Number("9".repeat(n))`) to avoid float rounding changing
  // the digit count for pathologically large inputs.
  const maxDigits = String(bytes.length).length;
  const markerReserve = utf8Encoder.encode(
    `\n...[truncated ${"9".repeat(maxDigits)} bytes]...\n`,
  ).length;

  if (maxBytes < markerReserve) {
    // Pathologically small cap: can't fit head/tail alongside the marker.
    // Clip the marker itself so the `<= maxBytes` invariant still holds.
    const fullMarker = utf8Encoder.encode(marker(bytes.length));
    return sliceFromHeadByBytes(fullMarker, maxBytes);
  }

  const budget = maxBytes - markerReserve;
  const half = Math.floor(budget / 2);
  const head = sliceFromHeadByBytes(bytes, half);
  const tail = sliceFromTailByBytes(bytes, half);
  const omitted = bytes.length - utf8Encoder.encode(head).length - utf8Encoder.encode(tail).length;
  return head + marker(omitted) + tail;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

function clampTimeoutMs(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  if (!Number.isFinite(value)) return DEFAULT_TOOL_TIMEOUT_MS;
  return Math.min(MAX_TOOL_TIMEOUT_MS, Math.max(MIN_TOOL_TIMEOUT_MS, value));
}

type HandlerSettlement = { ok: true; value: IToolHandlerResult } | { ok: false; error: unknown };

function isResponsesInputContentPart(value: unknown): value is ResponsesInputContentPart {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const part = value as Record<string, unknown>;
  if (part.type === "input_text") return typeof part.text === "string";
  if (part.type === "input_image") {
    return part.detail === "auto" && typeof part.image_url === "string";
  }
  return (
    part.type === "input_file" &&
    typeof part.filename === "string" &&
    typeof part.file_data === "string"
  );
}

function clipToolResultParts(
  parts: ResponsesInputContentPart[],
): ResponsesInputContentPart[] | null {
  const encoded = utf8Encoder.encode(JSON.stringify(parts));
  return encoded.length <= MAX_TOOL_RESULT_PART_BYTES ? parts : null;
}

export class ToolDispatcher {
  constructor(private readonly registry: ToolRegistry) {}

  /**
   * Never rejects. Every failure mode (isEnabled/validate/handler/clip/
   * formatting throwing, timeout, cancellation) is converted into a bounded
   * error `role:"tool"` result.
   */
  async dispatch(
    call: INormalizedToolCall,
    options: IToolDispatchOptions,
  ): Promise<IToolDispatchOutcome> {
    try {
      return await this.dispatchInner(call, options);
    } catch (error) {
      try {
        return this.errorOutcome(
          call,
          "error",
          `Tool "${call.name}" failed: ${describeError(error)}`,
        );
      } catch {
        return {
          status: "error",
          toolMessage: { role: "tool", tool_call_id: call.id, content: FALLBACK_ERROR_MESSAGE },
        };
      }
    }
  }

  /**
   * Helper for the loop: bounded cancellation result for a call that was
   * never dispatched (or abandoned) because the request was cancelled.
   */
  buildCancelledOutcome(call: INormalizedToolCall): IToolDispatchOutcome {
    return this.errorOutcome(
      call,
      "cancelled",
      `Tool "${call.name}" was cancelled because the request was aborted; its execution outcome is unknown.`,
    );
  }

  private async dispatchInner(
    call: INormalizedToolCall,
    options: IToolDispatchOptions,
  ): Promise<IToolDispatchOutcome> {
    // Checked before every other branch, including `precomputedError`: the
    // loop can abandon a call after the request was cancelled while it was
    // still waiting on the (bounded) `beginToolBlock()` updater call, before
    // ever reaching this dispatch. A call in that state was never executed,
    // so its outcome must be reported as "cancelled" (unknown execution
    // outcome) rather than as a normal "error" — which is what every branch
    // below this point would otherwise produce regardless of cancellation.
    if (options.requestSignal?.aborted) {
      return this.buildCancelledOutcome(call);
    }

    if (call.precomputedError !== undefined) {
      return this.errorOutcome(call, "error", call.precomputedError);
    }

    if (!options.frozenToolNames.has(call.name)) {
      return this.errorOutcome(
        call,
        "error",
        `Tool "${call.name}" was not offered in this request and cannot be executed.`,
      );
    }

    const tool = this.registry.get(call.name);
    if (!tool) {
      return this.errorOutcome(call, "error", `Unknown tool: "${call.name}".`);
    }

    if (!tool.isEnabled(options.ctx)) {
      return this.errorOutcome(
        call,
        "error",
        `Tool "${call.name}" is not enabled in this context.`,
      );
    }

    const rawArguments = call.rawArguments.trim().length === 0 ? "{}" : call.rawArguments;
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(rawArguments);
    } catch {
      return this.errorOutcome(
        call,
        "error",
        `Invalid JSON arguments for tool "${call.name}": could not parse. Reconsider the arguments and try again.`,
      );
    }

    const validated = tool.validate(parsedArgs);
    if (!validated.ok) {
      return this.errorOutcome(
        call,
        "error",
        `Invalid arguments for tool "${call.name}": ${validated.error}`,
      );
    }

    return await this.executeWithGuards(tool, validated.value, call, options);
  }

  private async executeWithGuards(
    tool: IClientTool,
    args: unknown,
    call: INormalizedToolCall,
    options: IToolDispatchOptions,
  ): Promise<IToolDispatchOutcome> {
    const { requestSignal } = options;

    // Handler must not even be invoked once the request is already cancelled.
    if (requestSignal?.aborted) {
      return this.buildCancelledOutcome(call);
    }

    const timeoutMs = clampTimeoutMs(tool.timeoutMs);
    const timeoutController = new AbortController();
    const combinedSignal = requestSignal
      ? AbortSignal.any([requestSignal, timeoutController.signal])
      : timeoutController.signal;

    const meta: IToolInvocationMeta = {
      requestId: options.requestId,
      toolCallId: call.id,
      invocationId: crypto.randomUUID(),
    };

    console.info(`[tool] client tool invoked name=${tool.name}`);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onRequestAbort: (() => void) | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (onRequestAbort && requestSignal) {
        requestSignal.removeEventListener("abort", onRequestAbort);
        onRequestAbort = undefined;
      }
    };

    try {
      // Race-safe: the listener is armed first, then `aborted` is
      // rechecked synchronously (no await in between) so an abort that
      // lands in the check-to-arm gap is never lost.
      const requestCancelSignalled = new Promise<void>((resolve) => {
        if (!requestSignal) return; // never resolves: no request signal to race against
        onRequestAbort = () => resolve();
        requestSignal.addEventListener("abort", onRequestAbort);
        if (requestSignal.aborted) resolve();
      });

      const timeoutSignalled = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timeoutController.abort();
          resolve();
        }, timeoutMs);
      });

      const handlerSettled: Promise<HandlerSettlement> = tool
        .handler(args, options.ctx, combinedSignal, meta)
        .then(
          (value) => ({ ok: true as const, value }),
          (error) => ({ ok: false as const, error }),
        );

      await Promise.race([requestCancelSignalled, timeoutSignalled, handlerSettled]);

      // Classify by re-checking signal state (not by which promise "won"
      // the race), with priority request-cancel > timeout > handler result
      // — an abort that coincides with a handler settlement must still be
      // treated as cancel/timeout (design "handler が abort 起因で reject
      // しても cancel/timeout に分類").
      if (requestSignal?.aborted) {
        return this.buildCancelledOutcome(call);
      }
      if (timeoutController.signal.aborted) {
        return this.errorOutcome(
          call,
          "timeout",
          `Tool "${call.name}" timed out after ${timeoutMs}ms; its execution outcome is unknown (it may still complete or have side effects).`,
        );
      }

      // Neither signal aborted, so the race can only have resolved via the
      // handler settling.
      const settlement = await handlerSettled;
      if (!settlement.ok) {
        return this.errorOutcome(
          call,
          "error",
          `Tool "${call.name}" failed: ${describeError(settlement.error)}`,
        );
      }

      // `IToolHandlerResult.llmResult` only binds at compile time —
      // a handler is arbitrary tool-author code, so a runtime value that
      // doesn't actually match (e.g. `{ llmResult: undefined }`) must be
      // caught here. Otherwise it reaches the budget estimate (which
      // assumes a string) and produces a `status:"ok"` tool message whose
      // `content` isn't a string, silently dropping the required `content`
      // field from the next model request instead of failing loudly.
      const llmResult = settlement.value.llmResult;
      if (
        typeof llmResult !== "string" &&
        (!Array.isArray(llmResult) || !llmResult.every(isResponsesInputContentPart))
      ) {
        return this.errorOutcome(
          call,
          "error",
          `Tool "${call.name}" returned a non-string result or invalid parts; its output cannot be forwarded to the model.`,
        );
      }

      const budget = options.ctx.resultBudgetTokens;
      const estimated = estimateToolResultTokens(llmResult);
      const fixedLength =
        settlement.value.terminal === true &&
        typeof llmResult === "string" &&
        estimated <= FIXED_RESULT_TOKENS - CALL_ID_TOKEN_ALLOWANCE;
      if (typeof llmResult !== "string") {
        const bounded = clipToolResultParts(llmResult);
        if (bounded === null) {
          return this.errorOutcome(
            call,
            "error",
            `Tool "${call.name}" returned a result that exceeds the multimodal output limit.`,
          );
        }
        if (budget !== undefined && estimated > budget) {
          return this.resultTooLargeOutcome(call, estimated, budget);
        }
        return {
          status: "ok",
          toolMessage: {
            role: "tool",
            tool_call_id: call.id,
            content: bounded,
          },
          ...(settlement.value.render !== undefined && { render: settlement.value.render }),
        };
      }

      if (!fixedLength && budget !== undefined && estimated > budget) {
        return this.resultTooLargeOutcome(call, estimated, budget);
      }
      return {
        status: "ok",
        toolMessage: {
          role: "tool",
          tool_call_id: call.id,
          content: llmResult,
        },
        ...(settlement.value.render !== undefined && { render: settlement.value.render }),
      };
    } finally {
      cleanup();
    }
  }

  /**
   * For a call the loop does not run because an earlier result in the same
   * response was `result_too_large`.
   */
  buildStoppedOutcome(call: INormalizedToolCall): IToolDispatchOutcome {
    return this.errorOutcome(
      call,
      "error",
      '{"error":"client_tools_stopped","reason":"result_too_large"}',
    );
  }

  private resultTooLargeOutcome(
    call: INormalizedToolCall,
    estimatedTokens: number,
    budget: number,
  ): IToolDispatchOutcome {
    console.warn(
      `[tool] result over budget name=${call.name} estimated=${estimatedTokens} budget=${budget}`,
    );
    return {
      ...this.errorOutcome(
        call,
        "error",
        JSON.stringify({
          error: "result_too_large",
          estimated_tokens: estimatedTokens,
          budget: Math.max(0, Math.floor(budget)),
        }),
      ),
      resultTooLarge: true,
    };
  }

  private errorOutcome(
    call: INormalizedToolCall,
    status: Exclude<ToolDispatchStatus, "ok">,
    message: string,
  ): IToolDispatchOutcome {
    return {
      status,
      toolMessage: {
        role: "tool",
        tool_call_id: call.id,
        content: clipToolResultBytes(message, MAX_TOOL_ERROR_RESULT_BYTES),
      },
    };
  }
}
