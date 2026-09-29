import { describe, expect, test } from "bun:test";
import {
  describeSchedule,
  firstRunAfter,
  nextRunAfter,
  nextThreeRuns,
  parseSchedule,
} from "../../../src/services/cronSchedule";

const NOW = Date.parse("2026-09-29T00:00:00Z");

describe("cron schedules", () => {
  test.each([
    ["0 9 * * *", "cron"],
    ["every 30m", "interval"],
    ["2h", "interval"],
    ["1d", "interval"],
    ["2026-10-01T09:00:00+09:00", "once"],
  ])("accepts %s", (input, kind) => {
    const result = parseSchedule(input, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.schedule.kind).toBe(kind as "cron" | "interval" | "once");
  });
  test.each([
    "0 0 9 * * *",
    "1m",
    "4m",
    "* * * * *",
    "0 0 30 2 *",
    "2026-02-30T09:00:00+09:00",
    "2026-10-01T09:00:00",
    "2026-09-28T09:00:00+09:00",
  ])("rejects %s", (input) => {
    const result = parseSchedule(input, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toBe("natural_language");
  });
  test("natural language is sent to the converter by the caller", () => {
    expect(parseSchedule("平日の朝九時", NOW)).toEqual({ ok: false, reason: "natural_language" });
  });
  test("Croner nextRun is strictly after the boundary", () => {
    const schedule = { kind: "cron" as const, expr: "0 9 * * *" };
    expect(firstRunAfter(schedule, NOW)).toBe(Date.parse("2026-09-30T00:00:00Z"));
    expect(nextRunAfter(schedule, NOW, NOW + 20_000)).toBe(Date.parse("2026-09-30T00:00:00Z"));
  });
  test("late */5 run resumes at the next five minute boundary", () => {
    const schedule = { kind: "cron" as const, expr: "*/5 * * * *" };
    expect(nextRunAfter(schedule, NOW, NOW + 20_000)).toBe(NOW + 5 * 60_000);
    expect(nextThreeRuns(schedule, NOW)).toEqual([
      NOW + 5 * 60_000,
      NOW + 10 * 60_000,
      NOW + 15 * 60_000,
    ]);
  });
  test("dense matches are skipped at execution time", () => {
    expect(nextRunAfter({ kind: "cron", expr: "* * * * *" }, NOW, NOW + 20_000)).toBe(
      NOW + 5 * 60_000,
    );
  });
  test("description of weekdays", () => {
    expect(describeSchedule({ kind: "cron", expr: "0 9 * * 1-5" })).toBe("毎週平日 9:00");
  });
});
