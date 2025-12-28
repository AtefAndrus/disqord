import type { AppConfig } from "../config";
import {
  AuthenticationError,
  BadRequestError,
  ConfigurationError,
  InsufficientCreditsError,
  InvalidModelError,
  ModelUnavailableError,
  ModerationError,
  RateLimitError,
  TimeoutError,
  UnknownApiError,
} from "../errors";
import type { ChatCompletionRequest, ChatCompletionResponse, OpenRouterModel } from "../types";
import { logger } from "../utils/logger";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface ILLMClient {
  chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
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
    };
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
    metadata?: Record<string, unknown>;
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
      const retryAfterSeconds = this.rateLimitResetAt
        ? Math.max(0, Math.ceil((this.rateLimitResetAt - Date.now()) / 1000))
        : undefined;
      throw new RateLimitError("Rate limited. Please try again later.", retryAfterSeconds);
    }

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...request,
        usage: {
          include: true,
        },
      }),
    });

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    return data;
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

    switch (response.status) {
      case 400:
        if (message.includes("is not a valid model ID")) {
          throw new InvalidModelError(message);
        }
        if (message.includes("data policy") || message.includes("Configure:")) {
          const configUrl = message.match(/https:\/\/openrouter\.ai\/[^\s]+/)?.[0];
          throw new ConfigurationError(message, configUrl);
        }
        throw new BadRequestError(message);

      case 401:
        throw new AuthenticationError(message);

      case 402:
        throw new InsufficientCreditsError(message);

      case 403:
        throw new ModerationError(message);

      case 408:
        throw new TimeoutError(message);

      case 429: {
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

      case 500:
        throw new ModelUnavailableError(message, 500);

      case 502:
        throw new ModelUnavailableError(message, 502);

      case 503:
        throw new ModelUnavailableError(message, 503);

      default:
        throw new UnknownApiError(message, response.status);
    }
  }
}
