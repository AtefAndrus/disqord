import { Events } from "discord.js";
import packageJson from "../package.json";
import { createBotClient } from "./bot/client";
import { registerCommands } from "./bot/commands";
import { createCommandHandlers } from "./bot/commands/handlers";
import { createInteractionCreateHandler } from "./bot/events/interactionCreate";
import { createMessageCreateHandler } from "./bot/events/messageCreate";
import { onReady } from "./bot/events/ready";
import { loadConfig } from "./config";
import { getDatabase } from "./db";
import { GuildSettingsRepository } from "./db/repositories/guildSettings";
import { ReplyRecordRepository } from "./db/repositories/replyRecord";
import { startHttpServer } from "./health";
import { OpenRouterClient } from "./llm/openrouter";
import { createReadEarlierMessagesTool } from "./llm/tools/readEarlierMessages";
import { ToolRegistry } from "./llm/tools/registry";
import { createViewAttachmentTool } from "./llm/tools/viewAttachment";
import { ChatService } from "./services/chatService";
import { ConversationWindowService } from "./services/conversationWindow";
import { DiscordMessageReader, type DiscordRestClient } from "./services/discordMessageReader";
import { ModelService } from "./services/modelService";
import { createReplyRecordCleanupRunner, ReplyRecordService } from "./services/replyRecordService";
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
  const replyRecordRepository = new ReplyRecordRepository(db);
  const replyRecordService = new ReplyRecordService(replyRecordRepository);
  await replyRecordService.markPendingFailed();
  await replyRecordService.cleanupExpired();

  const llmClient = OpenRouterClient.fromConfig(config);
  const settingsService = new SettingsService(guildSettingsRepo);
  const modelService = new ModelService(llmClient);
  const tweetService = new TweetService(config.fxtwitterApiBase, packageJson.version);
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createReadEarlierMessagesTool());
  toolRegistry.register(createViewAttachmentTool());
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
  );

  const client = await createBotClient();
  const messageReader = new DiscordMessageReader({
    get: (route, options) => {
      const query = options?.query
        ? new URLSearchParams(
            Object.entries(options.query).map(([key, value]) => [key, String(value)]),
          )
        : undefined;
      return client.rest.get(route as `/${string}`, {
        ...(query && { query }),
        ...(options?.signal && { signal: options.signal }),
      });
    },
  } satisfies DiscordRestClient);
  const conversationWindow = new ConversationWindowService(
    messageReader,
    replyRecordRepository,
    () => Date.now(),
    async (model) => (await modelService.isMultimodalCapable(model, "image")) === true,
  );

  const messageCreateHandler = createMessageCreateHandler(
    chatService,
    settingsService,
    modelService,
    {
      e2eTesterBotId: config.e2eTesterBotId,
      webSearchEngine: config.webSearchEngine,
      conversationWindow,
      replyRecordService,
    },
  );
  const interactionCreateHandler = createInteractionCreateHandler(
    commandHandlers,
    settingsService,
    modelService,
    llmClient,
    chatService,
    config.webSearchEngine,
  );

  client.once(Events.ClientReady, () => onReady(client));
  client.on("messageCreate", messageCreateHandler);
  client.on("interactionCreate", interactionCreateHandler);

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
  const ttlSweepRunner = createReplyRecordCleanupRunner(
    replyRecordService,
    setInterval,
    clearInterval,
    () => conversationWindow.sweepStaleChannels(),
  );

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    ttlSweepRunner.cancel();
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
