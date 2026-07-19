import { ToolProtocolError } from "../errors";
import type {
  AssistantChatMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatPlugin,
  FunctionTool,
  ServerTool,
  StreamChunk,
  StreamFinalResult,
  StreamHeartbeatChunk,
  StreamToolCallChunk,
  Tool,
  ToolChoice,
} from "../types";
import type { ILLMClient } from "./openrouter";
import { MAX_TOOL_CALL_INDEX } from "./openrouter";
import type { IToolContext, ToolRegistry, ToolRenderPayload } from "./tools/registry";
import type { INormalizedToolCall } from "./tools/toolHandler";
import { ToolDispatcher } from "./tools/toolHandler";

/**
 * Streaming updater the loop drives for one assistant turn at a time. See
 * design "updater への content 反映" for the state machine this implements:
 * `beginTurn()` opens a turn, `stageContent()` reports the cumulative
 * (not delta) content as it streams in, and exactly one of `commitTurn()` /
 * `abortTurn()` closes it. `beginToolBlock()`/`endToolBlock()` bracket a
 * single tool dispatch and are independent of the turn state machine.
 *
 * Contract: after a successful `beginTurn()`, the loop calls `commitTurn()`
 * or `abortTurn()` exactly once before starting a new turn. If `beginTurn()`
 * itself was never called (e.g. the request was already cancelled), none of
 * these methods are called. A throwing/rejecting updater method never stops
 * the loop's protocol progression — the loop logs it via `console.error` and
 * continues (the commit/abort decision itself is still made exactly once).
 * A slow/never-settling updater method also never stops progression: every
 * call is bounded by a race against the request cancel signal and a fixed
 * timeout (`UPDATER_CALL_TIMEOUT_MS`) — if the updater doesn't settle in
 * time the loop stops waiting on it (abandoning that render) and moves on.
 * The call is still always made; only the `await` is cut short.
 */
export interface IToolLoopUpdater {
  beginTurn(): void | Promise<void>;
  /** Cumulative content for the current assistant turn (not a delta). */
  stageContent(text: string): void | Promise<void>;
  commitTurn(kind: "tool_calls" | "final"): void | Promise<void>;
  abortTurn(reason: string): void | Promise<void>;
  beginToolBlock(name: string): void | Promise<void>;
  endToolBlock(name: string, render?: ToolRenderPayload): void | Promise<void>;
}

/** Sum of `StreamFinalResult.usage` across every turn. Optional sub-fields are only added when present. */
export interface AggregatedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export type ToolLoopResult =
  | {
      status: "final";
      text: string;
      finishReason: "stop" | "length" | "content_filter";
      history: ChatMessage[];
      usage?: AggregatedUsage;
      model?: string;
      provider?: string;
    }
  | { status: "cancelled"; history: ChatMessage[]; usage?: AggregatedUsage }
  | { status: "error"; error: unknown; history: ChatMessage[]; usage?: AggregatedUsage };

export interface IToolLoopParams {
  llmClient: ILLMClient;
  model: string;
  /** Initial history. The caller's array is copied, never mutated. */
  messages: ChatMessage[];
  plugins?: ChatPlugin[];
  registry: ToolRegistry;
  /** Defaults to `new ToolDispatcher(registry)`. */
  dispatcher?: ToolDispatcher;
  serverTools?: ServerTool[];
  ctx: IToolContext;
  updater: IToolLoopUpdater;
  /** Request-level cancellation (stop button). */
  signal?: AbortSignal;
  requestId: string;
  /**
   * Test-only override of the idle/wall-clock/updater-call timeouts, so
   * tests don't have to wait out the real (minutes-long) production
   * defaults. Defaults to `STREAM_IDLE_TIMEOUT_MS` / `STREAM_WALL_TIMEOUT_MS`
   * / `UPDATER_CALL_TIMEOUT_MS`.
   */
  timeouts?: { idleMs?: number; wallMs?: number; updaterCallMs?: number };
}

export const MAX_TURNS = 5;
export const MAX_TOOL_CALLS_PER_TURN = 8;
/** Hard cap on distinct (by index) tool calls accumulated within a single turn. */
export const MAX_DISTINCT_TOOL_CALLS_HARD_CAP = 32;
/** Max UTF-8 bytes held per turn: content + all calls' id/name/args combined. */
export const MAX_TURN_ACCUM_BYTES = 1_048_576;
/**
 * Fixed per-fragment structural overhead charged to a turn's accumulated
 * byte budget for every accepted tool_call delta fragment, on top of the
 * UTF-8 bytes of any id/name/argumentsDelta it carries. Without this, a
 * fragment whose only payload is an empty `argumentsDelta` costs 0 bytes and
 * an unbounded number of them could be accumulated; charging a flat cost per
 * fragment ensures fragment *count* is itself bounded by MAX_TURN_ACCUM_BYTES.
 */
export const TOOL_CALL_FRAGMENT_OVERHEAD_BYTES = 16;
/** Max gap between consecutive stream chunks before the turn is aborted. */
export const STREAM_IDLE_TIMEOUT_MS = 90_000;
/** Max wall-clock time to drain a single turn's stream. */
export const STREAM_WALL_TIMEOUT_MS = 600_000;
/** Max time to wait on a single updater callback before abandoning it and continuing the loop. */
export const UPDATER_CALL_TIMEOUT_MS = 10_000;
/**
 * Max time `runTurn()`'s cleanup waits on `iterator.return()` before
 * abandoning it. `chatStream()`'s own cleanup calls `reader.cancel()`
 * fire-and-forget (never awaited) specifically so its generator finalizes
 * promptly, but `iterator.return()` still only resolves once the generator
 * actually resumes and unwinds past its `finally` — which for a
 * pathologically slow/hung underlying stream implementation (or a future
 * regression of that fire-and-forget property) could still stall. This bound
 * ensures a single turn's cleanup can never hang the loop indefinitely.
 */
export const ITERATOR_CLEANUP_TIMEOUT_MS = 5_000;

const utf8Encoder = new TextEncoder();
function byteLen(text: string): number {
  return utf8Encoder.encode(text).length;
}

