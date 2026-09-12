import type { Client } from "discord.js";
import { createAdminHandlers } from "./http/adminEndpoints";
import type { LogFileWriter } from "./utils/logFile";
import { logger } from "./utils/logger";

export interface HealthStatus {
  status: "ok" | "unhealthy";
  discord: {
    connected: boolean;
    ping: number | null;
  };
  uptime: number;
}

export interface HttpServerOptions {
  client: Client;
  port: number;
  adminApiSecret?: string;
  logFileWriter?: LogFileWriter;
}

export function startHttpServer(options: HttpServerOptions): ReturnType<typeof Bun.serve> {
  const { client, port, adminApiSecret, logFileWriter } = options;
  const startTime = Date.now();

  const adminHandlers = createAdminHandlers({ adminApiSecret, logFileWriter });

  const server = Bun.serve({
    port,
    routes: {
      "/admin/metrics": (req) => adminHandlers.handleAdminMetrics(req),
      "/admin/logs": (req) => adminHandlers.handleAdminLogs(req),
    },
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        const isConnected = client.isReady();
        const ping = client.ws.ping;

        const healthStatus: HealthStatus = {
          status: isConnected ? "ok" : "unhealthy",
          discord: {
            connected: isConnected,
            ping: ping >= 0 ? ping : null,
          },
          uptime: Math.floor((Date.now() - startTime) / 1000),
        };

        return new Response(JSON.stringify(healthStatus), {
          status: isConnected ? 200 : 503,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  logger.info("HTTP server started", { port });
  return server;
}

/**
 * @deprecated Use startHttpServer instead
 */
export function startHealthServer(client: Client, port: number): ReturnType<typeof Bun.serve> {
  return startHttpServer({ client, port });
}
