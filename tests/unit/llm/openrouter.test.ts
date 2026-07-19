import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  AuthenticationError,
  BadRequestError,
  InsufficientCreditsError,
  InvalidModelError,
  ModelUnavailableError,
  ModerationError,
  RateLimitError,
  StreamProtocolError,
  TimeoutError,
  UnknownApiError,
} from "../../../src/errors";
import {
  MAX_SSE_FRAME_BYTES,
  MAX_TOOL_CALL_INDEX,
  OpenRouterClient,
  SSE_CARRY_FRAGMENT_OVERHEAD_BYTES,
} from "../../../src/llm/openrouter";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  StreamFinalResult,
  StreamHeartbeatChunk,
  StreamToolCallChunk,
} from "../../../src/types";
import { metrics } from "../../../src/utils/metrics";

/** Builds an SSE `data:` event line (including the trailing blank-line terminator). */
function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Response whose body streams the given string/byte chunks verbatim, in order. */
function sseResponse(chunks: (string | Uint8Array)[]): Response {
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
  return new Response(readable, { status: 200 });
}

type StreamYield = StreamChunk | StreamToolCallChunk | StreamHeartbeatChunk | StreamFinalResult;

async function drain(gen: AsyncGenerator<StreamYield, void, void>): Promise<StreamYield[]> {
  const out: StreamYield[] = [];
  for await (const chunk of gen) {
    out.push(chunk);
  }
  return out;
}

function isToolCallChunk(chunk: StreamYield): chunk is StreamToolCallChunk {
  return "toolCall" in chunk;
}

function isContentChunk(chunk: StreamYield): chunk is StreamChunk {
  return "content" in chunk;
}

function isFinalResult(chunk: StreamYield): chunk is StreamFinalResult {
  return "done" in chunk && chunk.done === true;
}

function isHeartbeatChunk(chunk: StreamYield): chunk is StreamHeartbeatChunk {
  return "heartbeat" in chunk;
}

