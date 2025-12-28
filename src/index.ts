import { Events } from "discord.js";
import { createBotClient } from "./bot/client";
import { registerCommands } from "./bot/commands";
import { createCommandHandlers } from "./bot/commands/handlers";
import { createInteractionCreateHandler } from "./bot/events/interactionCreate";
import { createMessageCreateHandler } from "./bot/events/messageCreate";
import { onReady } from "./bot/events/ready";
import { loadConfig } from "./config";
import { getDatabase } from "./db";
import { GuildSettingsRepository } from "./db/repositories/guildSettings";
import { startHttpServer } from "./health";
import { OpenRouterClient } from "./llm/openrouter";
import { ChatService } from "./services/chatService";
import { ModelService } from "./services/modelService";
import { ReleaseNotificationService } from "./services/releaseNotificationService";
import { SettingsService } from "./services/settingsService";
import { logger } from "./utils/logger";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  logger.info("Configuration loaded", { nodeEnv: config.nodeEnv });

  const db = getDatabase();
  logger.info("Database initialized");

  const guildSettingsRepo = new GuildSettingsRepository(db, config.defaultModel);

  const llmClient = OpenRouterClient.fromConfig(config);
  const settingsService = new SettingsService(guildSettingsRepo, config.defaultModel);
  const modelService = new ModelService(llmClient);
  const chatService = new ChatService(llmClient, settingsService);

  const commandHandlers = createCommandHandlers(llmClient, settingsService, modelService);

  const messageCreateHandler = createMessageCreateHandler(
    chatService,
    settingsService,
    modelService,
  );
  const interactionCreateHandler = createInteractionCreateHandler(
    commandHandlers,
    settingsService,
    modelService,
  );

  const client = await createBotClient();
  client.once(Events.ClientReady, () => onReady(client));
  client.on("messageCreate", messageCreateHandler);
  client.on("interactionCreate", interactionCreateHandler);

  await registerCommands(config.applicationId, config.discordToken);
  logger.info("Slash commands registered");

  await client.login(config.discordToken);
  logger.info("Bot logged in");

  const releaseNotificationService = new ReleaseNotificationService(client, settingsService);

  const httpServer = startHttpServer({
    client,
    port: config.healthPort,
    githubWebhookSecret: config.githubWebhookSecret,
    releaseNotificationService,
  });

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    httpServer.stop();
    client.destroy();
    db.close();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason: unknown) => {
    logger.error("Unhandled rejection", { reason });
  });

  process.on("uncaughtException", (error: Error) => {
    logger.error("Uncaught exception, shutting down", { error });
    shutdown("uncaughtException");
  });
}

bootstrap().catch((error) => {
  logger.error("DisQord failed to start", { error });
  process.exitCode = 1;
});
