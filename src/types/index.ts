export type GuildId = string;
export type ChannelId = string;
export type UserId = string;
export type MessageId = string;

export interface GuildSettings {
  guildId: GuildId;
  adminRoleId: string | null;
  releaseAnnounceChannelId: ChannelId | null;
  allowedChannels: ChannelId[] | null;
  settingsVersion: number;
  updatedBy: string | null;
  defaultModel: string;
  freeModelsOnly: boolean;
  showLlmDetails: boolean;
  autoReplyChannels: ChannelId[];
  webSearchEnabled: boolean;
  reasoningDisplayEnabled: boolean;
  twitterExpandEnabled: boolean;
  historyEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  created: number;
  contextLength: number;
  pricing: {
    prompt: string;
    completion: string;
    image?: string;
    request?: string;
  };
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters?: string[];
}

export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageContentPart {
  type: "image_url";
  image_url: { url: string };
}

export interface FileContentPart {
  type: "file";
  file: { filename: string; file_data: string };
}

export type ChatMessageContent = TextContentPart | ImageContentPart | FileContentPart;

export interface FileParserPlugin {
  id: "file-parser";
  pdf?: { engine: "cloudflare-ai" | "mistral-ocr" | "native" };
}

export type ChatPlugin = FileParserPlugin;

export interface FunctionToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface FunctionTool {
  type: "function";
  function: FunctionToolDefinition;
}

/** server tool（openrouter:web_search 等）は opaque に透過させる */
export interface ServerTool {
  type: string;
  [key: string]: unknown;
}

export type Tool = FunctionTool | ServerTool;

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export interface UserChatMessage {
  role: "user";
  content: string | ChatMessageContent[];
}

export interface SystemChatMessage {
  role: "system";
  content: string | ChatMessageContent[];
}

export interface AssistantChatMessage {
  role: "assistant";
  content: string | null;
  reasoningItems?: ResponsesReasoningItem[];
  tool_calls?: ToolCall[];
}

export interface ToolChatMessage {
  role: "tool";
  content: string | ResponsesInputContentPart[];
  tool_call_id: string;
}

export type ChatMessage =
  | UserChatMessage
  | SystemChatMessage
  | AssistantChatMessage
  | ToolChatMessage;

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  include?: "reasoning.encrypted_content"[];
  reasoning?: ResponsesReasoningConfig;
  plugins?: ChatPlugin[];
  tools?: Tool[];
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
  session_id?: string;
}

export interface ChatCompletionResponse {
  id?: string;
  model?: string;
  provider?: string;
  choices: {
    message: {
      role: "assistant";
      content: string;
    };
  }[];
  /**
   * Chat Completions field names are kept as the internal shape even though
   * the wire is the Responses API: the footer and the usage accounting of
   * later changes read these names, so `OpenRouterClient` maps
   * `input_tokens`/`output_tokens` onto them at the boundary. Optional keys
   * are absent when the API did not report them; absent is "unknown", not 0.
   */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
    cost_details?: {
      upstream_inference_cost?: number;
      upstream_inference_prompt_cost?: number;
      upstream_inference_completions_cost?: number;
      server_tool_cost?: number;
    };
    is_byok?: boolean;
    server_tool_use_details?: ServerToolUseDetails;
  };
}

/**
 * Omitted from `usage` entirely when no server tool ran in the request.
 * A type alias rather than an interface: `toolLoop.ts` sums usage detail
 * objects generically, and only an alias is assignable to a string-keyed record.
 */
export type ServerToolUseDetails = {
  tool_calls_requested?: number;
  tool_calls_executed?: number;
  web_search_requests?: number;
};

// ---- Responses API wire shapes (`POST /api/v1/responses`). Only
// `OpenRouterClient` sees these; everything else keeps the
// `ChatCompletionRequest` / `ChatCompletionResponse` shapes above. ----

export type ResponsesInputContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" }
  | { type: "input_file"; filename: string; file_data: string };

