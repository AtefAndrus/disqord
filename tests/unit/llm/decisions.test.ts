import { afterEach, describe, expect, mock, test } from "bun:test";
import { type DecisionsRequest, OpenRouterClient } from "../../../src/llm/openrouter";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const request: DecisionsRequest = {
  model: "typesafe/jev-1.14",
  state: { new_message: "hello" },
  questions: {
    should_reply: { type: "noul", instructions: "reply?", criteria: { true: "yes", false: "no" } },
  },
};

describe("OpenRouterClient.decideNoul", () => {
  test("posts the exact request to Decisions with attribution headers and parses metadata", async () => {
    const fetchMock = mock(async () =>
      Response.json({
        model: "typesafe/jev-1.14-20261014",
        provider: "TypeSafe",
        answers: { should_reply: { type: "noul", noul: 0.93 } },
        usage: { cost: 0.000021462 },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const signal = new AbortController().signal;
    expect(await new OpenRouterClient("key").decideNoul(request, "should_reply", signal)).toEqual({
      noul: 0.93,
      model: "typesafe/jev-1.14-20261014",
      provider: "TypeSafe",
      cost: 0.000021462,
    });
    expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers: {
        Authorization: "Bearer key",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/AtefAndrus/disqord",
        "X-OpenRouter-Title": "DisQord",
        "X-OpenRouter-Categories": "general-chat",
      },
      body: JSON.stringify(request),
      signal,
    });
  });
  test("HTTP errors carry status and do not affect chat rate limits", async () => {
    globalThis.fetch = mock(
      async () => new Response("error", { status: 429 }),
    ) as unknown as typeof fetch;
    const client = new OpenRouterClient("key");
    await expect(client.decideNoul(request, "should_reply")).rejects.toMatchObject({ status: 429 });
    expect(client.isRateLimited()).toBe(false);
  });
  test.each([
    {},
    { answers: {} },
    { answers: { other: { noul: 0.5 } } },
    ...[undefined, null, "0.3", -0.1, 1.1].map((noul) => ({ answers: { should_reply: { noul } } })),
  ])("rejects invalid answer %j", async (response) => {
    globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
    await expect(new OpenRouterClient("key").decideNoul(request, "should_reply")).rejects.toThrow(
      "invalid noul",
    );
  });
  test.each([0, 1])("accepts the boundary %s and ignores malformed metadata", async (noul) => {
    globalThis.fetch = mock(async () =>
      Response.json({
        answers: { should_reply: { noul } },
        model: 1,
        provider: null,
        usage: { cost: "1" },
      }),
    ) as unknown as typeof fetch;
    expect(await new OpenRouterClient("key").decideNoul(request, "should_reply")).toEqual({ noul });
  });
  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects nonfinite noul %s",
    async (noul) => {
      globalThis.fetch = mock(async () => ({
        ok: true,
        json: async () => ({ answers: { should_reply: { noul } } }),
      })) as unknown as typeof fetch;
      await expect(new OpenRouterClient("key").decideNoul(request, "should_reply")).rejects.toThrow(
        "invalid noul",
      );
    },
  );
});
