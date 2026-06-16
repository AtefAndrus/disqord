import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogFileWriter, LOG_BASENAME } from "../../../src/utils/logFile";

describe("logFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "disqord-logfile-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a no-op writer when no dir is given", () => {
    const w = createLogFileWriter({ env: "production" });
    w.write("hello");
    expect(w.getRecent()).toEqual([]);
    expect(w.getLogBytes()).toBe(0);
    w.close();
  });

  it("is no-op outside production mode even if dir is given", () => {
    const w = createLogFileWriter({ dir, env: "development" });
    w.write("[2026-01-01T00:00:00.000Z] [INFO] hello");
    w.close();
    expect(existsSync(join(dir, LOG_BASENAME))).toBe(false);
  });

  it("writes lines to disqord.log in production", () => {
    const w = createLogFileWriter({ dir, env: "production" });
    w.write("[2026-01-01T00:00:00.000Z] [INFO] one");
    w.write("[2026-01-01T00:00:01.000Z] [WARN] two");
    w.close();

    const contents = readFileSync(join(dir, LOG_BASENAME), "utf-8");
    expect(contents).toContain("[INFO] one");
    expect(contents).toContain("[WARN] two");
  });

  it("getRecent returns lines from current file in append order", () => {
    const w = createLogFileWriter({ dir, env: "production" });
    for (let i = 0; i < 5; i++) {
      w.write(`[2026-01-01T00:00:0${i}.000Z] [INFO] line-${i}`);
    }
    const recent = w.getRecent({ lines: 3 });
    expect(recent).toHaveLength(3);
    expect(recent[0]).toContain("line-2");
    expect(recent[2]).toContain("line-4");
    w.close();
  });

  it("getRecent filters by level (warn excludes debug/info)", () => {
    const w = createLogFileWriter({ dir, env: "production" });
    w.write("[2026-01-01T00:00:00.000Z] [DEBUG] d");
    w.write("[2026-01-01T00:00:00.000Z] [INFO] i");
    w.write("[2026-01-01T00:00:00.000Z] [WARN] w");
    w.write("[2026-01-01T00:00:00.000Z] [ERROR] e");
    const recent = w.getRecent({ level: "warn", lines: 10 });
    expect(recent).toHaveLength(2);
    expect(recent[0]).toContain("[WARN] w");
    expect(recent[1]).toContain("[ERROR] e");
    w.close();
  });

  it("getRecent filters by since (drops entries strictly older)", () => {
    const w = createLogFileWriter({ dir, env: "production" });
    w.write("[2026-01-01T00:00:00.000Z] [INFO] old");
    w.write("[2026-01-01T00:00:10.000Z] [INFO] new");
    const recent = w.getRecent({
      since: new Date("2026-01-01T00:00:05.000Z"),
      lines: 10,
    });
    expect(recent).toHaveLength(1);
    expect(recent[0]).toContain("new");
    w.close();
  });

  it("rotates files when maxBytes is exceeded", () => {
    const w = createLogFileWriter({ dir, env: "production", maxBytes: 100 });
    for (let i = 0; i < 20; i++) {
      w.write(`[2026-01-01T00:00:00.000Z] [INFO] payload-${i.toString().padStart(3, "0")}`);
    }
    w.close();

    expect(existsSync(join(dir, "disqord.1.log"))).toBe(true);
    expect(existsSync(join(dir, LOG_BASENAME))).toBe(true);
  });

  it("getLogBytes sums current + rotated files", () => {
    const w = createLogFileWriter({ dir, env: "production", maxBytes: 80 });
    for (let i = 0; i < 10; i++) {
      w.write(`[2026-01-01T00:00:00.000Z] [INFO] line-${i}`);
    }
    const bytes = w.getLogBytes();
    expect(bytes).toBeGreaterThan(0);
    w.close();
  });

  it("getRecent merges current and rotated files (oldest first)", () => {
    const w = createLogFileWriter({ dir, env: "production", maxBytes: 100 });
    for (let i = 0; i < 30; i++) {
      w.write(`[2026-01-01T00:00:00.000Z] [INFO] msg-${i.toString().padStart(3, "0")}`);
    }
    const all = w.getRecent({ lines: 1000 });
    expect(all.length).toBeGreaterThan(0);
    const lastLine = all[all.length - 1];
    expect(lastLine).toContain("msg-029");
    w.close();
  });

  it("keeps writing when Phase 1 archive shuffling fails (current fd preserved)", () => {
    // Make `disqord.5.log` a directory so unlinkSync fails with EISDIR
    // when rotate() tries to delete the oldest archive in Phase 1.
    mkdirSync(join(dir, "disqord.5.log"));
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const w = createLogFileWriter({ dir, env: "production", maxBytes: 80 });
    for (let i = 0; i < 30; i++) {
      w.write(`[2026-01-01T00:00:00.000Z] [INFO] before-${i.toString().padStart(3, "0")}`);
    }
    // After Phase 1 failure the writer must NOT be broken: subsequent writes
    // still land in disqord.log.
    w.write("[2026-01-01T00:00:00.000Z] [INFO] after-phase1-failure");
    w.close();

    const content = readFileSync(join(dir, LOG_BASENAME), "utf-8");
    expect(content).toContain("after-phase1-failure");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("never throws on a broken backing dir; writes become no-op", () => {
    // Path under a non-existent root that mkdirSync also cannot create
    // (e.g. an existing file used as parent). We simulate by passing a path
    // that mkdirSync would succeed in, so instead we corrupt by deleting fd
    // post-open via rmSync of the dir.
    const w = createLogFileWriter({ dir, env: "production" });
    rmSync(dir, { recursive: true, force: true });
    expect(() => {
      w.write("[2026-01-01T00:00:00.000Z] [INFO] after-rm");
    }).not.toThrow();
    w.close();
  });
});