describe("OpenRouterClient", () => {
  let client: OpenRouterClient;
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    client = new OpenRouterClient("test-api-key");
    originalFetch = globalThis.fetch;
    mockFetch = mock();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    metrics.reset();

    spyOn(console, "debug").mockImplementation(() => {});
    spyOn(console, "info").mockImplementation(() => {});
    spyOn(console, "warn").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    metrics.reset();
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
            "HTTP-Referer": "https://github.com/AtefAndrus/disqord",
            "X-OpenRouter-Title": "DisQord",
            "X-OpenRouter-Categories": "general-chat",
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
      expect(JSON.parse(options.body as string)).toEqual({
        ...request,
        usage: { include: true },
      });
    });

    test("plugins が未指定の場合は body の JSON に含まれない", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [] }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Test" }],
      };
      await client.chat(request);

      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect("plugins" in body).toBe(false);
    });

    test("plugins が指定された場合は body の JSON に正しく載る", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [] }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Summarize" }],
        plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }],
      };
      await client.chat(request);

      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.plugins).toEqual([{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }]);
    });

    test("content 配列 (text + image_url + file 混在) が round-trip する", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [] }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe these" },
              { type: "image_url", image_url: { url: "https://cdn.discord.test/a.png" } },
              {
                type: "file",
                file: { filename: "spec.pdf", file_data: "https://cdn.discord.test/spec.pdf" },
              },
            ],
          },
        ],
        plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }],
      };
      await client.chat(request);

      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as {
        messages: ChatCompletionRequest["messages"];
        plugins: ChatCompletionRequest["plugins"];
      };
      expect(body.messages[0]?.content).toEqual([
        { type: "text", text: "Describe these" },
        { type: "image_url", image_url: { url: "https://cdn.discord.test/a.png" } },
        {
          type: "file",
          file: { filename: "spec.pdf", file_data: "https://cdn.discord.test/spec.pdf" },
        },
      ]);
      expect(body.plugins).toEqual([{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }]);
    });

    test("tools が未指定の場合は body の JSON に tools/tool_choice/parallel_tool_calls が含まれない", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [] }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };
      await client.chat(request);

      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect("tools" in body).toBe(false);
      expect("tool_choice" in body).toBe(false);
      expect("parallel_tool_calls" in body).toBe(false);
    });

    test("tools が空配列の場合は body の JSON に tools/tool_choice/parallel_tool_calls が含まれない", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [] }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
        tool_choice: "auto",
      };
      await client.chat(request);

      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect("tools" in body).toBe(false);
      expect("tool_choice" in body).toBe(false);
    });

    test("tools が非空配列の場合は body に tools/tool_choice/parallel_tool_calls が正しく載る", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [] }),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
        tools: [
          {
            type: "function",
            function: { name: "get_weather", description: "Get weather", parameters: {} },
          },
        ],
        tool_choice: "auto",
        parallel_tool_calls: false,
      };
      await client.chat(request);

      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.tools).toEqual(request.tools);
      expect(body.tool_choice).toBe("auto");
      expect(body.parallel_tool_calls).toBe(false);
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

      // Local rate-limit cooldown must not inflate metrics: only the first
      // call actually hit fetch and threw, so requests=1 and errors=1.
      const snap = metrics.snapshot();
      expect(snap.counters["openrouter.requests"]).toBe(1);
      expect(snap.counters["openrouter.errors"]).toBe(1);
    });

    test("成功した chat 呼び出しは openrouter.requests のみ計上する", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "ok",
            choices: [{ message: { role: "assistant", content: "hi" } }],
          } satisfies ChatCompletionResponse),
      });

      await client.chat({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      });

      const snap = metrics.snapshot();
      expect(snap.counters["openrouter.requests"]).toBe(1);
      expect(snap.counters["openrouter.errors"]).toBeUndefined();
    });
  });

  describe("chatStream", () => {
    test("正しいエンドポイントとヘッダーでfetchを呼び出す", async () => {
      mockFetch.mockResolvedValueOnce(new Response("data: [DONE]\n\n", { status: 200 }));

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };
      for await (const _chunk of client.chatStream(request)) {
        // ストリームを最後まで消費する
      }

      expect(mockFetch).toHaveBeenCalledWith(
        "https://openrouter.ai/api/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer test-api-key",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/AtefAndrus/disqord",
            "X-OpenRouter-Title": "DisQord",
            "X-OpenRouter-Categories": "general-chat",
          },
        }),
      );
    });

    describe("tools body 組み立て", () => {
      test("tools が未指定の場合は body に tools/tool_choice/parallel_tool_calls が含まれない", async () => {
        mockFetch.mockResolvedValueOnce(sseResponse(["data: [DONE]\n\n"]));

        const request: ChatCompletionRequest = {
          model: "test-model",
          messages: [{ role: "user", content: "Hi" }],
        };
        await drain(client.chatStream(request));

        const body = JSON.parse(
          (mockFetch.mock.calls[0][1] as RequestInit).body as string,
        ) as Record<string, unknown>;
        expect("tools" in body).toBe(false);
        expect("tool_choice" in body).toBe(false);
        expect("parallel_tool_calls" in body).toBe(false);
      });

      test("tools が空配列の場合は body に tools/tool_choice/parallel_tool_calls が含まれない", async () => {
        mockFetch.mockResolvedValueOnce(sseResponse(["data: [DONE]\n\n"]));

        const request: ChatCompletionRequest = {
          model: "test-model",
          messages: [{ role: "user", content: "Hi" }],
          tools: [],
          tool_choice: "auto",
        };
        await drain(client.chatStream(request));

        const body = JSON.parse(
          (mockFetch.mock.calls[0][1] as RequestInit).body as string,
        ) as Record<string, unknown>;
        expect("tools" in body).toBe(false);
        expect("tool_choice" in body).toBe(false);
      });

      test("tools が非空配列の場合は body に tools/tool_choice/parallel_tool_calls が正しく載る", async () => {
        mockFetch.mockResolvedValueOnce(sseResponse(["data: [DONE]\n\n"]));

        const request: ChatCompletionRequest = {
          model: "test-model",
          messages: [{ role: "user", content: "Hi" }],
          tools: [
            { type: "function", function: { name: "ping", description: "", parameters: {} } },
          ],
          tool_choice: "required",
          parallel_tool_calls: true,
        };
        await drain(client.chatStream(request));

        const body = JSON.parse(
          (mockFetch.mock.calls[0][1] as RequestInit).body as string,
        ) as Record<string, unknown>;
        expect(body.tools).toEqual(request.tools);
        expect(body.tool_choice).toBe("required");
        expect(body.parallel_tool_calls).toBe(true);
      });
    });

    describe("tool_call delta の逐次 yield", () => {
      test("id/name は最初の断片のみ、arguments は分割到着をそのまま透過する", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        type: "function",
                        function: { name: "get_weather", arguments: "" },
                      },
                    ],
                  },
                },
              ],
            }),
            sseData({
              choices: [
                { delta: { tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] } },
              ],
            }),
            sseData({
              choices: [
                {
                  delta: { tool_calls: [{ index: 0, function: { arguments: 'ation":"Tokyo"}' } }] },
                },
              ],
            }),
            sseData({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const toolCallChunks = results.filter(isToolCallChunk);

        expect(toolCallChunks).toEqual([
          {
            toolCall: { index: 0, id: "call_1", name: "get_weather", argumentsDelta: "" },
            done: false,
          },
          { toolCall: { index: 0, argumentsDelta: '{"loc' }, done: false },
          { toolCall: { index: 0, argumentsDelta: 'ation":"Tokyo"}' }, done: false },
        ]);
      });

      test("複数 index の tool_call が並行して yield される", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: "call_a", function: { name: "a", arguments: "" } },
                      { index: 1, id: "call_b", function: { name: "b", arguments: "" } },
                    ],
                  },
                },
              ],
            }),
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 1, function: { arguments: "1" } },
                      { index: 0, function: { arguments: "0" } },
                    ],
                  },
                },
              ],
            }),
            sseData({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const indices = results.filter(isToolCallChunk).map((c) => c.toolCall.index);

        expect(indices).toEqual([0, 1, 1, 0]);
      });

      test("index が非負整数でない tool_call は protocol error", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [{ delta: { tool_calls: [{ index: -1, function: { arguments: "x" } }] } }],
            }),
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("MAX_SAFE_INTEGER を超える index は protocol error になる（安全整数の範囲外は別 index との衝突を避けるため拒否）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: Number.MAX_SAFE_INTEGER + 1, function: { arguments: "x" } },
                    ],
                  },
                },
              ],
            }),
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("MAX_SAFE_INTEGER+1 と +2 はどちらも同一 number に丸まらず、いずれも protocol error になる（合流の再現防止）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: Number.MAX_SAFE_INTEGER + 2, function: { arguments: "y" } },
                    ],
                  },
                },
              ],
            }),
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test(`MAX_TOOL_CALL_INDEX (${MAX_TOOL_CALL_INDEX}) を超える index は protocol error になる`, async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: MAX_TOOL_CALL_INDEX + 1, function: { arguments: "x" } }],
                  },
                },
              ],
            }),
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test(`index が MAX_TOOL_CALL_INDEX (${MAX_TOOL_CALL_INDEX}) ちょうどなら受理される`, async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: MAX_TOOL_CALL_INDEX, function: { arguments: "x" } }],
                  },
                },
              ],
            }),
            sseData({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        expect(results.filter(isToolCallChunk).map((c) => c.toolCall.index)).toEqual([
          MAX_TOOL_CALL_INDEX,
        ]);
      });

      test("function.name が文字列でない tool_call は protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 42 } }] } }],
            }),
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("function.arguments が文字列でない tool_call は protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 42 } }] } }],
            }),
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("id が文字列でない tool_call は protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 42 }] } }] })]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test('type が "function" 以外の tool_call は protocol error になる', async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [{ delta: { tool_calls: [{ index: 0, type: "not-function" }] } }],
            }),
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });
    });

    describe("finish_reason の判定", () => {
      test("choice 直下の finish_reason が正として使われる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { content: "hi" }, finish_reason: null }] }),
            sseData({ choices: [{ delta: {}, finish_reason: "stop" }] }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const final = results.find(isFinalResult) as StreamFinalResult;
        expect(final.finishReason).toBe("stop");
      });

      test("delta 側の finish_reason がフォールバックとして使われる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { finish_reason: "stop" } }] }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const final = results.find(isFinalResult) as StreamFinalResult;
        expect(final.finishReason).toBe("stop");
      });

      test("choice と delta の finish_reason が一致する場合は正常終了する", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { finish_reason: "stop" }, finish_reason: "stop" }] }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const final = results.find(isFinalResult) as StreamFinalResult;
        expect(final.finishReason).toBe("stop");
      });

      test("choice と delta の finish_reason が食い違う場合は protocol error", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { finish_reason: "length" }, finish_reason: "stop" }] }),
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("finish_reason が文字列/null以外（数値など）の場合、同一フレームの content も含めて一切 yield されず protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { content: "leaked" }, finish_reason: 42 }] }),
          ]),
        );

        const gen = client.chatStream({
          model: "test-model",
          messages: [{ role: "user", content: "Hi" }],
        });
        const received: StreamYield[] = [];
        let thrown: unknown;
        try {
          for await (const chunk of gen) {
            received.push(chunk);
          }
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(StreamProtocolError);
        // Whole-frame validation: the malformed finish_reason must be caught
        // before the frame's valid `content` is ever staged to the caller.
        expect(received.filter(isContentChunk)).toHaveLength(0);
      });

      test("finish_reason:'tool_calls' が伝搬する", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{}" } }],
                  },
                },
              ],
            }),
            sseData({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const final = results.find(isFinalResult) as StreamFinalResult;
        expect(final.finishReason).toBe("tool_calls");
      });

      test("terminal finish_reason 受領後の content delta は protocol error", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: {}, finish_reason: "stop" }] }),
            sseData({ choices: [{ delta: { content: "late" } }] }),
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("terminal finish_reason 受領後の tool_call delta は protocol error", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: {}, finish_reason: "stop" }] }),
            sseData({
              choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "x" } }] } }],
            }),
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("terminal finish_reason 受領後でも usage チャンク・comment・[DONE] は許容される", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
            ": OPENROUTER PROCESSING\n\n",
            sseData({
              choices: [],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const final = results.find(isFinalResult) as StreamFinalResult;
        expect(final.finishReason).toBe("stop");
        expect(final.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
      });

      test("finish_reason 受領後に [DONE] なしで EOF になっても正常終了する", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const final = results.find(isFinalResult) as StreamFinalResult;
        expect(final.finishReason).toBe("stop");
        expect(final.fullText).toBe("hi");
      });

      test("改行なしで EOF になった完全な data: 行（carry として残った分）も通常どおり処理される", async () => {
        // sseData() の末尾 "\n\n" を付けず、この行が改行で確定されないまま EOF を迎える状況を作る。
        const line = `data: ${JSON.stringify({
          choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
        })}`;
        mockFetch.mockResolvedValueOnce(sseResponse([line]));

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const contentChunks = results.filter(isContentChunk);
        expect(contentChunks).toEqual([{ content: "hi", done: false }]);
        const final = results.find(isFinalResult) as StreamFinalResult;
        expect(final.finishReason).toBe("stop");
        expect(final.fullText).toBe("hi");
      });

      test("terminal finish_reason 受領後、改行なしの truncated data: 行のまま EOF になると protocol error（黙って捨てられない）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
            'data: {"truncated', // 改行なし・不完全な JSON のまま EOF を迎える
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });
    });

    describe("malformed SSE フレーム", () => {
      test("不正な JSON の data: 行は protocol error になる（silent skip しない）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse(["data: {not valid json\n\n", "data: [DONE]\n\n"]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("choices フィールドを持たないチャンク（例: `{}`）は usage トレーラー扱いされず protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(sseResponse([sseData({}), "data: [DONE]\n\n"]));

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("choices が配列でないチャンクは protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData({ choices: "not-an-array" }), "data: [DONE]\n\n"]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("choices[0] が null のチャンクは protocol error になる（生 TypeError にならない）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData({ choices: [null] }), "data: [DONE]\n\n"]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("choices: [] が usage を伴わない場合は protocol error になる（反復送信で idle timeout を無限にリセットできない）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData({ choices: [] }), "data: [DONE]\n\n"]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("choice が delta を完全に欠く場合は protocol error になる（`{}`）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData({ choices: [{}] }), "data: [DONE]\n\n"]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("finish_reason だけを持ち delta を欠く terminal チャンクは protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData({ choices: [{ finish_reason: "stop" }] }), "data: [DONE]\n\n"]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("delta: {} と finish_reason を伴うチャンクは従来どおり正常終了する", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: {}, finish_reason: "stop" }] }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const final = results.find(isFinalResult) as StreamFinalResult;
        expect(final.finishReason).toBe("stop");
        expect(final.fullText).toBe("");
      });

      test("delta.content が数値のチャンクは protocol error になる（文字列化して混入させない）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData({ choices: [{ delta: { content: 123 } }] }), "data: [DONE]\n\n"]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("delta.tool_calls が配列でない（オブジェクト）チャンクは protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData({ choices: [{ delta: { tool_calls: {} } }] }), "data: [DONE]\n\n"]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("delta.tool_calls の要素が null のチャンクは protocol error になる（生 TypeError にならない）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { tool_calls: [null] } }] }),
            "data: [DONE]\n\n",
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("正当な content と不正な tool_calls:[null] が同一フレームに混在する場合、content は一度も yield されずに protocol error になる", async () => {
        // フレーム内の全要素（content, tool_calls の各要素）は yield/状態変更の
        // 前にすべて検証される。content が先に staged されてから tool_calls の
        // 不正が見つかって throw する — という「部分適用されたフレーム」が
        // 起きないことを確認する。
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { content: "hi", tool_calls: [null] } }] }),
            "data: [DONE]\n\n",
          ]),
        );

        const gen = client.chatStream({
          model: "test-model",
          messages: [{ role: "user", content: "Hi" }],
        });
        const collected: StreamYield[] = [];
        let caught: unknown;
        try {
          for await (const chunk of gen) {
            collected.push(chunk);
          }
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(StreamProtocolError);
        expect(collected.filter(isContentChunk)).toEqual([]);
      });

      test("data: null（トップレベルが object でない）は protocol error になる（生 TypeError にならない）", async () => {
        mockFetch.mockResolvedValueOnce(sseResponse([sseData(null), "data: [DONE]\n\n"]));

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("data: 42（トップレベルが scalar）は protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(sseResponse([sseData(42), "data: [DONE]\n\n"]));

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("tool_call.function が非 object（文字列）のチャンクは protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: "x" }] } }] }),
            "data: [DONE]\n\n",
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("choices が2要素のチャンクは protocol error になる（n=1 前提の違反）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [{ delta: { content: "a" } }, { delta: { content: "b" } }],
            }),
            "data: [DONE]\n\n",
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("choices: []（明示的な空配列）は usage トレーラーとして引き続き許容される", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            }),
            sseData({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const final = results.find(isFinalResult) as StreamFinalResult;
        expect(final.finishReason).toBe("stop");
      });

      test("スペースなしの `data:` prefix でも正当なフレームはパースされる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            `data:${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}\n\n`,
            "data:[DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const contentChunks = results.filter(isContentChunk);
        expect(contentChunks).toEqual([{ content: "hi", done: false }]);
        const final = results.find(isFinalResult) as StreamFinalResult;
        expect(final.finishReason).toBe("stop");
      });

      test("スペースなしの malformed JSON も protocol error として検出される", async () => {
        mockFetch.mockResolvedValueOnce(sseResponse(["data:{not valid json\n\n"]));

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("空行は無視され、コメント行は heartbeat チャンクとして yield される", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            ": OPENROUTER PROCESSING\n\n",
            "\n",
            sseData({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
            ": another comment\n\n",
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const contentChunks = results.filter(isContentChunk);
        expect(contentChunks).toEqual([{ content: "hi", done: false }]);
        // 2 つのコメント行それぞれについて 1 つずつ heartbeat が yield される
        // （空行は heartbeat にもならず、純粋に無視される）。
        const heartbeatChunks = results.filter(isHeartbeatChunk);
        expect(heartbeatChunks).toEqual([
          { heartbeat: true, done: false },
          { heartbeat: true, done: false },
        ]);
      });

      test("event:/id:/retry: など data: 以外の非空フィールド行も heartbeat チャンクとして yield される", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            "event: ping\n\n",
            "id: 1\n\n",
            "retry: 3000\n\n",
            sseData({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const contentChunks = results.filter(isContentChunk);
        expect(contentChunks).toEqual([{ content: "hi", done: false }]);
        // event:/id:/retry: の3行それぞれについて1つずつ heartbeat が yield される。
        const heartbeatChunks = results.filter(isHeartbeatChunk);
        expect(heartbeatChunks).toEqual([
          { heartbeat: true, done: false },
          { heartbeat: true, done: false },
          { heartbeat: true, done: false },
        ]);
      });

      test("terminal finish_reason 受領後のコメント行も heartbeat として yield される（凍結の対象外）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
            ": OPENROUTER PROCESSING\n\n",
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        expect(results.filter(isHeartbeatChunk)).toEqual([{ heartbeat: true, done: false }]);
        const final = results.find(isFinalResult) as StreamFinalResult;
        expect(final.finishReason).toBe("stop");
      });
    });

    describe("受理されたが何も yield しないフレームは heartbeat になる（idle timeout の誤発火防止）", () => {
      test("role のみの delta フレームは heartbeat として yield される", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { role: "assistant" } }] }),
            sseData({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        expect(results.filter(isHeartbeatChunk)).toEqual([{ heartbeat: true, done: false }]);
      });

      test("reasoning のみの delta フレームは heartbeat として yield される", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { reasoning: "thinking..." } }] }),
            sseData({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        expect(results.filter(isHeartbeatChunk)).toEqual([{ heartbeat: true, done: false }]);
      });

      test("usage-only トレーラー（choices: []）は heartbeat として yield される", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            }),
            sseData({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        // The usage-only trailer's `usage` is attached to the heartbeat itself
        // (not just the terminal StreamFinalResult) — see the fix note on
        // `StreamHeartbeatChunk` for why: a cancel/error between this trailer
        // and `[DONE]` must not lose it.
        expect(results.filter(isHeartbeatChunk)).toEqual([
          {
            heartbeat: true,
            done: false,
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          },
        ]);
      });

      test("finish_reason だけの terminal フレーム（content 同梱なし）は heartbeat として yield される", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { content: "hi" } }] }),
            sseData({ choices: [{ delta: {}, finish_reason: "stop" }] }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        // content フレーム自体は content を yield 済みなので heartbeat は
        // terminal フレーム分の 1 つだけ。
        expect(results.filter(isHeartbeatChunk)).toEqual([{ heartbeat: true, done: false }]);
        const final = results.find(isFinalResult) as StreamFinalResult;
        expect(final.finishReason).toBe("stop");
        expect(final.fullText).toBe("hi");
      });

      test("content を伴うフレームは heartbeat を二重 yield しない", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        expect(results.filter(isHeartbeatChunk)).toEqual([]);
      });

      test("content と usage を併載するフレームは、content の yield 後に usage 付き heartbeat を1つ追加で yield する", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const contentChunks = results.filter(isContentChunk);
        expect(contentChunks).toEqual([{ content: "hi", done: false }]);
        // Exactly one heartbeat for this frame (not two — the `!yieldedPayload`
        // branch and the payload-carried-usage branch are mutually exclusive).
        expect(results.filter(isHeartbeatChunk)).toEqual([
          {
            heartbeat: true,
            done: false,
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          },
        ]);
        // Ordering: content chunk before the usage heartbeat.
        const contentIndex = results.findIndex(isContentChunk);
        const heartbeatIndex = results.findIndex(isHeartbeatChunk);
        expect(contentIndex).toBeLessThan(heartbeatIndex);
      });
    });

    describe("usage フィールドの検証", () => {
      test("usage.cost が数値でないチャンクは protocol error になる（.toFixed() の生 throw を防ぐ）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 2,
                total_tokens: 3,
                cost: "bad",
              },
            }),
            "data: [DONE]\n\n",
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("usage.prompt_tokens が数値でないチャンクは protocol error になる（文字列連結での集計破壊を防ぐ）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [],
              usage: { prompt_tokens: "1", completion_tokens: 2, total_tokens: 3 },
            }),
            "data: [DONE]\n\n",
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("usage.prompt_tokens が負値のチャンクは protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [],
              usage: { prompt_tokens: -1, completion_tokens: 2, total_tokens: 3 },
            }),
            "data: [DONE]\n\n",
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("usage.total_tokens が小数のチャンクは protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3.5 },
            }),
            "data: [DONE]\n\n",
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("usage.cost が負値のチャンクは protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cost: -1 },
            }),
            "data: [DONE]\n\n",
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("cached_tokens / reasoning_tokens が負値・小数の場合も protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 2,
                total_tokens: 3,
                prompt_tokens_details: { cached_tokens: -1 },
              },
            }),
            "data: [DONE]\n\n",
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("usage.prompt_tokens_details がオブジェクトでないチャンクは protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 2,
                total_tokens: 3,
                prompt_tokens_details: 5,
              },
            }),
            "data: [DONE]\n\n",
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("cached_tokens / reasoning_tokens が数値でない場合も protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 2,
                total_tokens: 3,
                completion_tokens_details: { reasoning_tokens: "1" },
              },
            }),
            "data: [DONE]\n\n",
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("正当な usage（cost・details 込み）は従来どおり最終結果へ伝搬する", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 2,
                total_tokens: 3,
                cost: 0.001,
                prompt_tokens_details: { cached_tokens: 1 },
                completion_tokens_details: { reasoning_tokens: 1 },
              },
            }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const final = results.find(isFinalResult) as StreamFinalResult;
        expect(final.usage).toEqual({
          prompt_tokens: 1,
          completion_tokens: 2,
          total_tokens: 3,
          cost: 0.001,
          prompt_tokens_details: { cached_tokens: 1 },
          completion_tokens_details: { reasoning_tokens: 1 },
        });
      });

      test("usage が false のチャンクは protocol error になる（falsy だが present な値は不在扱いにしない）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData({ choices: [], usage: false }), "data: [DONE]\n\n"]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("usage が 0 のチャンクは protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData({ choices: [], usage: 0 }), "data: [DONE]\n\n"]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test('usage が "" のチャンクは protocol error になる', async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData({ choices: [], usage: "" }), "data: [DONE]\n\n"]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("usage が null のチャンクは従来どおり「不在」として許容される（非最終チャンクの usage:null 慣行）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
              usage: null,
            }),
            sseData({
              choices: [],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const final = results.find(isFinalResult) as StreamFinalResult;
        expect(final.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
      });
    });

    describe("model / provider フィールドの検証", () => {
      test("model がオブジェクトのチャンクは protocol error になり、同一フレームの正当な content も yield されない", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              model: {},
              choices: [{ delta: { content: "hi" }, finish_reason: null }],
            }),
            "data: [DONE]\n\n",
          ]),
        );

        const gen = client.chatStream({
          model: "test-model",
          messages: [{ role: "user", content: "Hi" }],
        });
        await expect(drain(gen)).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("provider が数値のチャンクは protocol error になり、同一フレームの正当な content も yield されない", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              provider: 42,
              choices: [{ delta: { content: "hi" }, finish_reason: null }],
            }),
            "data: [DONE]\n\n",
          ]),
        );

        const gen = client.chatStream({
          model: "test-model",
          messages: [{ role: "user", content: "Hi" }],
        });
        await expect(drain(gen)).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("model/provider が null のチャンクは従来どおり「不在」として許容される", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              model: null,
              provider: null,
              choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
            }),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const final = results.find(isFinalResult) as StreamFinalResult;
        expect(final.model).toBeUndefined();
        expect(final.provider).toBeUndefined();
      });

      test("model が非オブジェクト・非文字列のチャンク（usage-only トレーラー）も protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({
              model: 123,
              choices: [],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            }),
            "data: [DONE]\n\n",
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });
    });

    describe("SSE フレーム / carry の最大 byte 長", () => {
      function buildContentDataLine(totalBytes: number): string {
        const prefix = 'data: {"choices":[{"delta":{"content":"';
        const suffix = '"},"finish_reason":null}]}';
        const overhead = prefix.length + suffix.length;
        const padLen = totalBytes - overhead;
        if (padLen < 0) {
          throw new Error(`totalBytes too small: need at least ${overhead}`);
        }
        return prefix + "A".repeat(padLen) + suffix;
      }

      test("ちょうど上限のフレームは受理される", async () => {
        const line = buildContentDataLine(MAX_SSE_FRAME_BYTES);
        mockFetch.mockResolvedValueOnce(sseResponse([`${line}\n\n`, "data: [DONE]\n\n"]));

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        expect(results.filter(isContentChunk)).toHaveLength(1);
      });

      test("上限を1byte超えるフレームは protocol error", async () => {
        const line = buildContentDataLine(MAX_SSE_FRAME_BYTES + 1);
        mockFetch.mockResolvedValueOnce(sseResponse([`${line}\n\n`]));

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("未終端の carry バッファが上限を超えると protocol error", async () => {
        // 改行を送らないまま複数 read にわたって carry を伸ばし続けるケース。
        const half = "A".repeat(Math.ceil(MAX_SSE_FRAME_BYTES / 2) + 10);
        mockFetch.mockResolvedValueOnce(sseResponse([half, half]));

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("改行のない行を多数の小さな chunk に分割して送っても、carry が上限を超えると protocol error になる（増分バイト計算でも従来と同じ判定）", async () => {
        // Same overall payload as the "未終端の carry バッファ" case above, but
        // split into many tiny chunks instead of two large ones: exercises the
        // incremental-tracking path (`carryBytes += byteLen(chunk)` on every
        // read) rather than the one-shot full-buffer re-encode.
        const totalBytes = MAX_SSE_FRAME_BYTES + 20;
        const chunkCount = 500;
        const chunkSize = Math.ceil(totalBytes / chunkCount);
        const chunks: string[] = [];
        let remaining = totalBytes;
        while (remaining > 0) {
          const size = Math.min(chunkSize, remaining);
          chunks.push("A".repeat(size));
          remaining -= size;
        }

        mockFetch.mockResolvedValueOnce(sseResponse(chunks));

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("1行を数千個の1〜2byte chunkに分割して送っても正しく parse される（carry の全体再走査ではなく、新規 chunk のみを走査していることの確認）", async () => {
        // A single unterminated line delivered across ~4000 reads of only
        // 1-2 bytes each: if the carry were re-scanned from the start on
        // every read (rather than only this read's own decoded chunk), this
        // shape of input is exactly what would blow up quadratically.
        const line = buildContentDataLine(4096);
        // Derived from `line` itself (rather than re-deriving the padding
        // arithmetic here) so this assertion can't drift from
        // `buildContentDataLine`'s own prefix/suffix lengths.
        const expectedContent = (
          JSON.parse(line.slice("data: ".length)) as {
            choices: { delta: { content: string } }[];
          }
        ).choices[0]?.delta.content;
        const full = `${line}\n\n`;
        const encoder = new TextEncoder();
        const fullBytes = encoder.encode(full);
        const chunks: Uint8Array[] = [];
        let offset = 0;
        let useTwoBytes = false;
        while (offset < fullBytes.length) {
          const size = Math.min(useTwoBytes ? 2 : 1, fullBytes.length - offset);
          chunks.push(fullBytes.slice(offset, offset + size));
          offset += size;
          useTwoBytes = !useTwoBytes;
        }
        expect(chunks.length).toBeGreaterThan(2000);

        mockFetch.mockResolvedValueOnce(sseResponse([...chunks, "data: [DONE]\n\n"]));

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const contentChunks = results.filter(isContentChunk);
        expect(contentChunks).toHaveLength(1);
        expect((contentChunks[0] as StreamChunk).content).toBe(expectedContent);
      });

      test(
        "改行のない 1byte chunk が大量に続くと、実ペイロード合計は 1MiB 未満でも" +
          "断片オーバーヘッド込みで上限エラーになる（carryParts の断片数自体を bound する）",
        async () => {
          // 各 chunk は SSE_CARRY_FRAGMENT_OVERHEAD_BYTES 分の構造オーバーヘッドを
          // carryBytes に課金される。実際に運ばれるバイト数（chunkCount 相当）は
          // 1 MiB を大きく下回るまま、断片数だけで上限を超えさせる。
          const chunkCount =
            Math.floor(MAX_SSE_FRAME_BYTES / (1 + SSE_CARRY_FRAGMENT_OVERHEAD_BYTES)) + 100;
          expect(chunkCount).toBeLessThan(MAX_SSE_FRAME_BYTES / 4); // 実ペイロードは 1MiB を大きく下回る

          const chunks = Array.from({ length: chunkCount }, () => "A");
          mockFetch.mockResolvedValueOnce(sseResponse(chunks));

          await expect(
            drain(
              client.chatStream({
                model: "test-model",
                messages: [{ role: "user", content: "Hi" }],
              }),
            ),
          ).rejects.toBeInstanceOf(StreamProtocolError);
        },
      );

      test("多バイト UTF-8 文字が chunk 境界を跨いでも正しく処理される", async () => {
        const encoder = new TextEncoder();
        const payload = sseData({
          choices: [{ delta: { content: "😀AB" }, finish_reason: "stop" }],
        });
        const bytes = encoder.encode(payload);
        const emojiBytes = encoder.encode("😀");

        let emojiStart = -1;
        outer: for (let i = 0; i <= bytes.length - emojiBytes.length; i++) {
          for (let j = 0; j < emojiBytes.length; j++) {
            if (bytes[i + j] !== emojiBytes[j]) continue outer;
          }
          emojiStart = i;
          break;
        }
        expect(emojiStart).toBeGreaterThanOrEqual(0);

        // 4バイトの絵文字シーケンスの途中（2バイト目の直後）で chunk を分割する。
        const splitPoint = emojiStart + 2;
        const chunk1 = bytes.slice(0, splitPoint);
        const chunk2 = bytes.slice(splitPoint);

        mockFetch.mockResolvedValueOnce(
          sseResponse([chunk1, chunk2, new TextEncoder().encode("data: [DONE]\n\n")]),
        );

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const contentChunks = results.filter(isContentChunk);
        expect(contentChunks).toEqual([{ content: "😀AB", done: false }]);
      });

      test("JSON 文字列中の単独 0xFF（不正な UTF-8 バイト）は U+FFFD に化けず protocol error になる", async () => {
        const encoder = new TextEncoder();
        // `data: {"choices":[{"delta":{"content":"` の直後に単独の 0xFF を挟み、
        // 文字列を JSON として閉じてから finish_reason を付ける。0xFF は単独では
        // 有効な UTF-8 の先頭バイトになり得ないため、非 fatal decoder なら U+FFFD
        // に化けて（malformed frame 検出をすり抜けて）通ってしまう入力。
        const prefix = encoder.encode('data: {"choices":[{"delta":{"content":"');
        const suffix = encoder.encode('"},"finish_reason":"stop"}]}\n\n');
        const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
        bytes.set(prefix, 0);
        bytes.set([0xff], prefix.length);
        bytes.set(suffix, prefix.length + 1);

        mockFetch.mockResolvedValueOnce(sseResponse([bytes]));

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("切断された多バイトシーケンスの直後に無関係なバイトが続く場合も protocol error になる", async () => {
        const encoder = new TextEncoder();
        const prefix = encoder.encode('data: {"choices":[{"delta":{"content":"');
        // 4バイトの絵文字シーケンスの先頭2バイトだけを送り、続きとして本来の
        // 継続バイト（0x80-0xBF）ではない ASCII バイトを送る — decoder が
        // `stream:true` で保留していた2バイトを、後続との不整合ごと破棄・エラー
        // 化すべきケース。
        const emojiBytes = encoder.encode("😀");
        const truncatedEmoji = emojiBytes.slice(0, 2);
        const bogusContinuation = encoder.encode('AB"},"finish_reason":"stop"}]}\n\n');
        const bytes = new Uint8Array(
          prefix.length + truncatedEmoji.length + bogusContinuation.length,
        );
        bytes.set(prefix, 0);
        bytes.set(truncatedEmoji, prefix.length);
        bytes.set(bogusContinuation, prefix.length + truncatedEmoji.length);

        mockFetch.mockResolvedValueOnce(sseResponse([bytes]));

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("多バイト UTF-8 シーケンスの先頭バイトだけでストリームが EOF になると protocol error になる（引数なし decode() の flush での fatal throw）", async () => {
        // ここまでの多バイト系テストはいずれも「不完全なシーケンスの直後に別の
        // バイトが続く」ケース（stream:true の decode() 呼び出し自体が throw す
        // る）。このテストは、不完全なシーケンスの直後に何も続かず read() が即
        // done:true を返す — つまり EOF 時の引数なし decoder.decode()（flush）
        // でしか異常が検出できない経路を直接踏む。
        const encoder = new TextEncoder();
        const emojiBytes = encoder.encode("😀"); // 4バイトシーケンス
        const truncatedEmoji = emojiBytes.slice(0, 2); // 先頭2バイトのみ

        mockFetch.mockResolvedValueOnce(sseResponse([truncatedEmoji]));

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });
    });

    describe("CR / CRLF / LF いずれの行区切りも受理する", () => {
      test("CR のみで区切られたストリーム（LF を一切含まない）も正しく parse される", async () => {
        const body =
          `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" }, finish_reason: null }] })}` +
          `\r\rdata: [DONE]\r\r`;
        mockFetch.mockResolvedValueOnce(sseResponse([body]));

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const contentChunks = results.filter(isContentChunk);
        expect(contentChunks).toEqual([{ content: "hello", done: false }]);
      });

      test("CRLF で区切られたストリームも正しく parse される", async () => {
        const body =
          `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" }, finish_reason: null }] })}` +
          `\r\n\r\ndata: [DONE]\r\n\r\n`;
        mockFetch.mockResolvedValueOnce(sseResponse([body]));

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const contentChunks = results.filter(isContentChunk);
        expect(contentChunks).toEqual([{ content: "hello", done: false }]);
      });

      test("CR が chunk 境界の末尾に、対応する LF が次 chunk 先頭に来る（CRLF が chunk をまたぐ）場合も正しく parse される", async () => {
        const line = `data: ${JSON.stringify({
          choices: [{ delta: { content: "split" }, finish_reason: null }],
        })}`;
        // 1個目の chunk は「行本体 + CR」で終わり、2個目の chunk が LF から始まる:
        // carry がリセットされた直後に LF だけの空行が来る経路を踏む。
        const chunk1 = `${line}\r`;
        const chunk2 = "\ndata: [DONE]\r\n";
        mockFetch.mockResolvedValueOnce(sseResponse([chunk1, chunk2]));

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const contentChunks = results.filter(isContentChunk);
        expect(contentChunks).toEqual([{ content: "split", done: false }]);
      });
    });

    describe("mid-stream エラーイベント", () => {
      test("top-level error フィールドを検出したら OpenRouter エラーとして throw する", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ error: { code: 402, message: "Insufficient credits mid-stream" } }),
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(InsufficientCreditsError);
      });

      test("error フィールドが非 object（文字列）の場合は buildApiError に渡さず protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(sseResponse([sseData({ error: "boom" })]));

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("error.code が文字列（シンボリックコード）の場合は UnknownApiError として throw される", async () => {
        // OpenRouter のストリーミングドキュメントは `code:"server_error"` のような文字列 code を
        // 公式に例示している。整数ステータスへマップできないため buildApiError の switch は
        // 経由せず、UnknownApiError にフォールバックする（StreamProtocolError にはしない）。
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData({ error: { code: "server_error", message: "failed" } })]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(UnknownApiError);
      });

      test("error.code が真偽値など非整数・非文字列の場合は protocol error になる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData({ error: { code: true, message: "failed" } })]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("error.code が数値の場合は従来どおり該当するエラークラスにマップされる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData({ error: { code: 402, message: "Insufficient credits" } })]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(InsufficientCreditsError);
      });

      test("error.code が欠落している場合は従来どおり許容され UnknownApiError にフォールバックする", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData({ error: { message: "no code here" } })]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(UnknownApiError);
      });

      test("terminal finish_reason 受領後の error イベントは protocol error になる（InsufficientCreditsError ではない）", async () => {
        // Once finish_reason:"stop" has been observed, the stream is frozen —
        // only [DONE]/comments/the usage trailer are still legal (see the
        // `finishReasonSeen` tests above). A `{error:{...}}` frame arriving
        // after that point is not a genuine API failure for a turn already
        // declared done, so it must be rejected as a protocol violation
        // rather than mapped through buildApiError() to an API error class.
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
            sseData({ error: { code: 402, message: "Insufficient credits mid-stream" } }),
          ]),
        );

        const thrown: unknown = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        ).catch((err) => err);
        expect(thrown).toBeInstanceOf(StreamProtocolError);
        expect(thrown).not.toBeInstanceOf(InsufficientCreditsError);
      });
    });

    describe("response body の reader.cancel()（body を消費者なしで残さない）", () => {
      let cancelSpy: ReturnType<typeof spyOn>;

      beforeEach(() => {
        // Spying on the reader's own method (rather than the underlying
        // source's `cancel` algorithm) catches the call even when the
        // stream is already closed/errored, where the underlying algorithm
        // is a documented no-op — normal completion is exactly such a case.
        cancelSpy = spyOn(ReadableStreamDefaultReader.prototype, "cancel");
      });

      afterEach(() => {
        cancelSpy.mockRestore();
      });

      test("正常完了時にも reader.cancel() が呼ばれる（no-op だが確実に呼ばれる）", async () => {
        mockFetch.mockResolvedValueOnce(sseResponse(["data: [DONE]\n\n"]));

        await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );

        expect(cancelSpy).toHaveBeenCalled();
      });

      test(
        "reader.cancel() が永久 pending でも、消費者側の finalize（for-await の break による " +
          "iterator.return()）は cancel の解決を待たずに settle する",
        async () => {
          // 応答なし（無限 pending）の cancel をスタブし、正常な cancel 完了に依存せず
          // finally 自体が同期的に完了することを検証する。
          cancelSpy.mockImplementation(() => new Promise(() => {}));
          mockFetch.mockResolvedValueOnce(
            sseResponse([
              sseData({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
              "data: [DONE]\n\n",
            ]),
          );

          const gen = client.chatStream({
            model: "test-model",
            messages: [{ role: "user", content: "Hi" }],
          });

          const start = Date.now();
          for await (const _chunk of gen) {
            // 1チャンク受け取った時点で消費をやめる。for-await の break は generator の
            // return() を暗黙に呼び出し、chatStream() の finally（cancel/releaseLock）を
            // 実行させる — toolLoop の runTurn() が iterator.return() を呼ぶのと同じ経路。
            break;
          }
          const elapsedMs = Date.now() - start;

          // reader.cancel() を fire-and-forget にした結果、finalize は cancel の解決を
          // 待たずに（永久 pending のままでも）速やかに完了する。
          expect(elapsedMs).toBeLessThan(500);
          expect(cancelSpy).toHaveBeenCalled();
        },
      );

      test("malformed JSON による parser エラー時にも reader.cancel() が呼ばれ、body を放置しない", async () => {
        mockFetch.mockResolvedValueOnce(sseResponse(["data: {not valid json\n\n"]));

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(StreamProtocolError);

        expect(cancelSpy).toHaveBeenCalled();
      });

      test("mid-stream エラーイベント時にも reader.cancel() が呼ばれる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData({ error: { code: 402, message: "Insufficient credits mid-stream" } }),
          ]),
        );

        await expect(
          drain(
            client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
          ),
        ).rejects.toBeInstanceOf(InsufficientCreditsError);

        expect(cancelSpy).toHaveBeenCalled();
      });
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
                created: 1640000000,
                context_length: 4096,
                pricing: { prompt: "0", completion: "0" },
                architecture: {
                  input_modalities: ["text", "image"],
                  output_modalities: ["text"],
                  modality: "text+image->text",
                  tokenizer: "Other",
                },
                supported_parameters: ["temperature", "stop"],
              },
              {
                id: "model-2",
                name: "Model 2",
                created: 1650000000,
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
          created: 1640000000,
          contextLength: 4096,
          pricing: { prompt: "0", completion: "0" },
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
          supportedParameters: ["temperature", "stop"],
        },
        {
          id: "model-2",
          name: "Model 2",
          created: 1650000000,
          contextLength: 8192,
          pricing: { prompt: "0.001", completion: "0.002" },
          inputModalities: [],
          outputModalities: [],
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
