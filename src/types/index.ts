export type GuildId = string;
export type ChannelId = string;
export type UserId = string;
export type MessageId = string;

export interface GuildSettings {
  guildId: GuildId;
  defaultModel: string;
  createdAt: string;
  updatedAt: string;
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
  choices: {
    message: {
      role: "assistant";
      content: string;
    };
  }[];
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
