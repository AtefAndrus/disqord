import type { Client } from "discord.js";
import { logger } from "./utils/logger";

export interface HealthStatus {
  status: "ok" | "unhealthy";
  discord: {
    connected: boolean;
    ping: number | null;
  };
  uptime: number;
}

export function startHealthServer(client: Client, port: number): ReturnType<typeof Bun.serve> {
  const startTime = Date.now();

  const server = Bun.serve({
    port,
    fetch(req) {
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

  logger.info("Health server started", { port });
  return server;
}
