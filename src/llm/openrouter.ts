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
  WebSearchFailedError,
} from "../errors";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatMessageContent,
  FunctionTool,
  OpenRouterModel,
  ResponsesFunctionTool,
  ResponsesInputContentPart,
  ResponsesInputItem,
  ResponsesReasoningItem,
  ResponsesToolChoice,
  ServerTool,
  StreamChunk,
  StreamFinalResult,
  StreamHeartbeatChunk,
  StreamReasoningItemChunk,
  StreamToolCallChunk,
  WebSearchCall,
  WebSearchResultLink,
  WebSearchTrace,
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
 * Maximum accepted `output_index` of a function call (yielded as
 * `StreamToolCallDelta.index`). `index` keys
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

interface FunctionCallProgress {
  // UTF-16 length of the `arguments` deltas yielded so far. Compared against
  // the finished `arguments` on `output_item.done` so a dropped delta fails
  // loudly instead of reaching a tool handler as truncated JSON that may
  // still parse.
  streamedLength: number;
  done: boolean;
}

/** Mutable per-request state threaded through `processSseLine()` across calls. */
interface SseStreamState {
  fullText: string;
  lastModel: string | undefined;
  lastProvider: string | undefined;
  lastUsage: ChatCompletionResponse["usage"] | undefined;
  // undefined = no terminal event (`response.completed` / `response.incomplete`)
  // observed yet. Once set, the stream is frozen: only [DONE]/comments are
  // legal until EOF.
  finishReasonSeen: string | undefined;
  // Every `function_call` item seen so far, keyed by `output_index`. This one
  // table is the only place a call's lifecycle is tracked, and
  // `openFunctionCall()` plus the `output_item.done` / terminal-event checks
  // are the only places it is enforced: a call is opened by its first event,
  // closed exactly once by an `output_item.done` whose `arguments` agree with
  // what was streamed, and never touched again. `toolLoop.ts` dispatches
  // whatever it accumulated, so every way of reaching a terminal "tool_calls"
  // with a call that skipped part of that lifecycle has to fail here.
  functionCalls: Map<number, FunctionCallProgress>;
  webSearch: WebSearchTrace;
}

/**
 * Reads the query and result URLs of a finished `openrouter:web_search`
 * item. Unlike function calls, nothing here drives the protocol: the trace
 * is only logged and displayed, so a malformed item is skipped rather than
 * failing a turn whose answer is otherwise fine.
 */
function readWebSearchCall(item: Record<string, unknown>): WebSearchCall | undefined {
  const action = item.action;
  if (!isPlainObject(action) || typeof action.query !== "string") return undefined;
  const sources = Array.isArray(action.sources)
    ? action.sources.flatMap((source) =>
        isPlainObject(source) && typeof source.url === "string" ? [source.url] : [],
      )
    : [];
  return { query: action.query, sources };
}

/** Same leniency as `readWebSearchCall()`. */
function readUrlCitation(annotation: unknown): WebSearchResultLink | undefined {
  if (
    !isPlainObject(annotation) ||
    annotation.type !== "url_citation" ||
    typeof annotation.url !== "string"
  ) {
    return undefined;
  }
  return {
    url: annotation.url,
    ...(typeof annotation.title === "string" && { title: annotation.title }),
  };
}

function finishedWebSearch(state: SseStreamState): WebSearchTrace | undefined {
  const { calls, results } = state.webSearch;
  return calls.length > 0 || results.length > 0 ? { calls, results } : undefined;
}

function readReasoningItem(item: Record<string, unknown>): ResponsesReasoningItem {
  if (typeof item.id !== "string") {
    throw new StreamProtocolError("reasoning item id must be a string");
  }
  if (!Array.isArray(item.summary)) {
    throw new StreamProtocolError("reasoning item summary must be an array");
  }
  // `OutputReasoningItem` declares `content` as `array | null`, so null is an
  // absent content list, not a malformed one.
  if (item.content !== undefined && item.content !== null && !Array.isArray(item.content)) {
    throw new StreamProtocolError("reasoning item content must be an array or null when present");
  }
  const parts: [unknown[], string][] = [
    [item.summary, "summary_text"],
    [Array.isArray(item.content) ? item.content : [], "reasoning_text"],
  ];
  for (const [list, type] of parts) {
    for (const part of list) {
      if (!isPlainObject(part) || part.type !== type || typeof part.text !== "string") {
        throw new StreamProtocolError(
          `reasoning item parts must be {type:"${type}", text: string}, got: ${JSON.stringify(part)}`,
        );
      }
    }
  }
  return item as unknown as ResponsesReasoningItem;
}