type StreamYield = StreamChunk | StreamToolCallChunk | StreamHeartbeatChunk | StreamFinalResult;

function isToolCallChunk(chunk: StreamYield): chunk is StreamToolCallChunk {
  return "toolCall" in chunk;
}

function isFinalResult(chunk: StreamYield): chunk is StreamFinalResult {
  return "fullText" in chunk;
}

function isHeartbeatChunk(chunk: StreamYield): chunk is StreamHeartbeatChunk {
  return "heartbeat" in chunk;
}

/**
 * Invokes a single updater callback without ever letting it stall protocol
 * progression. Never throws: a synchronous throw is caught and logged
 * immediately; an async rejection is caught via `.catch` (so it can never
 * surface as an unhandled rejection later) but is not necessarily awaited to
 * completion. The wait is raced against the request cancel signal and a
 * fixed `timeoutMs` — if neither the updater nor the request itself settles
 * in time, the loop stops waiting and moves on (abandoning that render). The
 * callback is always invoked; only the `await` on its result is bounded.
 */
async function invokeUpdater(
  fn: () => void | Promise<void>,
  requestSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  let result: void | Promise<void>;
  try {
    result = fn();
  } catch (error) {
    console.error("[toolLoop] updater callback threw", error);
    return;
  }
  if (result === undefined) return; // synchronous updater: already complete

  const settled = Promise.resolve(result).catch((error) => {
    console.error("[toolLoop] updater callback threw", error);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });

  let cancelListener: (() => void) | undefined;
  const cancelPromise = new Promise<void>((resolve) => {
    if (!requestSignal) return; // never resolves: nothing to race against
    cancelListener = () => resolve();
    requestSignal.addEventListener("abort", cancelListener);
    if (requestSignal.aborted) resolve();
  });

  try {
    await Promise.race([settled, timeoutPromise, cancelPromise]);
  } finally {
    clearTimeout(timer);
    if (cancelListener && requestSignal) {
      requestSignal.removeEventListener("abort", cancelListener);
    }
  }
}

async function decideCommit(
  updater: IToolLoopUpdater,
  kind: "tool_calls" | "final",
  requestSignal: AbortSignal | undefined,
  updaterCallMs: number,
): Promise<void> {
  await invokeUpdater(() => updater.commitTurn(kind), requestSignal, updaterCallMs);
}

async function decideAbort(
  updater: IToolLoopUpdater,
  reason: string,
  requestSignal: AbortSignal | undefined,
  updaterCallMs: number,
): Promise<void> {
  await invokeUpdater(() => updater.abortTurn(reason), requestSignal, updaterCallMs);
}

/**
 * Aborts the current turn via `decideAbort()` and, if the request was
 * cancelled while that bounded wait was in flight, returns `cancelled`
 * instead of the caller's prepared `error`. `abortTurn()` is never called
 * twice for the same turn here: `decideAbort()` itself is never skipped
 * (only the `await` on it may be cut short — see `invokeUpdater()`), so the
 * terminal abort decision has already been made exactly once by the time
 * this checks `requestSignal`; this only decides which `ToolLoopResult` to
 * surface. Without this recheck, a slow/hung `abortTurn()` that only settles
 * because the request was cancelled (not because the abort genuinely
 * completed) would still be reported as `status:"error"` even though the
 * stop button succeeded.
 */
async function abortToErrorOrCancelled(
  updater: IToolLoopUpdater,
  reason: string,
  requestSignal: AbortSignal | undefined,
  updaterCallMs: number,
  history: ChatMessage[],
  usage: AggregatedUsage | undefined,
  error: unknown,
): Promise<ToolLoopResult> {
  await decideAbort(updater, reason, requestSignal, updaterCallMs);
  if (requestSignal?.aborted) {
    return { status: "cancelled", history, usage };
  }
  return { status: "error", error, history, usage };
}

/**
 * Commits a "final" turn via `decideCommit()` and, if the request was
 * cancelled while that bounded wait was in flight, returns `cancelled`
 * instead of the caller's prepared `final` result. `abortTurn()` is
 * deliberately not called in that case: `commitTurn("final")` itself is
 * never skipped (only the `await` on it may be cut short — see
 * `invokeUpdater()`), so the turn's terminal commit/abort decision has
 * already been made exactly once; calling `abortTurn()` too would decide it
 * twice. The assistant message already pushed to `history` by the caller is
 * intentionally left in place — the stop button no longer promises "nothing
 * was said", only "nothing further will happen".
 */
async function commitFinalOrCancelled(
  updater: IToolLoopUpdater,
  requestSignal: AbortSignal | undefined,
  updaterCallMs: number,
  history: ChatMessage[],
  usage: AggregatedUsage | undefined,
  finalResult: Extract<ToolLoopResult, { status: "final" }>,
): Promise<ToolLoopResult> {
  await decideCommit(updater, "final", requestSignal, updaterCallMs);
  if (requestSignal?.aborted) {
    return { status: "cancelled", history, usage };
  }
  return finalResult;
}

/**
 * Adds `delta` to `previous`, but never lets the result become non-finite
 * (e.g. two `Number.MAX_VALUE`-scale token counts summing to `Infinity`).
 * `openrouter.ts`'s `assertValidUsage` bounds any *single* chunk's fields to
 * safe integers / non-negative finite numbers, but says nothing about their
 * *sum* across turns — a pair of individually-valid extreme values can still
 * overflow on aggregation. Usage is display-only metadata (see
 * `buildUsageDetailsText`), never something the response body's success
 * depends on, so an overflow here must degrade the number, not fail the
 * turn: it's logged via `console.warn` and the field is left at its
 * pre-addition value rather than clamped to an arbitrary cap that would
 * misrepresent the real total.
 *
 * `requireSafeInteger` additionally rejects a *finite but unsafe* sum (e.g.
 * `Number.MAX_SAFE_INTEGER + 2`, which is finite yet no longer represents an
 * exact integer). Token counts are inherently integral and are consumed
 * downstream as exact counts, so a rounded/imprecise sum is just as
 * misleading as a non-finite one — only `cost` (a monetary amount, not a
 * count) is exempt and keeps the plain finiteness check.
 */
