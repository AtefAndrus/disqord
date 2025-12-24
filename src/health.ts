import type { Client } from "discord.js";
import { parseReleasePayload, verifyGitHubSignature } from "./http/webhookHandler";
import type { IReleaseNotificationService } from "./services/releaseNotificationService";
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
  githubWebhookSecret?: string;
  releaseNotificationService?: IReleaseNotificationService;
}

export function startHttpServer(options: HttpServerOptions): ReturnType<typeof Bun.serve> {
  const { client, port, githubWebhookSecret, releaseNotificationService } = options;
  const startTime = Date.now();

  const server = Bun.serve({
    port,
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

      if (url.pathname === "/webhook/github" && req.method === "POST") {
        return handleGitHubWebhook(req, githubWebhookSecret, releaseNotificationService);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  logger.info("HTTP server started", { port });
  return server;
}

async function handleGitHubWebhook(
  req: Request,
  secret?: string,
  notificationService?: IReleaseNotificationService,
): Promise<Response> {
  // Check if webhook secret is configured
  if (!secret) {
    logger.warn("GitHub webhook received but secret is not configured");
    return new Response(JSON.stringify({ error: "Webhook not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Get raw body for signature verification
  const rawBody = await req.text();
  const signature = req.headers.get("X-Hub-Signature-256");

  if (!signature) {
    logger.warn("GitHub webhook missing signature header");
    return new Response(JSON.stringify({ error: "Missing signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Verify signature
  const isValid = await verifyGitHubSignature(rawBody, signature, secret);
  if (!isValid) {
    logger.warn("GitHub webhook signature verification failed");
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Check event type
  const eventType = req.headers.get("X-GitHub-Event");
  if (eventType !== "release") {
    logger.info("Ignoring non-release GitHub event", { eventType });
    return new Response(JSON.stringify({ message: "Event ignored" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Parse payload
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const payload = parseReleasePayload(body);
  if (!payload) {
    return new Response(JSON.stringify({ error: "Invalid payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Process notification
  if (!notificationService) {
    logger.warn("Release notification service not configured");
    return new Response(JSON.stringify({ error: "Notification service not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  logger.info("Processing GitHub release webhook", {
    action: payload.action,
    tag: payload.release.tag_name,
    repository: payload.repository.full_name,
  });

  const result = await notificationService.notify(payload);

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * @deprecated Use startHttpServer instead
 */
export function startHealthServer(client: Client, port: number): ReturnType<typeof Bun.serve> {
  return startHttpServer({ client, port });
}
