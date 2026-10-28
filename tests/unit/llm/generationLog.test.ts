import { afterEach, describe, expect, mock, test } from "bun:test";
import { OpenRouterGenerationLogClient } from "../../../src/llm/generationLog";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenRouterGenerationLogClient", () => {
  test("both endpoints use the bot key, encoded ID, and abort signal", async () => {
    const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({ data: { input: "[OR_REDACTED]", output: "answer", error: null } }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new OpenRouterGenerationLogClient("test-key");
    const signal = new AbortController().signal;
    const metadata = await client.getGeneration("gen-a&b", signal);
    const content = await client.getGenerationContent("gen-a&b", signal);
    expect(metadata).toEqual(content);
    expect(content).toEqual({
      ok: true,
      data: { input: "[OR_REDACTED]", output: "answer", error: null },
    });
    expect(fetchMock.mock.calls).toEqual([
      [
        "https://openrouter.ai/api/v1/generation?id=gen-a%26b",
        { headers: { Authorization: "Bearer test-key" }, signal },
      ],
      [
        "https://openrouter.ai/api/v1/generation/content?id=gen-a%26b",
        { headers: { Authorization: "Bearer test-key" }, signal },
      ],
    ]);
  });

  for (const status of [401, 403, 404, 429, 500]) {
    test(`preserves HTTP ${status} and the failure reason`, async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("endpoint failed", { status })),
      ) as unknown as typeof fetch;
      expect(await new OpenRouterGenerationLogClient("key").getGeneration("gen-1")).toEqual({
        ok: false,
        status,
        reason: "endpoint failed",
      });
    });
  }

  test("reports network failures without throwing", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("network offline")),
    ) as unknown as typeof fetch;
    expect(await new OpenRouterGenerationLogClient("key").getGenerationContent("gen-1")).toEqual({
      ok: false,
      reason: "network offline",
    });
  });

  test("reports invalid JSON and missing data", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("not JSON")),
    ) as unknown as typeof fetch;
    expect((await new OpenRouterGenerationLogClient("key").getGeneration("gen-1")).ok).toBe(false);
    globalThis.fetch = mock(() =>
      Promise.resolve(Response.json({ unexpected: true })),
    ) as unknown as typeof fetch;
    expect(await new OpenRouterGenerationLogClient("key").getGeneration("gen-1")).toEqual({
      ok: false,
      status: 200,
      reason: "応答に data がありません",
    });
  });
});
