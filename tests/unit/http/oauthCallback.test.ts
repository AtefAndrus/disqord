import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ApiKeyRepository } from "../../../src/db/repositories/apiKey";
import { applyMigrations } from "../../../src/db/schema";
import { createOAuthCallbackHandler } from "../../../src/http/oauthCallback";
import { OpenRouterClient } from "../../../src/llm/openrouter";
import {
  ApiKeyService,
  type ConnectionHooks,
  type ConnectionTarget,
} from "../../../src/services/apiKeyService";
import { CryptoService } from "../../../src/services/cryptoService";
import { logger } from "../../../src/utils/logger";

describe("OAuth callback", () => {
  let db: Database;
  let service: ApiKeyService;
  let now: number;
  const originalFetch = globalThis.fetch;
  const user: ConnectionTarget = { scope: "user", userId: "u" };
  const guild: ConnectionTarget = { scope: "guild", guildId: "g" };
  let fetch: ReturnType<
    typeof mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>
  >;
  const makeHooks = (): ConnectionHooks => ({
    authorize: mock(async () => true),
    report: mock(async () => {}),
  });
  function begin(target = user, hooks = makeHooks()): string {
    const state = new URL(service.startConnection("actor", target, hooks)).searchParams.get(
      "state",
    );
    if (!state) throw new Error("missing fixture state");
    return state;
  }
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    now = 1_000_000;
    service = new ApiKeyService(
      new ApiKeyRepository(db),
      new CryptoService("12".repeat(32)),
      new OpenRouterClient("default-fixture"),
      "default-fixture",
      true,
      "https://callback.example/auth/callback",
      () => now,
    );
    fetch = mock(async (input) =>
      Response.json(
        String(input).endsWith("/auth/keys")
          ? { key: "connected-fixture" }
          : { data: { limit_remaining: null } },
      ),
    );
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });
  test("invalid or absent state and missing code do not exchange or consume the pending connection", async () => {
    const state = begin();
    for (const args of [
      [null, "fixture"],
      ["unknown", "fixture"],
      [state, null],
    ] as const)
      expect(await service.completeCallback(args[0], args[1])).toBe("invalid");
    expect(fetch).not.toHaveBeenCalled();
    expect(service.hasPendingConnection("actor", user)).toBe(true);
    expect(await service.completeCallback(state, "fixture")).toBe("connected");
    expect(await service.completeCallback(state, "fixture")).toBe("already_used");
    expect(fetch).toHaveBeenCalledTimes(2);
    const expired = begin();
    now += 15 * 60_000;
    expect(await service.completeCallback(expired, "fixture")).toBe("invalid");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  test("concurrent callbacks claim state before awaiting, and return before the report completes", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hooks = makeHooks();
    hooks.authorize = mock(async () => {
      await barrier;
      return true;
    });
    hooks.report = mock(async () => {
      await new Promise(() => {});
    });
    const state = begin(guild, hooks);
    const first = service.completeCallback(state, "fixture");
    expect(await service.completeCallback(state, "fixture")).toBe("already_used");
    expect(fetch).not.toHaveBeenCalled();
    release();
    expect(await first).toBe("connected");
    expect(hooks.authorize).toHaveBeenCalledTimes(1);
    expect(service.getConnection(guild).status).toBe("connected");
  });
  test.each(["denied", "failed"])(
    "guild authorization %s refuses exchange and consumes the state",
    async (kind) => {
      const hooks = makeHooks();
      hooks.authorize = mock(async () => {
        if (kind === "failed") throw new Error("offline");
        return false;
      });
      const state = begin(guild, hooks);
      expect(await service.completeCallback(state, "fixture")).toBe("failed");
      expect(await service.completeCallback(state, "fixture")).toBe("already_used");
      expect(fetch).not.toHaveBeenCalled();
      expect(service.getConnection(guild).status).toBe("disconnected");
    },
  );
  test("disconnect during callback authorization prevents exchange", async () => {
    const entered = Promise.withResolvers<void>();
    const authorization = Promise.withResolvers<boolean>();
    const hooks = makeHooks();
    hooks.authorize = mock(async () => {
      entered.resolve();
      return authorization.promise;
    });
    const state = begin(guild, hooks);
    const completion = service.completeCallback(state, "fixture");
    await entered.promise;
    service.disconnect(guild);
    authorization.resolve(true);
    expect(await completion).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
    expect(service.getConnection(guild).status).toBe("disconnected");
  });
  test("exchange failure consumes state and never saves", async () => {
    const state = begin();
    fetch.mockImplementation(async () => new Response("", { status: 403 }));
    expect(await service.completeCallback(state, "fixture")).toBe("failed");
    expect(await service.completeCallback(state, "fixture")).toBe("already_used");
    expect(service.getConnection(user).status).toBe("disconnected");
    expect(service.hasPendingConnection("actor", user)).toBe(false);
  });
  test("callback authorization logs no exception, state or code", async () => {
    const hooks = makeHooks();
    hooks.authorize = mock(async () => {
      throw Object.assign(new Error("secret-message"), { name: "secret-name" });
    });
    const state = begin(guild, hooks);
    const logs = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await service.completeCallback(state, "secret-code")).toBe("failed");
      expect(logs.mock.calls).toEqual([
        ["OAuth connection failed", { stage: "authorize", status: undefined, errorType: "Error" }],
      ]);
      expect(JSON.stringify(logs.mock.calls)).not.toContain("secret");
      expect(JSON.stringify(logs.mock.calls)).not.toContain(state);
    } finally {
      logs.mockRestore();
    }
  });
  test("HTML has security headers and never echoes query values on any outcome", async () => {
    const handler = createOAuthCallbackHandler(service);
    const state = begin();
    for (const query of [
      "state=unknown-marker&code=code-marker",
      `state=${state}`,
      `state=${state}&code=code-marker`,
      `state=${state}&code=code-marker`,
    ]) {
      const response = await handler(
        new Request(`https://callback.example/auth/callback?${query}`),
      );
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
      const html = await response.text();
      for (const value of [state, "code-marker", "unknown-marker"])
        expect(html).not.toContain(value);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
