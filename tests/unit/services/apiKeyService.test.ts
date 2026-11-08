import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { ApiKeyRepository } from "../../../src/db/repositories/apiKey";
import { applyMigrations } from "../../../src/db/schema";
import { ApiKeyUnreadableError } from "../../../src/errors";
import { OpenRouterClient } from "../../../src/llm/openrouter";
import { ApiKeyService, type ConnectionTarget } from "../../../src/services/apiKeyService";
import { CryptoService } from "../../../src/services/cryptoService";
import { logger } from "../../../src/utils/logger";

const hooks = (): {
  authorize: ReturnType<typeof mock<() => Promise<boolean>>>;
  report: ReturnType<typeof mock<(result: "connected" | "failed") => Promise<void>>>;
} => ({ authorize: mock(async () => true), report: mock(async () => {}) });
describe("ApiKeyService", () => {
  let db: Database;
  let repo: ApiKeyRepository;
  let service: ApiKeyService;
  let now: number;
  const crypto = new CryptoService("12".repeat(32));
  const shared = new OpenRouterClient("default-fixture");
  const originalFetch = globalThis.fetch;
  const user: ConnectionTarget = { scope: "user", userId: "u" };
  const guild: ConnectionTarget = { scope: "guild", guildId: "g" };
  function save(ownerId: string, scope: "user" | "guild", value: string): void {
    const encrypted = crypto.encrypt(value, `${scope}:${ownerId}`);
    repo.upsert({
      ownerId,
      scope,
      encryptedKey: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
    });
  }
  function mockExchange(): ReturnType<typeof mock> {
    const fetch = mock(
      async (input: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(input).endsWith("/auth/keys")
              ? { key: "connected-fixture" }
              : { data: { limit_remaining: null } },
          ),
        ),
    );
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    return fetch;
  }
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    repo = new ApiKeyRepository(db);
    now = 1_000_000;
    service = new ApiKeyService(
      repo,
      crypto,
      shared,
      "default-fixture",
      true,
      undefined,
      () => now,
    );
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });
  test("mention selects user, guild and default while guild resolution never selects user", () => {
    expect(service.resolveForMention("u", "g")).toEqual({
      key: "default-fixture",
      source: "default",
    });
    save("g", "guild", "guild-fixture");
    expect(service.resolveForMention("u", "g")?.source).toBe("guild");
    save("u", "user", "user-fixture");
    expect(service.resolveForMention("u", "g")).toEqual({ key: "user-fixture", source: "user" });
    expect(service.resolveForGuild("g")).toEqual({ key: "guild-fixture", source: "guild" });
    service.disconnect(guild);
    expect(service.resolveForGuild("g")?.source).toBe("default");
    expect(service.clientFor({ key: "default-fixture", source: "default" })).toBe(shared);
    expect(service.clientFor({ key: "user-fixture", source: "user" })).not.toBe(
      service.clientFor({ key: "user-fixture", source: "user" }),
    );
  });
  test("missing connection returns null and disabled feature uses default", () => {
    expect(
      new ApiKeyService(repo, crypto, shared, "default-fixture", false).resolveForGuild("g"),
    ).toBeNull();
    expect(
      new ApiKeyService(repo, null, shared, "default-fixture", true).resolveForMention("u", "g")
        ?.source,
    ).toBe("default");
  });
  test("unreadable user and guild rows never fall back; disconnect still removes the row", () => {
    save("g", "guild", "guild-fixture");
    save("u", "user", "user-fixture");
    db.run("UPDATE api_keys SET auth_tag = 'invalid' WHERE scope = 'user'");
    expect(() => service.resolveForMention("u", "g")).toThrow(ApiKeyUnreadableError);
    expect(service.getConnection(user)).toEqual({ status: "unreadable" });
    expect(service.disconnect(user)).toEqual({ removed: true, keyHash: null });
    db.run("UPDATE api_keys SET auth_tag = 'invalid' WHERE scope = 'guild'");
    expect(() => service.resolveForGuild("g")).toThrow(ApiKeyUnreadableError);
  });
  test("headless PKCE verifies and saves an exchanged key, without Authorization on exchange", async () => {
    const fetch = mockExchange();
    const url = new URL(service.startConnection("u", user, hooks()));
    expect(url.searchParams.has("callback_url")).toBe(false);
    expect(url.searchParams.has("state")).toBe(false);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    await service.completeConnection("u", user, "code-fixture");
    const request = fetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { code_verifier: string };
    expect(body.code_verifier).toMatch(/^[\w-]{43,128}$/);
    expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(
      url.searchParams.get("code_challenge") ?? "",
    );
    expect((request.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(service.resolveForMention("u", "g")?.key).toBe("connected-fixture");
    expect(service.hasPendingConnection("u", user)).toBe(false);
    expect(repo.find("u", "user")?.encryptedKey).not.toContain("connected-fixture");
  });
  test("pending expires with injected time and rejects another actor", async () => {
    const fetch = mockExchange();
    service.startConnection("u", user, hooks());
    await expect(service.completeConnection("other", user, "code-fixture")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    now += 15 * 60_000;
    expect(service.hasPendingConnection("u", user)).toBe(false);
    await expect(service.completeConnection("u", user, "code-fixture")).rejects.toThrow();
  });
  test("concurrent paste submissions exchange once and report processing for the second", async () => {
    const exchange = Promise.withResolvers<Response>();
    const fetch = mockExchange();
    fetch.mockImplementationOnce(() => exchange.promise);
    service.startConnection("u", user, hooks());
    const first = service.completeConnection("u", user, "code-fixture");
    try {
      await expect(service.completeConnection("u", user, "code-fixture")).resolves.toBe(
        "processing",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(repo.find("u", "user")).toBeNull();
    } finally {
      exchange.resolve(Response.json({ key: "connected-fixture" }));
      await first;
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(service.getConnection(user).status).toBe("connected");
  });
  test("does not save when the pending connection expires during exchange", async () => {
    const exchange = Promise.withResolvers<Response>();
    const fetch = mockExchange();
    fetch.mockImplementationOnce(() => exchange.promise);
    service.startConnection("u", user, hooks());
    const completion = service.completeConnection("u", user, "code-fixture");
    now += 15 * 60_000;
    exchange.resolve(Response.json({ key: "connected-fixture" }));
    await expect(completion).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(repo.find("u", "user")).toBeNull();
  });
  test.each(["exchange", "verify"])(
    "paste retains the same pending request after %s failure",
    async (stage) => {
      service.startConnection("u", user, hooks());
      let verifier: string | undefined;
      const failed = mock(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/auth/keys")) {
          verifier = (JSON.parse(String(init?.body)) as { code_verifier: string }).code_verifier;
          if (stage === "verify") return Response.json({ key: "connected-fixture" });
        }
        return new Response("", { status: 403 });
      });
      globalThis.fetch = failed as unknown as typeof globalThis.fetch;
      await expect(service.completeConnection("u", user, "typo-fixture")).rejects.toThrow();
      expect(service.hasPendingConnection("u", user)).toBe(true);
      expect(repo.find("u", "user")).toBeNull();
      const retried = mockExchange();
      await service.completeConnection("u", user, "corrected-fixture");
      expect(JSON.parse(String((retried.mock.calls[0][1] as RequestInit).body))).toMatchObject({
        code: "corrected-fixture",
        code_verifier: verifier,
      });
      expect(service.hasPendingConnection("u", user)).toBe(false);
      expect(service.resolveForMention("u", "g")?.key).toBe("connected-fixture");
    },
  );
  test.each(["encrypt", "save"])("logs only safe failure metadata at %s", async (stage) => {
    mockExchange();
    service.startConnection("u", user, hooks());
    const failure = Object.assign(new Error("secret-key code state verifier"), {
      name: "secret-name",
    });
    const broken =
      stage === "encrypt"
        ? spyOn(crypto, "encrypt").mockImplementation(() => {
            throw failure;
          })
        : spyOn(repo, "upsert").mockImplementation(() => {
            throw failure;
          });
    const logs = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(service.completeConnection("u", user, "secret-code")).rejects.toThrow();
      expect(logs.mock.calls).toEqual([
        ["OAuth connection failed", { stage, status: undefined, errorType: "Error" }],
      ]);
      expect(JSON.stringify(logs.mock.calls)).not.toContain("secret");
      expect(repo.find("u", "user")).toBeNull();
    } finally {
      logs.mockRestore();
      broken.mockRestore();
    }
  });
  test.each(["disconnect", "replace", "removeGuild", "reconcile"])(
    "does not save when %s occurs during exchange",
    async (change) => {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetch = mock(async (input: string | URL | Request) => {
        if (String(input).endsWith("/auth/keys")) {
          await wait;
          return Response.json({ key: "connected-fixture" });
        }
        return Response.json({ data: { limit_remaining: null } });
      });
      globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
      service.startConnection("actor-a", guild, hooks());
      const completion = service.completeConnection("actor-a", guild, "code-fixture");
      if (change === "disconnect") service.disconnect(guild);
      if (change === "replace") service.startConnection("actor-b", guild, hooks());
      if (change === "removeGuild") service.removeGuild("g");
      if (change === "reconcile") service.removeGuildsNotIn([]);
      release();
      await expect(completion).rejects.toThrow();
      expect(repo.find("g", "guild")).toBeNull();
      expect(service.hasPendingConnection("actor-b", guild)).toBe(change === "replace");
    },
  );
  test("invalid connected key is kept and never invokes the shared default client", async () => {
    save("u", "user", "invalid-fixture");
    const fetch = mock(async (_input: unknown, init?: RequestInit) => {
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
        "Bearer invalid-fixture",
      );
      return Response.json({ error: { message: "invalid" } }, { status: 401 });
    });
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    const payer = service.resolveForMention("u", "g");
    if (!payer) throw new Error("fixture missing");
    await expect(
      service.clientFor(payer).chat({ model: "fixture", messages: [] }),
    ).rejects.toMatchObject({
      statusCode: 401,
      userMessage: expect.stringContaining("/connect user"),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(repo.find("u", "user")).not.toBeNull();
  });
});
