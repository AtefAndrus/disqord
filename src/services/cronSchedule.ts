import { Cron } from "croner";

export type CronSchedule = { kind: "cron" | "interval" | "once"; expr: string };
export type ScheduleResult = { ok: true; schedule: CronSchedule } | { ok: false; reason: string };

const CRON_FIELD = /^[\d*,/\-A-Za-z]+$/u;
const CRON_NAME =
  /^(?:sun|mon|tue|wed|thu|fri|sat|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/iu;
const MIN_INTERVAL_MS = 5 * 60_000;

function parseOnce(input: string, now: number): ScheduleResult {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/iu.exec(
      input,
    );
  if (!match)
    return { ok: false, reason: "日時はオフセット付き ISO 8601 形式で指定してください。" };
  const [, year, month, day, hour, minute, second, offset] = match;
  const y = Number(year),
    mo = Number(month),
    d = Number(day),
    h = Number(hour),
    mi = Number(minute),
    s = Number(second ?? 0);
  const offsetHours = offset === "Z" ? 0 : Number(offset?.slice(1, 3));
  const offsetMinutes = offset === "Z" ? 0 : Number(offset?.slice(4, 6));
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > days ||
    h > 23 ||
    mi > 59 ||
    s > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  )
    return { ok: false, reason: "存在しない日時です。" };
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp) || timestamp <= now)
    return { ok: false, reason: "日時は現在より後を指定してください。" };
  return { ok: true, schedule: { kind: "once", expr: new Date(timestamp).toISOString() } };
}

export function validateSchedule(schedule: CronSchedule, now: number): ScheduleResult {
  if (schedule.kind === "once") return parseOnce(schedule.expr, now);
  if (schedule.kind === "interval") {
    const ms = Number(schedule.expr);
    return Number.isSafeInteger(ms) && ms >= MIN_INTERVAL_MS && ms % 60_000 === 0
      ? { ok: true, schedule }
      : { ok: false, reason: "間隔は 5 分以上の 1 分単位で指定してください。" };
  }
  try {
    const cron = new Cron(schedule.expr, { timezone: "Asia/Tokyo" });
    let previous = now;
    for (let i = 0; i < 20; i++) {
      const next = cron.nextRun(new Date(previous));
      if (!next) return { ok: false, reason: "今後一致する実行時刻がありません。" };
      if (i > 0 && next.getTime() - previous < MIN_INTERVAL_MS)
        return { ok: false, reason: "実行時刻の間隔は 5 分以上必要です。" };
      previous = next.getTime();
    }
    return { ok: true, schedule };
  } catch {
    return { ok: false, reason: "cron 式が正しくありません。" };
  }
}

export function parseSchedule(
  input: string,
  now: number,
): ScheduleResult | { ok: false; reason: "natural_language" } {
  const value = input.trim();
  const fields = value.split(/\s+/u);
  const cronFields = fields.every(
    (field) =>
      CRON_FIELD.test(field) &&
      field.split(/[\d*,/-]+/u).every((name) => !name || CRON_NAME.test(name)),
  );
  if (
    (fields.length === 6 || fields.length === 7) &&
    /^[\d*,/-]+$/u.test(fields[0] ?? "") &&
    cronFields
  )
    return { ok: false, reason: "cron 式は 5 フィールドで指定してください。" };
  if (fields.length === 5 && /^[\d*,/-]+$/u.test(fields[0] ?? "") && cronFields)
    return validateSchedule({ kind: "cron", expr: value }, now);
  const interval = /^(?:every\s+)?(\d+)([mhd])$/iu.exec(value);
  if (interval) {
    const unit = interval[2]?.toLowerCase();
    const ms =
      Number(interval[1]) * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000);
    return validateSchedule({ kind: "interval", expr: String(ms) }, now);
  }
  if (/^\d{4}-\d{2}-\d{2}T/u.test(value)) return parseOnce(value, now);
  return { ok: false, reason: "natural_language" };
}

export function nextRunAfter(
  schedule: CronSchedule,
  scheduledAt: number,
  now: number,
): number | null {
  if (schedule.kind === "once") return null;
  if (schedule.kind === "interval") return now + Number(schedule.expr);
  const from = Math.max(scheduledAt + MIN_INTERVAL_MS, now) - 1;
  return (
    new Cron(schedule.expr, { timezone: "Asia/Tokyo" }).nextRun(new Date(from))?.getTime() ?? null
  );
}

export function firstRunAfter(schedule: CronSchedule, now: number): number | null {
  if (schedule.kind === "once")
    return Date.parse(schedule.expr) > now ? Date.parse(schedule.expr) : null;
  if (schedule.kind === "interval") return now + Number(schedule.expr);
  return (
    new Cron(schedule.expr, { timezone: "Asia/Tokyo" }).nextRun(new Date(now))?.getTime() ?? null
  );
}

