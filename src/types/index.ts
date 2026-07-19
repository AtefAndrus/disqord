export type GuildId = string;
export type ChannelId = string;
export type UserId = string;
export type MessageId = string;

export interface GuildSettings {
  guildId: GuildId;
  defaultModel: string;
  freeModelsOnly: boolean;
  releaseChannelId: ChannelId | null;
  showLlmDetails: boolean;
  autoReplyChannels: ChannelId[];
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
  tool_calls?: ToolCall[];
}

export interface ToolChatMessage {
  role: "tool";
  content: string;
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
  plugins?: ChatPlugin[];
  tools?: Tool[];
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
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
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
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

/**
 * Yielded for an SSE comment line (e.g. OpenRouter's `: OPENROUTER PROCESSING`
 * keep-alive), a non-`data:` field line, or an accepted `data:` frame that
 * carries no content/tool_call for the caller (role-only delta, usage-only
 * trailer, finish_reason-only terminal frame, ...) — it exists so a consumer
 * measuring inter-chunk gaps (e.g. an idle timeout) observes stream liveness
 * during a heartbeat-only lull instead of mistaking it for a stalled
 * connection. `usage` is populated whenever the underlying `data:` frame
 * carries a validated `usage` — most notably OpenRouter's empty-`choices`
 * trailer sent right before `[DONE]`, but also a frame that pairs `usage`
 * with `content`/`tool_calls`: that payload is yielded through
 * `StreamChunk`/`StreamToolCallChunk` as usual, and this heartbeat follows
 * immediately after as a separate chunk carrying just the frame's `usage`.
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
}
