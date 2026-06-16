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

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string | ChatMessageContent[];
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  plugins?: ChatPlugin[];
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

export interface StreamFinalResult {
  done: true;
  fullText: string;
  usage?: ChatCompletionResponse["usage"];
  model?: string;
  provider?: string;
}
