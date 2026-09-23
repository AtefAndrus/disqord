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
  StreamReasoningItemChunk,
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

type StreamYield =
  | StreamChunk
  | StreamToolCallChunk
  | StreamReasoningItemChunk
  | StreamHeartbeatChunk
  | StreamFinalResult;

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

const REQUEST: ChatCompletionRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "Hi" }],
};

// Responses stream events, reduced to the fields `chatStream()` reads. The
// shapes follow a capture of the live API (2026-09-19).
function textDelta(delta: string): Record<string, unknown> {
  return { type: "response.output_text.delta", output_index: 0, content_index: 0, delta };
}

function argumentsDelta(outputIndex: number, delta: string): Record<string, unknown> {
  return { type: "response.function_call_arguments.delta", output_index: outputIndex, delta };
}

function functionCallItem(
  phase: "added" | "done",
  outputIndex: number,
  item: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: `response.output_item.${phase}`,
    output_index: outputIndex,
    item: { type: "function_call", ...item },
  };
}

function completed(response: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "response.completed", response: { status: "completed", ...response } };
}

const RESPONSES_USAGE = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
const MAPPED_USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

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

  /** Queues a streaming response made of `events`, terminated by `data: [DONE]`. */
  function respondWithEvents(events: unknown[]): void {
    mockFetch.mockResolvedValueOnce(sseResponse([...events.map(sseData), "data: [DONE]\n\n"]));
  }

  describe("chat", () => {
    test("Responses の結果を ChatCompletionResponse の形へ写像する", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "gen-123",
            model: "openai/gpt-5-nano",
            status: "completed",
            output: [
              { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] },
              {
                type: "message",
                role: "assistant",
                content: [
                  { type: "output_text", text: "Hel" },
                  { type: "output_text", text: "lo!" },
                ],
              },
            ],
            usage: RESPONSES_USAGE,
            openrouter_metadata: {
              endpoints: { available: [{ provider: "OpenAI", selected: true }] },
            },
          }),
      });

      const result = await client.chat(REQUEST);

      expect(result).toEqual({
        id: "gen-123",
        model: "openai/gpt-5-nano",
        provider: "OpenAI",
        choices: [{ message: { role: "assistant", content: "Hello!" } }],
        usage: MAPPED_USAGE,
      } satisfies ChatCompletionResponse);
    });

    test("HTTP 200 でも status:'failed' の結果は API エラーとして throw する", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "failed",
            error: { code: 402, message: "Insufficient credits" },
          }),
      });

      await expect(client.chat(REQUEST)).rejects.toBeInstanceOf(InsufficientCreditsError);
    });

    test("body が object でなければ protocol error になる", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(null) });

      await expect(client.chat(REQUEST)).rejects.toBeInstanceOf(StreamProtocolError);
    });

    test("正しいエンドポイントとヘッダーでfetchを呼び出す", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      };
      await client.chat(request);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://openrouter.ai/api/v1/responses",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer test-api-key",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/AtefAndrus/disqord",
            "X-OpenRouter-Title": "DisQord",
            "X-OpenRouter-Categories": "general-chat",
            "X-OpenRouter-Metadata": "enabled",
          },
        }),
      );
    });

    test("リクエストボディが正しくJSONシリアライズされる", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const request: ChatCompletionRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "Test message" }],
      };
      await client.chat(request);

      const callArgs = mockFetch.mock.calls[0];
      const options = callArgs[1] as RequestInit;
      // `messages` は `input` になり、deprecated な `usage:{include:true}` と
      // `stream` は載らない。
      expect(JSON.parse(options.body as string)).toEqual({
        model: "test-model",
        input: [{ role: "user", content: "Test message" }],
      });
    });

    test("ChatCompletionRequest に後から足されたフィールドは body へそのまま透過する", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

      await client.chat({ ...REQUEST, session_id: "s-1" } as ChatCompletionRequest);

      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.session_id).toBe("s-1");
    });

    test("assistant の tool_calls と tool メッセージは function_call / function_call_output item になる", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

      await client.chat({
        model: "test-model",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "Weather?" },
          {
            role: "assistant",
            content: "Let me check.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "w", arguments: '{"c":"Tokyo"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: '{"temp":21}' },
          // テキストを伴わない tool-calling turn: 空の assistant message は送らない。
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_2", type: "function", function: { name: "w", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "call_2", content: "ok" },
        ],
      });

      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as {
        input: unknown[];
      };
      expect(body.input).toEqual([
        { role: "system", content: "Be brief." },
        { role: "user", content: "Weather?" },
        { role: "assistant", content: "Let me check." },
        { type: "function_call", call_id: "call_1", name: "w", arguments: '{"c":"Tokyo"}' },
        { type: "function_call_output", call_id: "call_1", output: '{"temp":21}' },
        { type: "function_call", call_id: "call_2", name: "w", arguments: "{}" },
        { type: "function_call_output", call_id: "call_2", output: "ok" },
      ]);
    });

    test("assistant の reasoning item は本文と function_call より前に受信順で出力する", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

      const reasoningItems = [
        {
          type: "reasoning" as const,
          id: "rs_1",
          summary: [{ type: "summary_text", text: "first" }],
          encrypted_content: "opaque-1",
          future_field: { keep: true },
        },
        {
          type: "reasoning" as const,
          id: "rs_2",
          summary: [{ type: "summary_text", text: "second" }],
          signature: "opaque-2",
        },
      ];
      await client.chat({
        model: "test-model",
        messages: [
          {
            role: "assistant",
            reasoningItems,
            content: "tool preamble",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "w", arguments: "{}" } },
            ],
          },
        ],
      });

      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as {
        input: unknown[];
      };
      expect(body.input).toEqual([
        ...reasoningItems,
        { role: "assistant", content: "tool preamble" },
        { type: "function_call", call_id: "call_1", name: "w", arguments: "{}" },
      ]);
    });

    test("tool の input_image / input_file part 配列を function_call_output にそのまま渡す", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

      await client.chat({
        model: "test-model",
        messages: [
          {
            role: "tool",
            tool_call_id: "call-attachment",
            content: [
              { type: "input_image", detail: "auto", image_url: "data:image/png;base64,AA==" },
              {
                type: "input_file",
                filename: "document.pdf",
                file_data: "data:application/pdf;base64,AA==",
              },
            ],
          },
        ],
      });

      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as {
        input: unknown[];
      };
      expect(body.input).toEqual([
        {
          type: "function_call_output",
          call_id: "call-attachment",
          output: [
            { type: "input_image", detail: "auto", image_url: "data:image/png;base64,AA==" },
            {
              type: "input_file",
              filename: "document.pdf",
              file_data: "data:application/pdf;base64,AA==",
            },
          ],
        },
      ]);
    });

    test("plugins が未指定の場合は body の JSON に含まれない", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
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
        json: () => Promise.resolve({}),
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

    test("content 配列 (text + image_url + file 混在) は input_text / input_image / input_file へ写像される", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
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
        input: { content: unknown }[];
        plugins: ChatCompletionRequest["plugins"];
      };
      expect(body.input[0]?.content).toEqual([
        { type: "input_text", text: "Describe these" },
        // Responses の image_url は `{url}` オブジェクトではなく文字列。
        { type: "input_image", image_url: "https://cdn.discord.test/a.png", detail: "auto" },
        {
          type: "input_file",
          filename: "spec.pdf",
          file_data: "https://cdn.discord.test/spec.pdf",
        },
      ]);
      expect(body.plugins).toEqual([{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }]);
    });

    test("tools が未指定の場合は body の JSON に tools/tool_choice/parallel_tool_calls が含まれない", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
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
      expect("include" in body).toBe(false);
    });

    test("tools が空配列の場合は body の JSON に tools/tool_choice/parallel_tool_calls が含まれない", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
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
        json: () => Promise.resolve({}),
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
      // function tool の定義は `function` ラッパーなしの flat な形で送る。
      expect(body.tools).toEqual([
        { type: "function", name: "get_weather", description: "Get weather", parameters: {} },
      ]);
      expect(body.tool_choice).toBe("auto");
      expect(body.parallel_tool_calls).toBe(false);
      expect(body.include).toEqual(["reasoning.encrypted_content"]);
    });

    test("server tool は無変更で載り、function を名指しする tool_choice は flat な形になる", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

      await client.chat({
        ...REQUEST,
        tools: [
          { type: "function", function: { name: "ping", description: "", parameters: {} } },
          { type: "openrouter:web_search", parameters: { max_results: 3 } },
        ],
        tool_choice: { type: "function", function: { name: "ping" } },
      });

      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.tools).toEqual([
        { type: "function", name: "ping", description: "", parameters: {} },
        { type: "openrouter:web_search", parameters: { max_results: 3 } },
      ]);
      expect(body.tool_choice).toEqual({ type: "function", name: "ping" });
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
            output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
          }),
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
        "https://openrouter.ai/api/v1/responses",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer test-api-key",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/AtefAndrus/disqord",
            "X-OpenRouter-Title": "DisQord",
            "X-OpenRouter-Categories": "general-chat",
            "X-OpenRouter-Metadata": "enabled",
          },
        }),
      );
    });

    describe("Web 検索の記録", () => {
      // Shapes from a capture of the live API (2026-09-22, engine perplexity).
      function webSearchItem(phase: "added" | "done", action?: unknown): Record<string, unknown> {
        return {
          type: `response.output_item.${phase}`,
          output_index: 0,
          item: {
            id: "st_tmp_1",
            type: "openrouter:web_search",
            status: phase === "done" ? "completed" : "in_progress",
            ...(action !== undefined && { action }),
          },
        };
      }
      function citation(annotation: unknown): Record<string, unknown> {
        return {
          type: "response.output_text.annotation.added",
          output_index: 1,
          content_index: 0,
          annotation_index: 0,
          annotation,
        };
      }

      test("検索語・参照 URL・引用リンクを最終結果に載せる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData(webSearchItem("added")),
            sseData(
              webSearchItem("done", {
                type: "search",
                query: "Bun v1.4.0 release date",
                sources: [
                  { type: "url", url: "https://bun.com/blog/bun-v1.4" },
                  { type: "url", url: 42 },
                ],
              }),
            ),
            // max_uses を超えた呼び出しは sources を持たない
            sseData(webSearchItem("done", { type: "search", query: "second" })),
            sseData(textDelta("2026年8月20日")),
            sseData(
              citation({
                type: "url_citation",
                url: "https://bun.com/blog/bun-v1.4",
                title: "Bun 1.4 | Bun Blog",
                start_index: 0,
                end_index: 0,
                content: "# Bun 1.4",
              }),
            ),
            sseData(citation({ type: "file_citation", file_id: "f" })),
            sseData(completed()),
            "data: [DONE]\n\n",
          ]),
        );

        const chunks = await drain(client.chatStream(REQUEST));
        const final = chunks.find(isFinalResult);

        expect(final?.webSearch).toEqual({
          calls: [
            { query: "Bun v1.4.0 release date", sources: ["https://bun.com/blog/bun-v1.4"] },
            { query: "second", sources: [] },
          ],
          results: [{ url: "https://bun.com/blog/bun-v1.4", title: "Bun 1.4 | Bun Blog" }],
        });
        expect(final?.fullText).toBe("2026年8月20日");
      });

      test("action の壊れた検索 item は読み飛ばし、ターンは失敗させない", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData(webSearchItem("done", "not an object")),
            sseData(textDelta("ok")),
            sseData(completed()),
            "data: [DONE]\n\n",
          ]),
        );

        const final = (await drain(client.chatStream(REQUEST))).find(isFinalResult);

        expect(final?.fullText).toBe("ok");
        expect(final && "webSearch" in final).toBe(false);
      });
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
        expect(body.tools).toEqual([
          { type: "function", name: "ping", description: "", parameters: {} },
        ]);
        expect(body.tool_choice).toBe("required");
        expect(body.parallel_tool_calls).toBe(true);
        expect(body.include).toEqual(["reasoning.encrypted_content"]);
        expect(body.stream).toBe(true);
      });

      test("reasoning summary は指定された場合だけ転送され、effort は追加しない", async () => {
        mockFetch.mockResolvedValueOnce(sseResponse(["data: [DONE]\n\n"]));

        await drain(
          client.chatStream({
            ...REQUEST,
            reasoning: { summary: "auto" },
          }),
        );

        const body = JSON.parse(
          (mockFetch.mock.calls[0][1] as RequestInit).body as string,
        ) as Record<string, unknown>;
        expect(body.reasoning).toEqual({ summary: "auto" });
        expect("effort" in (body.reasoning as Record<string, unknown>)).toBe(false);
      });
    });

    describe("tool call イベントの写像", () => {
      test("call_id/name は output_item.added と done で届き、arguments は delta をそのまま透過する", async () => {
        respondWithEvents([
          functionCallItem("added", 1, { call_id: "call_1", name: "get_weather", arguments: "" }),
          argumentsDelta(1, '{"loc'),
          argumentsDelta(1, 'ation":"Tokyo"}'),
          { type: "response.function_call_arguments.done", output_index: 1 },
          functionCallItem("done", 1, {
            call_id: "call_1",
            name: "get_weather",
            arguments: '{"location":"Tokyo"}',
          }),
          completed(),
        ]);

        const results = await drain(client.chatStream(REQUEST));

        expect(results.filter(isToolCallChunk)).toEqual([
          { toolCall: { index: 1, id: "call_1", name: "get_weather" }, done: false },
          { toolCall: { index: 1, argumentsDelta: '{"loc' }, done: false },
          { toolCall: { index: 1, argumentsDelta: 'ation":"Tokyo"}' }, done: false },
          { toolCall: { index: 1, id: "call_1", name: "get_weather" }, done: false },
        ]);
      });

      test("並行する tool call の断片が入り混じって届いても、call ごとに長さ照合される", async () => {
        // 実 wire では reasoning item が output_index 0 を占め、function_call は 1, 2 に並ぶ。
        // call ごとに長さを持たず単一の累積値で照合する実装は、この列で done の照合に失敗する。
        respondWithEvents([
          { type: "response.output_item.added", output_index: 0, item: { type: "reasoning" } },
          functionCallItem("added", 1, { call_id: "call_a", name: "a" }),
          functionCallItem("added", 2, { call_id: "call_b", name: "b" }),
          argumentsDelta(1, '{"city":'),
          argumentsDelta(2, '{"n":'),
          argumentsDelta(2, "12345}"),
          argumentsDelta(1, '"Tokyo"}'),
          functionCallItem("done", 2, { call_id: "call_b", name: "b", arguments: '{"n":12345}' }),
          functionCallItem("done", 1, {
            call_id: "call_a",
            name: "a",
            arguments: '{"city":"Tokyo"}',
          }),
          completed(),
        ]);

        const results = await drain(client.chatStream(REQUEST));

        const argumentsByIndex = new Map<number, string>();
        for (const { toolCall } of results.filter(isToolCallChunk)) {
          argumentsByIndex.set(
            toolCall.index,
            (argumentsByIndex.get(toolCall.index) ?? "") + (toolCall.argumentsDelta ?? ""),
          );
        }
        expect(Object.fromEntries(argumentsByIndex)).toEqual({
          1: '{"city":"Tokyo"}',
          2: '{"n":12345}',
        });
        expect((results.find(isFinalResult) as StreamFinalResult).finishReason).toBe("tool_calls");
      });

      test("done が arguments を欠く function call は protocol error になる（長さ照合を素通りさせない）", async () => {
        respondWithEvents([
          functionCallItem("added", 0, { call_id: "call_1", name: "ping" }),
          argumentsDelta(0, '{"x":1}'),
          functionCallItem("done", 0, { call_id: "call_1", name: "ping" }),
          completed(),
        ]);

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test.each([
        ["arguments delta", argumentsDelta(0, "}")],
        ["output_item.added", functionCallItem("added", 0, { call_id: "call_1", name: "ping" })],
        [
          "2 度目の output_item.done",
          functionCallItem("done", 0, { call_id: "call_1", name: "ping", arguments: '{"x":1' }),
        ],
      ])(
        "done 済みの function call に %s が届くと protocol error になる（照合済みの arguments を後から変えさせない）",
        async (_label, lateEvent) => {
          respondWithEvents([
            functionCallItem("added", 0, { call_id: "call_1", name: "ping" }),
            argumentsDelta(0, '{"x":1'),
            functionCallItem("done", 0, { call_id: "call_1", name: "ping", arguments: '{"x":1' }),
            lateEvent,
            completed(),
          ]);

          await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(
            StreamProtocolError,
          );
        },
      );

      test("delta が一度も流れなかった call は done の完成形 arguments を argumentsDelta として受け取る", async () => {
        respondWithEvents([
          functionCallItem("added", 0, { call_id: "call_1", name: "ping" }),
          functionCallItem("done", 0, { call_id: "call_1", name: "ping", arguments: '{"a":1}' }),
          completed(),
        ]);

        const results = await drain(client.chatStream(REQUEST));

        expect(results.filter(isToolCallChunk)).toEqual([
          { toolCall: { index: 0, id: "call_1", name: "ping" }, done: false },
          {
            toolCall: { index: 0, id: "call_1", name: "ping", argumentsDelta: '{"a":1}' },
            done: false,
          },
        ]);
      });

      test("done の完成形 arguments と蓄積した delta の長さが食い違うと protocol error（delta の欠落を黙って通さない）", async () => {
        respondWithEvents([
          functionCallItem("added", 0, { call_id: "call_1", name: "ping" }),
          argumentsDelta(0, '{"a":'),
          functionCallItem("done", 0, { call_id: "call_1", name: "ping", arguments: '{"a":1}' }),
        ]);

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test.each([
        ["負値", -1],
        ["小数", 1.5],
        ["文字列", "0"],
        ["欠落", undefined],
        ["MAX_SAFE_INTEGER 超（別 index と同一 number に丸まる範囲）", Number.MAX_SAFE_INTEGER + 2],
        [`MAX_TOOL_CALL_INDEX (${MAX_TOOL_CALL_INDEX}) 超`, MAX_TOOL_CALL_INDEX + 1],
      ])(
        "output_index が%sの function_call は protocol error になる",
        async (_label, outputIndex) => {
          respondWithEvents([
            {
              type: "response.function_call_arguments.delta",
              output_index: outputIndex,
              delta: "x",
            },
          ]);

          await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(
            StreamProtocolError,
          );
        },
      );

      test(`output_index が MAX_TOOL_CALL_INDEX (${MAX_TOOL_CALL_INDEX}) ちょうどなら受理される`, async () => {
        respondWithEvents([argumentsDelta(MAX_TOOL_CALL_INDEX, "x")]);

        const results = await drain(client.chatStream(REQUEST));

        expect(results.filter(isToolCallChunk)).toEqual([
          { toolCall: { index: MAX_TOOL_CALL_INDEX, argumentsDelta: "x" }, done: false },
        ]);
      });

      test.each(["call_id", "name", "arguments"])(
        "function_call の %s が文字列でなければ protocol error になる",
        async (key) => {
          respondWithEvents([
            functionCallItem("done", 0, {
              call_id: "call_1",
              name: "ping",
              arguments: "",
              [key]: 42,
            }),
          ]);

          await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(
            StreamProtocolError,
          );
        },
      );

      test("arguments delta が文字列でなければ protocol error になる", async () => {
        respondWithEvents([
          { type: "response.function_call_arguments.delta", output_index: 0, delta: 42 },
        ]);

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test.each([
        ["null", null],
        ["type を欠く object", {}],
        ["文字列", "function_call"],
      ])(
        "output_item の item が%sなら protocol error になる（生 TypeError にならない）",
        async (_label, item) => {
          respondWithEvents([{ type: "response.output_item.added", output_index: 0, item }]);

          await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(
            StreamProtocolError,
          );
        },
      );

      test("function_call 以外の item（message / reasoning / server tool）は heartbeat になり tool call を生まない", async () => {
        respondWithEvents([
          { type: "response.output_item.added", output_index: 0, item: { type: "reasoning" } },
          {
            type: "response.output_item.done",
            output_index: 1,
            item: { type: "openrouter:datetime", status: "completed" },
          },
          { type: "response.output_item.added", output_index: 2, item: { type: "message" } },
          textDelta("hi"),
          completed(),
        ]);

        const results = await drain(client.chatStream(REQUEST));

        expect(results.filter(isToolCallChunk)).toEqual([]);
        // 3 つの item イベントと、終端の response.completed。
        expect(results.filter(isHeartbeatChunk)).toHaveLength(4);
        expect((results.find(isFinalResult) as StreamFinalResult).finishReason).toBe("stop");
      });
    });

    describe("終端イベントと finishReason", () => {
      test("function call を伴わない response.completed は finishReason:'stop' になる", async () => {
        respondWithEvents([textDelta("he"), textDelta("llo"), completed()]);

        const final = (await drain(client.chatStream(REQUEST))).find(
          isFinalResult,
        ) as StreamFinalResult;

        expect(final.finishReason).toBe("stop");
        expect(final.fullText).toBe("hello");
      });

      test("function_call item が完成した response.completed は finishReason:'tool_calls' になる", async () => {
        respondWithEvents([
          textDelta("checking"),
          functionCallItem("added", 1, { call_id: "call_1", name: "ping" }),
          functionCallItem("done", 1, { call_id: "call_1", name: "ping", arguments: "" }),
          completed(),
        ]);

        const final = (await drain(client.chatStream(REQUEST))).find(
          isFinalResult,
        ) as StreamFinalResult;

        expect(final.finishReason).toBe("tool_calls");
        expect(final.fullText).toBe("checking");
      });

      test.each([
        ["added だけ", [functionCallItem("added", 0, { call_id: "call_1", name: "ping" })]],
        ["arguments delta だけ", [argumentsDelta(0, "{}")]],
        [
          "完成した call の横に未完成の call が残る",
          [
            functionCallItem("added", 0, { call_id: "call_1", name: "ping" }),
            functionCallItem("done", 0, { call_id: "call_1", name: "ping", arguments: "" }),
            functionCallItem("added", 2, { call_id: "call_2", name: "ping" }),
            argumentsDelta(2, "{}"),
          ],
        ],
      ])(
        "done に至らない function call（%s）を残した response.completed は protocol error になる（未完成の call を dispatch させない）",
        async (_label, events) => {
          respondWithEvents([...events, completed()]);

          await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(
            StreamProtocolError,
          );
        },
      );

      test("response.incomplete は未完成の function call を残していても受理する（打ち切りでは起こりうる）", async () => {
        respondWithEvents([
          functionCallItem("added", 0, { call_id: "call_1", name: "ping" }),
          argumentsDelta(0, '{"a":'),
          {
            type: "response.incomplete",
            response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
          },
        ]);

        const final = (await drain(client.chatStream(REQUEST))).find(
          isFinalResult,
        ) as StreamFinalResult;

        expect(final.finishReason).toBe("length");
      });

      test.each([
        ["max_output_tokens", { reason: "max_output_tokens" }, "length"],
        ["content_filter", { reason: "content_filter" }, "content_filter"],
        ["未知の reason", { reason: "quota" }, "incomplete"],
        // wire の文字列をそのまま渡すと、loop の dispatch 分岐や正常完了分岐を選べてしまう。
        ['reason が "tool_calls"', { reason: "tool_calls" }, "incomplete"],
        ['reason が "stop"', { reason: "stop" }, "incomplete"],
        ["incomplete_details が null", null, "incomplete"],
      ])("response.incomplete（%s）", async (_label, incompleteDetails, expected) => {
        respondWithEvents([
          textDelta("partial"),
          {
            type: "response.incomplete",
            response: { status: "incomplete", incomplete_details: incompleteDetails },
          },
        ]);

        const final = (await drain(client.chatStream(REQUEST))).find(
          isFinalResult,
        ) as StreamFinalResult;

        expect(final.finishReason).toBe(expected);
        expect(final.fullText).toBe("partial");
      });

      test("response.failed は response.error を API エラーとして throw する", async () => {
        respondWithEvents([
          {
            type: "response.failed",
            response: { status: "failed", error: { code: 402, message: "Insufficient credits" } },
          },
        ]);

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(
          InsufficientCreditsError,
        );
      });

      test("response.failed の error.code がシンボリック文字列なら UnknownApiError になる", async () => {
        respondWithEvents([
          {
            type: "response.failed",
            response: { status: "failed", error: { code: "server_error", message: "failed" } },
          },
        ]);

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(UnknownApiError);
      });

      test("response.failed が error を伴わなければ protocol error になる", async () => {
        respondWithEvents([
          { type: "response.failed", response: { status: "failed", error: null } },
        ]);

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test.each([
        ["response が null の response.completed", { type: "response.completed", response: null }],
        ["response を欠く response.incomplete", { type: "response.incomplete" }],
        ["response が文字列の response.failed", { type: "response.failed", response: "failed" }],
      ])("%sは protocol error になる（生 TypeError にならない）", async (_label, event) => {
        respondWithEvents([event]);

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test.each([
        ["text delta", textDelta("late")],
        ["tool call delta", argumentsDelta(0, "x")],
        ["2 つ目の終端イベント", completed()],
        ["未知のイベント", { type: "response.something_new" }],
      ])("終端イベント受領後の%sは protocol error になる", async (_label, lateEvent) => {
        respondWithEvents([textDelta("hi"), completed(), lateEvent]);

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("終端イベント受領後に [DONE] なしで EOF になっても正常終了する", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData(textDelta("hi")), sseData(completed())]),
        );

        const final = (await drain(client.chatStream(REQUEST))).find(
          isFinalResult,
        ) as StreamFinalResult;

        expect(final.finishReason).toBe("stop");
        expect(final.fullText).toBe("hi");
      });

      test("終端イベントなしで EOF になると finishReason は undefined のまま（完了と見なさない）", async () => {
        mockFetch.mockResolvedValueOnce(sseResponse([sseData(textDelta("hi"))]));

        const final = (await drain(client.chatStream(REQUEST))).find(
          isFinalResult,
        ) as StreamFinalResult;

        expect(final.finishReason).toBeUndefined();
      });

      test("改行なしで EOF になった完全な data: 行（carry として残った分）も通常どおり処理される", async () => {
        // sseData() の末尾 "\n\n" を付けず、この行が改行で確定されないまま EOF を迎える状況を作る。
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData(textDelta("hi")), `data: ${JSON.stringify(completed())}`]),
        );

        const results = await drain(client.chatStream(REQUEST));

        expect(results.filter(isContentChunk)).toEqual([{ content: "hi", done: false }]);
        expect((results.find(isFinalResult) as StreamFinalResult).finishReason).toBe("stop");
      });

      test("終端イベント受領後、改行なしの truncated data: 行のまま EOF になると protocol error（黙って捨てられない）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData(completed()),
            'data: {"truncated', // 改行なし・不完全な JSON のまま EOF を迎える
          ]),
        );

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(StreamProtocolError);
      });
    });

    describe("malformed SSE フレーム", () => {
      test("不正な JSON の data: 行は protocol error になる（silent skip しない）", async () => {
        mockFetch.mockResolvedValueOnce(sseResponse(["data: {not valid json\n\n"]));

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test.each([
        ["type を欠く object（`{}`）", {}],
        ["type が文字列でない object", { type: 42 }],
        ["null", null],
        ["scalar", 42],
        ["配列", [{ type: "response.created" }]],
      ])(
        "data: が%sなら protocol error になる（heartbeat として受理しない）",
        async (_label, payload) => {
          respondWithEvents([payload]);

          await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(
            StreamProtocolError,
          );
        },
      );

      test("output_text delta が数値なら protocol error になる（文字列化して混入させない）", async () => {
        respondWithEvents([{ type: "response.output_text.delta", delta: 123 }]);

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("スペースなしの `data:` prefix でも正当なフレームはパースされる", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([`data:${JSON.stringify(textDelta("hi"))}\n\n`, "data:[DONE]\n\n"]),
        );

        const results = await drain(client.chatStream(REQUEST));

        expect(results.filter(isContentChunk)).toEqual([{ content: "hi", done: false }]);
      });

      test("スペースなしの malformed JSON も protocol error として検出される", async () => {
        mockFetch.mockResolvedValueOnce(sseResponse(["data:{not valid json\n\n"]));

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("空行は無視され、コメント行は heartbeat チャンクとして yield される", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            ": OPENROUTER PROCESSING\n\n",
            "\n",
            sseData(textDelta("hi")),
            ": another comment\n\n",
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(client.chatStream(REQUEST));

        expect(results.filter(isContentChunk)).toEqual([{ content: "hi", done: false }]);
        // 2 つのコメント行それぞれについて 1 つずつ heartbeat が yield される
        // （空行は heartbeat にもならず、純粋に無視される）。
        expect(results.filter(isHeartbeatChunk)).toEqual([
          { heartbeat: true, done: false },
          { heartbeat: true, done: false },
        ]);
      });

      test("event:/id:/retry: など data: 以外の非空フィールド行も heartbeat チャンクとして yield される", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            "event: response.output_text.delta\n",
            "id: 1\n",
            "retry: 3000\n",
            sseData(textDelta("hi")),
            "data: [DONE]\n\n",
          ]),
        );

        const results = await drain(client.chatStream(REQUEST));

        expect(results.filter(isContentChunk)).toEqual([{ content: "hi", done: false }]);
        expect(results.filter(isHeartbeatChunk)).toHaveLength(3);
      });

      test("終端イベント受領後のコメント行も heartbeat として yield される（凍結の対象外）", async () => {
        mockFetch.mockResolvedValueOnce(
          sseResponse([sseData(completed()), ": OPENROUTER PROCESSING\n\n", "data: [DONE]\n\n"]),
        );

        const results = await drain(client.chatStream(REQUEST));

        // 1 つは response.completed 自身、もう 1 つがコメント行。
        expect(results.filter(isHeartbeatChunk)).toHaveLength(2);
        expect((results.find(isFinalResult) as StreamFinalResult).finishReason).toBe("stop");
      });
    });

    describe("呼び出し側へ渡すものが無いイベントは heartbeat になる（idle timeout の誤発火防止）", () => {
      test.each([
        "response.created",
        "response.in_progress",
        "response.content_part.added",
        "response.output_text.done",
        "response.content_part.done",
        "response.function_call_arguments.done",
      ])("%s は heartbeat として yield される", async (type) => {
        respondWithEvents([{ type, response: {}, output_index: 0 }]);

        const results = await drain(client.chatStream(REQUEST));

        expect(results.filter(isHeartbeatChunk)).toEqual([{ heartbeat: true, done: false }]);
      });

      test.each(["response.reasoning_text.delta", "response.reasoning_summary_text.delta"])(
        "%s は heartbeat になり、本文は content にも fullText にも入らない",
        async (type) => {
          respondWithEvents([{ type, output_index: 0, delta: "thinking..." }]);

          const results = await drain(client.chatStream(REQUEST));

          expect(results.filter(isHeartbeatChunk)).toEqual([{ heartbeat: true, done: false }]);
          expect(results.filter(isContentChunk)).toEqual([]);
          expect((results.find(isFinalResult) as StreamFinalResult).fullText).toBe("");
        },
      );

      test("この client が知らない type のイベントは拒否せず heartbeat として受理する", async () => {
        respondWithEvents([{ type: "response.something_new", payload: 1 }, textDelta("hi")]);

        const results = await drain(client.chatStream(REQUEST));

        expect(results.filter(isHeartbeatChunk)).toEqual([{ heartbeat: true, done: false }]);
        expect(results.filter(isContentChunk)).toEqual([{ content: "hi", done: false }]);
      });

      test("空文字の text delta は content を yield せず heartbeat になる", async () => {
        respondWithEvents([textDelta("")]);

        const results = await drain(client.chatStream(REQUEST));

        expect(results.filter(isContentChunk)).toEqual([]);
        expect(results.filter(isHeartbeatChunk)).toEqual([{ heartbeat: true, done: false }]);
      });

      test("content を伴うイベントは heartbeat を二重 yield しない", async () => {
        respondWithEvents([textDelta("hi")]);

        const results = await drain(client.chatStream(REQUEST));

        expect(results.filter(isHeartbeatChunk)).toEqual([]);
      });

      test("response.completed は usage を載せた heartbeat を 1 つ yield する（[DONE] 前の早期終了でも usage を失わない）", async () => {
        respondWithEvents([textDelta("hi"), completed({ usage: RESPONSES_USAGE })]);

        const results = await drain(client.chatStream(REQUEST));

        expect(results.filter(isHeartbeatChunk)).toEqual([
          { heartbeat: true, done: false, usage: MAPPED_USAGE },
        ]);
        expect((results.find(isFinalResult) as StreamFinalResult).usage).toEqual(MAPPED_USAGE);
      });
    });

    describe("reasoning output item", () => {
      test("output_item.done の reasoning item を opaque なまま独立 chunk として返す", async () => {
        const item = {
          type: "reasoning" as const,
          id: "rs_1",
          summary: [{ type: "summary_text", text: "summary" }],
          encrypted_content: "encrypted",
          signature: "signed",
          format: { type: "future" },
          content: [{ type: "reasoning_text", text: "body" }],
        };
        respondWithEvents([
          { type: "response.output_item.done", output_index: 0, item },
          completed(),
        ]);

        const results = await drain(client.chatStream(REQUEST));

        expect(results[0]).toEqual({ reasoningItem: item, done: false });
      });

      test.each([
        ["summary is not an array", { summary: "bad" }],
        ["content is not an array", { summary: [], content: "bad" }],
        ["summary text is not a string", { summary: [{ type: "summary_text", text: 7 }] }],
        ["content text is not a string", { summary: [], content: [{ type: "reasoning_text" }] }],
      ])("malformed reasoning item (%s) throws StreamProtocolError", async (_label, fields) => {
        respondWithEvents([
          {
            type: "response.output_item.done",
            output_index: 0,
            item: { type: "reasoning", id: "rs_1", ...fields },
          },
        ]);

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("content が無い要約 item を受け付ける", async () => {
        const item = {
          type: "reasoning" as const,
          id: "rs_summary",
          summary: [{ type: "summary_text", text: "summary only" }],
        };
        respondWithEvents([
          { type: "response.output_item.done", output_index: 0, item },
          completed(),
        ]);

        const results = await drain(client.chatStream(REQUEST));

        expect(results[0]).toEqual({ reasoningItem: item, done: false });
      });
    });

    describe("usage の写像と検証", () => {
      test("Responses の usage を Chat Completions の名前へ写像する", async () => {
        respondWithEvents([
          completed({
            usage: {
              input_tokens: 417,
              input_tokens_details: { cached_tokens: 3, cache_write_tokens: 7 },
              output_tokens: 416,
              output_tokens_details: { reasoning_tokens: 256 },
              total_tokens: 833,
              cost: 0.00018725,
              is_byok: false,
              cost_details: {
                upstream_inference_cost: 0.00018725,
                upstream_inference_input_cost: 0.00002085,
                upstream_inference_output_cost: 0.0001664,
                server_tool_cost: 0,
              },
              server_tool_use_details: { tool_calls_requested: 1, tool_calls_executed: 1 },
            },
          }),
        ]);

        const final = (await drain(client.chatStream(REQUEST))).find(
          isFinalResult,
        ) as StreamFinalResult;

        expect(final.usage).toEqual({
          prompt_tokens: 417,
          completion_tokens: 416,
          total_tokens: 833,
          cost: 0.00018725,
          prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 7 },
          completion_tokens_details: { reasoning_tokens: 256 },
          cost_details: {
            upstream_inference_cost: 0.00018725,
            upstream_inference_prompt_cost: 0.00002085,
            upstream_inference_completions_cost: 0.0001664,
            // 0 は「計量対象の server tool が走って 0 ドルで確定した」という報告値で、未報告とは別。
            server_tool_cost: 0,
          },
          is_byok: false,
          server_tool_use_details: { tool_calls_requested: 1, tool_calls_executed: 1 },
        });
      });

      test("null で返るフィールドは 0 にせず、キーごと省く（未報告と 0 を区別する）", async () => {
        respondWithEvents([
          completed({
            usage: {
              ...RESPONSES_USAGE,
              cost: null,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: null },
              cost_details: { upstream_inference_cost: null },
              server_tool_use_details: null,
            },
          }),
        ]);

        const final = (await drain(client.chatStream(REQUEST))).find(
          isFinalResult,
        ) as StreamFinalResult;

        expect(final.usage).toEqual({
          ...MAPPED_USAGE,
          prompt_tokens_details: { cached_tokens: 0 },
        });
      });

      test("server_tool_use_details はカウンタが空でもキーを残す（server tool が起動した事実を失わない）", async () => {
        respondWithEvents([
          completed({ usage: { ...RESPONSES_USAGE, server_tool_use_details: {} } }),
        ]);

        const final = (await drain(client.chatStream(REQUEST))).find(
          isFinalResult,
        ) as StreamFinalResult;

        expect(final.usage).toEqual({ ...MAPPED_USAGE, server_tool_use_details: {} });
      });

      test.each([
        ["cost が数値でない（.toFixed() の生 throw を防ぐ）", { cost: "bad" }],
        ["cost が負値", { cost: -1 }],
        ["input_tokens が文字列（文字列連結での集計破壊を防ぐ）", { input_tokens: "1" }],
        ["input_tokens が負値", { input_tokens: -1 }],
        ["input_tokens が null", { input_tokens: null }],
        ["total_tokens が小数", { total_tokens: 1.5 }],
        ["output_tokens が欠落", { output_tokens: undefined }],
        ["cached_tokens が負値", { input_tokens_details: { cached_tokens: -1 } }],
        ["cache_write_tokens が小数", { input_tokens_details: { cache_write_tokens: 0.5 } }],
        ["reasoning_tokens が文字列", { output_tokens_details: { reasoning_tokens: "3" } }],
        ["input_tokens_details が object でない", { input_tokens_details: "oops" }],
        ["cost_details の値が文字列", { cost_details: { upstream_inference_cost: "1" } }],
        ["is_byok が真偽値でない", { is_byok: "yes" }],
        [
          "server_tool_use_details のカウンタが負値",
          { server_tool_use_details: { tool_calls_executed: -1 } },
        ],
      ])(
        "usage の %s 場合は protocol error になり、final は yield されない",
        async (_label, override) => {
          respondWithEvents([
            textDelta("hi"),
            completed({ usage: { ...RESPONSES_USAGE, ...override } }),
          ]);

          const results: StreamYield[] = [];
          const thrown: unknown = await (async () => {
            for await (const chunk of client.chatStream(REQUEST)) results.push(chunk);
          })().catch((err) => err);

          expect(thrown).toBeInstanceOf(StreamProtocolError);
          expect(results.filter(isFinalResult)).toEqual([]);
          expect(results.filter(isHeartbeatChunk)).toEqual([]);
        },
      );

      test.each([
        ["false", false],
        ["0", 0],
        ['""', ""],
        ["配列", []],
      ])(
        "usage が %s の場合は protocol error になる（falsy だが present な値は不在扱いにしない）",
        async (_label, usage) => {
          respondWithEvents([completed({ usage })]);

          await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(
            StreamProtocolError,
          );
        },
      );

      test("usage が null / 欠落の場合は「不在」として許容される", async () => {
        respondWithEvents([completed({ usage: null })]);

        const final = (await drain(client.chatStream(REQUEST))).find(
          isFinalResult,
        ) as StreamFinalResult;

        expect(final.usage).toBeUndefined();
        expect(final.finishReason).toBe("stop");
      });
    });

    describe("model / provider の読み取り", () => {
      test("model は response.model、provider は openrouter_metadata で selected の endpoint から読む", async () => {
        respondWithEvents([
          completed({
            model: "openai/gpt-5-nano",
            openrouter_metadata: {
              endpoints: {
                available: [
                  { provider: "Azure", model: "openai/gpt-5-nano", selected: false },
                  { provider: "OpenAI", model: "openai/gpt-5-nano", selected: true },
                ],
              },
            },
          }),
        ]);

        const final = (await drain(client.chatStream(REQUEST))).find(
          isFinalResult,
        ) as StreamFinalResult;

        expect(final.model).toBe("openai/gpt-5-nano");
        expect(final.provider).toBe("OpenAI");
      });

      test.each([
        ["欠落", undefined],
        ["文字列", "OpenAI"],
        ["endpoints が配列", { endpoints: [] }],
        [
          "selected の endpoint が無い",
          { endpoints: { available: [{ provider: "OpenAI", selected: false }] } },
        ],
        [
          "provider が文字列でない",
          { endpoints: { available: [{ provider: 1, selected: true }] } },
        ],
      ])(
        "openrouter_metadata が%sなら provider は不明のまま正常終了する（表示専用の値で turn を落とさない）",
        async (_label, metadata) => {
          respondWithEvents([textDelta("hi"), completed({ openrouter_metadata: metadata })]);

          const final = (await drain(client.chatStream(REQUEST))).find(
            isFinalResult,
          ) as StreamFinalResult;

          expect(final.provider).toBeUndefined();
          expect(final.finishReason).toBe("stop");
        },
      );

      test("response.model がオブジェクトなら protocol error になる（footer に [object Object] を出さない）", async () => {
        respondWithEvents([completed({ model: {} })]);

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(StreamProtocolError);
      });

      test("response.model が null なら「不在」として許容される", async () => {
        respondWithEvents([completed({ model: null })]);

        const final = (await drain(client.chatStream(REQUEST))).find(
          isFinalResult,
        ) as StreamFinalResult;

        expect(final.model).toBeUndefined();
      });
    });

    describe("SSE フレーム / carry の最大 byte 長", () => {
      function buildContentDataLine(totalBytes: number): string {
        const prefix = 'data: {"type":"response.output_text.delta","delta":"';
        const suffix = '"}';
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
        const expectedContent = (JSON.parse(line.slice("data: ".length)) as { delta: string })
          .delta;
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
        const payload = sseData(textDelta("😀AB"));
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
        // text delta の `delta` 文字列の途中に単独の 0xFF を挟み、文字列を JSON
        // として閉じる。0xFF は単独では
        // 有効な UTF-8 の先頭バイトになり得ないため、非 fatal decoder なら U+FFFD
        // に化けて（malformed frame 検出をすり抜けて）通ってしまう入力。
        const prefix = encoder.encode('data: {"type":"response.output_text.delta","delta":"');
        const suffix = encoder.encode('"}\n\n');
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
        const prefix = encoder.encode('data: {"type":"response.output_text.delta","delta":"');
        // 4バイトの絵文字シーケンスの先頭2バイトだけを送り、続きとして本来の
        // 継続バイト（0x80-0xBF）ではない ASCII バイトを送る — decoder が
        // `stream:true` で保留していた2バイトを、後続との不整合ごと破棄・エラー
        // 化すべきケース。
        const emojiBytes = encoder.encode("😀");
        const truncatedEmoji = emojiBytes.slice(0, 2);
        const bogusContinuation = encoder.encode('AB"}\n\n');
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
        const body = `data: ${JSON.stringify(textDelta("hello"))}\r\rdata: [DONE]\r\r`;
        mockFetch.mockResolvedValueOnce(sseResponse([body]));

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const contentChunks = results.filter(isContentChunk);
        expect(contentChunks).toEqual([{ content: "hello", done: false }]);
      });

      test("CRLF で区切られたストリームも正しく parse される", async () => {
        const body = `data: ${JSON.stringify(textDelta("hello"))}\r\n\r\ndata: [DONE]\r\n\r\n`;
        mockFetch.mockResolvedValueOnce(sseResponse([body]));

        const results = await drain(
          client.chatStream({ model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
        );
        const contentChunks = results.filter(isContentChunk);
        expect(contentChunks).toEqual([{ content: "hello", done: false }]);
      });

      test("CR が chunk 境界の末尾に、対応する LF が次 chunk 先頭に来る（CRLF が chunk をまたぐ）場合も正しく parse される", async () => {
        const line = `data: ${JSON.stringify(textDelta("split"))}`;
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

      test("Responses の flat な error イベント（type:'error'）も OpenRouter エラーとして throw する", async () => {
        respondWithEvents([
          { type: "error", code: 402, message: "Insufficient credits", param: null },
        ]);

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(
          InsufficientCreditsError,
        );
      });

      test("flat な error イベントの code がシンボリック文字列なら UnknownApiError になる", async () => {
        respondWithEvents([{ type: "error", code: "rate_limit_exceeded", message: "slow down" }]);

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(UnknownApiError);
      });

      test("flat な error イベントが message を欠く場合は protocol error になる", async () => {
        respondWithEvents([{ type: "error", code: 402 }]);

        await expect(drain(client.chatStream(REQUEST))).rejects.toBeInstanceOf(StreamProtocolError);
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

      test("終端イベント受領後の error イベントは protocol error になる（InsufficientCreditsError ではない）", async () => {
        // Once a terminal event has been observed, the stream is frozen —
        // only [DONE]/comments are still legal. An error event arriving
        // after that point is not a genuine API failure for a turn already
        // declared done, so it must be rejected as a protocol violation
        // rather than mapped through buildApiError() to an API error class.
        mockFetch.mockResolvedValueOnce(
          sseResponse([
            sseData(textDelta("hi")),
            sseData(completed()),
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
            sseResponse([sseData(textDelta("hi")), "data: [DONE]\n\n"]),
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
