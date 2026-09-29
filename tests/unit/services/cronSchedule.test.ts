import { describe, expect, test } from "bun:test";
import {
  describeSchedule,
  describeScheduleDetails,
  firstRunAfter,
  formatScheduleInput,
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
    expect(parseSchedule("9 am on weekdays please", NOW)).toEqual({
      ok: false,
      reason: "natural_language",
    });
    expect(parseSchedule("30 minutes past every hour daily", NOW)).toEqual({
      ok: false,
      reason: "natural_language",
    });
    expect(parseSchedule("0 9 * * mon-fri", NOW)).toMatchObject({
      ok: true,
      schedule: { kind: "cron" },
    });
    expect(parseSchedule("0 9 1 jan *", NOW)).toMatchObject({
      ok: true,
      schedule: { kind: "cron" },
    });
  });
  test.each([
    { kind: "interval" as const, expr: "1800000", input: "30m" },
    { kind: "interval" as const, expr: "7200000", input: "2h" },
    { kind: "interval" as const, expr: "86400000", input: "1d" },
    { kind: "cron" as const, expr: "0 9 * * mon-fri", input: "0 9 * * mon-fri" },
    { kind: "once" as const, expr: "2026-10-01T00:00:00.000Z", input: "2026-10-01T09:00:00+09:00" },
    {
      kind: "once" as const,
      expr: "2026-09-30T15:30:00.250Z",
      input: "2026-10-01T00:30:00.250+09:00",
    },
  ])("formats a stored $kind schedule for modal round-trip ($input)", (schedule) => {
    expect(formatScheduleInput(schedule)).toBe(schedule.input);
    expect(parseSchedule(formatScheduleInput(schedule), NOW)).toEqual({
      ok: true,
      schedule: { kind: schedule.kind, expr: schedule.expr },
    });
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
    expect(describeSchedule({ kind: "interval", expr: "86400000" })).toBe(
      "承認から 1 日後、以後 1 日ごと",
    );
    expect(describeSchedule({ kind: "interval", expr: "7200000" }, { context: "job" })).toBe(
      "2 時間ごと",
    );
    expect(describeScheduleDetails({ kind: "cron", expr: "0 9 1 jan *" })).toEqual({
      text: "0 9 1 jan *",
      isPlain: true,
    });
  });
  test.each([
    ["30 7 * * *", "毎日 7:30"],
    ["15 * * * *", "毎時 15 分"],
    ["0 9 * * mon-fri", "毎週平日 9:00"],
    ["0 17 * * 5", "毎週 金 17:00"],
    ["0 17 * * fri", "毎週 金 17:00"],
    ["0 10 * * 1,3,5", "毎週 月・水・金 10:00"],
    ["0 10 * * 0,6", "毎週 土・日 10:00"],
    ["0 10 * * 5-7", "毎週 金・土・日 10:00"],
    ["0 8 * * 0-6", "毎日 8:00"],
    ["0 9 1 * *", "毎月 1 日 9:00"],
    ["0 9 1,15 * *", "毎月 1・15 日 9:00"],
  ])("reads %s as %s", (expr, text) => {
    expect(describeScheduleDetails({ kind: "cron", expr })).toEqual({ text, isPlain: false });
  });
  test.each([
    "*/10 * * * *",
    "0 */2 * * *",
    "0 9 * 1 *",
    "0 9 1 * 1",
    "0 9 * * 1/2",
    "0 9 * * 5-1",
    "0 9 32 * *",
  ])("leaves %s as written", (expr) => {
    expect(describeScheduleDetails({ kind: "cron", expr })).toEqual({ text: expr, isPlain: true });
  });
});