function addFinite(
  previous: number,
  delta: number,
  field: string,
  requireSafeInteger = false,
): number {
  const sum = previous + delta;
  const valid = requireSafeInteger ? Number.isSafeInteger(sum) : Number.isFinite(sum);
  if (!valid) {
    console.warn(
      `[toolLoop] usage aggregation for "${field}" overflowed to ` +
        `${requireSafeInteger ? "an unsafe" : "a non-finite"} value ` +
        `(${previous} + ${delta}); keeping the pre-addition total.`,
    );
    return previous;
  }
  return sum;
}

function addUsage(
  acc: AggregatedUsage | undefined,
  turn: ChatCompletionResponse["usage"] | undefined,
): AggregatedUsage | undefined {
  if (!turn) return acc;
  const base: AggregatedUsage = acc ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  base.prompt_tokens = addFinite(base.prompt_tokens, turn.prompt_tokens, "prompt_tokens", true);
  base.completion_tokens = addFinite(
    base.completion_tokens,
    turn.completion_tokens,
    "completion_tokens",
    true,
  );
  base.total_tokens = addFinite(base.total_tokens, turn.total_tokens, "total_tokens", true);
  if (turn.cost !== undefined) {
    base.cost = addFinite(base.cost ?? 0, turn.cost, "cost");
  }
  if (turn.prompt_tokens_details?.cached_tokens !== undefined) {
    base.prompt_tokens_details = {
      cached_tokens: addFinite(
        base.prompt_tokens_details?.cached_tokens ?? 0,
        turn.prompt_tokens_details.cached_tokens,
        "prompt_tokens_details.cached_tokens",
        true,
      ),
    };
  }
  if (turn.completion_tokens_details?.reasoning_tokens !== undefined) {
    base.completion_tokens_details = {
      reasoning_tokens: addFinite(
        base.completion_tokens_details?.reasoning_tokens ?? 0,
        turn.completion_tokens_details.reasoning_tokens,
        "completion_tokens_details.reasoning_tokens",
        true,
      ),
    };
  }
  return base;
}

interface AccumulatedCall {
  index: number;
  id?: string;
  name?: string;
  argsParts: string[];
}

/**
 * `usage` on the non-`completed` variants is the last usage observed via a
 * heartbeat chunk during this turn (see `runTurn()`'s `lastHeartbeatUsage`).
 * OpenRouter sends the turn's usage on the empty-`choices` trailer chunk
 * immediately before `[DONE]`, which `openrouter.ts` yields as a heartbeat —
 * so a cancel/timeout/guard-violation/transport-error that lands after that
 * trailer but before the terminal `StreamFinalResult` would otherwise lose
 * usage the turn already paid for. `completed` never needs this: its usage
 * comes from `final.usage`, the same underlying value.
 */
type TurnOutcome =
  | {
      kind: "completed";
      final: StreamFinalResult;
      content: string;
      calls: Map<number, AccumulatedCall>;
    }
  | { kind: "cancelled"; usage?: ChatCompletionResponse["usage"] }
  | { kind: "timeout"; usage?: ChatCompletionResponse["usage"] }
  | { kind: "guard-violation"; message: string; usage?: ChatCompletionResponse["usage"] }
  | { kind: "transport-error"; error: unknown; usage?: ChatCompletionResponse["usage"] };

interface RunTurnParams {
  llmClient: ILLMClient;
  request: ChatCompletionRequest;
  requestSignal: AbortSignal | undefined;
  idleMs: number;
  wallMs: number;
  onContent: (fullContentSoFar: string) => void | Promise<void>;
}

/**
 * Drains one turn's stream, accumulating content/tool_call deltas and
 * enforcing idle/wall-clock timeouts and the per-turn accumulation
 * guardrails. Never throws — every failure mode maps to a `TurnOutcome`
 * variant so the caller can classify cancel > timeout > other deterministically.
 */