export function nextThreeRuns(schedule: CronSchedule, now: number): number[] {
  const result: number[] = [];
  let next = firstRunAfter(schedule, now);
  while (next !== null && result.length < 3) {
    result.push(next);
    next = nextRunAfter(schedule, next, next);
  }
  return result;
}

function intervalUnit(expr: string): string {
  const ms = Number(expr);
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} 日`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 時間`;
  return `${ms / 60_000} 分`;
}

const JST_OFFSET_MS = 9 * 3_600_000;

/** The text that reproduces the stored schedule through `parseSchedule`; `once` is written in JST. */
export function formatScheduleInput(schedule: CronSchedule): string {
  if (schedule.kind === "cron") return schedule.expr;
  if (schedule.kind === "once") {
    const ms = Date.parse(schedule.expr);
    const local = new Date(ms + JST_OFFSET_MS).toISOString();
    // Milliseconds are kept only when present, so that reading it back gives the same instant.
    return `${ms % 1000 === 0 ? local.slice(0, 19) : local.slice(0, 23)}+09:00`;
  }
  const ms = Number(schedule.expr);
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${ms / 60_000}m`;
}

export function describeScheduleDetails(
  schedule: CronSchedule,
  options: { context?: "proposal" | "job" } = {},
): { text: string; isPlain: boolean } {
  if (schedule.kind === "once")
    return {
      text: new Date(schedule.expr).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
      isPlain: false,
    };
  if (schedule.kind === "interval") {
    const unit = intervalUnit(schedule.expr);
    return {
      text: options.context === "job" ? `${unit}ごと` : `承認から ${unit}後、以後 ${unit}ごと`,
      isPlain: false,
    };
  }
  const text = readCron(schedule.expr);
  return text ? { text, isPlain: false } : { text: schedule.expr, isPlain: true };
}

const DAY_ABBREVIATIONS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function cronNumber(field: string, min: number, max: number): number | undefined {
  if (!/^\d{1,2}$/u.test(field)) return undefined;
  const value = Number(field);
  return value >= min && value <= max ? value : undefined;
}

function dayOfWeek(token: string): number | undefined {
  const named = DAY_ABBREVIATIONS.indexOf(token.toLowerCase());
  return named >= 0 ? named : cronNumber(token, 0, 7);
}

/** Days 0 (Sunday) to 6 for a list of days and ranges, or undefined for anything else (steps). */
function daysOfWeek(field: string): Set<number> | undefined {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const [first, last, extra] = part.split("-");
    const from = first === undefined ? undefined : dayOfWeek(first);
    const to = last === undefined ? from : dayOfWeek(last);
    if (from === undefined || to === undefined || extra !== undefined || from > to)
      return undefined;
    for (let day = from; day <= to; day++) days.add(day % 7);
  }
  return days;
}

/**
 * Reads the daily, hourly, weekly, and monthly shapes; anything else (steps,
 * month fields, a day of month together with days of week) is left to the
 * expression itself.
 */
function readCron(expr: string): string | undefined {
  const fields = expr.trim().split(/\s+/u);
  const [minuteField, hourField, dayField, monthField, weekField] = fields;
  const minute = cronNumber(minuteField ?? "", 0, 59);
  if (fields.length !== 5 || minute === undefined || monthField !== "*") return undefined;
  if (hourField === "*")
    return dayField === "*" && weekField === "*" ? `毎時 ${minute} 分` : undefined;
  const hour = cronNumber(hourField ?? "", 0, 23);
  if (hour === undefined) return undefined;
  const time = `${hour}:${String(minute).padStart(2, "0")}`;
  if (dayField !== "*") {
    if (weekField !== "*") return undefined;
    const dates = (dayField ?? "").split(",").map((day) => cronNumber(day, 1, 31));
    return dates.every((date) => date !== undefined)
      ? `毎月 ${dates.join("・")} 日 ${time}`
      : undefined;
  }
  if (weekField === "*") return `毎日 ${time}`;
  const days = daysOfWeek(weekField ?? "");
  if (!days) return undefined;
  if (days.size === 7) return `毎日 ${time}`;
  if (days.size === 5 && ![0, 6].some((day) => days.has(day))) return `毎週平日 ${time}`;
  // Listed from Monday, the way a Japanese week is read.
  const labels = [1, 2, 3, 4, 5, 6, 0].filter((day) => days.has(day)).map((day) => DAY_LABELS[day]);
  return `毎週 ${labels.join("・")} ${time}`;
}

export function describeSchedule(
  schedule: CronSchedule,
  options: { context?: "proposal" | "job" } = {},
): string {
  return describeScheduleDetails(schedule, options).text;
}
