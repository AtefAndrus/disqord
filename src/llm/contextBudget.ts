import type { ChatMessage, ChatMessageContent, ResponsesInputContentPart, Tool } from "../types";
import { estimateTextTokens } from "../utils/tokenEstimate";

/**
 * Sent as `max_output_tokens` unless the model states a smaller maximum, and
 * reserved out of the context by the same amount. `max_output_tokens` also
 * bounds reasoning tokens on reasoning models, so it is not set lower.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
/**
 * The output reservation never takes more than this share of the context.
 * Reserving a provider's full maximum would leave `qwen/qwen-2.5-7b-instruct`
 * (context 32,768, maximum output 29,491) almost no room for the input.
 */
export const MAX_OUTPUT_CONTEXT_SHARE = 0.25;
/**
 * Applied to what is left of the context after the first request. The
 * estimate is about twice the real count for Japanese but can fall short for
 * ASCII-heavy JSON, which tokenizes nearer three characters per token.
 */
export const CONTEXT_BUDGET_SAFETY_FACTOR = 0.75;
/** Used when the model's context length is unknown. */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 16_000;
/** Role, separators, and call ids around each history item. */
export const MESSAGE_OVERHEAD_TOKENS = 8;
/** One image in the input. Providers bill roughly 250 to 1,600 tokens per image. */
export const IMAGE_TOKEN_ESTIMATE = 1_600;
/** One PDF in the input. A PDF's real cost grows with its pages; this is a fixed stand-in. */
export const PDF_TOKEN_ESTIMATE = 10_000;
/** Cap on the error texts the tool dispatcher generates itself. */
export const MAX_TOOL_ERROR_RESULT_BYTES = 256;
/**
 * Upper bound of a fixed-length tool result: a dispatcher error clipped to
 * `MAX_TOOL_ERROR_RESULT_BYTES` (at most one token per two bytes), or a
 * tool's terminal result, which the dispatcher accepts only up to this size.
 */
export const FIXED_RESULT_TOKENS =
  Math.ceil(MAX_TOOL_ERROR_RESULT_BYTES / 2) + 1 + MESSAGE_OVERHEAD_TOKENS;

export function computeMaxOutputTokens(
  contextLength: number | null | undefined,
  maxCompletionTokens: number | null | undefined,
): number {
  const limits = [DEFAULT_MAX_OUTPUT_TOKENS];
  if (maxCompletionTokens != null && maxCompletionTokens > 0) limits.push(maxCompletionTokens);
  if (contextLength != null && contextLength > 0) {
    limits.push(Math.max(1, Math.floor(contextLength * MAX_OUTPUT_CONTEXT_SHARE)));
  }
  return Math.min(...limits);
}

function estimatePartTokens(part: ChatMessageContent | ResponsesInputContentPart): number {
  switch (part.type) {
    case "text":
    case "input_text":
      return estimateTextTokens(part.text);
    case "image_url":
    case "input_image":
      return IMAGE_TOKEN_ESTIMATE;
    case "file":
    case "input_file":
      return PDF_TOKEN_ESTIMATE;
  }
}

function estimateContentTokens(
  content: string | readonly (ChatMessageContent | ResponsesInputContentPart)[] | null,
): number {
  if (content === null) return 0;
  if (typeof content === "string") return estimateTextTokens(content);
  return content.reduce((total, part) => total + estimatePartTokens(part), 0);
}

/** What one `role:"tool"` history item adds to the next request. Tools size their results with this. */
export function estimateToolResultTokens(
  content: string | readonly ResponsesInputContentPart[],
): number {
  return estimateContentTokens(content) + MESSAGE_OVERHEAD_TOKENS;
}

export function estimateChatMessageTokens(message: ChatMessage): number {
  if (message.role === "tool") return estimateToolResultTokens(message.content);
  let tokens = estimateContentTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
  if (message.role === "assistant") {
    if (message.reasoningItems && message.reasoningItems.length > 0) {
      tokens += estimateTextTokens(JSON.stringify(message.reasoningItems));
    }
    for (const call of message.tool_calls ?? []) {
      tokens +=
        estimateTextTokens(`${call.id}${call.function.name}${call.function.arguments}`) +
        MESSAGE_OVERHEAD_TOKENS;
    }
  }
  return tokens;
}

export function estimateToolsTokens(tools: readonly Tool[]): number {
  return tools.length === 0 ? 0 : estimateTextTokens(JSON.stringify(tools));
}
