import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Client } from "discord.js";
import { type HealthStatus, startHealthServer, startHttpServer } from "../../src/health";
import { canonicalizeQuery } from "../../src/http/adminAuth";
import { hmacSha256Hex } from "../../src/http/hmac";
import { createOAuthCallbackHandler } from "../../src/http/oauthCallback";
import { createMockApiKeyService } from "../helpers/mockFactories";

function createMockClient(isReady: boolean, ping: number): Client {
  return {
    isReady: () => isReady,
    ws: { ping },
  } as unknown as Client;
}

describe("Health Server", () => {
  let server: ReturnType<typeof startHealthServer>;

  afterEach(() => {
    if (server) {
      server.stop();
    }
  });

  test("registers only the configured callback and extends GET request's timeout", async () => {
    const timeout = mock((_req: Request, _seconds: number) => {});
    let routes: Record<
      string,
      (request: Request, server: { timeout: typeof timeout }) => Promise<Response> | Response
    > = {};
    const serve = spyOn(Bun, "serve").mockImplementation((options) => {
      routes = options.routes as unknown as typeof routes;
      return { stop: () => {}, timeout } as unknown as ReturnType<typeof Bun.serve>;
    });
    try {
      startHttpServer({ client: createMockClient(true, 42), port: 0 });
      expect(routes["/auth/callback"]).toBeUndefined();
      const callback = mock(async (_request: Request) => new Response("fixture"));
      startHttpServer({
        client: createMockClient(true, 42),
        port: 0,
        oauthCallback: callback,
      });
      const req = new Request("http://localhost/auth/callback");
      const response = await routes["/auth/callback"]?.(req, { timeout });
      expect(await response?.text()).toBe("fixture");
      expect(timeout).toHaveBeenCalledWith(req, 30);
    } finally {
      serve.mockRestore();
    }
  });

  test("real server rejects HEAD and other non-GET callbacks before completing a connection", async () => {
    const keys = createMockApiKeyService();
    server = startHttpServer({
      client: createMockClient(true, 42),
      port: 0,
      oauthCallback: createOAuthCallbackHandler(keys),
    });
    const url = `http://127.0.0.1:${server.port}/auth/callback?state=fixture-state&code=fixture-code`;
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await fetch(url, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET");
      expect(keys.completeCallback).not.toHaveBeenCalled();
      await response.text();
    }
    expect((await fetch(url)).status).toBe(200);
    expect(keys.completeCallback).toHaveBeenCalledTimes(1);
    expect(keys.completeCallback).toHaveBeenCalledWith("fixture-state", "fixture-code");
  });

  describe("GET /health", () => {
    test("returns 200 OK when Discord client is connected", async () => {
      const mockClient = createMockClient(true, 42);
      server = startHealthServer(mockClient, 0);

      const response = await fetch(`http://localhost:${server.port}/health`);
      const body = (await response.json()) as HealthStatus;

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(body.status).toBe("ok");
      expect(body.discord.connected).toBe(true);
      expect(body.discord.ping).toBe(42);
      expect(typeof body.uptime).toBe("number");
      expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(Date.parse(body.startedAt)).toBeLessThanOrEqual(Date.parse(body.now));
    });

    test("returns 503 Service Unavailable when Discord client is not connected", async () => {
      const mockClient = createMockClient(false, -1);
      server = startHealthServer(mockClient, 0);

      const response = await fetch(`http://localhost:${server.port}/health`);
      const body = (await response.json()) as HealthStatus;

      expect(response.status).toBe(503);
      expect(body.status).toBe("unhealthy");
      expect(body.discord.connected).toBe(false);
      expect(body.discord.ping).toBe(null);
    });

    test("returns null ping when ping is negative", async () => {
      const mockClient = createMockClient(true, -1);
      server = startHealthServer(mockClient, 0);

      const response = await fetch(`http://localhost:${server.port}/health`);
      const body = (await response.json()) as HealthStatus;

      expect(response.status).toBe(200);
      expect(body.discord.ping).toBe(null);
    });
  });

  describe("Other endpoints", () => {
    test("returns 404 Not Found for unknown paths", async () => {
      const mockClient = createMockClient(true, 42);
      server = startHealthServer(mockClient, 0);

      const response = await fetch(`http://localhost:${server.port}/unknown`);

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    });

    test("returns 404 for root path", async () => {
      const mockClient = createMockClient(true, 42);
      server = startHealthServer(mockClient, 0);

      const response = await fetch(`http://localhost:${server.port}/`);

      expect(response.status).toBe(404);
    });

    test("POST /webhook/github returns 404 after the release endpoint is removed", async () => {
      const mockClient = createMockClient(true, 42);
      server = startHealthServer(mockClient, 0);

      const response = await fetch(`http://localhost:${server.port}/webhook/github`, {
        method: "POST",
      });

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    });
  });

  describe("Admin endpoints (integrated through Bun.serve)", () => {
    const ADMIN_SECRET = "integration-test-secret";

    async function signed(method: string, path: string): Promise<Request> {
      const ts = Date.now();
      const u = new URL(`http://localhost:${server.port}${path}`);
      const message = `${method}\n${u.pathname}\n${canonicalizeQuery(u.searchParams)}\n${ts}`;
      const sig = await hmacSha256Hex(ADMIN_SECRET, message);
      return new Request(u.toString(), {
        method,
        headers: {
          "X-Admin-Timestamp": String(ts),
          "X-Admin-Signature": `sha256=${sig}`,
        },
      });
    }

    test("GET /admin/metrics returns 200 JSON when secret matches", async () => {
      server = startHttpServer({
        client: createMockClient(true, 42),
        port: 0,
        adminApiSecret: ADMIN_SECRET,
      });
      const res = await fetch(await signed("GET", "/admin/metrics"));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
    });

    test("GET /admin/metrics returns 503 when secret is not configured", async () => {
      server = startHttpServer({ client: createMockClient(true, 42), port: 0 });
      const res = await fetch(await signed("GET", "/admin/metrics"));
      expect(res.status).toBe(503);
    });

    test("POST /admin/metrics returns 405 with Allow: GET", async () => {
      server = startHttpServer({
        client: createMockClient(true, 42),
        port: 0,
        adminApiSecret: ADMIN_SECRET,
      });
      const res = await fetch(`http://localhost:${server.port}/admin/metrics`, { method: "POST" });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
    });

    test("DELETE /admin/logs returns 405 with Allow: GET", async () => {
      server = startHttpServer({
        client: createMockClient(true, 42),
        port: 0,
        adminApiSecret: ADMIN_SECRET,
      });
      const res = await fetch(`http://localhost:${server.port}/admin/logs`, { method: "DELETE" });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
    });

    test("PUT /admin/metrics never falls through to the 404 fetch fallback", async () => {
      server = startHttpServer({
        client: createMockClient(true, 42),
        port: 0,
        adminApiSecret: ADMIN_SECRET,
      });
      const res = await fetch(`http://localhost:${server.port}/admin/metrics`, { method: "PUT" });
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(405);
    });
  });
});
