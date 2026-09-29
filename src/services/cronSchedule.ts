import { Cron } from "croner";

export type CronSchedule = { kind: "cron" | "interval" | "once"; expr: string };
export type ScheduleResult = { ok: true; schedule: CronSchedule } | { ok: false; reason: string };

const CRON_FIELD = /^[\d*,/\-A-Za-z]+$/u;
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
  if (
    (fields.length === 6 || fields.length === 7) &&
    /^[\d*,/-]+$/u.test(fields[0] ?? "") &&
    fields.every((field) => CRON_FIELD.test(field))
  )
    return { ok: false, reason: "cron 式は 5 フィールドで指定してください。" };
  if (
    fields.length === 5 &&
    /^[\d*,/-]+$/u.test(fields[0] ?? "") &&
    fields.every((field) => CRON_FIELD.test(field))
  )
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

export function describeSchedule(schedule: CronSchedule): string {
  if (schedule.kind === "once")
    return new Date(schedule.expr).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  if (schedule.kind === "interval")
    return `承認から ${Number(schedule.expr) / 60_000} 分後、以後 ${Number(schedule.expr) / 60_000} 分ごと`;
  const match = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/u.exec(schedule.expr);
  return match ? `毎週平日 ${match[2]}:${match[1]?.padStart(2, "0")}` : schedule.expr;
}
