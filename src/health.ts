import type { Client } from "discord.js";
import packageJson from "../package.json";
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
  /** デプロイ後の確認で、新しい版のプロセスに切り替わったかを見分けるのに使う。 */
  version: string;
  /**
   * HTTP サーバーの起動時刻。DB の初期化と Discord へのログインの後なので、プロセスの起動より遅い。
   * デプロイ後の確認は、これがデプロイ前に読んだ `now` より後のプロセスだけを新しいとみなす。遅い側にずれても誤判定しない。
   */
  startedAt: string;
  /** 応答した時点のサーバーの時刻。デプロイ後の確認が、ランナーの時計を使わずに新旧のプロセスを見分ける基準にする。 */
  now: string;
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
          version: packageJson.version,
          startedAt: new Date(startTime).toISOString(),
          now: new Date().toISOString(),
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