/** An opaque Responses reasoning text part; unknown fields are preserved when the item is resent. */
export interface ResponsesReasoningTextPart {
  text: string;
  [key: string]: unknown;
}

/** A complete reasoning output item, kept exactly as received for a tool-loop continuation. */
export interface ResponsesReasoningItem {
  type: "reasoning";
  id: string;
  summary: ResponsesReasoningTextPart[];
  content?: ResponsesReasoningTextPart[] | null;
  [key: string]: unknown;
}

export interface ResponsesReasoningConfig {
  summary: "auto";
}

/** Provider-authored reasoning text extracted for the final attachment. */
export type ReasoningDisplayText = string;

export type ResponsesInputItem =
  | { role: "system" | "user"; content: string | ResponsesInputContentPart[] }
  | { role: "assistant"; content: string }
  | ResponsesReasoningItem
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string | ResponsesInputContentPart[] };

export interface ResponsesFunctionTool extends FunctionToolDefinition {
  type: "function";
}

export type ResponsesToolChoice = "auto" | "none" | "required" | { type: "function"; name: string };

export interface ResponsesOutputItem {
  type: string;
  [key: string]: unknown;
}

export interface ResponsesResult {
  id?: string;
  model?: string;
  status?: string;
  error?: { code?: number | string; message: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: ResponsesOutputItem[];
  usage?: unknown;
  openrouter_metadata?: unknown;
}

export interface OpenRouterError {
  code: number;
  message: string;
  metadata?: {
    headers?: {
      "X-RateLimit-Limit"?: string;
      "X-RateLimit-Remaining"?: string;
      "X-RateLimit-Reset"?: string;
    };
  };
}

export interface StreamChunk {
  content: string;
  done: false;
}

export interface StreamToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

export interface StreamToolCallChunk {
  toolCall: StreamToolCallDelta;
  done: false;
}

export interface StreamReasoningItemChunk {
  reasoningItem: ResponsesReasoningItem;
  done: false;
}

/**
 * Yielded for an SSE comment line (e.g. OpenRouter's `: OPENROUTER PROCESSING`
 * keep-alive), a non-`data:` field line, or an accepted event that carries
 * no content/tool_call for the caller (lifecycle events, reasoning deltas,
 * server tool items, the terminal event, ...) — it exists so a consumer
 * measuring inter-chunk gaps (e.g. an idle timeout) observes stream liveness
 * during a heartbeat-only lull instead of mistaking it for a stalled
 * connection. `usage` is populated on the heartbeat yielded for the terminal
 * event (`response.completed` / `response.incomplete`), sent right before
 * `[DONE]`.
 * Without this, that usage is otherwise only observable via the terminal
 * `StreamFinalResult` — unreachable if the caller cancels or the stream
 * errors between this heartbeat and the terminal chunk — so surfacing it
 * here lets a caller keep the last-known usage even when the turn never
 * reaches completion.
 */
export interface StreamHeartbeatChunk {
  heartbeat: true;
  done: false;
  usage?: ChatCompletionResponse["usage"];
}

export interface StreamFinalResult {
  done: true;
  fullText: string;
  usage?: ChatCompletionResponse["usage"];
  model?: string;
  provider?: string;
  finishReason?: string | null;
  /** Absent when no web search ran in the turn. */
  webSearch?: WebSearchTrace;
  /** Absent when the turn returned no displayable reasoning text. */
  reasoningText?: ReasoningDisplayText;
}

/** One `openrouter:web_search` call as the stream reported it. */
export interface WebSearchCall {
  query: string;
  /** Result URLs; OpenRouter omits them for a call refused past `max_uses`. */
  sources: string[];
}

/**
 * A `url_citation` annotation. OpenRouter attaches one per search result
 * handed to the model (all with `start_index`/`end_index` 0 as of
 * 2026-09-22), so it lists the pages the model was given, not the spans of
 * the answer that quote them.
 */
export interface WebSearchResultLink {
  url: string;
  title?: string;
}

export interface WebSearchTrace {
  calls: WebSearchCall[];
  results: WebSearchResultLink[];
}