async function runTurn(params: RunTurnParams): Promise<TurnOutcome> {
  const { llmClient, request, requestSignal, idleMs, wallMs, onContent } = params;

  const transportController = new AbortController();
  const combinedSignal = requestSignal
    ? AbortSignal.any([requestSignal, transportController.signal])
    : transportController.signal;

  // Obtained inside the try below (not here) so a synchronous throw from
  // `chatStream()` itself — e.g. a client implementation that validates its
  // arguments eagerly rather than deferring to the generator body — is
  // caught and classified instead of propagating out of `runTurn()` as a
  // rejection (see the `catch` below and its comment).
  let iterator: AsyncGenerator<StreamYield, void, void> | undefined;

  let content = "";
  const calls = new Map<number, AccumulatedCall>();
  let accumBytes = 0;
  // Last usage observed via a heartbeat chunk this turn (see the
  // `TurnOutcome` doc comment for why this exists): OpenRouter's
  // empty-`choices` usage trailer arrives as a heartbeat, one or more
  // frames before the terminal `StreamFinalResult` — a cancel/timeout/
  // guard-violation/transport-error landing in that gap must not lose it.
  let lastHeartbeatUsage: ChatCompletionResponse["usage"] | undefined;

  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let requestAbortListener: (() => void) | undefined;
  let wallExpired = false;
  let cancelled = false;

  // Armed once per turn (race-safe: listener attached, then `aborted`
  // rechecked synchronously) — mirrors the pattern in toolHandler.ts.
  const cancelPromise = new Promise<void>((resolve) => {
    if (!requestSignal) return; // never resolves: nothing to race against
    requestAbortListener = () => {
      cancelled = true;
      resolve();
    };
    requestSignal.addEventListener("abort", requestAbortListener);
    if (requestSignal.aborted) {
      cancelled = true;
      resolve();
    }
  });

  const wallPromise = new Promise<void>((resolve) => {
    wallTimer = setTimeout(() => {
      wallExpired = true;
      resolve();
    }, wallMs);
  });

  try {
    iterator = llmClient.chatStream(request, combinedSignal);
    while (true) {
      let idleExpired = false;
      const idlePromise = new Promise<void>((resolve) => {
        idleTimer = setTimeout(() => {
          idleExpired = true;
          resolve();
        }, idleMs);
      });

      // Never let the race itself reject: a raw `iterator.next()` promise
      // participating in Promise.race would make `await Promise.race(...)`
      // throw whenever it wins by rejecting, short-circuiting past the
      // `cancelled` check below and turning a same-tick cancel+throw race
      // into an uncaught rejection instead of a classified TurnOutcome
      // (design "stream の throw と cancel が同時 → cancel 優先"; also
      // required by "reject はプログラマ/不変条件違反のみ" — a transport
      // rejection must become `status:'error'`, not an exception). Wrapping
      // it into an always-resolving settlement lets us pick the race winner
      // without ever awaiting a rejected promise.
      const nextSettled: Promise<
        | {
            ok: true;
            step: IteratorResult<StreamYield, void>;
          }
        | { ok: false; error: unknown }
      > = iterator.next().then(
        (step) => ({ ok: true, step }),
        (error) => ({ ok: false, error }),
      );
      await Promise.race([nextSettled, idlePromise, wallPromise, cancelPromise]);
      clearTimeout(idleTimer);

      // Priority: request cancel > timeout (idle or wall) > stream result.
      // Decided by rechecking state, not by which promise "won" the race —
      // cancel and a stream rejection can settle in the same microtask
      // batch, and cancel must win regardless of settlement order.
      if (cancelled) {
        transportController.abort();
        return { kind: "cancelled", usage: lastHeartbeatUsage };
      }
      if (wallExpired || idleExpired) {
        transportController.abort();
        return { kind: "timeout", usage: lastHeartbeatUsage };
      }

      // Neither cancel nor timeout fired, so the race settled via the
      // stream (nextSettled is guaranteed resolved at this point).
      const settlement = await nextSettled;
      if (!settlement.ok) {
        // A reject racing a cancel is classified as cancel (design "stream
        // の throw と cancel が同時 → cancel 優先").
        if (requestSignal?.aborted) {
          return { kind: "cancelled", usage: lastHeartbeatUsage };
        }
        return { kind: "transport-error", error: settlement.error, usage: lastHeartbeatUsage };
      }
      const step = settlement.step;

      if (step.done) {
        // Generator ended without ever yielding a terminal StreamFinalResult:
        // treated the same as a mid-stream disconnect.
        return {
          kind: "transport-error",
          error: new ToolProtocolError("Stream ended without a final result."),
          usage: lastHeartbeatUsage,
        };
      }

      const chunk = step.value;
      if (isFinalResult(chunk)) {
        return { kind: "completed", final: chunk, content, calls };
      }

      if (isHeartbeatChunk(chunk)) {
        // No data to accumulate or stage — looping back to `while (true)`
        // re-arms `idlePromise`/`idleTimer` from scratch, which is exactly
        // the "reset the idle timer" behavior a heartbeat-only lull needs:
        // a stream sending nothing but keep-alive comments must not be
        // mistaken for a stalled one. A heartbeat carrying `usage` (see
        // `StreamHeartbeatChunk`'s doc comment) updates `lastHeartbeatUsage`
        // so it survives into a subsequent cancel/timeout/error outcome.
        if (chunk.usage !== undefined) {
          lastHeartbeatUsage = chunk.usage;
        }
        continue;
      }

      if (isToolCallChunk(chunk)) {
        const delta = chunk.toolCall;

        // Defense in depth: `OpenRouterClient` already validates `index` at
        // the wire (see `MAX_TOOL_CALL_INDEX` in openrouter.ts), but `ILLMClient`
        // is an interface any implementation can satisfy — a different client
        // that skips that validation must not be able to hand this loop
        // `index:-1`, a fractional index, or an unsafe-integer index and have
        // it reach the `Map<number, AccumulatedCall>` below, where a
        // non-safe-integer key can silently collide with another index and a
        // negative/fractional one has no defined accumulation slot at all.
        if (
          !Number.isSafeInteger(delta.index) ||
          delta.index < 0 ||
          delta.index > MAX_TOOL_CALL_INDEX
        ) {
          transportController.abort();
          return {
            kind: "guard-violation",
            message: `invalid tool_call index: ${delta.index}`,
            usage: lastHeartbeatUsage,
          };
        }

        const existingCall = calls.get(delta.index);
        if (!existingCall && calls.size >= MAX_DISTINCT_TOOL_CALLS_HARD_CAP) {
          transportController.abort();
          return {
            kind: "guard-violation",
            message: "Too many distinct tool calls accumulated in a single turn.",
            usage: lastHeartbeatUsage,
          };
        }

        // A later fragment at an already-seen index carrying a *different*
        // id/name than the one already recorded is a malformed/adversarial
        // stream, not a benign resend: silently keeping the first value (as a
        // plain "only record the first" accumulator would) risks executing
        // the call under a name/id the model never actually settled on. A
        // resend of the *same* value is still ignored below (willSetId/
        // willSetName only fire once per field), so this only rejects a
        // genuine mismatch.
        if (existingCall) {
          if (
            delta.id !== undefined &&
            existingCall.id !== undefined &&
            delta.id !== existingCall.id
          ) {
            transportController.abort();
            return {
              kind: "guard-violation",
              message:
                `Conflicting tool_call id at index ${delta.index}: ` +
                `"${existingCall.id}" then "${delta.id}".`,
              usage: lastHeartbeatUsage,
            };
          }
          if (
            delta.name !== undefined &&
            existingCall.name !== undefined &&
            delta.name !== existingCall.name
          ) {
            transportController.abort();
            return {
              kind: "guard-violation",
              message:
                `Conflicting tool_call name at index ${delta.index}: ` +
                `"${existingCall.name}" then "${delta.name}".`,
              usage: lastHeartbeatUsage,
            };
          }
        }

        // Computed (and budget-checked) *before* any mutation of `calls`/
        // `accumBytes`, so a fragment that would push the turn over budget is
        // rejected outright rather than partially applied first and only
        // then discovered to be over budget (design "byte ガードは蓄積/
        // staging の前に評価する" — the guard must gate acceptance, not just
        // detect overflow after the fact).
        // Charged for every accepted fragment regardless of payload, so a
        // stream of otherwise-free (empty-argumentsDelta) fragments still
        // accumulates bytes and eventually trips the MAX_TURN_ACCUM_BYTES
        // guard below instead of growing `argsParts` unbounded.
        let additionalBytes = TOOL_CALL_FRAGMENT_OVERHEAD_BYTES;
        const willSetId = delta.id !== undefined && existingCall?.id === undefined;
        const willSetName = delta.name !== undefined && existingCall?.name === undefined;
        if (willSetId) additionalBytes += byteLen(delta.id as string);
        if (willSetName) additionalBytes += byteLen(delta.name as string);
        const hasArgsDelta = delta.argumentsDelta !== undefined && delta.argumentsDelta.length > 0;
        if (hasArgsDelta) additionalBytes += byteLen(delta.argumentsDelta as string);

        if (accumBytes + additionalBytes > MAX_TURN_ACCUM_BYTES) {
          transportController.abort();
          return {
            kind: "guard-violation",
            message: "Turn accumulation exceeded the maximum byte budget.",
            usage: lastHeartbeatUsage,
          };
        }

        const call = existingCall ?? { index: delta.index, argsParts: [] };
        if (!existingCall) calls.set(delta.index, call);
        accumBytes += additionalBytes;
        if (willSetId) call.id = delta.id;
        if (willSetName) call.name = delta.name;
        if (hasArgsDelta) call.argsParts.push(delta.argumentsDelta as string);
      } else {
        // Same "check before mutate" ordering as the tool_call branch above:
        // a chunk that would push the turn over budget must never reach
        // `content`/`onContent` (which stages it to Discord) in the first
        // place, even if the chunk itself is individually under the limit.
        const chunkBytes = byteLen(chunk.content);
        if (accumBytes + chunkBytes > MAX_TURN_ACCUM_BYTES) {
          transportController.abort();
          return {
            kind: "guard-violation",
            message: "Turn accumulation exceeded the maximum byte budget.",
            usage: lastHeartbeatUsage,
          };
        }
        accumBytes += chunkBytes;
        content += chunk.content;
        await safeCall(() => onContent(content));
      }
    }
  } catch (error) {
    // A synchronous throw here (most plausibly from the `chatStream()` call
    // itself, before any iterator was even obtained) previously escaped
    // `runTurn()` entirely and rejected `runToolLoop()` — breaking the
    // documented "never reject" contract and, for a turn where `beginTurn()`
    // had already been called, skipping the terminal commit/abort decision
    // the loop otherwise always makes exactly once. Classifying it as
    // `transport-error` instead routes it through the same `decideAbort()` +
    // `status:"error"` path as a mid-stream transport rejection.
    return { kind: "transport-error", error, usage: lastHeartbeatUsage };
  } finally {
    clearTimeout(wallTimer);
    clearTimeout(idleTimer);
    if (requestAbortListener && requestSignal) {
      requestSignal.removeEventListener("abort", requestAbortListener);
    }
    // Every exit path above (completed/cancelled/timeout/guard-violation/
    // transport-error) must finalize `iterator` here, not just abort the
    // transport: `chatStream()`'s own `finally` (which releases/cancels the
    // response body reader) only runs once the generator itself resumes and
    // unwinds, which for an async generator only happens via a `next()`/
    // `return()` call reaching it — never merely by the caller stopping
    // consumption. Aborting first ensures a `reader.read()` the generator is
    // suspended on rejects promptly, so the queued `return()` below can
    // actually resolve instead of hanging forever. `iterator` can still be
    // `undefined` here if `chatStream()` itself threw synchronously before
    // ever producing one.
    transportController.abort();
    if (iterator) {
      await boundedIteratorReturn(iterator);
    }
  }
}

