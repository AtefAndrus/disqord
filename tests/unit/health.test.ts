import { afterEach, describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import { type HealthStatus, startHealthServer, startHttpServer } from "../../src/health";
import { canonicalizeQuery } from "../../src/http/adminAuth";
import { hmacSha256Hex } from "../../src/http/hmac";

function createMockClient(isReady: boolean, ping: number): Client {
  return {
    isReady: () => isReady,
    ws: { ping },
  } as unknown as Client;
}

describe("Health Server", () => {
  let server: ReturnType<typeof startHealthServer>;
  const TEST_PORT = 13000 + Math.floor(Math.random() * 1000);

  afterEach(() => {
    if (server) {
      server.stop();
    }
  });

  describe("GET /health", () => {
    test("returns 200 OK when Discord client is connected", async () => {
      const mockClient = createMockClient(true, 42);
      server = startHealthServer(mockClient, TEST_PORT);

      const response = await fetch(`http://localhost:${TEST_PORT}/health`);
      const body = (await response.json()) as HealthStatus;

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(body.status).toBe("ok");
      expect(body.discord.connected).toBe(true);
      expect(body.discord.ping).toBe(42);
      expect(typeof body.uptime).toBe("number");
    });

    test("returns 503 Service Unavailable when Discord client is not connected", async () => {
      const mockClient = createMockClient(false, -1);
      server = startHealthServer(mockClient, TEST_PORT + 1);

      const response = await fetch(`http://localhost:${TEST_PORT + 1}/health`);
      const body = (await response.json()) as HealthStatus;

      expect(response.status).toBe(503);
      expect(body.status).toBe("unhealthy");
      expect(body.discord.connected).toBe(false);
      expect(body.discord.ping).toBe(null);
    });

    test("returns null ping when ping is negative", async () => {
      const mockClient = createMockClient(true, -1);
      server = startHealthServer(mockClient, TEST_PORT + 2);

      const response = await fetch(`http://localhost:${TEST_PORT + 2}/health`);
      const body = (await response.json()) as HealthStatus;

      expect(response.status).toBe(200);
      expect(body.discord.ping).toBe(null);
    });
  });

  describe("Other endpoints", () => {
    test("returns 404 Not Found for unknown paths", async () => {
      const mockClient = createMockClient(true, 42);
      server = startHealthServer(mockClient, TEST_PORT + 3);

      const response = await fetch(`http://localhost:${TEST_PORT + 3}/unknown`);

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    });

    test("returns 404 for root path", async () => {
      const mockClient = createMockClient(true, 42);
      server = startHealthServer(mockClient, TEST_PORT + 4);

      const response = await fetch(`http://localhost:${TEST_PORT + 4}/`);

      expect(response.status).toBe(404);
    });
  });

  describe("Admin endpoints (integrated through Bun.serve)", () => {
    const ADMIN_SECRET = "integration-test-secret";

    async function signed(method: string, port: number, path: string): Promise<Request> {
      const ts = Date.now();
      const u = new URL(`http://localhost:${port}${path}`);
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
      const port = TEST_PORT + 5;
      server = startHttpServer({
        client: createMockClient(true, 42),
        port,
        adminApiSecret: ADMIN_SECRET,
      });
      const res = await fetch(await signed("GET", port, "/admin/metrics"));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
    });

    test("GET /admin/metrics returns 503 when secret is not configured", async () => {
      const port = TEST_PORT + 6;
      server = startHttpServer({ client: createMockClient(true, 42), port });
      const res = await fetch(await signed("GET", port, "/admin/metrics"));
      expect(res.status).toBe(503);
    });

    test("POST /admin/metrics returns 405 with Allow: GET", async () => {
      const port = TEST_PORT + 7;
      server = startHttpServer({
        client: createMockClient(true, 42),
        port,
        adminApiSecret: ADMIN_SECRET,
      });
      const res = await fetch(`http://localhost:${port}/admin/metrics`, { method: "POST" });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
    });

    test("DELETE /admin/logs returns 405 with Allow: GET", async () => {
      const port = TEST_PORT + 8;
      server = startHttpServer({
        client: createMockClient(true, 42),
        port,
        adminApiSecret: ADMIN_SECRET,
      });
      const res = await fetch(`http://localhost:${port}/admin/logs`, { method: "DELETE" });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
    });

    test("PUT /admin/metrics never falls through to the 404 fetch fallback", async () => {
      const port = TEST_PORT + 9;
      server = startHttpServer({
        client: createMockClient(true, 42),
        port,
        adminApiSecret: ADMIN_SECRET,
      });
      const res = await fetch(`http://localhost:${port}/admin/metrics`, { method: "PUT" });
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(405);
    });
  });
});
