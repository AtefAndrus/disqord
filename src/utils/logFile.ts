import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export const LOG_BASENAME = "disqord.log";
export const ROTATION_COUNT = 5;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const LINE_REGEX = /^\[([^\]]+)\]\s+\[([A-Z]+)\]/;

export interface LogFileWriterOptions {
  dir?: string;
  maxBytes?: number;
  env?: string;
}

export interface GetRecentOptions {
  level?: LogLevel;
  lines?: number;
  since?: Date;
}

export interface LogFileWriter {
  write(line: string): void;
  flush(): void;
  close(): void;
  getRecent(options?: GetRecentOptions): string[];
  getLogBytes(): number;
  readonly dir: string | undefined;
}

function noopWriter(dir: string | undefined): LogFileWriter {
  return {
    write: () => {},
    flush: () => {},
    close: () => {},
    getRecent: () => [],
    getLogBytes: () => 0,
    dir,
  };
}

function rotatedPath(dir: string, index: number): string {
  return join(dir, `disqord.${index}.log`);
}

export function createLogFileWriter(options: LogFileWriterOptions = {}): LogFileWriter {
  const { dir, maxBytes = DEFAULT_MAX_BYTES, env = "production" } = options;

  if (!dir) {
    return noopWriter(undefined);
  }
  if (env !== "production") {
    return noopWriter(dir);
  }

  const logDir: string = dir;
  const currentPath = join(logDir, LOG_BASENAME);
  let fd: number | null = null;
  let writtenBytes = 0;
  let broken = false;

  try {
    mkdirSync(logDir, { recursive: true });
    if (existsSync(currentPath)) {
      writtenBytes = statSync(currentPath).size;
    }
    fd = openSync(currentPath, "a");
  } catch (err) {
    console.error("[logFile] Failed to open log file, falling back to no-op", err);
    return noopWriter(logDir);
  }

  function rotate(): void {
    // Phase 1: maintain rotated archive. Failures here are non-fatal — the
    // current file is still appendable, so we keep `fd` open and reset the
    // byte counter to avoid retrying rotation on every subsequent write.
    try {
      const oldest = rotatedPath(logDir, ROTATION_COUNT);
      if (existsSync(oldest)) {
        unlinkSync(oldest);
      }
      for (let i = ROTATION_COUNT - 1; i >= 1; i--) {
        const src = rotatedPath(logDir, i);
        const dst = rotatedPath(logDir, i + 1);
        if (existsSync(src)) {
          renameSync(src, dst);
        }
      }
    } catch (err) {
      console.error("[logFile] Archive rotation failed; current log kept", err);
      writtenBytes = 0;
      return;
    }

    // Phase 2: rotate the current file. Failure here disables future file
    // logging because we cannot guarantee a usable fd from this point on.
    try {
      if (fd !== null) {
        closeSync(fd);
        fd = null;
      }
      if (existsSync(currentPath)) {
        renameSync(currentPath, rotatedPath(logDir, 1));
      }
      fd = openSync(currentPath, "a");
      writtenBytes = 0;
    } catch (err) {
      console.error("[logFile] Current rotation failed, becoming no-op", err);
      broken = true;
      fd = null;
    }
  }

  function write(line: string): void {
    if (broken || fd === null) return;
    try {
      const buffer = Buffer.from(`${line}\n`, "utf-8");
      writeSync(fd, buffer);
      writtenBytes += buffer.length;
      if (writtenBytes >= maxBytes) {
        rotate();
      }
    } catch (err) {
      console.error("[logFile] Write failed, becoming no-op", err);
      broken = true;
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
        fd = null;
      }
    }
  }

  function flush(): void {
    // writeSync is synchronous; nothing to flush.
  }

  function close(): void {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
      fd = null;
    }
  }

  function listFilesOldestFirst(): string[] {
    const out: string[] = [];
    for (let i = ROTATION_COUNT; i >= 1; i--) {
      const p = rotatedPath(logDir, i);
      if (existsSync(p)) out.push(p);
    }
    if (existsSync(currentPath)) out.push(currentPath);
    return out;
  }

  function getRecent(opts: GetRecentOptions = {}): string[] {
    const { level, lines = 200, since } = opts;
    const sinceMs = since ? since.getTime() : null;
    const minRank = level ? LEVEL_RANK[level] : -1;

    const collected: string[] = [];
    for (const file of listFilesOldestFirst()) {
      let content: string;
      try {
        content = readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      for (const ln of content.split("\n")) {
        if (ln.length === 0) continue;
        if (minRank >= 0 || sinceMs !== null) {
          const m = ln.match(LINE_REGEX);
          if (!m) continue;
          if (minRank >= 0) {
            const lvl = m[2].toLowerCase() as LogLevel;
            const rank = LEVEL_RANK[lvl];
            if (rank === undefined || rank < minRank) continue;
          }
          if (sinceMs !== null) {
            const ts = Date.parse(m[1]);
            if (Number.isNaN(ts) || ts < sinceMs) continue;
          }
        }
        collected.push(ln);
      }
    }

    if (lines <= 0) return [];
    return collected.slice(-lines);
  }

  function getLogBytes(): number {
    let total = 0;
    for (const file of listFilesOldestFirst()) {
      try {
        total += statSync(file).size;
      } catch {}
    }
    return total;
  }

  return { write, flush, close, getRecent, getLogBytes, dir: logDir };
}