/**
 * Calls `iterator.return()` to finalize the stream generator, bounded by a
 * fixed `ITERATOR_CLEANUP_TIMEOUT_MS` race: if `return()` doesn't settle in
 * time, this function returns anyway and the call is abandoned (left to
 * settle — or never settle — on its own). Without this bound, a
 * pathologically slow/hung generator finalize would stall every future turn
 * of the loop (this `await` sits in `runTurn()`'s `finally`, which every exit
 * path passes through) even though `chatStream()`'s own cleanup no longer
 * awaits its `reader.cancel()`. The timer is always cleared so an abandoned
 * (losing) race never leaks a pending timeout.
 */
async function boundedIteratorReturn(
  iterator: AsyncGenerator<StreamYield, void, void>,
): Promise<void> {
  const returnSettled = (async () => {
    try {
      await iterator.return?.(undefined);
    } catch {
      // The generator's cleanup throwing must not override this turn's
      // already-decided outcome.
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ITERATOR_CLEANUP_TIMEOUT_MS);
  });

  try {
    await Promise.race([returnSettled, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

/** Wraps a caller-supplied side-effecting callback so it can never break stream draining. */
async function safeCall(fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error("[toolLoop] onContent callback threw", error);
  }
}

type NormalizeResult = { ok: true; calls: INormalizedToolCall[] } | { ok: false; reason: string };

/**
 * Normalizes accumulated `tool_calls` deltas (design step 4 / "正規化"):
 * drop calls with a missing/empty `function.name` (warn), assign a
 * synthetic id to calls missing an id or repeating one already seen, sort by
 * numeric index, and flag the tail beyond `maxPerTurn` with a
 * `precomputedError` so the dispatcher turns it into an error result instead
 * of executing it.
 */
function normalizeToolCalls(
  calls: Map<number, AccumulatedCall>,
  maxPerTurn: number,
): NormalizeResult {
  const sorted = [...calls.values()].sort((a, b) => a.index - b.index);

  const withNames = sorted.filter((call) => {
    const hasName = call.name !== undefined && call.name.trim().length > 0;
    if (!hasName) {
      console.warn(`[toolLoop] dropping tool call at index ${call.index}: missing function.name`);
    }
    return hasName;
  });

  if (withNames.length === 0) {
    return {
      ok: false,
      reason:
        sorted.length === 0
          ? 'finish_reason was "tool_calls" but no tool call fragments were accumulated.'
          : "All accumulated tool calls were dropped due to a missing function name.",
    };
  }

  const seenIds = new Set<string>();
  const normalized = withNames.map((call, i): INormalizedToolCall => {
    let id = call.id;
    if (id === undefined || id.length === 0 || seenIds.has(id)) {
      id = `synthetic-${crypto.randomUUID()}`;
    }
    seenIds.add(id);
    return {
      index: call.index,
      id,
      // Safe: `withNames` was filtered to entries with a non-empty name.
      name: call.name as string,
      rawArguments: call.argsParts.join(""),
      ...(i >= maxPerTurn && { precomputedError: "too many tool calls in one turn" }),
    };
  });

  return { ok: true, calls: normalized };
}

interface DispatchCallsParams {
  normalizedCalls: INormalizedToolCall[];
  dispatcher: ToolDispatcher;
  ctx: IToolContext;
  requestSignal: AbortSignal | undefined;
  frozenToolNames: ReadonlySet<string>;
  requestId: string;
  updater: IToolLoopUpdater;
  history: ChatMessage[];
  updaterCallMs: number;
}

/**
 * Sequentially dispatches normalized calls, pushing each `role:"tool"`
 * result to `history` as it completes. If the request is cancelled before or
 * during a call, every remaining (not-yet-started) call — and the
 * in-flight one, if the dispatcher itself reports `cancelled` — is filled
 * with a bounded cancellation result, and no further calls are attempted.
 */
async function dispatchCalls(params: DispatchCallsParams): Promise<{ cancelled: boolean }> {
  const {
    normalizedCalls,
    dispatcher,
    ctx,
    requestSignal,
    frozenToolNames,
    requestId,
    updater,
    history,
    updaterCallMs,
  } = params;

  for (let i = 0; i < normalizedCalls.length; i++) {
    const call = normalizedCalls[i];
    if (!call) continue;

    if (requestSignal?.aborted) {
      for (let j = i; j < normalizedCalls.length; j++) {
        const remaining = normalizedCalls[j];
        if (!remaining) continue;
        history.push(dispatcher.buildCancelledOutcome(remaining).toolMessage);
      }
      return { cancelled: true };
    }

    await invokeUpdater(() => updater.beginToolBlock(call.name), requestSignal, updaterCallMs);
    const outcome = await dispatcher.dispatch(call, {
      ctx,
      requestSignal,
      frozenToolNames,
      requestId,
    });
    history.push(outcome.toolMessage);
    await invokeUpdater(
      () => updater.endToolBlock(call.name, outcome.render),
      requestSignal,
      updaterCallMs,
    );

    if (outcome.status === "cancelled") {
      for (let j = i + 1; j < normalizedCalls.length; j++) {
        const remaining = normalizedCalls[j];
        if (!remaining) continue;
        history.push(dispatcher.buildCancelledOutcome(remaining).toolMessage);
      }
      return { cancelled: true };
    }
  }

  return { cancelled: false };
}

/**
 * Runs the client tool-calling protocol loop against `llmClient`: builds the
 * (frozen) combined `tools` array once, streams each assistant turn,
 * normalizes and sequentially dispatches any `tool_calls`, and repeats up to
 * `MAX_TURNS` (the last turn forces `tool_choice:"none"`). See
 * `docs/changes/tool-calling-foundation/design.md` for the full protocol
 * this implements.
 */
export async function runToolLoop(params: IToolLoopParams): Promise<ToolLoopResult> {
  const {
    llmClient,
    model,
    plugins,
    registry,
    ctx,
    updater,
    signal: requestSignal,
    requestId,
  } = params;
  const dispatcher = params.dispatcher ?? new ToolDispatcher(registry);
  const serverTools = params.serverTools ?? [];
  const idleMs = params.timeouts?.idleMs ?? STREAM_IDLE_TIMEOUT_MS;
  const wallMs = params.timeouts?.wallMs ?? STREAM_WALL_TIMEOUT_MS;
  const updaterCallMs = params.timeouts?.updaterCallMs ?? UPDATER_CALL_TIMEOUT_MS;

  const history: ChatMessage[] = [...params.messages];

  // Mirrors the per-turn abort check further down (before `beginTurn()` for
  // turn 1), but must happen here too: `registry.buildTools(ctx)` below runs
  // arbitrary per-tool `isEnabled()` code before any turn is opened, so an
  // already-cancelled request must short-circuit before that call is even
  // made rather than rely on it succeeding.
  if (requestSignal?.aborted) {
    return { status: "cancelled", history };
  }

  // Frozen once for the whole loop (design step 1): re-authorization at
  // dispatch time is handled by ToolDispatcher re-evaluating `isEnabled`,
  // not by rebuilding this snapshot. `isEnabled()` is per-tool user/tool
  // code, not something this loop controls — a throw here happens before
  // `beginTurn()` for turn 1 is ever called, so there is no open turn to
  // abort and no updater call to make; it is reported directly as an error.
  let clientTools: FunctionTool[];
  try {
    clientTools = registry.buildTools(ctx);
  } catch (error) {
    return { status: "error", error, history };
  }
  const frozenToolNames = new Set(clientTools.map((t) => t.function.name));
  // Deep-cloned so the frozen snapshot is structurally independent of
  // `registry`/`serverTools` state from this point on: `clientTools` carries
  // each tool's `parameters` object by reference, and a tool handler (or any
  // other code) mutating that object during turn 1's dispatch must not change
  // what gets resent on turn 2+ — the "毎ターン同一の凍結 tools を再送する"
  // contract requires the snapshot taken here to never change again. A clone
  // failure (a non-structured-cloneable value somewhere in a tool's
  // parameters, e.g. a function) is reported the same way as a
  // `buildTools()` throw above: no turn has been opened yet, so there is
  // nothing to abort.
  let tools: Tool[];
  try {
    tools = structuredClone<Tool[]>([...clientTools, ...serverTools]);
  } catch (error) {
    return { status: "error", error, history };
  }
  const hasTools = tools.length > 0;

  let aggregatedUsage: AggregatedUsage | undefined;
  // Last non-`undefined` model/provider observed across every turn's final
  // chunk so far (not just the most recent turn's). A turn's `StreamFinalResult`
  // is allowed to omit `model`/`provider` (see `openrouter.ts`'s `state.lastModel`/
  // `lastProvider`, only set `if (chunk.model)` / `if (chunk.provider)`), and the
  // design requires the loop's own result to reflect whatever was observed
  // across the whole tool-calling conversation, not just whichever turn
  // happened to finish last.
  let lastObservedModel: string | undefined;
  let lastObservedProvider: string | undefined;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    // Covers both "before the first request" and "before the next model
    // request after a turn's tool dispatch" — in both cases `beginTurn()`
    // for the *new* turn has not been called yet, so no updater call is made.
    if (requestSignal?.aborted) {
      return { status: "cancelled", history, usage: aggregatedUsage };
    }

    const toolChoice: ToolChoice = turn < MAX_TURNS ? "auto" : "none";
    const request: ChatCompletionRequest = {
      model,
      messages: [...history],
      ...(plugins && { plugins }),
      ...(hasTools && { tools, tool_choice: toolChoice }),
    };

    await invokeUpdater(() => updater.beginTurn(), requestSignal, updaterCallMs);

    // `beginTurn()`'s bounded wait (like every `invokeUpdater()` call) can be
    // cut short by the request cancelling mid-wait. Unlike the `aborted`
    // check above (before `beginTurn()` was called, so no turn is open yet),
    // a cancel observed here means `beginTurn()` *was* already called, so the
    // turn must still be closed via `abortTurn()` before returning —
    // otherwise the model stream would start for a turn the loop is about to
    // report as cancelled, and the updater's beginTurn/commit-or-abort
    // contract would be violated (a begun turn left with no terminal call).
    if (requestSignal?.aborted) {
      await decideAbort(updater, "request cancelled", requestSignal, updaterCallMs);
      return { status: "cancelled", history, usage: aggregatedUsage };
    }

    const turnResult = await runTurn({
      llmClient,
      request,
      requestSignal,
      idleMs,
      wallMs,
      onContent: (full) =>
        invokeUpdater(() => updater.stageContent(full), requestSignal, updaterCallMs),
    });

    // `runTurn()`'s own cleanup (`boundedIteratorReturn`, bounded by
    // `ITERATOR_CLEANUP_TIMEOUT_MS`) runs in its `finally` after a terminal
    // chunk is already decided, so a cancel can land there — after the turn
    // is internally `kind:"completed"` — without ever being observed by the
    // cancel check inside `runTurn()`'s own loop. Rechecking here, before
    // branching on `turnResult.kind`, ensures a cancel that arrives during
    // that cleanup window still ends the turn as cancelled instead of
    // committing/returning a "final" the stop button already reports as
    // succeeded. This subsumes the `kind === "cancelled"` branch below (that
    // branch's cancel implies `requestSignal.aborted` too), which is kept as
    // defense in depth — `abortTurn()` is idempotent for the loop's "decide
    // the turn's outcome exactly once" contract.
    if (requestSignal?.aborted) {
      // `turnResult` is already `kind:"completed"` here whenever the cancel
      // landed during cleanup (as opposed to mid-stream), and its `final.usage`
      // was never folded into `aggregatedUsage` — that fold normally happens a
      // few lines below, which this early return skips. Without this, a turn
      // whose terminal chunk (with usage) was fully received still reports
      // `cancelled` with only the *previous* turns' usage (or `undefined` on
      // turn 1), silently dropping the very usage this turn already paid for.
      if (turnResult.kind === "completed") {
        aggregatedUsage = addUsage(aggregatedUsage, turnResult.final.usage);
      } else {
        // Same rationale as the `completed` branch above, for a cancel
        // observed during cleanup on any other turn outcome: `turnResult.usage`
        // is whatever usage this turn's heartbeat(s) already observed (see the
        // `TurnOutcome` doc comment) and must not be dropped just because the
        // terminal chunk itself was never reached.
        aggregatedUsage = addUsage(aggregatedUsage, turnResult.usage);
      }
      await decideAbort(updater, "request cancelled", requestSignal, updaterCallMs);
      return { status: "cancelled", history, usage: aggregatedUsage };
    }

    if (turnResult.kind === "cancelled") {
      aggregatedUsage = addUsage(aggregatedUsage, turnResult.usage);
      await decideAbort(updater, "request cancelled", requestSignal, updaterCallMs);
      return { status: "cancelled", history, usage: aggregatedUsage };
    }

    if (turnResult.kind === "timeout") {
      aggregatedUsage = addUsage(aggregatedUsage, turnResult.usage);
      return await abortToErrorOrCancelled(
        updater,
        "stream timed out",
        requestSignal,
        updaterCallMs,
        history,
        aggregatedUsage,
        new ToolProtocolError("Tool loop turn timed out waiting for the model stream."),
      );
    }

    if (turnResult.kind === "guard-violation") {
      aggregatedUsage = addUsage(aggregatedUsage, turnResult.usage);
      return await abortToErrorOrCancelled(
        updater,
        turnResult.message,
        requestSignal,
        updaterCallMs,
        history,
        aggregatedUsage,
        new ToolProtocolError(turnResult.message),
      );
    }

    if (turnResult.kind === "transport-error") {
      aggregatedUsage = addUsage(aggregatedUsage, turnResult.usage);
      return await abortToErrorOrCancelled(
        updater,
        "stream error",
        requestSignal,
        updaterCallMs,
        history,
        aggregatedUsage,
        turnResult.error,
      );
    }

    const { final, content, calls } = turnResult;
    aggregatedUsage = addUsage(aggregatedUsage, final.usage);
    if (final.model !== undefined) lastObservedModel = final.model;
    if (final.provider !== undefined) lastObservedProvider = final.provider;
    const hasToolFragments = calls.size > 0;
    const finishReason = final.finishReason;

    // No tools were offered in this turn's request (frozen combined `tools`
    // is empty, so `tools`/`tool_choice` were omitted entirely — see
    // `hasTools` above). A model that still emits tool_call fragments or a
    // terminal `finish_reason:"tool_calls"` here is hallucinating a call
    // against an empty registry; letting it through would either dispatch a
    // "not offered" result and start another model request (breaking the
    // documented single-request equivalence for an empty registry) or, once
    // Fix 3 above is trusted, be silently absorbed. Fail the turn outright
    // instead, with no further model request.
    if (!hasTools && (hasToolFragments || finishReason === "tool_calls")) {
      return await abortToErrorOrCancelled(
        updater,
        "tool_calls received but no tools were offered",
        requestSignal,
        updaterCallMs,
        history,
        aggregatedUsage,
        new ToolProtocolError(
          "Model attempted a tool call but no tools were offered to it in this request.",
        ),
      );
    }

    if (finishReason === undefined || finishReason === null) {
      return await abortToErrorOrCancelled(
        updater,
        "stream ended without a terminal finish_reason",
        requestSignal,
        updaterCallMs,
        history,
        aggregatedUsage,
        new ToolProtocolError(
          "Stream ended without a terminal finish_reason (disconnect or missing terminal chunk).",
        ),
      );
    }

    if (finishReason === "tool_calls") {
      if (turn === MAX_TURNS) {
        return await abortToErrorOrCancelled(
          updater,
          "model returned tool_calls on the final turn",
          requestSignal,
          updaterCallMs,
          history,
          aggregatedUsage,
          new ToolProtocolError(
            'Model returned "tool_calls" on the final allowed turn despite tool_choice:"none".',
          ),
        );
      }

      const normalizeResult = normalizeToolCalls(calls, MAX_TOOL_CALLS_PER_TURN);
      if (!normalizeResult.ok) {
        return await abortToErrorOrCancelled(
          updater,
          normalizeResult.reason,
          requestSignal,
          updaterCallMs,
          history,
          aggregatedUsage,
          new ToolProtocolError(normalizeResult.reason),
        );
      }
      const normalizedCalls = normalizeResult.calls;

      const assistantMessage: AssistantChatMessage = {
        role: "assistant",
        content: content.length > 0 ? content : null,
        tool_calls: normalizedCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.rawArguments },
        })),
      };
      history.push(assistantMessage);
      await decideCommit(updater, "tool_calls", requestSignal, updaterCallMs);

      const dispatchOutcome = await dispatchCalls({
        normalizedCalls,
        dispatcher,
        ctx,
        requestSignal,
        frozenToolNames,
        requestId,
        updater,
        history,
        updaterCallMs,
      });

      if (dispatchOutcome.cancelled) {
        return { status: "cancelled", history, usage: aggregatedUsage };
      }

      continue;
    }

    if (finishReason === "stop") {
      if (hasToolFragments) {
        return await abortToErrorOrCancelled(
          updater,
          'received tool_call fragments with finish_reason "stop"',
          requestSignal,
          updaterCallMs,
          history,
          aggregatedUsage,
          new ToolProtocolError('Received tool_call fragments with finish_reason "stop".'),
        );
      }
      if (content.length === 0) {
        return await abortToErrorOrCancelled(
          updater,
          "empty response",
          requestSignal,
          updaterCallMs,
          history,
          aggregatedUsage,
          new ToolProtocolError(
            "The model returned an empty response (no content, no tool calls).",
          ),
        );
      }
      history.push({ role: "assistant", content });
      return await commitFinalOrCancelled(
        updater,
        requestSignal,
        updaterCallMs,
        history,
        aggregatedUsage,
        {
          status: "final",
          text: content,
          finishReason: "stop",
          history,
          usage: aggregatedUsage,
          model: lastObservedModel,
          provider: lastObservedProvider,
        },
      );
    }

    if (finishReason === "length" || finishReason === "content_filter") {
      if (hasToolFragments) {
        return await abortToErrorOrCancelled(
          updater,
          `received tool_call fragments with finish_reason "${finishReason}"`,
          requestSignal,
          updaterCallMs,
          history,
          aggregatedUsage,
          new ToolProtocolError(
            `Received tool_call fragments with finish_reason "${finishReason}".`,
          ),
        );
      }
      if (content.length === 0) {
        return await abortToErrorOrCancelled(
          updater,
          "empty response",
          requestSignal,
          updaterCallMs,
          history,
          aggregatedUsage,
          new ToolProtocolError(
            "The model returned an empty response (no content, no tool calls).",
          ),
        );
      }
      history.push({ role: "assistant", content });
      return await commitFinalOrCancelled(
        updater,
        requestSignal,
        updaterCallMs,
        history,
        aggregatedUsage,
        {
          status: "final",
          text: content,
          finishReason,
          history,
          usage: aggregatedUsage,
          model: lastObservedModel,
          provider: lastObservedProvider,
        },
      );
    }

    if (finishReason === "error") {
      return await abortToErrorOrCancelled(
        updater,
        'model reported finish_reason "error"',
        requestSignal,
        updaterCallMs,
        history,
        aggregatedUsage,
        new ToolProtocolError('Stream finished with finish_reason "error".'),
      );
    }

    // Unknown non-null finish_reason: never treated as an implicit completion.
    return await abortToErrorOrCancelled(
      updater,
      `unknown finish_reason: "${finishReason}"`,
      requestSignal,
      updaterCallMs,
      history,
      aggregatedUsage,
      new ToolProtocolError(`Unknown finish_reason: "${finishReason}".`),
    );
  }

  // Unreachable: every branch above either `return`s or `continue`s (and
  // `continue` only happens for turn < MAX_TURNS, since the MAX_TURNS
  // iteration's tool_calls branch always returns). Kept for type-safety.
  throw new ToolProtocolError("Tool loop exited without producing a result.");
}
