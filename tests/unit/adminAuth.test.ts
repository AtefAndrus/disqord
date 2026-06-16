import { describe, expect, it } from "bun:test";
import { canonicalizeQuery, verifyAdminRequest } from "../../src/http/adminAuth";
import { hmacSha256Hex } from "../../src/http/hmac";

const SECRET = "test-admin-secret";

async function signRequest(
  method: string,
  url: string,
  ts: number,
  secret: string = SECRET,
): Promise<Request> {
  const u = new URL(url);
  const canonicalQuery = canonicalizeQuery(u.searchParams);
  const message = `${method}\n${u.pathname}\n${canonicalQuery}\n${ts}`;
  const sig = await hmacSha256Hex(secret, message);
  return new Request(url, {
    method,
    headers: {
      "X-Admin-Timestamp": String(ts),
      "X-Admin-Signature": `sha256=${sig}`,
    },
  });
}

describe("canonicalizeQuery", () => {
  it("returns an empty string for no params", () => {
    expect(canonicalizeQuery(new URLSearchParams(""))).toBe("");
  });

  it("sorts keys ascending", () => {
    expect(canonicalizeQuery(new URLSearchParams("b=2&a=1"))).toBe("a=1&b=2");
  });

  it("sorts duplicate keys by value ascending and preserves them", () => {
    expect(canonicalizeQuery(new URLSearchParams("k=2&k=1"))).toBe("k=1&k=2");
  });

  it("encodes special characters", () => {
    expect(canonicalizeQuery(new URLSearchParams("q=hello world"))).toBe("q=hello%20world");
  });

  it("produces the same canonical form for + and %20 (URLSearchParams normalizes both to space)", () => {
    const a = canonicalizeQuery(new URLSearchParams("q=hello+world"));
    const b = canonicalizeQuery(new URLSearchParams("q=hello%20world"));
    expect(a).toBe(b);
  });

  it("canonicalizes duplicate keys with special characters deterministically", () => {
    const params = new URLSearchParams();
    params.append("tag", "release/v2");
    params.append("tag", "release/v1");
    expect(canonicalizeQuery(params)).toBe("tag=release%2Fv1&tag=release%2Fv2");
  });
});

describe("verifyAdminRequest", () => {
  it("returns 503 when secret is undefined", async () => {
    const req = new Request("https://example.com/admin/metrics");
    const result = await verifyAdminRequest(req, undefined);
    expect(result).toEqual({ ok: false, status: 503, reason: expect.any(String) });
  });

  it("returns 503 when secret is empty string", async () => {
    const req = new Request("https://example.com/admin/metrics");
    const result = await verifyAdminRequest(req, "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it("returns 401 when timestamp header is missing", async () => {
    const req = new Request("https://example.com/admin/metrics");
    const result = await verifyAdminRequest(req, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("returns 401 when timestamp is not a positive integer", async () => {
    const req = new Request("https://example.com/admin/metrics", {
      headers: { "X-Admin-Timestamp": "NaN", "X-Admin-Signature": "sha256=00" },
    });
    const result = await verifyAdminRequest(req, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("returns 401 when timestamp is older than 5 minutes", async () => {
    const stale = Date.now() - 6 * 60_000;
    const req = await signRequest("GET", "https://example.com/admin/metrics", stale);
    const result = await verifyAdminRequest(req, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("returns 401 when timestamp is more than 5 minutes in the future", async () => {
    const future = Date.now() + 6 * 60_000;
    const req = await signRequest("GET", "https://example.com/admin/metrics", future);
    const result = await verifyAdminRequest(req, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("returns 401 when timestamp has more than 15 digits (regex bound)", async () => {
    const tooLong = "1".repeat(16);
    const req = new Request("https://example.com/admin/metrics", {
      headers: {
        "X-Admin-Timestamp": tooLong,
        "X-Admin-Signature": `sha256=${"0".repeat(64)}`,
      },
    });
    const result = await verifyAdminRequest(req, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("returns 401 when signature header is missing", async () => {
    const req = new Request("https://example.com/admin/metrics", {
      headers: { "X-Admin-Timestamp": String(Date.now()) },
    });
    const result = await verifyAdminRequest(req, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("returns 401 when signature lacks sha256= prefix", async () => {
    const req = new Request("https://example.com/admin/metrics", {
      headers: {
        "X-Admin-Timestamp": String(Date.now()),
        "X-Admin-Signature": "deadbeef",
      },
    });
    const result = await verifyAdminRequest(req, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("returns 401 when signature does not match", async () => {
    const ts = Date.now();
    const req = new Request("https://example.com/admin/metrics", {
      headers: {
        "X-Admin-Timestamp": String(ts),
        "X-Admin-Signature": `sha256=${"0".repeat(64)}`,
      },
    });
    const result = await verifyAdminRequest(req, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("returns ok for a valid signature with no query", async () => {
    const ts = Date.now();
    const req = await signRequest("GET", "https://example.com/admin/metrics", ts);
    const result = await verifyAdminRequest(req, SECRET);
    expect(result.ok).toBe(true);
  });

  it("returns ok for a valid signature with query params (any order)", async () => {
    const ts = Date.now();
    const req = await signRequest("GET", "https://example.com/admin/logs?level=warn&lines=200", ts);
    const result = await verifyAdminRequest(req, SECRET);
    expect(result.ok).toBe(true);
  });

  it("accepts a signature computed over the canonical (sorted) query even if the URL is unsorted", async () => {
    const ts = Date.now();
    const path = "/admin/logs";
    // Client-side: compute signature with canonical (sorted) order.
    const canonicalQuery = "level=warn&lines=200";
    const message = `GET\n${path}\n${canonicalQuery}\n${ts}`;
    const sig = await hmacSha256Hex(SECRET, message);
    // But send URL with unsorted query.
    const req = new Request(`https://example.com${path}?lines=200&level=warn`, {
      headers: {
        "X-Admin-Timestamp": String(ts),
        "X-Admin-Signature": `sha256=${sig}`,
      },
    });
    const result = await verifyAdminRequest(req, SECRET);
    expect(result.ok).toBe(true);
  });

  it("rejects a request signed with a different secret", async () => {
    const ts = Date.now();
    const req = await signRequest("GET", "https://example.com/admin/metrics", ts, "wrong-secret");
    const result = await verifyAdminRequest(req, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects when the HTTP method on the wire differs from the signed method", async () => {
    const ts = Date.now();
    const signedForGet = await signRequest("GET", "https://example.com/admin/metrics", ts);
    const tampered = new Request("https://example.com/admin/metrics", {
      method: "POST",
      headers: signedForGet.headers,
    });
    const result = await verifyAdminRequest(tampered, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects when the request path differs from the signed path", async () => {
    const ts = Date.now();
    const signedForMetrics = await signRequest("GET", "https://example.com/admin/metrics", ts);
    const tampered = new Request("https://example.com/admin/logs", {
      method: "GET",
      headers: signedForMetrics.headers,
    });
    const result = await verifyAdminRequest(tampered, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});
