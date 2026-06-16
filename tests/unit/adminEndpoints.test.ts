import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { canonicalizeQuery } from "../../src/http/adminAuth";
import { createAdminHandlers } from "../../src/http/adminEndpoints";
import { hmacSha256Hex } from "../../src/http/hmac";
import type { LogFileWriter } from "../../src/utils/logFile";
import { metrics } from "../../src/utils/metrics";

const SECRET = "test-secret";

async function signedRequest(
  method: string,
  url: string,
  secret: string = SECRET,
): Promise<Request> {
  const ts = Date.now();
  const u = new URL(url);
  const message = `${method}\n${u.pathname}\n${canonicalizeQuery(u.searchParams)}\n${ts}`;
  const sig = await hmacSha256Hex(secret, message);
  return new Request(url, {
    method,
    headers: {
      "X-Admin-Timestamp": String(ts),
      "X-Admin-Signature": `sha256=${sig}`,
    },
  });
}

function fakeWriter(lines: string[]): LogFileWriter {
  return {
    write: () => {},
    flush: () => {},
    close: () => {},
    getRecent: (opts) => {
      let out = [...lines];
      if (opts?.lines !== undefined) out = out.slice(-opts.lines);
      return out;
    },
    getLogBytes: () => 0,
    dir: "/tmp/fake",
  };
}

describe("adminEndpoints", () => {
  beforeEach(() => {
    metrics.reset();
  });

  afterEach(() => {
    metrics.reset();
  });

  describe("handleAdminMetrics", () => {
    it("returns 405 with Allow: GET for non-GET requests", async () => {
      const handlers = createAdminHandlers({ adminApiSecret: SECRET });
      const req = new Request("https://example.com/admin/metrics", { method: "POST" });
      const res = await handlers.handleAdminMetrics(req);
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
    });

    it("returns 503 when secret is not configured", async () => {
      const handlers = createAdminHandlers({});
      const req = await signedRequest("GET", "https://example.com/admin/metrics");
      const res = await handlers.handleAdminMetrics(req);
      expect(res.status).toBe(503);
    });

    it("returns 401 for invalid signature", async () => {
      const handlers = createAdminHandlers({ adminApiSecret: SECRET });
      const req = new Request("https://example.com/admin/metrics", {
        headers: {
          "X-Admin-Timestamp": String(Date.now()),
          "X-Admin-Signature": `sha256=${"0".repeat(64)}`,
        },
      });
      const res = await handlers.handleAdminMetrics(req);
      expect(res.status).toBe(401);
    });

    it("returns 200 JSON for a valid request", async () => {
      const handlers = createAdminHandlers({ adminApiSecret: SECRET });
      metrics.increment("openrouter.requests");
      const req = await signedRequest("GET", "https://example.com/admin/metrics");
      const res = await handlers.handleAdminMetrics(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      const body = (await res.json()) as { counters: Record<string, number> };
      expect(body.counters["openrouter.requests"]).toBe(1);
    });
  });

  describe("handleAdminLogs", () => {
    it("returns 405 for non-GET", async () => {
      const handlers = createAdminHandlers({ adminApiSecret: SECRET });
      const req = new Request("https://example.com/admin/logs", { method: "DELETE" });
      const res = await handlers.handleAdminLogs(req);
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
    });

    it("returns 503 when secret is not configured", async () => {
      const handlers = createAdminHandlers({ logFileWriter: fakeWriter(["a", "b"]) });
      const req = await signedRequest("GET", "https://example.com/admin/logs");
      const res = await handlers.handleAdminLogs(req);
      expect(res.status).toBe(503);
    });

    it("returns 400 for invalid level", async () => {
      const handlers = createAdminHandlers({
        adminApiSecret: SECRET,
        logFileWriter: fakeWriter([]),
      });
      const req = await signedRequest("GET", "https://example.com/admin/logs?level=trace");
      const res = await handlers.handleAdminLogs(req);
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid lines", async () => {
      const handlers = createAdminHandlers({
        adminApiSecret: SECRET,
        logFileWriter: fakeWriter([]),
      });
      const req = await signedRequest("GET", "https://example.com/admin/logs?lines=abc");
      const res = await handlers.handleAdminLogs(req);
      expect(res.status).toBe(400);
    });

    it("returns 400 for lines out of range", async () => {
      const handlers = createAdminHandlers({
        adminApiSecret: SECRET,
        logFileWriter: fakeWriter([]),
      });
      const req = await signedRequest("GET", "https://example.com/admin/logs?lines=0");
      const res = await handlers.handleAdminLogs(req);
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid since", async () => {
      const handlers = createAdminHandlers({
        adminApiSecret: SECRET,
        logFileWriter: fakeWriter([]),
      });
      const req = await signedRequest("GET", "https://example.com/admin/logs?since=not-a-date");
      const res = await handlers.handleAdminLogs(req);
      expect(res.status).toBe(400);
    });

    it("returns 200 text/plain with log lines", async () => {
      const writer = fakeWriter([
        "[2026-01-01T00:00:00.000Z] [INFO] one",
        "[2026-01-01T00:00:01.000Z] [WARN] two",
      ]);
      const handlers = createAdminHandlers({ adminApiSecret: SECRET, logFileWriter: writer });
      const req = await signedRequest("GET", "https://example.com/admin/logs");
      const res = await handlers.handleAdminLogs(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      const text = await res.text();
      expect(text).toContain("[INFO] one");
      expect(text).toContain("[WARN] two");
    });

    it("returns empty body 200 when no writer is configured", async () => {
      const handlers = createAdminHandlers({ adminApiSecret: SECRET });
      const req = await signedRequest("GET", "https://example.com/admin/logs");
      const res = await handlers.handleAdminLogs(req);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
    });
  });
});
