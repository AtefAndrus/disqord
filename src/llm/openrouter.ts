import type { AppConfig } from "../config";
import {
  type AppError,
  AuthenticationError,
  BadRequestError,
  ConfigurationError,
  InsufficientCreditsError,
  InvalidModelError,
  ModelUnavailableError,
  ModerationError,
  RateLimitError,
  StreamProtocolError,
  TimeoutError,
  UnknownApiError,
} from "../errors";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  OpenRouterModel,
  StreamChunk,
  StreamFinalResult,
  StreamHeartbeatChunk,
  StreamToolCallChunk,
} from "../types";
import { logger } from "../utils/logger";
import { metrics } from "../utils/metrics";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_APP_URL = "https://github.com/AtefAndrus/disqord";
const OPENROUTER_APP_TITLE = "DisQord";
const OPENROUTER_APP_CATEGORIES = "general-chat";

/**
 * Maximum UTF-8 byte length for a single SSE line (either a completed
 * `data:`/comment/field line, or the unterminated carry buffer held across
 * reads). Guards against unbounded buffering on a malformed/malicious stream.
 */
export const MAX_SSE_FRAME_BYTES = 1024 * 1024; // 1 MiB

/**
 * Fixed per-fragment structural overhead charged to `carryBytes` for every
 * unterminated-line fragment retained across `read()`s, on top of its own
 * UTF-8 byte length. Mirrors `toolLoop.ts`'s `TOOL_CALL_FRAGMENT_OVERHEAD_BYTES`:
 * without it, a stream delivered at a granularity of one byte per `read()`
 * keeps the *actual* carried bytes far under `MAX_SSE_FRAME_BYTES` while
 * `carryParts` still grows by one string object per byte, unboundedly
 * consuming heap and CPU (a 1 MiB carry limit alone permits roughly a
 * million such fragments). Charging a flat cost per fragment bounds fragment
 * *count* itself by `MAX_SSE_FRAME_BYTES` (~32K fragments for a
 * one-byte-per-read stream) — this only bites pathologically small reads;
 * normal chunk sizes (hundreds of bytes or more) are unaffected.
 */
export const SSE_CARRY_FRAGMENT_OVERHEAD_BYTES = 32;

/**
 * Maximum accepted `tool_call.index` value on a stream delta. `index` keys
 * the in-progress-call accumulation map by numeric value, so any bound above
 * `Number.MAX_SAFE_INTEGER` would let two distinct indices round to the same
 * `number` (e.g. `2**53` and `2**53+1`) and have their fragments merge into
 * one accumulated call. A small fixed cap (well above any plausible number of
 * concurrent tool calls in a single turn) avoids relying on the edge of
 * safe-integer range at all.
 */
export const MAX_TOOL_CALL_INDEX = 4096;

const utf8Encoder = new TextEncoder();

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).length;
}

/**
 * Guards against unbounded buffering on a malformed/malicious stream: applied
 * to both a completed `data:`/comment/field line read during normal
 * draining and the unterminated carry buffer held across reads (including
 * the tail flushed at EOF — see `processSseLine()`'s caller in `chatStream()`).
 */
function assertFrameSize(text: string): void {
  if (utf8ByteLength(text) > MAX_SSE_FRAME_BYTES) {
    throw new StreamProtocolError("SSE frame exceeds the maximum allowed size");
  }
}

/** Mutable per-request state threaded through `processSseLine()` across calls. */
interface SseStreamState {
  fullText: string;
  lastModel: string | undefined;
  lastProvider: string | undefined;
  lastUsage: ChatCompletionResponse["usage"] | undefined;
  // undefined = no terminal finish_reason observed yet. Once set, the
  // stream is frozen: only [DONE]/comments/empty-choices usage chunks
  // are legal until EOF (see design "ストリーム終了の判定").
  finishReasonSeen: string | undefined;
}

