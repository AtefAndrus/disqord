import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  AuthenticationError,
  BadRequestError,
  InsufficientCreditsError,
  InvalidModelError,
  ModelUnavailableError,
  ModerationError,
  RateLimitError,
  TimeoutError,
  UnknownApiError,
} from "../../../src/errors";
import { OpenRouterClient } from "../../../src/llm/openrouter";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../../src/types";

describe("OpenRouterClient", () => {
  let client: OpenRouterClient;
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    client = new OpenRouterClient("test-api-key");
    originalFetch = globalThis.fetch;
    mockFetch = mock();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    spyOn(console, "debug").mockImplementation(() => {});
    spyOn(console, "info").mockImplementation(() => {});
    spyOn(console, "warn").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("chat", () => {
    test("正常なレスポンスを返す", async () => {
      const expectedResponse: ChatCompletionResponse = {
        id: "chatcmpl-123",
        choices: [{ message: { role: "assistant", content: "Hello!" } }],
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(expectedResponse),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };
      const result = await client.chat(request);

      expect(result).toEqual(expectedResponse);
    });

    test("正しいエンドポイントとヘッダーでfetchを呼び出す", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [] }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };
      await client.chat(request);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://openrouter.ai/api/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer test-api-key",
            "Content-Type": "application/json",
          },
        }),
      );
    });

    test("リクエストボディが正しくJSONシリアライズされる", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [] }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Test message" }],
      };
      await client.chat(request);

      const callArgs = mockFetch.mock.calls[0];
      const options = callArgs[1] as RequestInit;
      expect(JSON.parse(options.body as string)).toEqual(request);
    });

    test("レート制限時はRateLimitErrorをスローする", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "X-RateLimit-Reset": String(Date.now() + 60000) }),
        json: () => Promise.resolve({ error: { message: "Rate limit exceeded" } }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };

      await expect(client.chat(request)).rejects.toBeInstanceOf(RateLimitError);
    });

    test("429エラーでレート制限状態になる", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "X-RateLimit-Reset": String(Date.now() + 60000) }),
        json: () => Promise.resolve({}),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };

      try {
        await client.chat(request);
      } catch {
        // Expected error
      }

      expect(client.isRateLimited()).toBe(true);
    });

    test("429エラーでX-RateLimit-Resetヘッダーがない場合はレート制限フラグをセットしない", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers(),
        json: () => Promise.resolve({ error: { message: "Provider returned error" } }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };

      try {
        await client.chat(request);
      } catch {
        // Expected error
      }

      // プロバイダー制限の場合はグローバルフラグをセットしない
      expect(client.isRateLimited()).toBe(false);
    });

    test("429エラーでヘッダーがない場合のuserMessageにリトライ秒数が含まれない", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers(),
        json: () => Promise.resolve({ error: { message: "Provider returned error" } }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };

      try {
        await client.chat(request);
      } catch (error) {
        expect(error).toBeInstanceOf(RateLimitError);
        expect((error as RateLimitError).userMessage).toBe(
          "リクエスト制限に達しました。しばらくしてから再度お試しください。",
        );
      }
    });

    test("500エラーはModelUnavailableErrorをスローする", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
        json: () => Promise.resolve({ error: { message: "Internal server error" } }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };

      await expect(client.chat(request)).rejects.toBeInstanceOf(ModelUnavailableError);
    });

    test("その他のHTTPエラーはUnknownApiErrorをスローする", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 599,
        headers: new Headers(),
        json: () => Promise.resolve({ error: { message: "Unknown error" } }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };

      await expect(client.chat(request)).rejects.toBeInstanceOf(UnknownApiError);
    });

    test("エラーレスポンスがパースできない場合はModelUnavailableErrorをスローする", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        headers: new Headers(),
        json: () => Promise.reject(new Error("Invalid JSON")),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };

      await expect(client.chat(request)).rejects.toBeInstanceOf(ModelUnavailableError);
    });

    test("400エラーはBadRequestErrorをスローする", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: new Headers(),
        json: () => Promise.resolve({ error: { message: "Invalid parameters" } }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };

      await expect(client.chat(request)).rejects.toBeInstanceOf(BadRequestError);
    });

    test("400エラーで無効なモデルIDの場合はInvalidModelErrorをスローする", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: new Headers(),
        json: () =>
          Promise.resolve({
            error: { message: "nonexistent/model is not a valid model ID" },
          }),
      });

      const request: ChatCompletionRequest = {
        model: "nonexistent/model",
        messages: [{ role: "user", content: "Hi" }],
      };

      await expect(client.chat(request)).rejects.toBeInstanceOf(InvalidModelError);
    });

    test("401エラーはAuthenticationErrorをスローする", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers(),
        json: () => Promise.resolve({ error: { message: "Invalid API key" } }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };

      await expect(client.chat(request)).rejects.toBeInstanceOf(AuthenticationError);
    });

    test("402エラーはInsufficientCreditsErrorをスローする", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 402,
        headers: new Headers(),
        json: () => Promise.resolve({ error: { message: "Insufficient credits" } }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };

      await expect(client.chat(request)).rejects.toBeInstanceOf(InsufficientCreditsError);
    });

    test("403エラーはModerationErrorをスローする", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers(),
        json: () =>
          Promise.resolve({
            error: {
              message: "Content flagged",
              metadata: { reasons: ["violence"], flagged_input: "test" },
            },
          }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };

      await expect(client.chat(request)).rejects.toBeInstanceOf(ModerationError);
    });

    test("408エラーはTimeoutErrorをスローする", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 408,
        headers: new Headers(),
        json: () => Promise.resolve({ error: { message: "Request timed out" } }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };

      await expect(client.chat(request)).rejects.toBeInstanceOf(TimeoutError);
    });

    test("503エラーはModelUnavailableErrorをスローする", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers(),
        json: () => Promise.resolve({ error: { message: "No provider available" } }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };

      await expect(client.chat(request)).rejects.toBeInstanceOf(ModelUnavailableError);
    });

    test("レート制限状態でchatを呼び出すとRateLimitErrorをスローする", async () => {
      // First, trigger rate limit
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "X-RateLimit-Reset": String(Date.now() + 60000) }),
        json: () => Promise.resolve({ error: { message: "Rate limited" } }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };

      try {
        await client.chat(request);
      } catch {
        // Expected
      }

      // Second call should throw RateLimitError without making a fetch
      await expect(client.chat(request)).rejects.toBeInstanceOf(RateLimitError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("listModels", () => {
    test("モデルIDの配列を返す", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "model-1",
                name: "Model 1",
                context_length: 4096,
                pricing: { prompt: "0", completion: "0" },
              },
              {
                id: "model-2",
                name: "Model 2",
                context_length: 8192,
                pricing: { prompt: "0.001", completion: "0.002" },
              },
            ],
          }),
      });

      const result = await client.listModels();

      expect(result).toEqual(["model-1", "model-2"]);
    });

    test("エラー時は空配列を返す", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      // First call to populate, second to test error
      await client.listModels();
      const result = await client.listModels();

      expect(result).toEqual([]);
    });
  });

  describe("listModelsWithPricing", () => {
    test("pricing情報付きのモデル一覧を返す", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: "model-1",
                name: "Model 1",
                context_length: 4096,
                pricing: { prompt: "0", completion: "0" },
              },
              {
                id: "model-2",
                name: "Model 2",
                context_length: 8192,
                pricing: { prompt: "0.001", completion: "0.002" },
              },
            ],
          }),
      });

      const result = await client.listModelsWithPricing();

      expect(result).toEqual([
        {
          id: "model-1",
          name: "Model 1",
          contextLength: 4096,
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "model-2",
          name: "Model 2",
          contextLength: 8192,
          pricing: { prompt: "0.001", completion: "0.002" },
        },
      ]);
    });

    test("エラー時は空配列を返す", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const result = await client.listModelsWithPricing();

      expect(result).toEqual([]);
    });
  });

  describe("getCredits", () => {
    test("残高を返す", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              label: "test-key",
              limit: 100,
              limit_remaining: 50,
              usage: 50,
              is_free_tier: false,
            },
          }),
      });

      const result = await client.getCredits();

      expect(result).toEqual({ remaining: 50 });
    });

    test("limit_remainingがnullの場合はInfinityを返す", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              label: "test-key",
              limit: null,
              limit_remaining: null,
              usage: 0,
              is_free_tier: true,
            },
          }),
      });

      const result = await client.getCredits();

      expect(result.remaining).toBe(Number.POSITIVE_INFINITY);
    });

    test("エラー時は残高0を返す", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const result = await client.getCredits();

      expect(result).toEqual({ remaining: 0 });
    });
  });

  describe("isRateLimited", () => {
    test("初期状態ではfalseを返す", () => {
      expect(client.isRateLimited()).toBe(false);
    });
  });
});