/**
 * Runtime object-shape check for wire data. The JSON payload is untyped at
 * the wire (a cast only asserts a shape, it never validates one), so a
 * provider sending e.g. `null` or a bare scalar where an object is expected
 * must be caught here — otherwise it either silently corrupts state (e.g.
 * `delta: 123` stringified into `fullText`) or reaches
 * a property access on `null`/a primitive and throws a raw `TypeError`
 * instead of the documented "reject-never" `StreamProtocolError` contract.
 * Arrays are excluded: a JSON array is `typeof "object"` but never the
 * intended shape for an event, its `item`, or its `response`.
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
    | StreamChunk
    | StreamToolCallChunk
    | StreamReasoningItemChunk
    | StreamHeartbeatChunk
    | StreamFinalResult,
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

/**
 * Runtime validation for an optional string field such as `response.model`.
 * Untyped wire JSON like every other field here: a provider sending e.g.
 * `model: {}` must be rejected before it ever reaches `state.lastModel`,
 * which a later footer render stringifies verbatim (`[object Object]`).
 * `null` is treated the same as absent.
 */
function assertValidOptionalStringField(value: unknown, fieldName: string): void {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new StreamProtocolError(
      `${fieldName} must be a string or null, got: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Reads a non-negative number off untyped wire JSON. `null` is how the API
 * spells "not reported" for several usage fields and is treated as absent.
 * Token counts must be safe integers (they are summed across turns as exact
 * counts in `toolLoop.ts`); monetary amounts only need to be finite.
 */
function readOptionalNumber(
  source: Record<string, unknown>,
  key: string,
  path: string,
  kind: "count" | "amount",
): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  const valid = kind === "count" ? Number.isSafeInteger(value) : Number.isFinite(value);
  if (!valid || (value as number) < 0) {
    throw new StreamProtocolError(
      `${path}.${key} must be a non-negative ${kind === "count" ? "safe integer" : "finite number"}, got: ${JSON.stringify(value)}`,
    );
  }
  return value as number;
}

function readOptionalObject(
  source: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw new StreamProtocolError(`${path}.${key} is not an object: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Copies `[targetKey, sourceKey]` pairs that the wire actually reported; an unreported key stays absent. */
function pickNumbers<T extends string>(
  source: Record<string, unknown> | undefined,
  path: string,
  kind: "count" | "amount",
  keys: readonly (readonly [T, string])[],
): Partial<Record<T, number>> | undefined {
  if (!source) return undefined;
  const picked: Partial<Record<T, number>> = {};
  for (const [targetKey, sourceKey] of keys) {
    const value = readOptionalNumber(source, sourceKey, path, kind);
    if (value !== undefined) picked[targetKey] = value;
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/**
 * Validates a Responses `usage` object and maps it onto the Chat Completions
 * field names the rest of the app reads (see `ChatCompletionResponse.usage`).
 * Validation happens here, at the wire, because a malformed value otherwise
 * only surfaces downstream: `buildUsageDetailsText()`'s `.toFixed()` throws a
 * raw TypeError on a non-number `cost`, and turn aggregation (`+=`) silently
 * produces a corrupted total.
 */
function mapResponsesUsage(raw: unknown): NonNullable<ChatCompletionResponse["usage"]> {
  if (!isPlainObject(raw)) {
    throw new StreamProtocolError(`usage is not an object: ${JSON.stringify(raw)}`);
  }
  const required = (key: string): number => {
    const value = readOptionalNumber(raw, key, "usage", "count");
    if (value === undefined) {
      throw new StreamProtocolError(`usage.${key} must be a non-negative safe integer, got: null`);
    }
    return value;
  };
  const usage: NonNullable<ChatCompletionResponse["usage"]> = {
    prompt_tokens: required("input_tokens"),
    completion_tokens: required("output_tokens"),
    total_tokens: required("total_tokens"),
  };
  const cost = readOptionalNumber(raw, "cost", "usage", "amount");
  if (cost !== undefined) usage.cost = cost;

  const promptDetails = pickNumbers(
    readOptionalObject(raw, "input_tokens_details", "usage"),
    "usage.input_tokens_details",
    "count",
    [
      ["cached_tokens", "cached_tokens"],
      ["cache_write_tokens", "cache_write_tokens"],
    ],
  );
  if (promptDetails) usage.prompt_tokens_details = promptDetails;

  const completionDetails = pickNumbers(
    readOptionalObject(raw, "output_tokens_details", "usage"),
    "usage.output_tokens_details",
    "count",
    [["reasoning_tokens", "reasoning_tokens"]],
  );
  if (completionDetails) usage.completion_tokens_details = completionDetails;

  const costDetails = pickNumbers(
    readOptionalObject(raw, "cost_details", "usage"),
    "usage.cost_details",
    "amount",
    [
      ["upstream_inference_cost", "upstream_inference_cost"],
      ["upstream_inference_prompt_cost", "upstream_inference_input_cost"],
      ["upstream_inference_completions_cost", "upstream_inference_output_cost"],
      ["server_tool_cost", "server_tool_cost"],
    ],
  );
  if (costDetails) usage.cost_details = costDetails;

  if (raw.is_byok !== undefined && raw.is_byok !== null) {
    if (typeof raw.is_byok !== "boolean") {
      throw new StreamProtocolError(
        `usage.is_byok must be a boolean, got: ${JSON.stringify(raw.is_byok)}`,
      );
    }
    usage.is_byok = raw.is_byok;
  }

  // Kept even when every counter inside is unreported: the key's presence
  // alone means a server tool ran, which a consumer must be able to tell
  // apart from "no server tool ran" (key absent).
  const serverToolUse = readOptionalObject(raw, "server_tool_use_details", "usage");
  if (serverToolUse) {
    usage.server_tool_use_details =
      pickNumbers(serverToolUse, "usage.server_tool_use_details", "count", [
        ["tool_calls_requested", "tool_calls_requested"],
        ["tool_calls_executed", "tool_calls_executed"],
        ["web_search_requests", "web_search_requests"],
      ]) ?? {};
  }
  return usage;
}

/**
 * Responses carries no top-level `provider`. The serving provider is only
 * reported under `openrouter_metadata` (opted into with the
 * `X-OpenRouter-Metadata` header) as the endpoint marked `selected`.
 * Deliberately lenient, unlike every other wire read here: the provider is a
 * display-only footer line, so an unexpected metadata shape drops that line
 * rather than failing a turn whose content arrived intact.
 */
function readSelectedProvider(metadata: unknown): string | undefined {
  if (!isPlainObject(metadata) || !isPlainObject(metadata.endpoints)) return undefined;
  const available = metadata.endpoints.available;
  if (!Array.isArray(available)) return undefined;
  for (const endpoint of available) {
    if (isPlainObject(endpoint) && endpoint.selected === true) {
      return typeof endpoint.provider === "string" ? endpoint.provider : undefined;
    }
  }
  return undefined;
}

/** `model` / `provider` / `usage` of a Responses result object, validated and mapped. */
function readResultMetadata(response: Record<string, unknown>): {
  model: string | undefined;
  provider: string | undefined;
  usage: ChatCompletionResponse["usage"] | undefined;
} {
  assertValidOptionalStringField(response.model, "response.model");
  return {
    model: typeof response.model === "string" ? response.model : undefined,
    provider: readSelectedProvider(response.openrouter_metadata),
    usage:
      response.usage === undefined || response.usage === null
        ? undefined
        : mapResponsesUsage(response.usage),
  };
}

/** Concatenated `output_text` of every `message` item, in output order. */
function readOutputText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  let text = "";
  for (const item of output) {
    if (!isPlainObject(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isPlainObject(part) && part.type === "output_text" && typeof part.text === "string") {
        text += part.text;
      }
    }
  }
  return text;
}

function toResponsesContentPart(part: ChatMessageContent): ResponsesInputContentPart {
  switch (part.type) {
    case "text":
      return { type: "input_text", text: part.text };
    case "image_url":
      // A bare string here, not Chat Completions' `{ url }` object. `detail`
      // is required by the API definition even though the live API accepts
      // its absence; "auto" leaves the resolution to the provider.
      return { type: "input_image", image_url: part.image_url.url, detail: "auto" };
    case "file":
      return { type: "input_file", filename: part.file.filename, file_data: part.file.file_data };
  }
}

function toResponsesContent(
  content: string | ChatMessageContent[],
): string | ResponsesInputContentPart[] {
  return typeof content === "string" ? content : content.map(toResponsesContentPart);
}

function toResponsesInput(messages: ChatMessage[]): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "user":
        input.push({ role: message.role, content: toResponsesContent(message.content) });
        break;
      case "assistant":
        // A tool-calling turn with no text has `content: null`; Responses has
        // no empty assistant message, so only the function_call items remain.
        for (const reasoningItem of message.reasoningItems ?? []) {
          input.push(reasoningItem);
        }
        if (message.content) input.push({ role: "assistant", content: message.content });
        for (const call of message.tool_calls ?? []) {
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
        break;
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: message.tool_call_id,
          output: message.content,
        });
        break;
    }
  }
  return input;
}

