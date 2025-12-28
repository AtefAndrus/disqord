import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ILLMClient } from "../../../src/llm/openrouter";
import { ModelService } from "../../../src/services/modelService";
import type { OpenRouterModel } from "../../../src/types";

describe("ModelService", () => {
  const mockModels: OpenRouterModel[] = [
    {
      id: "free-model-1",
      name: "Free Model 1",
      created: 1640000000,
      contextLength: 4096,
      pricing: { prompt: "0", completion: "0" },
    },
    {
      id: "free-model-2",
      name: "Free Model 2",
      created: 1650000000,
      contextLength: 8192,
      pricing: { prompt: "0", completion: "0" },
    },
    {
      id: "paid-model-1",
      name: "Paid Model 1",
      created: 1660000000,
      contextLength: 16384,
      pricing: { prompt: "0.001", completion: "0.002" },
    },
    {
      id: "paid-model-2",
      name: "Paid Model 2",
      created: 1670000000,
      contextLength: 32768,
      pricing: { prompt: "0.01", completion: "0.02" },
    },
  ];

  let mockLLMClient: ILLMClient;
  let modelService: ModelService;

  beforeEach(() => {
    mockLLMClient = {
      chat: mock(() =>
        Promise.resolve({ choices: [{ message: { role: "assistant" as const, content: "" } }] }),
      ),
      listModels: mock(() => Promise.resolve(mockModels.map((m) => m.id))),
      listModelsWithPricing: mock(() => Promise.resolve(mockModels)),
      getCredits: mock(() => Promise.resolve({ remaining: 100 })),
      isRateLimited: mock(() => false),
    };
    modelService = new ModelService(mockLLMClient);
  });

  describe("getAllModels", () => {
    test("returns all models from LLM client", async () => {
      const models = await modelService.getAllModels();
      expect(models).toHaveLength(4);
      expect(models).toEqual(mockModels);
    });

    test("caches models and does not refetch within TTL", async () => {
      await modelService.getAllModels();
      await modelService.getAllModels();
      await modelService.getAllModels();

      expect(mockLLMClient.listModelsWithPricing).toHaveBeenCalledTimes(1);
    });

    test("bypasses cache when noCache is true", async () => {
      await modelService.getAllModels();
      await modelService.getAllModels({ noCache: true });

      expect(mockLLMClient.listModelsWithPricing).toHaveBeenCalledTimes(2);
    });
  });

  describe("getFreeModels", () => {
    test("returns only free models (pricing.prompt === '0' and pricing.completion === '0')", async () => {
      const freeModels = await modelService.getFreeModels();
      expect(freeModels).toHaveLength(2);
      expect(
        freeModels.every((m) => m.pricing.prompt === "0" && m.pricing.completion === "0"),
      ).toBe(true);
    });

    test("excludes paid models", async () => {
      const freeModels = await modelService.getFreeModels();
      expect(freeModels.find((m) => m.id === "paid-model-1")).toBeUndefined();
      expect(freeModels.find((m) => m.id === "paid-model-2")).toBeUndefined();
    });
  });

  describe("isModelAvailable", () => {
    test("returns true for existing model", async () => {
      expect(await modelService.isModelAvailable("free-model-1")).toBe(true);
      expect(await modelService.isModelAvailable("paid-model-1")).toBe(true);
    });

    test("returns false for non-existing model", async () => {
      expect(await modelService.isModelAvailable("non-existing-model")).toBe(false);
    });
  });

  describe("isFreeModel", () => {
    test("returns true for free model", async () => {
      expect(await modelService.isFreeModel("free-model-1")).toBe(true);
      expect(await modelService.isFreeModel("free-model-2")).toBe(true);
    });

    test("returns false for paid model", async () => {
      expect(await modelService.isFreeModel("paid-model-1")).toBe(false);
      expect(await modelService.isFreeModel("paid-model-2")).toBe(false);
    });

    test("returns false for non-existing model", async () => {
      expect(await modelService.isFreeModel("non-existing-model")).toBe(false);
    });
  });

  describe("validateModelSelection", () => {
    test("returns valid for existing model when freeModelsOnly is false", async () => {
      const result = await modelService.validateModelSelection("paid-model-1", false);
      expect(result).toEqual({ valid: true });
    });

    test("returns MODEL_NOT_FOUND for non-existing model", async () => {
      const result = await modelService.validateModelSelection("non-existing-model", false);
      expect(result).toEqual({ valid: false, error: "MODEL_NOT_FOUND" });
    });

    test("returns MODEL_NOT_FREE for paid model when freeModelsOnly is true", async () => {
      const result = await modelService.validateModelSelection("paid-model-1", true);
      expect(result).toEqual({ valid: false, error: "MODEL_NOT_FREE" });
    });

    test("returns valid for free model when freeModelsOnly is true", async () => {
      const result = await modelService.validateModelSelection("free-model-1", true);
      expect(result).toEqual({ valid: true });
    });
  });

  describe("refreshCache", () => {
    test("forces cache refresh", async () => {
      await modelService.getAllModels();
      expect(mockLLMClient.listModelsWithPricing).toHaveBeenCalledTimes(1);

      await modelService.refreshCache();
      expect(mockLLMClient.listModelsWithPricing).toHaveBeenCalledTimes(2);
    });
  });

  describe("getCacheStatus", () => {
    test("returns empty status when cache is not populated", () => {
      const status = modelService.getCacheStatus();
      expect(status.lastUpdatedAt).toBeNull();
      expect(status.modelCount).toBe(0);
      expect(status.isExpired).toBe(true);
    });

    test("returns populated status after getAllModels", async () => {
      await modelService.getAllModels();
      const status = modelService.getCacheStatus();
      expect(status.lastUpdatedAt).toBeInstanceOf(Date);
      expect(status.modelCount).toBe(4);
      expect(status.isExpired).toBe(false);
    });

    test("returns correct model count for free models", async () => {
      await modelService.getFreeModels();
      const status = modelService.getCacheStatus();
      expect(status.modelCount).toBe(4); // All models are cached, not just free ones
    });
  });
});
