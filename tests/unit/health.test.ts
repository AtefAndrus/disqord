import { afterEach, describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import { type HealthStatus, startHealthServer } from "../../src/health";

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
});