/**
 * Runtime object-shape check for wire data. The JSON payload is untyped at
 * the wire (`JSON.parse(...) as StreamDelta` only asserts a shape, it never
 * validates one), so a provider sending e.g. `null` or a bare scalar where an
 * object is expected must be caught here — otherwise it either silently
 * corrupts state (e.g. `content: 123` stringified into `fullText`) or reaches
 * a property access on `null`/a primitive and throws a raw `TypeError`
 * instead of the documented "reject-never" `StreamProtocolError` contract.
 * Arrays are excluded: a JSON array is `typeof "object"` but never the
 * intended shape for `choice`/`delta`/a `tool_calls` element.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ILLMClient {
  chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  chatStream(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<
    StreamChunk | StreamToolCallChunk | StreamHeartbeatChunk | StreamFinalResult,
    void,
    void
  >;
  listModels(): Promise<string[]>;
  listModelsWithPricing(): Promise<OpenRouterModel[]>;
  getCredits(): Promise<{ remaining: number }>;
  isRateLimited(): boolean;
}

interface OpenRouterModelResponse {
  data: {
    id: string;
    name: string;
    created: number;
    context_length: number;
    pricing: {
      prompt: string;
      completion: string;
      image?: string;
      request?: string;
    };
    architecture?: {
      input_modalities?: string[];
      output_modalities?: string[];
      modality?: string;
      tokenizer?: string;
      instruct_type?: string | null;
    };
    supported_parameters?: string[];
  }[];
}

interface OpenRouterKeyResponse {
  data: {
    label: string;
    limit: number | null;
    limit_remaining: number | null;
    usage: number;
    is_free_tier: boolean;
  };
}

interface OpenRouterErrorResponse {
  error?: {
    // Most error events carry an integer HTTP-status-like code, but
    // OpenRouter's streaming docs also document symbolic string codes (e.g.
    // `"server_error"`) for some mid-stream disconnect events — both are a
    // legitimate wire shape, not a malformed frame.
    code?: number | string;
    message: string;
    metadata?: Record<string, unknown>;
  };
}

interface StreamDeltaToolCall {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface StreamDelta {
  id?: string;
  model?: string;
  provider?: string;
  choices: {
    index?: number;
    delta: {
      content?: string;
      role?: string;
      tool_calls?: StreamDeltaToolCall[];
      // Some providers surface finish_reason on the delta instead of the
      // choice; treated as a fallback (see resolveFinishReason).
      finish_reason?: string | null;
    };
    finish_reason?: string | null;
  }[];
  usage?: ChatCompletionResponse["usage"];
  // Mid-stream error event: sibling to `choices`, documented by OpenRouter.
  error?: OpenRouterErrorResponse["error"];
}

/**
 * Resolves the authoritative finish_reason for a chunk, preferring the
 * choice-level field and falling back to the delta-level field (provider
 * quirk). A non-null mismatch between the two is a protocol error.
 *
 * Both inputs are `unknown` (not the `string | null | undefined` the
 * `StreamDelta` interface claims) because that interface is only a
 * compile-time assertion over untyped wire JSON — a provider sending e.g.
 * `finish_reason: 42` is not caught by the type system. Rejecting a
 * non-string/non-null value here, before this function's caller mutates
 * `state` or yields anything, keeps this frame subject to the same
 * whole-frame validation as every other field: a frame with valid `content`
 * alongside a malformed `finish_reason` must fail without ever staging that
 * content to the caller.
 */
function resolveFinishReason(choiceFinish: unknown, deltaFinish: unknown): string | null {
  for (const [value, fieldName] of [
    [choiceFinish, "choice.finish_reason"],
    [deltaFinish, "delta.finish_reason"],
  ] as const) {
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new StreamProtocolError(
        `${fieldName} must be a string or null, got: ${JSON.stringify(value)}`,
      );
    }
  }
  const choice = choiceFinish as string | null | undefined;
  const delta = deltaFinish as string | null | undefined;
  if (choice != null && delta != null && choice !== delta) {
    throw new StreamProtocolError(
      `finish_reason mismatch between choice (${choice}) and delta (${delta})`,
    );
  }
  return choice ?? delta ?? null;
}

/**
 * Runtime validation for `chunk.model`/`chunk.provider`. Untyped wire JSON
 * like every other field here: a provider sending e.g. `model: {}` must be
 * rejected before it ever reaches `state.lastModel`, which a later footer
 * render stringifies verbatim (`[object Object]`) or, for a value with no
 * sane string coercion, throws a raw TypeError downstream instead of the
 * documented protocol-error contract. `null` is treated the same as absent
 * — callers only assign a truthy value, so a `null` here still results in no
 * assignment, matching the "not present on this chunk" convention every
 * other optional field on `StreamDelta` already follows.
 */
