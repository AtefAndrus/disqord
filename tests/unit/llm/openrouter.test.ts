import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
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

    test("レート制限時はエラーをスローする", async () => {
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

      await expect(client.chat(request)).rejects.toThrow("Rate limited");
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

    test("429エラーでX-RateLimit-Resetヘッダーがない場合はデフォルト60秒", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers(),
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

    test("その他のHTTPエラーはメッセージ付きでスローする", async () => {
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

      await expect(client.chat(request)).rejects.toThrow("Internal server error");
    });

    test("エラーレスポンスがパースできない場合はステータスコードを含む", async () => {
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

      await expect(client.chat(request)).rejects.toThrow("HTTP 502");
    });
  });

  describe("listModels", () => {
    test("モデルIDの配列を返す", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { id: "model-1", name: "Model 1", context_length: 4096 },
              { id: "model-2", name: "Model 2", context_length: 8192 },
            ],
          }),
      });

      const result = await client.listModels();

      expect(result).toEqual(["model-1", "model-2"]);
    });

    test("エラー時は空配列を返す", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const result = await client.listModels();

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