/**
 * Builds the `POST /responses` body from the internal Chat Completions
 * shaped request. Fields this function does not name are forwarded as-is
 * (`...rest`), which is what lets a later change add a request field such as
 * `session_id` to `ChatCompletionRequest` without touching this client.
 */
function toResponsesBody(request: ChatCompletionRequest, stream: boolean): Record<string, unknown> {
  const { messages, plugins, tools, tool_choice, parallel_tool_calls, ...rest } = request;
  const hasTools = Array.isArray(tools) && tools.length > 0;
  // Responses takes a function tool's definition flat, without Chat
  // Completions' `function` wrapper. Server tools are the same on both APIs.
  const responsesTools = tools?.map((tool): ResponsesFunctionTool | ServerTool =>
    tool.type === "function"
      ? { type: "function", ...(tool as FunctionTool).function }
      : (tool as ServerTool),
  );
  const responsesToolChoice: ResponsesToolChoice | undefined =
    typeof tool_choice === "object"
      ? { type: "function", name: tool_choice.function.name }
      : tool_choice;
  return {
    ...rest,
    input: toResponsesInput(messages),
    ...(hasTools && { include: ["reasoning.encrypted_content"] }),
    ...(plugins && { plugins }),
    ...(hasTools && {
      tools: responsesTools,
      ...(responsesToolChoice !== undefined && { tool_choice: responsesToolChoice }),
      ...(parallel_tool_calls !== undefined && { parallel_tool_calls }),
    }),
    ...(stream && { stream: true }),
  };
}

