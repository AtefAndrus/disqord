import type { LogFileWriter } from "./logFile";

type LogLevel = "debug" | "info" | "warn" | "error";

let writer: LogFileWriter | null = null;

export function setLogFileWriter(w: LogFileWriter | null): void {
  writer = w;
}

function serializeError(_key: string, value: unknown): unknown {
  if (!(value instanceof Error)) return value;
  const error = value as Error & { code?: unknown; status?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof error.code === "string" || typeof error.code === "number"
      ? { code: error.code }
      : {}),
    ...(typeof error.status === "string" || typeof error.status === "number"
      ? { status: error.status }
      : {}),
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
