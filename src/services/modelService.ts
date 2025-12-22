import type { ILLMClient } from "../llm/openrouter";
import type { OpenRouterModel } from "../types";

export interface ModelValidationResult {
  valid: boolean;
  error?: "MODEL_NOT_FOUND" | "MODEL_NOT_FREE";
}

export interface CacheStatus {
  lastUpdatedAt: Date | null;
  modelCount: number;
  isExpired: boolean;
}

export interface IModelService {
  getAllModels(options?: { noCache?: boolean }): Promise<OpenRouterModel[]>;
  getFreeModels(options?: { noCache?: boolean }): Promise<OpenRouterModel[]>;
  isModelAvailable(modelId: string): Promise<boolean>;
  isFreeModel(modelId: string): Promise<boolean>;
  validateModelSelection(modelId: string, freeModelsOnly: boolean): Promise<ModelValidationResult>;
  refreshCache(): Promise<void>;
  getCacheStatus(): CacheStatus;
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export class ModelService implements IModelService {
  private modelsCache: CacheEntry<OpenRouterModel[]> | null = null;

  constructor(private readonly llmClient: ILLMClient) {}

  async getAllModels(options?: { noCache?: boolean }): Promise<OpenRouterModel[]> {
    const now = Date.now();

    if (!options?.noCache && this.modelsCache && this.modelsCache.expiresAt > now) {
      return this.modelsCache.data;
    }

    const models = await this.llmClient.listModelsWithPricing();
    this.modelsCache = {
      data: models,
      expiresAt: now + CACHE_TTL_MS,
    };
    return models;
  }

  async getFreeModels(options?: { noCache?: boolean }): Promise<OpenRouterModel[]> {
    const models = await this.getAllModels(options);
    return models.filter((m) => m.pricing.prompt === "0" && m.pricing.completion === "0");
  }

  async isModelAvailable(modelId: string): Promise<boolean> {
    const models = await this.getAllModels();
    return models.some((m) => m.id === modelId);
  }

  async isFreeModel(modelId: string): Promise<boolean> {
    const freeModels = await this.getFreeModels();
    return freeModels.some((m) => m.id === modelId);
  }

  async validateModelSelection(
    modelId: string,
    freeModelsOnly: boolean,
  ): Promise<ModelValidationResult> {
    const isAvailable = await this.isModelAvailable(modelId);
    if (!isAvailable) {
      return { valid: false, error: "MODEL_NOT_FOUND" };
    }

    if (freeModelsOnly) {
      const isFree = await this.isFreeModel(modelId);
      if (!isFree) {
        return { valid: false, error: "MODEL_NOT_FREE" };
      }
    }

    return { valid: true };
  }

  async refreshCache(): Promise<void> {
    await this.getAllModels({ noCache: true });
  }

  getCacheStatus(): CacheStatus {
    if (!this.modelsCache) {
      return {
        lastUpdatedAt: null,
        modelCount: 0,
        isExpired: true,
      };
    }

    const now = Date.now();
    const lastUpdatedAt = new Date(this.modelsCache.expiresAt - CACHE_TTL_MS);
    return {
      lastUpdatedAt,
      modelCount: this.modelsCache.data.length,
      isExpired: this.modelsCache.expiresAt <= now,
    };
  }
}
