import { Events } from "discord.js";
import packageJson from "../package.json";
import { createBotClient } from "./bot/client";
import { registerCommands } from "./bot/commands";
import { createCommandHandlers } from "./bot/commands/handlers";
import { createInteractionCreateHandler } from "./bot/events/interactionCreate";
import { createMessageCreateHandler } from "./bot/events/messageCreate";
import { createRawEventHandler } from "./bot/events/raw";
import { onReady } from "./bot/events/ready";
import { loadConfig } from "./config";
import { getDatabase } from "./db";
import { ConversationRepository, DeletedBeforeSaveRecord } from "./db/repositories/conversation";
import { GuildSettingsRepository } from "./db/repositories/guildSettings";
import { startHttpServer } from "./health";
import { OpenRouterClient } from "./llm/openrouter";
import { ToolRegistry } from "./llm/tools/registry";
import { ChatService } from "./services/chatService";
import { ModelService } from "./services/modelService";
import { SettingsService } from "./services/settingsService";
import { TweetService } from "./services/tweetService";
import { createLogFileWriter } from "./utils/logFile";
import { logger, setLogFileWriter } from "./utils/logger";
import { metrics } from "./utils/metrics";

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  const logFileWriter = createLogFileWriter({
    dir: config.logDir,
    maxBytes: config.logMaxBytes,
    env: config.nodeEnv,
  });
  setLogFileWriter(logFileWriter);
  metrics.attach({
    databasePath: config.databasePath,
    logFileWriter,
  });

  logger.info("Configuration loaded", { nodeEnv: config.nodeEnv });

  const db = getDatabase();
  logger.info("Database initialized");

  const guildSettingsRepo = new GuildSettingsRepository(db, config.defaultModel);
  const deletedBeforeSave = new DeletedBeforeSaveRecord();
  const conversationRepository = new ConversationRepository(db, deletedBeforeSave);
  await conversationRepository.failPendingTurns();
  await conversationRepository.sweepExpired();

  const llmClient = OpenRouterClient.fromConfig(config);
  const settingsService = new SettingsService(guildSettingsRepo);
  const modelService = new ModelService(llmClient);
  const tweetService = new TweetService(config.fxtwitterApiBase, packageJson.version);
  // Empty for now — tool-calling-foundation Phase 4 wires the registry into
  // ChatService/runToolLoop; future changes (code-execution, discord-tool,
  // web-search, ...) register their tools here.
  const toolRegistry = new ToolRegistry();
  const chatService = new ChatService(
    llmClient,
    settingsService,
    toolRegistry,
    config.webSearchEngine,
    tweetService,
    modelService,
  );

  const commandHandlers = createCommandHandlers(
    llmClient,
    settingsService,
    modelService,
    config.webSearchEngine,
    config.fxtwitterApiBase,
  );

  const messageCreateHandler = createMessageCreateHandler(
    chatService,
    settingsService,
    modelService,
    {
      e2eTesterBotId: config.e2eTesterBotId,
      webSearchEngine: config.webSearchEngine,
      conversationRepository,
    },
  );
  const interactionCreateHandler = createInteractionCreateHandler(
    commandHandlers,
    settingsService,
    modelService,
    llmClient,
    chatService,
    config.webSearchEngine,
    config.fxtwitterApiBase,
  );

  const client = await createBotClient();
  const rawEventHandler = createRawEventHandler(conversationRepository, deletedBeforeSave);
  client.once(Events.ClientReady, () => onReady(client));
  client.on("messageCreate", messageCreateHandler);
  client.on("interactionCreate", interactionCreateHandler);
  client.on(Events.Raw, (packet) => {
    void rawEventHandler(packet).catch(() => {
      console.error("Failed to handle raw Discord event");
    });
  });

  metrics.attach({ client });

  await registerCommands(config.applicationId, config.discordToken);
  logger.info("Slash commands registered");

  await client.login(config.discordToken);
  logger.info("Bot logged in");

  const httpServer = startHttpServer({
    client,
    port: config.healthPort,
    adminApiSecret: config.adminApiSecret,
    logFileWriter,
  });
  const ttlTimer = setInterval(
    () => {
      void conversationRepository.sweepExpired();
    },
    24 * 60 * 60 * 1000,
  );
  ttlTimer.unref();

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    clearInterval(ttlTimer);
    httpServer.stop();
    client.destroy();
    db.close();
    logFileWriter.flush();
    logFileWriter.close();
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
