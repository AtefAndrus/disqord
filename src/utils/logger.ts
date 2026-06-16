import type { LogFileWriter } from "./logFile";

type LogLevel = "debug" | "info" | "warn" | "error";

let writer: LogFileWriter | null = null;

export function setLogFileWriter(w: LogFileWriter | null): void {
  writer = w;
}

function log(level: LogLevel, message: string, meta?: unknown) {
  const timestamp = new Date().toISOString();
  const serialized = meta ? ` ${JSON.stringify(meta)}` : "";
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
