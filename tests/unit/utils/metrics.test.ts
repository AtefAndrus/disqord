import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metrics } from "../../../src/utils/metrics";

describe("metrics", () => {
  beforeEach(() => {
    metrics.reset();
  });

  afterEach(() => {
    metrics.reset();
  });

  it("starts with empty counters and zero db/log bytes", () => {
    const snap = metrics.snapshot();
    expect(snap.counters).toEqual({});
    expect(snap.dbBytes).toBe(0);
    expect(snap.logBytes).toBe(0);
    expect(snap.discord.ping).toBeNull();
    expect(typeof snap.uptime).toBe("number");
    expect(typeof snap.memory.rss).toBe("number");
    expect(typeof snap.memory.heapUsed).toBe("number");
  });

  it("accumulates increments across calls", () => {
    metrics.increment("openrouter.requests");
    metrics.increment("openrouter.requests");
    metrics.increment("openrouter.errors");
    const snap = metrics.snapshot();
    expect(snap.counters["openrouter.requests"]).toBe(2);
    expect(snap.counters["openrouter.errors"]).toBe(1);
  });

  it("accepts an explicit `by` amount", () => {
    metrics.increment("foo", 5);
    metrics.increment("foo", 3);
    const snap = metrics.snapshot();
    expect(snap.counters.foo).toBe(8);
  });

  it("ignores non-positive or non-finite `by` values", () => {
    metrics.increment("foo", 0);
    metrics.increment("foo", -1);
    metrics.increment("foo", Number.NaN);
    metrics.increment("foo", Number.POSITIVE_INFINITY);
    const snap = metrics.snapshot();
    expect(snap.counters.foo).toBeUndefined();
  });

  it("reports discord.ping from attached client when non-negative", () => {
    metrics.attach({ client: { ws: { ping: 42 } } });
    expect(metrics.snapshot().discord.ping).toBe(42);
  });

  it("normalizes negative discord.ping to null", () => {
    metrics.attach({ client: { ws: { ping: -1 } } });
    expect(metrics.snapshot().discord.ping).toBeNull();
  });

  it("sums dbBytes across base / -wal / -shm files", () => {
    const dir = mkdtempSync(join(tmpdir(), "disqord-metrics-db-"));
    try {
      const path = join(dir, "test.db");
      writeFileSync(path, "AAAA"); // 4 bytes
      writeFileSync(`${path}-wal`, "BB"); // 2 bytes
      // -shm intentionally absent
      metrics.attach({ databasePath: path });
      expect(metrics.snapshot().dbBytes).toBe(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delegates logBytes to the attached log file writer", () => {
    metrics.attach({ logFileWriter: { getLogBytes: () => 1234 } });
    expect(metrics.snapshot().logBytes).toBe(1234);
  });

  it("never throws when databasePath does not exist", () => {
    metrics.attach({ databasePath: "/non/existent/path.db" });
    expect(metrics.snapshot().dbBytes).toBe(0);
  });
});
