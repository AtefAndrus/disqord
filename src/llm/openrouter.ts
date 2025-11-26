import type { ChatCompletionRequest, ChatCompletionResponse } from "../types";

export interface ILLMClient {
  chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  listModels(): Promise<string[]>;
  getCredits(): Promise<{ remaining: number }>;
  isRateLimited(): boolean;
}

export class OpenRouterClient implements ILLMClient {
  isRateLimited(): boolean {
    return false;
  }

  async chat(_request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    throw new Error("Not implemented");
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  async getCredits(): Promise<{ remaining: number }> {
    return { remaining: 0 };
  }
}