/**
 * `output_index` keys tool-call accumulation in `toolLoop.ts` (as
 * `StreamToolCallDelta.index`): it is unique per output item within one
 * response and increases in emission order, which is all the accumulator and
 * its index-ordered dispatch need. The values are not contiguous (reasoning
 * and message items take indices too).
 */
function readOutputIndex(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_TOOL_CALL_INDEX
  ) {
    throw new StreamProtocolError(`invalid output_index: ${JSON.stringify(value)}`);
  }
  return value as number;
}

/**
 * Looks up the progress of the function call at `index`, opening it if this
 * is its first event. A call that already reached `output_item.done` is
 * frozen: a later delta would change arguments that already passed their
 * length check, and a second `added`/`done` would reopen it.
 */
function openFunctionCall(state: SseStreamState, index: number): FunctionCallProgress {
  const call = state.functionCalls.get(index) ?? { streamedLength: 0, done: false };
  if (call.done) {
    throw new StreamProtocolError(
      `received another event for the function call at output_index ${index} after it finished`,
    );
  }
  return call;
}

/**
 * Maps `response.incomplete`'s reason onto the Chat Completions
 * `finish_reason` vocabulary `toolLoop.ts` branches on. Any reason outside
 * the two documented ones becomes `"incomplete"`, which the loop rejects as
 * an unknown finish_reason. The raw reason is never passed through: it is
 * untyped wire text, and a value such as `"tool_calls"` or `"stop"` would
 * otherwise select the loop's dispatch or normal-completion branch.
 */
