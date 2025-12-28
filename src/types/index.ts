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
  };
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
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
