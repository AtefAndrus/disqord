import type { LogFileWriter } from "./logFile";

type LogLevel = "debug" | "info" | "warn" | "error";

let writer: LogFileWriter | null = null;

export function setLogFileWriter(w: LogFileWriter | null): void {
  writer = w;
}

function serializeError(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const original = this[key];
  if (!(original instanceof Error)) return value;
  const error = original as Error & { code?: unknown; status?: unknown };
  const isJsonPrimitive = (property: unknown): property is string | number | boolean | null =>
    property === null ||
    typeof property === "string" ||
    typeof property === "number" ||
    typeof property === "boolean";
  return {
    name: error.name,
    message: error.message,
    ...(isJsonPrimitive(error.code) ? { code: error.code } : {}),
    ...(isJsonPrimitive(error.status) ? { status: error.status } : {}),
  };
}

function log(level: LogLevel, message: string, meta?: unknown): void {
  const timestamp = new Date().toISOString();
  const serialized = meta ? ` ${JSON.stringify(meta, serializeError)}` : "";
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${serialized}`;
  console[level](line);
  writer?.write(line);
}

export const logger = {
  debug: (message: string, meta?: unknown) => log("debug", message, meta),
  info: (message: string, meta?: unknown) => log("info", message, meta),
  warn: (message: string, meta?: unknown) => log("warn", message, meta),
  error: (message: string, meta?: unknown) => log("error", message, meta),
};
