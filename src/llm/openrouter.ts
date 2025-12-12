import type { AppConfig } from "../config";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../types";
import { logger } from "../utils/logger";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface ILLMClient {
  chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  listModels(): Promise<string[]>;
  getCredits(): Promise<{ remaining: number }>;
  isRateLimited(): boolean;
}

interface OpenRouterModelResponse {
  data: {
    id: string;
    name: string;
    context_length: number;
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
    code: number;
    message: string;
  };
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
      throw new Error("Rate limited. Please try again later.");
    }

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    return data;
  }

  async listModels(): Promise<string[]> {
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
    return data.data.map((model) => model.id);
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
    if (response.status === 429) {
      const resetHeader = response.headers.get("X-RateLimit-Reset");
      if (resetHeader) {
        this.rateLimitResetAt = Number.parseInt(resetHeader, 10);
      } else {
        this.rateLimitResetAt = Date.now() + 60_000;
      }
      logger.warn("Rate limited by OpenRouter", { resetAt: this.rateLimitResetAt });
      throw new Error("Rate limited by OpenRouter. Please try again later.");
    }

    const errorBody = (await response.json().catch(() => ({}))) as OpenRouterErrorResponse;
    const message = errorBody.error?.message ?? `HTTP ${response.status}`;
    logger.error("OpenRouter API error", { status: response.status, message });
    throw new Error(`OpenRouter API error: ${message}`);
  }
}