function assertValidOptionalStringField(value: unknown, fieldName: string): void {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new StreamProtocolError(
      `${fieldName} must be a string or null, got: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Runtime validation for a chunk's `usage` field. Like every other field
 * parsed off the wire here, `usage` is untyped JSON at runtime — a provider
 * sending e.g. `cost:"bad"` or `prompt_tokens:"1"` must be rejected here,
 * otherwise it is stored as-is and only surfaces once a downstream consumer
 * reads it: `buildUsageDetailsText()`'s `.toFixed()` throws a raw TypeError
 * on a non-number `cost`, and turn aggregation (`+=`) silently produces a
 * corrupted string total instead of failing loudly with the documented
 * protocol-error contract.
 *
 * Token counts are further constrained to non-negative safe integers (not
 * merely "finite"): a negative or fractional token count is nonsensical, and
 * left unchecked it flows straight into `toolLoop.ts`'s cross-turn `+=`
 * aggregation, corrupting a total that is otherwise safe to sum. `cost` stays
 * a plain non-negative finite-number check — it's a monetary amount, not a
 * count, so fractional values are expected.
 */
function assertValidUsage(
  usage: unknown,
): asserts usage is NonNullable<ChatCompletionResponse["usage"]> {
  if (!isPlainObject(usage)) {
    throw new StreamProtocolError(`Stream chunk usage is not an object: ${JSON.stringify(usage)}`);
  }
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
    const value = usage[key];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new StreamProtocolError(
        `usage.${key} must be a non-negative safe integer, got: ${JSON.stringify(value)}`,
      );
    }
  }
  if (usage.cost !== undefined && (!Number.isFinite(usage.cost) || (usage.cost as number) < 0)) {
    throw new StreamProtocolError(
      `usage.cost must be a non-negative finite number, got: ${JSON.stringify(usage.cost)}`,
    );
  }
  const detailChecks: readonly [detailsKey: string, innerKey: string][] = [
    ["prompt_tokens_details", "cached_tokens"],
    ["completion_tokens_details", "reasoning_tokens"],
  ];
  for (const [detailsKey, innerKey] of detailChecks) {
    const details = usage[detailsKey];
    if (details === undefined) continue;
    if (!isPlainObject(details)) {
      throw new StreamProtocolError(
        `usage.${detailsKey} is not an object: ${JSON.stringify(details)}`,
      );
    }
    const inner = details[innerKey];
    if (inner !== undefined && (!Number.isSafeInteger(inner) || (inner as number) < 0)) {
      throw new StreamProtocolError(
        `usage.${detailsKey}.${innerKey} must be a non-negative safe integer, got: ${JSON.stringify(inner)}`,
      );
    }
  }
}

export class OpenRouterClient implements ILLMClient {
  private rateLimitResetAt: number | null = null;

  constructor(private readonly apiKey: string) {}

  static fromConfig(config: AppConfig): OpenRouterClient {
    return new OpenRouterClient(config.openRouterApiKey);
  }

  isRateLimited(): boolean {
    if (this.rateLimitResetAt === null) {
      return false;
    }
    if (Date.now() >= this.rateLimitResetAt) {
      this.rateLimitResetAt = null;
      return false;
    }
    return true;
  }

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    if (this.isRateLimited()) {
      const retryAfterSeconds = this.rateLimitResetAt
        ? Math.max(0, Math.ceil((this.rateLimitResetAt - Date.now()) / 1000))
        : undefined;
      throw new RateLimitError("Rate limited. Please try again later.", retryAfterSeconds);
    }

    metrics.increment("openrouter.requests");
    try {
      const { plugins, tools, tool_choice, parallel_tool_calls, ...rest } = request;
      const hasTools = Array.isArray(tools) && tools.length > 0;
      const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": OPENROUTER_APP_URL,
          "X-OpenRouter-Title": OPENROUTER_APP_TITLE,
          "X-OpenRouter-Categories": OPENROUTER_APP_CATEGORIES,
        },
        body: JSON.stringify({
          ...rest,
          ...(plugins && { plugins }),
          ...(hasTools && {
            tools,
            ...(tool_choice !== undefined && { tool_choice }),
            ...(parallel_tool_calls !== undefined && { parallel_tool_calls }),
          }),
          usage: {
            include: true,
          },
        }),
      });

      if (!response.ok) {
        await this.handleErrorResponse(response);
      }

      const data = (await response.json()) as ChatCompletionResponse;
      return data;
    } catch (err) {
      metrics.increment("openrouter.errors");
      throw err;
    }
  }

  async *chatStream(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<
    StreamChunk | StreamToolCallChunk | StreamHeartbeatChunk | StreamFinalResult,
    void,
    void
  > {
    if (this.isRateLimited()) {
      const retryAfterSeconds = this.rateLimitResetAt
        ? Math.max(0, Math.ceil((this.rateLimitResetAt - Date.now()) / 1000))
        : undefined;
      throw new RateLimitError("Rate limited. Please try again later.", retryAfterSeconds);
    }

    metrics.increment("openrouter.requests");
    try {
      const { plugins, tools, tool_choice, parallel_tool_calls, ...rest } = request;
      const hasTools = Array.isArray(tools) && tools.length > 0;
      const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": OPENROUTER_APP_URL,
          "X-OpenRouter-Title": OPENROUTER_APP_TITLE,
          "X-OpenRouter-Categories": OPENROUTER_APP_CATEGORIES,
        },
        body: JSON.stringify({
          ...rest,
          ...(plugins && { plugins }),
          ...(hasTools && {
            tools,
            ...(tool_choice !== undefined && { tool_choice }),
            ...(parallel_tool_calls !== undefined && { parallel_tool_calls }),
          }),
          stream: true,
          usage: {
            include: true,
          },
        }),
        signal,
      });

      if (!response.ok) {
        await this.handleErrorResponse(response);
      }

      if (!response.body) {
        throw new UnknownApiError("Response body is null", 0);
      }

      const reader = response.body.getReader();
      // `fatal: true` rejects an invalid/truncated byte sequence instead of
      // silently substituting U+FFFD for it. A non-fatal decoder would let a
      // corrupted byte inside a JSON string survive as `�`, which can still
      // parse as valid JSON and pass every field-shape check below — so a
      // transport-level bit error could reach a tool handler as a subtly
      // wrong argument instead of failing loudly as the protocol violation it
      // actually is.
      const decoder = new TextDecoder("utf-8", { fatal: true });
      // Wraps `decoder.decode()` so the DOMException it throws on invalid
      // UTF-8 (from either a mid-stream chunk or the final EOF flush) is
      // reported through this client's documented "reject-never" contract
      // (StreamProtocolError) instead of an undocumented raw DOMException.
      const decodeOrThrow = (chunk?: Uint8Array): string => {
        try {
          return chunk !== undefined ? decoder.decode(chunk, { stream: true }) : decoder.decode();
        } catch (err) {
          throw new StreamProtocolError(
            `Invalid UTF-8 byte sequence in stream: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };
      // Accumulates the not-yet-line-terminated tail across reads, as an
      // array of fragments joined into one string only once a line
      // terminator (`\n`, `\r`, or `\r\n` — see the main read loop below)
      // finally arrives (not a single ever-growing `+=` string). Only this
      // read's own decoded chunk is ever scanned for a terminator — the
      // carry itself is never re-scanned — so a line delivered unterminated
      // across many reads costs O(chunk) per read instead of O(carry-so-far)
      // per read (which would total O(n^2) CPU by the time the 1 MiB guard
      // finally trips).
      let carryParts: string[] = [];
      // Running UTF-8 byte length of `carryParts` joined, maintained
      // incrementally so the 1 MiB guard never needs to re-encode the whole
      // carry either.
      let carryBytes = 0;
      const state: SseStreamState = {
        fullText: "",
        lastModel: undefined,
        lastProvider: undefined,
        lastUsage: undefined,
        finishReasonSeen: undefined,
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const decoded = decodeOrThrow(value);
          let searchStart = 0;
          while (true) {
            // The SSE spec (and this codebase's "CR/CRLF/LF どれでも受理する"
            // requirement) treats CR, LF, and CRLF all as line terminators —
            // scanning for `\n` alone would stall forever (carry growing
            // unbounded) on a CR-only stream. Pick whichever of `\n`/`\r`
            // occurs first from `searchStart`; a CRLF pair is handled for
            // free by this loop itself, with no special-casing needed: the CR
            // ends the line first, then the very next iteration finds the LF
            // immediately at the new `searchStart` and yields a zero-length
            // line, which `processSseLine()` already treats as a no-op blank
            // line (SSE dispatch boundary).
            const lfIndex = decoded.indexOf("\n", searchStart);
            const crIndex = decoded.indexOf("\r", searchStart);
            const lineEnd =
              lfIndex === -1 ? crIndex : crIndex === -1 ? lfIndex : Math.min(lfIndex, crIndex);
            if (lineEnd === -1) break;

            let line: string;
            if (carryParts.length > 0) {
              // First line completed by this chunk: join the carry (built
              // from possibly many prior reads) with just this chunk's
              // prefix. This join runs once per completed line, not once per
              // read, so its cost is bounded by the final line's size.
              carryParts.push(decoded.slice(searchStart, lineEnd));
              line = carryParts.join("");
              carryParts = [];
              carryBytes = 0;
            } else {
              line = decoded.slice(searchStart, lineEnd);
            }
            assertFrameSize(line);
            const stop = yield* this.processSseLine(line, state);
            if (stop) return;
            searchStart = lineEnd + 1;
          }

          // Whatever remains after this chunk's last line terminator (or the
          // whole chunk, if it had none) becomes carry for the next read.
          // `TextDecoder` with `stream: true` never emits a partial code
          // point (it holds a split multi-byte sequence back until the bytes
          // completing it arrive), so adding this remainder's byte length to
          // `carryBytes` is exact regardless of how many prior fragments
          // make up the carry. A CR at the very end of this chunk (the CRLF
          // split across a chunk boundary, LF arriving in the next read) is
          // simply carried forward like any other unterminated tail — the
          // next read's leading `\n` is then found at the new carry-relative
          // `searchStart` of 0 and, per the CRLF handling above, yields the
          // same harmless zero-length blank line.
          const remainder = decoded.slice(searchStart);
          if (remainder.length > 0) {
            carryParts.push(remainder);
            // Charged per accepted fragment, not just per byte (see
            // `SSE_CARRY_FRAGMENT_OVERHEAD_BYTES`'s doc comment): bounds
            // `carryParts.length` itself, not just its total byte content.
            carryBytes += utf8ByteLength(remainder) + SSE_CARRY_FRAGMENT_OVERHEAD_BYTES;
            if (carryBytes > MAX_SSE_FRAME_BYTES) {
              throw new StreamProtocolError("SSE frame exceeds the maximum allowed size");
            }
          }
        }

        // EOF reached. `decoder.decode()` with no argument flushes any
        // pending bytes the decoder was holding onto internally (e.g. a
        // multi-byte UTF-8 sequence truncated mid-character by the final
        // `read()`), so they aren't silently lost. The resulting carry is
        // whatever was left over from the main loop above — never processed
        // as a line because it was never newline-terminated. Processing it
        // here the same way a normal line is processed ensures a
        // fully-formed but newline-less `data:` line right at EOF is still
        // parsed, and a truncated/malformed one still fails loudly
        // (StreamProtocolError) instead of being dropped — both the
        // "terminal 後は usage/comment のみ許容" rule and the
        // malformed-frame contract apply here too.
        const eofTail = decodeOrThrow();
        if (eofTail.length > 0) carryParts.push(eofTail);
        if (carryParts.length > 0) {
          const finalLine = carryParts.join("");
          assertFrameSize(finalLine);
          const stop = yield* this.processSseLine(finalLine, state);
          if (stop) return;
        }

        // Handle case where stream ends without [DONE]. A clean EOF after a
        // terminal finish_reason was observed is a normal completion.
        yield {
          done: true,
          fullText: state.fullText,
          usage: state.lastUsage,
          model: state.lastModel,
          provider: state.lastProvider,
          finishReason: state.finishReasonSeen,
        };
      } finally {
        // Fire-and-forget, not awaited: `cancel()` is still always called —
        // on a throw/return path a still-open response body would otherwise
        // linger with no consumer if the server keeps the connection alive —
        // but its underlying cancel algorithm can hang indefinitely on an
        // unresponsive/broken connection. Awaiting it here would block this
        // `finally` (and therefore this generator's own finalize) on that
        // hang, which in turn blocks every caller's `iterator.return()` —
        // exactly the caller-side stall this generator's cleanup must not
        // cause. `.catch()` keeps a rejection from becoming an unhandled
        // rejection later. `releaseLock()` does not need to wait for cancel
        // to settle — it only detaches this reader from the stream — so it
        // runs synchronously right after, keeping this `finally` itself
        // synchronous and the generator finalized immediately.
        reader.cancel().catch(() => {
          // Cancellation failing must not mask the turn's real outcome.
        });
        try {
          reader.releaseLock();
        } catch {
          // releaseLock() throwing must not mask the turn's real outcome.
        }
      }
    } catch (err) {
      metrics.increment("openrouter.errors");
      throw err;
    }
  }

  /**
   * Parses and applies one already-decoded, presumed-complete SSE line,
   * mutating `state` in place and yielding any content/tool-call/final
   * chunks it produces. Shared by `chatStream()`'s main per-`read()` loop
   * and its EOF flush of the trailing carry buffer (see the two call sites
   * in `chatStream()`) so a newline-less line right before EOF goes through
   * exactly the same validation as any other line instead of being silently
   * dropped. Returns `true` when `line` was `data: [DONE]` — the final
   * result was already yielded by this call, and the caller must stop
   * draining immediately (`return`) rather than yield its own fallback final
   * result.
   *
   * Every field of a `data:` frame (delta shape, content type, the
   * `tool_calls` array and each element's shape/types/index, finish_reason
   * resolution and post-terminal freeze, `usage`) is validated *before* this
   * method mutates `state` (`fullText`, `finishReasonSeen`, `lastUsage`, ...)
   * or yields anything derived from the frame. Without this ordering, a
   * single frame that is partly valid and partly malformed — e.g. legitimate
   * `content` alongside a malformed `tool_calls` entry — could have its valid
   * part (`content`) staged to the caller (and `fullText` mutated) before the
   * malformed part is even reached, so the frame ends up "half applied" right
   * before the whole call throws. Each early-return branch below (comment,
   * non-`data:` field line, blank line, `[DONE]`, empty-`choices` trailer,
   * absent `choices[0]`) is already fully validated by the time it is
   * reached, so it mutates+yields immediately; only the main
   * single-choice/delta path defers its mutations+yields to the end.
   */
  private *processSseLine(
    line: string,
    state: SseStreamState,
  ): Generator<
    StreamChunk | StreamToolCallChunk | StreamHeartbeatChunk | StreamFinalResult,
    boolean,
    void
  > {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false; // blank line: SSE dispatch boundary, not a payload
    if (trimmed.startsWith(":")) {
      // SSE comment line (e.g. OpenRouter's `: OPENROUTER PROCESSING`
      // keep-alive). Carries no data, but yielding it lets a consumer
      // measuring inter-chunk gaps (idle timeout) see the stream is still
      // alive during a heartbeat-only lull instead of timing it out.
      // Always allowed, including after a terminal finish_reason (state is
      // never consulted here) — same "comments are never subject to the
      // post-terminal freeze" rule as before this chunk started being
      // yielded at all.
      yield { heartbeat: true, done: false };
      return false;
    }
    if (!trimmed.startsWith("data:")) {
      // Other non-empty SSE field lines (`event:`/`id:`/`retry:`/...). This
      // client has no use for their value, but — exactly like a comment line
      // — receiving one is proof the connection is still alive. A named-event
      // stream that only ever sends these between `data:` frames (e.g. an
      // intermediary emitting `event: ping` keep-alives instead of SSE
      // comments) must not starve the idle-timeout liveness signal in
      // `toolLoop.ts` just because this client doesn't otherwise interpret
      // the field.
      yield { heartbeat: true, done: false };
      return false;
    }

    // Per the SSE spec, a single space directly after the colon is
    // optional and stripped if present; any further leading
    // whitespace is part of the field value itself.
    let data = trimmed.slice(5);
    if (data.startsWith(" ")) {
      data = data.slice(1);
    }
    if (data === "[DONE]") {
      yield {
        done: true,
        fullText: state.fullText,
        usage: state.lastUsage,
        model: state.lastModel,
        provider: state.lastProvider,
        finishReason: state.finishReasonSeen,
      };
      return true;
    }

    let parsedData: unknown;
    try {
      parsedData = JSON.parse(data);
    } catch {
      throw new StreamProtocolError(`Malformed SSE data frame: ${data}`);
    }
    // A top-level frame that parses but isn't an object (e.g. `null`, a bare
    // number) must not reach the property accesses below (`chunk.error`,
    // `chunk.choices`, ...), which would throw a raw TypeError on `null`
    // instead of the documented protocol-error contract.
    if (!isPlainObject(parsedData)) {
      throw new StreamProtocolError(`Stream chunk is not an object: ${JSON.stringify(parsedData)}`);
    }
    const chunk = parsedData as unknown as StreamDelta;

    if (chunk.error) {
      // Once a terminal `finish_reason` has been observed, the only frames
      // this stream still tolerates are `[DONE]`/comments/the usage trailer
      // (see the `finishReasonSeen` freeze check further below, applied to
      // `choices` frames) — an `error` event arriving after that point is
      // not the API reporting a genuine failure for a turn already declared
      // done, so it must fail as a protocol violation here rather than being
      // mapped through `throwForStreamErrorPayload()` to an API error class
      // (e.g. `InsufficientCreditsError`) that would misrepresent an
      // otherwise-successfully-completed turn as having errored.
      if (state.finishReasonSeen !== undefined) {
        throw new StreamProtocolError("received an error event after terminal finish_reason");
      }
      // `chunk.error` is only typed as `{code,message,...}` at compile time —
      // the wire payload is untyped, so a provider sending e.g. a bare string
      // must be caught here rather than reach `throwForStreamErrorPayload()`,
      // which destructures `message` and would otherwise pass `undefined`
      // straight into `buildApiError()`.
      if (!isPlainObject(chunk.error) || typeof chunk.error.message !== "string") {
        throw new StreamProtocolError(
          `Stream error event is malformed: ${JSON.stringify(chunk.error)}`,
        );
      }
      // `code` is untyped at the wire like every other field here: OpenRouter's
      // streaming docs document both an integer HTTP-status-like code and a
      // symbolic string code (e.g. `"server_error"`) as legitimate shapes, so
      // only a value that is neither is a genuine protocol violation (e.g. a
      // boolean or a float). A missing `code` is left alone — that's the
      // pre-existing, still-supported shape — and falls through to
      // `throwForStreamErrorPayload()`'s own handling.
      if (
        chunk.error.code !== undefined &&
        !Number.isInteger(chunk.error.code) &&
        typeof chunk.error.code !== "string"
      ) {
        throw new StreamProtocolError(
          `Stream error event has a non-integer, non-string code: ${JSON.stringify(chunk.error.code)}`,
        );
      }
      this.throwForStreamErrorPayload(chunk.error); // always throws
    }

    // ---- Validation phase: every field below is checked (and, for
    // `usage`/`tool_calls`, normalized into a local value) without touching
    // `state` or yielding anything. A throw anywhere in this phase leaves
    // `state` exactly as it was before this line was processed. ----

    // Checked here — ahead of every branch below, including the
    // empty-`choices`/absent-`choices[0]` usage-only trailers, which also
    // read `chunk.model`/`chunk.provider` — so a malformed value on any kind
    // of data frame is rejected before it can be committed to `state`.
    assertValidOptionalStringField(chunk.model, "model");
    assertValidOptionalStringField(chunk.provider, "provider");

    // `usage` counts as "absent" only for a missing key or an explicit
    // `null` — OpenAI-compatible streams conventionally send `usage: null`
    // on every non-final chunk ahead of the terminal usage trailer, and that
    // must keep being tolerated. A truthy-guard (`if (chunk.usage)`) instead
    // let any other falsy value (`false`/`0`/`""`) through as "absent" too,
    // silently skipping validation for a malformed-but-present field.
    let validatedUsage: ChatCompletionResponse["usage"] | undefined;
    if (chunk.usage !== undefined && chunk.usage !== null) {
      assertValidUsage(chunk.usage);
      validatedUsage = chunk.usage;
    }

    if (!Array.isArray(chunk.choices)) {
      // A missing/non-array `choices` is structurally invalid, not
      // the documented usage-trailer exception — that exception is
      // specifically an *empty array* (see below), not an absent key.
      throw new StreamProtocolError(
        "Stream chunk is missing a `choices` array (and is not an error event).",
      );
    }

    if (chunk.choices.length === 0) {
      // Empty `choices` is only the documented usage-only trailer shape when
      // it actually carries `usage` — see the module-level fix note on
      // `assertFrameSize`'s neighbors: without a `usage` payload, an empty
      // `choices` array has no defined meaning and must not be silently
      // accepted as a heartbeat (that would let a malformed/adversarial
      // stream reset the idle timer indefinitely with content-free frames).
      if (validatedUsage === undefined) {
        throw new StreamProtocolError(
          "Stream chunk has an empty `choices` array without a `usage` payload " +
            "(the only documented shape for an empty-choices frame is the usage trailer).",
        );
      }
      // Fully validated at this point, so commit + yield now. `usage` is
      // attached to the heartbeat itself (not just `state.lastUsage`) so a
      // caller that never reaches the terminal chunk (cancelled or errored
      // before `[DONE]`) can still observe the usage this trailer carried —
      // see `StreamHeartbeatChunk`'s doc comment.
      if (chunk.model) state.lastModel = chunk.model;
      if (chunk.provider) state.lastProvider = chunk.provider;
      state.lastUsage = validatedUsage;
      yield { heartbeat: true, done: false, usage: validatedUsage };
      return false;
    }

    // We always request/expect exactly one choice (no `n` parameter is ever
    // sent); a provider sending more than one is a protocol violation, not a
    // shape this client can silently narrow by only reading `choices[0]`.
    if (chunk.choices.length > 1) {
      throw new StreamProtocolError(
        `Stream chunk has more than one choice (expected exactly 1): ${chunk.choices.length}`,
      );
    }

    if (state.finishReasonSeen !== undefined) {
      throw new StreamProtocolError("received additional stream data after terminal finish_reason");
    }

    const choice = chunk.choices[0];
    if (choice === undefined) {
      // Fully validated at this point, same as the empty-choices branch above
      // (including attaching `usage` to the heartbeat itself, if present).
      if (chunk.model) state.lastModel = chunk.model;
      if (chunk.provider) state.lastProvider = chunk.provider;
      if (validatedUsage !== undefined) state.lastUsage = validatedUsage;
      yield {
        heartbeat: true,
        done: false,
        ...(validatedUsage !== undefined && { usage: validatedUsage }),
      };
      return false;
    }
    // `choice` (including `null`) must be an object before any
    // property on it is read — otherwise malformed input (e.g.
    // `choices: [null]`) reaches `choice.index` below and throws a
    // raw TypeError instead of the documented protocol error.
    if (!isPlainObject(choice)) {
      throw new StreamProtocolError(`Stream choice is not an object: ${JSON.stringify(choice)}`);
    }
    if (choice.index !== undefined && choice.index !== 0) {
      throw new StreamProtocolError(`unexpected choice index: ${choice.index}`);
    }

    // `delta` must be present (an object, `{}` included) on a non-empty
    // choice — it is the only field this client relies on to know a frame
    // is a legitimate incremental update rather than a content-free shell.
    // Without this, a frame like `{choices:[{finish_reason:"stop"}]}` (no
    // `delta` at all) would still fall through to the "accepted but nothing
    // to yield" heartbeat path below, letting a stream that only ever sends
    // such shells reset the idle timer indefinitely with frames that carry
    // no actual delta payload.
    const delta = choice.delta;
    if (!isPlainObject(delta)) {
      throw new StreamProtocolError(
        `Stream choice.delta must be an object, got: ${JSON.stringify(delta)}`,
      );
    }
    const content = delta.content;
    // A non-string/non-null `content` (e.g. a bare number) must not
    // silently pass through `if (content)` and get concatenated into
    // `fullText` (which coerces it to a string) — that would let the
    // stream "succeed" with corrupted text instead of failing.
    if (content !== undefined && content !== null && typeof content !== "string") {
      throw new StreamProtocolError(
        `delta.content must be a string or null, got: ${JSON.stringify(content)}`,
      );
    }

    const toolCalls = delta?.tool_calls;
    if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
      throw new StreamProtocolError(
        `delta.tool_calls must be an array, got: ${JSON.stringify(toolCalls)}`,
      );
    }

    // Validated and normalized here, but not yielded yet: a later tool_call
    // entry in this same frame failing validation must not leave an earlier
    // entry's chunk already yielded (see the method-level comment).
    const normalizedToolCalls: StreamToolCallChunk["toolCall"][] = [];
    for (const toolCall of toolCalls ?? []) {
      if (!isPlainObject(toolCall)) {
        throw new StreamProtocolError(
          `tool_call entry is not an object: ${JSON.stringify(toolCall)}`,
        );
      }
      if (
        !Number.isSafeInteger(toolCall.index) ||
        toolCall.index < 0 ||
        toolCall.index > MAX_TOOL_CALL_INDEX
      ) {
        throw new StreamProtocolError(`invalid tool_call index: ${toolCall.index}`);
      }
      // The JSON payload is untyped at the wire: a provider sending a
      // non-string id/name/arguments (e.g. a bare number) must fail
      // here rather than reach normalizeToolCalls(), whose
      // `call.name.trim()` assumes a string and would throw instead
      // of producing the "reject-never" status:"error" contract.
      if (toolCall.id !== undefined && typeof toolCall.id !== "string") {
        throw new StreamProtocolError(
          `tool_call.id must be a string, got: ${JSON.stringify(toolCall.id)}`,
        );
      }
      if (toolCall.type !== undefined && toolCall.type !== "function") {
        throw new StreamProtocolError(
          `unsupported tool_call.type: ${JSON.stringify(toolCall.type)}`,
        );
      }
      // A present-but-non-object `function` (e.g. a bare string) must not be
      // treated the same as an absent one: `toolCall.function?.name` below
      // would silently read `undefined` off it instead of rejecting the frame.
      if (toolCall.function !== undefined && !isPlainObject(toolCall.function)) {
        throw new StreamProtocolError(
          `tool_call.function is not an object: ${JSON.stringify(toolCall.function)}`,
        );
      }
      if (toolCall.function?.name !== undefined && typeof toolCall.function.name !== "string") {
        throw new StreamProtocolError(
          `tool_call.function.name must be a string, got: ${JSON.stringify(toolCall.function.name)}`,
        );
      }
      if (
        toolCall.function?.arguments !== undefined &&
        typeof toolCall.function.arguments !== "string"
      ) {
        throw new StreamProtocolError(
          `tool_call.function.arguments must be a string, got: ${JSON.stringify(toolCall.function.arguments)}`,
        );
      }
      normalizedToolCalls.push({
        index: toolCall.index,
        ...(toolCall.id !== undefined && { id: toolCall.id }),
        ...(toolCall.function?.name !== undefined && {
          name: toolCall.function.name,
        }),
        ...(toolCall.function?.arguments !== undefined && {
          argumentsDelta: toolCall.function.arguments,
        }),
      });
    }

    // Resolving finish_reason can itself throw (choice/delta mismatch); doing
    // so here keeps it inside the validation phase, before any mutation.
    const finishReason = resolveFinishReason(choice.finish_reason, delta?.finish_reason);

    // ---- Apply phase: every element of this frame validated successfully,
    // so `state` is now mutated and the frame's chunks are yielded. ----
    if (chunk.model) state.lastModel = chunk.model;
    if (chunk.provider) state.lastProvider = chunk.provider;
    if (validatedUsage !== undefined) state.lastUsage = validatedUsage;

    // Set once this frame actually yields a content/tool_call chunk to the
    // caller. A `data:` frame that is accepted (parses, passes every
    // validation) but carries nothing a consumer can see — a role-only or
    // reasoning-only delta, a usage-only trailer, a finish_reason-only
    // terminal frame — must still surface *something*, or a stream that only
    // ever sends these (e.g. a reasoning model streaming reasoning deltas,
    // or a slow usage trailer arriving long after the last content) starves
    // the idle-timeout liveness signal in `toolLoop.ts` even though the
    // connection is perfectly healthy. Reusing the heartbeat chunk type
    // means the loop's existing heartbeat branch (idle reset + continue)
    // handles it with no changes there.
    let yieldedPayload = false;
    if (content) {
      state.fullText += content;
      yield { content, done: false };
      yieldedPayload = true;
    }
    for (const toolCall of normalizedToolCalls) {
      yield { toolCall, done: false };
      yieldedPayload = true;
    }
    if (finishReason !== null) {
      state.finishReasonSeen = finishReason;
    }

    // Frame was accepted (parsed, validated, no error) but never yielded a
    // content/tool_call chunk above — e.g. a role-only or reasoning-only
    // delta, or a finish_reason-only terminal frame. See the comment at
    // `yieldedPayload`'s declaration for why this must still yield. `usage`
    // is attached here too on the rare frame that pairs a content-free
    // choice with a top-level `usage` sibling — see `StreamHeartbeatChunk`'s
    // doc comment for why the heartbeat itself (not just `state.lastUsage`)
    // carries it.
    if (!yieldedPayload) {
      yield {
        heartbeat: true,
        done: false,
        ...(validatedUsage !== undefined && { usage: validatedUsage }),
      };
    } else if (validatedUsage !== undefined) {
      // Frame yielded content/tool_call above *and* carries `usage`. That
      // usage was already committed to `state.lastUsage`, but `toolLoop.ts`
      // only tracks a turn's "usage observed so far" off heartbeat chunks
      // (see `StreamHeartbeatChunk`'s doc comment) — a content/tool_call
      // chunk alone doesn't update it. Without this extra yield, a
      // cancel/malformed frame landing between this frame and `[DONE]` would
      // lose this frame's usage from the early-exit `ToolLoopResult` even
      // though `state.lastUsage` (and thus a normal completion) has it. Kept
      // as its own chunk, after the payload, rather than merged onto it: the
      // payload chunk types (`StreamChunk`/`StreamToolCallChunk`) carry no
      // `usage` field, and this frame already took the `!yieldedPayload`
      // branch's heartbeat if it had nothing else to yield, so exactly one
      // heartbeat is ever yielded per frame.
      yield { heartbeat: true, done: false, usage: validatedUsage };
    }

    return false;
  }

  async listModels(): Promise<string[]> {
    const models = await this.listModelsWithPricing();
    return models.map((model) => model.id);
  }

  async listModelsWithPricing(): Promise<OpenRouterModel[]> {
    const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      logger.error("Failed to fetch models", { status: response.status });
      return [];
    }

    const data = (await response.json()) as OpenRouterModelResponse;
    return data.data.map((model) => ({
      id: model.id,
      name: model.name,
      created: model.created,
      contextLength: model.context_length,
      pricing: model.pricing,
      inputModalities: model.architecture?.input_modalities ?? [],
      outputModalities: model.architecture?.output_modalities ?? [],
      ...(model.supported_parameters && { supportedParameters: model.supported_parameters }),
    }));
  }

  async getCredits(): Promise<{ remaining: number }> {
    const response = await fetch(`${OPENROUTER_BASE_URL}/key`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      logger.error("Failed to fetch credits", { status: response.status });
      return { remaining: 0 };
    }

    const data = (await response.json()) as OpenRouterKeyResponse;
    return { remaining: data.data.limit_remaining ?? Number.POSITIVE_INFINITY };
  }

  private async handleErrorResponse(response: Response): Promise<never> {
    const errorBody = (await response.json().catch(() => ({}))) as OpenRouterErrorResponse;
    const message = errorBody.error?.message ?? `HTTP ${response.status}`;
    const metadata = errorBody.error?.metadata;

    // Log error with metadata if available
    logger.error("OpenRouter API error", {
      status: response.status,
      message,
      ...(metadata && { metadata }),
    });

    if (response.status === 429) {
      const resetHeader = response.headers.get("X-RateLimit-Reset");
      let retryAfterSeconds: number | undefined;
      if (resetHeader) {
        // ユーザーレベル制限 → グローバルフラグセット
        const resetAt = Number.parseInt(resetHeader, 10);
        this.rateLimitResetAt = resetAt;
        retryAfterSeconds = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
      }
      // ヘッダーなし（プロバイダー制限）→ フラグセットしない
      throw new RateLimitError(message, retryAfterSeconds);
    }

    throw this.buildApiError(response.status, message);
  }

  /**
   * Mid-stream error event (`{error:{code,message,...}}`, sibling to
   * `choices`). An integer `code` is mapped to the same error classes as
   * HTTP-level failures via `buildApiError()`. A symbolic string `code`
   * (e.g. `"server_error"`, a documented OpenRouter provider-disconnect
   * shape) has no corresponding HTTP status to map through that switch, so
   * it surfaces as the generic fallback API error instead — this is still a
   * real upstream error to report, not a protocol violation.
   */
  private throwForStreamErrorPayload(
    payload: NonNullable<OpenRouterErrorResponse["error"]>,
  ): never {
    const { code, message, metadata } = payload;
    logger.error("OpenRouter stream error event", {
      code,
      message,
      ...(metadata && { metadata }),
    });
    if (typeof code === "string") {
      throw new UnknownApiError(message);
    }
    throw this.buildApiError(code, message);
  }

  /** Maps an OpenRouter error code + message to the corresponding AppError subclass. */
  private buildApiError(status: number | undefined, message: string): AppError {
    switch (status) {
      case 400:
        if (message.includes("is not a valid model ID")) {
          return new InvalidModelError(message);
        }
        if (message.includes("data policy") || message.includes("Configure:")) {
          const configUrl = message.match(/https:\/\/openrouter\.ai\/[^\s]+/)?.[0];
          return new ConfigurationError(message, configUrl);
        }
        return new BadRequestError(message);

      case 401:
        return new AuthenticationError(message);

      case 402:
        return new InsufficientCreditsError(message);

      case 403:
        return new ModerationError(message);

      case 408:
        return new TimeoutError(message);

      case 429:
        return new RateLimitError(message);

      case 500:
      case 502:
      case 503:
        return new ModelUnavailableError(message, status as 500 | 502 | 503);

      default:
        return new UnknownApiError(message, status);
    }
  }
}
