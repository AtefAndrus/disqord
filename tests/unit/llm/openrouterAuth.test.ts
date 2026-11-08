import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  buildAuthorizationUrl,
  exchangeCode,
  formatKeyBalance,
  getKeyInfo,
  OAuthError,
} from "../../../src/llm/openrouterAuth";
import { logger } from "../../../src/utils/logger";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
describe("OpenRouter OAuth", () => {
  test.each(["exchange", "key_info"] as const)(
    "%s failures log stage, status and safe error type only",
    async (stage) => {
      const logs = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        for (const status of [403, undefined]) {
          globalThis.fetch = mock(async () => {
            if (status) return new Response("secret-response", { status });
            throw Object.assign(
              new Error("secret-message secret-key secret-code secret-state secret-verifier"),
              { name: "secret-name" },
            );
          }) as unknown as typeof globalThis.fetch;
          const request =
            stage === "exchange"
              ? exchangeCode("secret-code", "secret-verifier")
              : getKeyInfo("secret-key");
          await expect(request).rejects.toBeInstanceOf(OAuthError);
          expect(logs.mock.calls.at(-1)).toEqual([
            "OpenRouter connection request failed",
            {
              stage,
              status,
              errorType: status ? "OAuthError" : "Error",
            },
          ]);
        }
        expect(logs).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(logs.mock.calls)).not.toContain("secret");
      } finally {
        logs.mockRestore();
      }
    },
  );
  test("authorization URL uses S256, callback and state only when configured", () => {
    const url = new URL(
      buildAuthorizationUrl("challenge-fixture", "https://callback.example/", "state-fixture"),
    );
    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      code_challenge: "challenge-fixture",
      code_challenge_method: "S256",
      callback_url: "https://callback.example/",
      state: "state-fixture",
      key_label: "DisQord",
    });
    expect(new URL(buildAuthorizationUrl("fixture")).searchParams.has("callback_url")).toBe(false);
  });
  test("key metadata preserves null for unlimited and reports failure rather than zero", async () => {
    for (const remaining of [null, 12.5]) {
      globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
        expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
          "Bearer fixture",
        );
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Response.json({ data: { limit_remaining: remaining } });
      }) as unknown as typeof globalThis.fetch;
      expect((await getKeyInfo("fixture")).limit_remaining).toBe(remaining);
    }
    globalThis.fetch = mock(
      async () => new Response("", { status: 401 }),
    ) as unknown as typeof globalThis.fetch;
    await expect(getKeyInfo("fixture")).rejects.toBeInstanceOf(OAuthError);
    expect(formatKeyBalance(null)).toBe("取得できません");
    expect(formatKeyBalance({ limit_remaining: null })).toContain("上限なし");
    expect(formatKeyBalance({ limit_remaining: 12.5 })).toBe("キーの上限までの残額 $12.50");
  });
  test.each(["malformed", "offline"])(
    "exchange hides sensitive %s response content",
    async (kind) => {
      globalThis.fetch = mock(async () => {
        if (kind === "offline") throw new Error("fixture-secret");
        return Response.json({ secret: "fixture-secret" });
      }) as unknown as typeof globalThis.fetch;
      try {
        await exchangeCode("code-fixture", "verifier-fixture");
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(OAuthError);
        expect(String(error)).not.toContain("fixture-secret");
        expect(String(error)).not.toContain("code-fixture");
      }
    },
  );
});
