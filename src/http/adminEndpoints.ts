import type { LogFileWriter, LogLevel } from "../utils/logFile";
import { metrics } from "../utils/metrics";
import { verifyAdminRequest } from "./adminAuth";

const VALID_LEVELS: ReadonlySet<LogLevel> = new Set(["debug", "info", "warn", "error"]);
const DEFAULT_LINES = 200;
const MAX_LINES = 10_000;

export interface AdminHandlersOptions {
  adminApiSecret?: string;
  logFileWriter?: LogFileWriter;
}

export interface AdminHandlers {
  handleAdminMetrics(req: Request): Promise<Response>;
  handleAdminLogs(req: Request): Promise<Response>;
}

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: { Allow: "GET", "Content-Type": "application/json" },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createAdminHandlers(options: AdminHandlersOptions): AdminHandlers {
  const { adminApiSecret, logFileWriter } = options;

  async function authenticate(req: Request): Promise<Response | null> {
    const result = await verifyAdminRequest(req, adminApiSecret);
    if (result.ok) return null;
    return jsonError(result.status, result.reason);
  }

  return {
    async handleAdminMetrics(req) {
      if (req.method !== "GET") return methodNotAllowed();
      const authErr = await authenticate(req);
      if (authErr) return authErr;
      const snapshot = metrics.snapshot();
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },

    async handleAdminLogs(req) {
      if (req.method !== "GET") return methodNotAllowed();
      const authErr = await authenticate(req);
      if (authErr) return authErr;

      const url = new URL(req.url);

      let level: LogLevel | undefined;
      const levelRaw = url.searchParams.get("level");
      if (levelRaw !== null) {
        if (!VALID_LEVELS.has(levelRaw as LogLevel)) {
          return jsonError(400, "Invalid level");
        }
        level = levelRaw as LogLevel;
      }

      let lines = DEFAULT_LINES;
      const linesRaw = url.searchParams.get("lines");
      if (linesRaw !== null) {
        const n = Number(linesRaw);
        if (!Number.isInteger(n) || n < 1 || n > MAX_LINES) {
          return jsonError(400, "Invalid lines");
        }
        lines = n;
      }

      let since: Date | undefined;
      const sinceRaw = url.searchParams.get("since");
      if (sinceRaw !== null) {
        const ms = Date.parse(sinceRaw);
        if (Number.isNaN(ms)) {
          return jsonError(400, "Invalid since");
        }
        since = new Date(ms);
      }

      const recent = logFileWriter ? logFileWriter.getRecent({ level, lines, since }) : [];
      const body = recent.length > 0 ? `${recent.join("\n")}\n` : "";
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    },
  };
}