function readIncompleteFinishReason(details: unknown): string {
  const reason = isPlainObject(details) ? details.reason : undefined;
  if (reason === "max_output_tokens") return "length";
  if (reason === "content_filter") return "content_filter";
  logger.warn("OpenRouter response.incomplete with an unrecognized reason", { reason });
  return "incomplete";
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
      const response = await this.postResponses(request, false);

      if (!response.ok) {
        await this.handleErrorResponse(response);
      }

      const data: unknown = await response.json();
      if (!isPlainObject(data)) {
        throw new StreamProtocolError(`Response body is not an object: ${JSON.stringify(data)}`);
      }
      // A generation that failed after the request was accepted comes back
      // as HTTP 200 with `status:"failed"`, so `handleErrorResponse()` above
      // never sees it.
      if (data.status === "failed") {
        this.throwForFailedResponse(data);
      }
      const { model, provider, usage } = readResultMetadata(data);
      return {
        ...(typeof data.id === "string" && { id: data.id }),
        ...(model !== undefined && { model }),
        ...(provider !== undefined && { provider }),
        choices: [{ message: { role: "assistant", content: readOutputText(data.output) } }],
        ...(usage !== undefined && { usage }),
      };
    } catch (err) {
      metrics.increment("openrouter.errors");
      throw err;
    }
  }

  private postResponses(
    request: ChatCompletionRequest,
    stream: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    return fetch(`${OPENROUTER_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": OPENROUTER_APP_URL,
        "X-OpenRouter-Title": OPENROUTER_APP_TITLE,
        "X-OpenRouter-Categories": OPENROUTER_APP_CATEGORIES,
        // Responses reports the serving provider only under the opt-in
        // `openrouter_metadata` (see `readSelectedProvider()`).
        "X-OpenRouter-Metadata": "enabled",
      },
      body: JSON.stringify(toResponsesBody(request, stream)),
      signal,
    });
  }

  async *chatStream(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<
    | StreamChunk
    | StreamToolCallChunk
    | StreamReasoningItemChunk
    | StreamHeartbeatChunk
    | StreamFinalResult,
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
      const response = await this.postResponses(request, true, signal);

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
        functionCalls: new Map(),
        webSearch: { calls: [], results: [] },
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
        // terminal event was observed is a normal completion.
        const webSearch = finishedWebSearch(state);
        yield {
          done: true,
          fullText: state.fullText,
          usage: state.lastUsage,
          model: state.lastModel,
          provider: state.lastProvider,
          finishReason: state.finishReasonSeen,
          ...(webSearch && { webSearch }),
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
   * Every field of an event is validated *before* this method mutates
   * `state` (`fullText`, `finishReasonSeen`, `lastUsage`, ...) or yields
   * anything derived from it, so a throw leaves `state` exactly as it was
   * before the line was processed and never stages a half-applied event to
   * the caller.
   */
  private *processSseLine(
    line: string,
    state: SseStreamState,
  ): Generator<
    | StreamChunk
    | StreamToolCallChunk
    | StreamReasoningItemChunk
    | StreamHeartbeatChunk
    | StreamFinalResult,
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
      // Always allowed, including after a terminal event (state is
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
      const webSearch = finishedWebSearch(state);
      yield {
        done: true,
        fullText: state.fullText,
        usage: state.lastUsage,
        model: state.lastModel,
        provider: state.lastProvider,
        finishReason: state.finishReasonSeen,
        ...(webSearch && { webSearch }),
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
    // number) must not reach the property accesses below (`event.type`,
    // `event.error`, ...), which would throw a raw TypeError on `null`
    // instead of the documented protocol-error contract.
    if (!isPlainObject(parsedData)) {
      throw new StreamProtocolError(`Stream chunk is not an object: ${JSON.stringify(parsedData)}`);
    }
    const event = parsedData;

    // Once a terminal event has been observed, the only lines this stream
    // still tolerates are `[DONE]` and comments/field lines (handled above).
    // This includes an error event: one arriving after the turn was already
    // declared done is not the API reporting a genuine failure, so it fails
    // as a protocol violation rather than being mapped to an API error class
    // (e.g. `InsufficientCreditsError`) that would misrepresent a completed
    // turn as having errored.
    if (state.finishReasonSeen !== undefined) {
      throw new StreamProtocolError("received additional stream data after the terminal event");
    }

    // Responses spells a mid-stream error as a flat `{type:"error", code,
    // message}` event. The `{error:{code,message}}` envelope is what
    // OpenRouter's HTTP errors use and what its Chat Completions streams sent
    // mid-stream; whether a Responses stream can still emit it is unverified,
    // so it stays accepted rather than being reclassified as an unknown event
    // (which would turn a real upstream failure into a silent heartbeat).
    const errorPayload = event.type === "error" ? event : event.error;
    if (errorPayload !== undefined && errorPayload !== null) {
      // The wire payload is untyped, so a provider sending e.g. a bare string
      // must be caught here rather than reach `throwForStreamErrorPayload()`,
      // which destructures `message`.
      if (!isPlainObject(errorPayload) || typeof errorPayload.message !== "string") {
        throw new StreamProtocolError(
          `Stream error event is malformed: ${JSON.stringify(errorPayload)}`,
        );
      }
      // Both an integer HTTP-status-like code and a symbolic string code
      // (e.g. `"server_error"`) are legitimate shapes; only a value that is
      // neither is a protocol violation. A missing `code` falls through to
      // `throwForStreamErrorPayload()`'s own handling.
      if (
        errorPayload.code !== undefined &&
        errorPayload.code !== null &&
        !Number.isInteger(errorPayload.code) &&
        typeof errorPayload.code !== "string"
      ) {
        throw new StreamProtocolError(
          `Stream error event has a non-integer, non-string code: ${JSON.stringify(errorPayload.code)}`,
        );
      }
      this.throwForStreamErrorPayload(
        errorPayload as NonNullable<OpenRouterErrorResponse["error"]>,
      ); // always throws
    }

    if (typeof event.type !== "string") {
      throw new StreamProtocolError(
        `Stream event has no string \`type\`: ${JSON.stringify(event.type)}`,
      );
    }

    switch (event.type) {
      case "response.output_text.delta": {
        // A non-string `delta` (e.g. a bare number) must not get concatenated
        // into `fullText` (which coerces it to a string) — that would let the
        // stream "succeed" with corrupted text instead of failing.
        if (typeof event.delta !== "string") {
          throw new StreamProtocolError(
            `output_text delta must be a string, got: ${JSON.stringify(event.delta)}`,
          );
        }
        if (event.delta.length === 0) break;
        state.fullText += event.delta;
        yield { content: event.delta, done: false };
        return false;
      }

      case "response.function_call_arguments.delta": {
        const index = readOutputIndex(event.output_index);
        if (typeof event.delta !== "string") {
          throw new StreamProtocolError(
            `function_call arguments delta must be a string, got: ${JSON.stringify(event.delta)}`,
          );
        }
        const call = openFunctionCall(state, index);
        state.functionCalls.set(index, {
          ...call,
          streamedLength: call.streamedLength + event.delta.length,
        });
        yield { toolCall: { index, argumentsDelta: event.delta }, done: false };
        return false;
      }

      case "response.output_item.added":
      case "response.output_item.done": {
        const item = event.item;
        if (!isPlainObject(item) || typeof item.type !== "string") {
          throw new StreamProtocolError(
            `${event.type} carries a malformed item: ${JSON.stringify(item)}`,
          );
        }
        if (item.type === "openrouter:web_search" && event.type === "response.output_item.done") {
          const call = readWebSearchCall(item);
          if (call) state.webSearch.calls.push(call);
          break;
        }
        if (item.type === "reasoning" && event.type === "response.output_item.done") {
          yield { reasoningItem: readReasoningItem(item), done: false };
          return false;
        }
        // Every other item type (`message`, `reasoning`, a server tool run
        // such as `openrouter:datetime`, ...) has nothing for the caller.
        if (item.type !== "function_call") break;

        const index = readOutputIndex(event.output_index);
        // A non-string id/name/arguments must fail here rather than reach
        // `normalizeToolCalls()`, whose `call.name.trim()` assumes a string.
        for (const key of ["call_id", "name", "arguments"] as const) {
          if (item[key] !== undefined && typeof item[key] !== "string") {
            throw new StreamProtocolError(
              `function_call.${key} must be a string, got: ${JSON.stringify(item[key])}`,
            );
          }
        }
        const callId = item.call_id as string | undefined;
        const name = item.name as string | undefined;
        const finishedArguments = item.arguments as string | undefined;

        // `call_id` and `name` arrive on `added` and are repeated on `done`;
        // both are forwarded, and `toolLoop.ts` rejects a repeat that
        // disagrees with the first value. `arguments` on `added` is ignored:
        // the deltas are the transport, and the finished string on `done` is
        // only checked against them.
        const call = openFunctionCall(state, index);
        let argumentsDelta: string | undefined;
        if (event.type === "response.output_item.done") {
          // Required, not merely checked when present: without it there is
          // nothing to hold the streamed deltas against.
          if (finishedArguments === undefined) {
            throw new StreamProtocolError(
              `function_call at output_index ${index} finished without \`arguments\``,
            );
          }
          if (finishedArguments.length !== call.streamedLength) {
            if (call.streamedLength > 0) {
              throw new StreamProtocolError(
                `function_call arguments at output_index ${index} finished with ${finishedArguments.length} characters but ${call.streamedLength} were streamed`,
              );
            }
            // No delta was ever streamed for this call, so the finished
            // string is the only copy of the arguments.
            argumentsDelta = finishedArguments;
          }
          state.functionCalls.set(index, { streamedLength: finishedArguments.length, done: true });
        } else {
          state.functionCalls.set(index, call);
        }
        yield {
          toolCall: {
            index,
            ...(callId !== undefined && { id: callId }),
            ...(name !== undefined && { name }),
            ...(argumentsDelta !== undefined && { argumentsDelta }),
          },
          done: false,
        };
        return false;
      }

      case "response.output_text.annotation.added": {
        const link = readUrlCitation(event.annotation);
        if (link) state.webSearch.results.push(link);
        break;
      }

      case "response.completed":
      case "response.incomplete": {
        if (!isPlainObject(event.response)) {
          throw new StreamProtocolError(
            `${event.type} carries a malformed response: ${JSON.stringify(event.response)}`,
          );
        }
        const calls = [...state.functionCalls.values()];
        // `response.incomplete` is exempt: a truncated turn legitimately
        // leaves a call unfinished, and its finishReason never makes the loop
        // dispatch (see `readIncompleteFinishReason()`).
        if (event.type === "response.completed" && calls.some((call) => !call.done)) {
          throw new StreamProtocolError(
            "response.completed arrived while a function call was still unfinished",
          );
        }
        const finishReason =
          event.type === "response.completed"
            ? calls.length > 0
              ? "tool_calls"
              : "stop"
            : readIncompleteFinishReason(event.response.incomplete_details);
        const { model, provider, usage } = readResultMetadata(event.response);

        if (model !== undefined) state.lastModel = model;
        if (provider !== undefined) state.lastProvider = provider;
        if (usage !== undefined) state.lastUsage = usage;
        state.finishReasonSeen = finishReason;
        // `usage` rides on the heartbeat itself (not just `state.lastUsage`)
        // so a caller that never reaches the terminal chunk (cancelled or
        // errored before `[DONE]`) can still observe it — see
        // `StreamHeartbeatChunk`'s doc comment.
        yield { heartbeat: true, done: false, ...(usage !== undefined && { usage }) };
        return false;
      }

      case "response.failed": {
        if (!isPlainObject(event.response)) {
          throw new StreamProtocolError(
            `response.failed carries a malformed response: ${JSON.stringify(event.response)}`,
          );
        }
        this.throwForFailedResponse(event.response); // always throws
      }
    }

    // An accepted event with nothing for the caller: lifecycle events
    // (`response.created`, `content_part.added`, `output_text.done`, ...),
    // reasoning deltas (their text is dropped), server tool progress, and any
    // event type this client does not know. Yielding a heartbeat keeps
    // `toolLoop.ts`'s idle timer measuring what it is meant to measure — a
    // gap in *receiving* — so a reasoning model that streams only reasoning
    // for minutes is not mistaken for a stalled connection. Accepting an
    // unknown type is this client's own forward-compatibility choice (the
    // OpenAPI definition lists a closed set): a new event type should not
    // fail every turn until this file learns about it. A stream that sends
    // such events forever is still bounded by the wall-clock timeout.
    yield { heartbeat: true, done: false };
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
   * Mid-stream error payload (`{code,message,...}`, from either error
   * shape `processSseLine()` accepts or a failed response's `error`). An
   * integer `code` is mapped to the same error classes as
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
      if (/^Server tool "openrouter:web_search" failed/u.test(message)) {
        throw new WebSearchFailedError(message);
      }
      throw new UnknownApiError(message);
    }
    throw this.buildApiError(code, message);
  }

  /** A Responses result with `status:"failed"`: its `error` has the same `{code,message}` shape as a stream error event. */
  private throwForFailedResponse(response: Record<string, unknown>): never {
    const error = response.error;
    if (
      !isPlainObject(error) ||
      typeof error.message !== "string" ||
      (error.code !== undefined &&
        error.code !== null &&
        !Number.isInteger(error.code) &&
        typeof error.code !== "string")
    ) {
      throw new StreamProtocolError(
        `Failed response carries a malformed error: ${JSON.stringify(error)}`,
      );
    }
    this.throwForStreamErrorPayload(error as NonNullable<OpenRouterErrorResponse["error"]>);
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
