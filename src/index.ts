import { Events, PermissionFlagsBits } from "discord.js";
import packageJson from "../package.json";
import { createBotClient } from "./bot/client";
import { registerCommands } from "./bot/commands";
import { createCommandHandlers } from "./bot/commands/handlers";
import { createInteractionCreateHandler } from "./bot/events/interactionCreate";
import { createMessageCreateHandler } from "./bot/events/messageCreate";
import { onReady } from "./bot/events/ready";
import { createReplyRecordCleanupHandlers } from "./bot/events/replyRecordCleanup";
import { loadConfig } from "./config";
import { getDatabase } from "./db";
import { BotStateRepository } from "./db/repositories/botState";
import { CronRepository } from "./db/repositories/cronRepository";
import { GuildSettingsRepository } from "./db/repositories/guildSettings";
import { ReplyRecordRepository } from "./db/repositories/replyRecord";
import { startHttpServer } from "./health";
import { OpenRouterClient } from "./llm/openrouter";
import { createAddReactionTool } from "./llm/tools/discord/addReaction";
import { createCreatePollTool } from "./llm/tools/discord/createPoll";
import { createCreateThreadTool } from "./llm/tools/discord/createThread";
import { createGetChannelInfoTool } from "./llm/tools/discord/getChannelInfo";
import { createListEventsTool } from "./llm/tools/discord/listEvents";
import { createListPinsTool } from "./llm/tools/discord/listPins";
import { createPinMessageTool } from "./llm/tools/discord/pinMessage";
import { createProposeCronJobTool } from "./llm/tools/proposeCronJob";
import { createReadEarlierMessagesTool } from "./llm/tools/readEarlierMessages";
import { ToolRegistry } from "./llm/tools/registry";
import { createViewAttachmentTool } from "./llm/tools/viewAttachment";
import { ChatService } from "./services/chatService";
import { ConversationWindowService, WINDOW_REBUILD_AFTER_MS } from "./services/conversationWindow";
import { CronService, startCronService } from "./services/cronService";
import { DiscordMessageReader, type DiscordRestClient } from "./services/discordMessageReader";
import { ModelService } from "./services/modelService";
import {
  createReleaseSender,
  ReleaseAnnouncer,
  resolveMessageChannel,
} from "./services/releaseAnnouncer";
import { loadReleaseNotes } from "./services/releaseNotes";
import { ReplyRecordService } from "./services/replyRecordService";
import { SettingsService } from "./services/settingsService";
import { TweetService } from "./services/tweetService";
import { createInFlightTracker } from "./utils/inFlight";
import { createLogFileWriter } from "./utils/logFile";
import { logger, setLogFileWriter } from "./utils/logger";
import { metrics } from "./utils/metrics";

// Fit below Coolify's default 30s stop grace period and docker stop's default 10s.
const CHAT_SHUTDOWN_TIMEOUT_MS = 8_000;

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
  const cronRepository = new CronRepository(db);
  const replyRecordRepository = new ReplyRecordRepository(db);
  const replyRecordService = new ReplyRecordService(replyRecordRepository);
  await replyRecordService.markPendingFailed();

  const llmClient = OpenRouterClient.fromConfig(config);
  const settingsService = new SettingsService(guildSettingsRepo);
  const modelService = new ModelService(llmClient);
  const tweetService = new TweetService(config.fxtwitterApiBase, packageJson.version);
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createReadEarlierMessagesTool());
  toolRegistry.register(createViewAttachmentTool());
  toolRegistry.register(createAddReactionTool());
  toolRegistry.register(createCreatePollTool());
  toolRegistry.register(createCreateThreadTool());
  toolRegistry.register(createPinMessageTool());
  toolRegistry.register(createListPinsTool());
  toolRegistry.register(createGetChannelInfoTool());
  toolRegistry.register(createListEventsTool());
  toolRegistry.register(createProposeCronJobTool());
  const chatService = new ChatService(
    llmClient,
    settingsService,
    toolRegistry,
    config.webSearchEngine,
    tweetService,
    modelService,
  );

  const releaseNotes = await loadReleaseNotes();
  const commandHandlers = createCommandHandlers(
    llmClient,
    settingsService,
    modelService,
    config.webSearchEngine,
    (guildId) => cronRepository.countJobs(guildId),
    releaseNotes,
  );

  const client = await createBotClient();
  const cronService = new CronService(cronRepository, settingsService, chatService, {
    resolve: async (guildId, channelId, userId) => {
      const guild = await client.guilds.fetch(guildId);
      const channel = await resolveMessageChannel(guild, channelId, true);
      if (userId) {
        const member = await guild.members.fetch({ user: userId, force: true, cache: false });
        if (!channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel))
          throw new Error("提案者が配信先を閲覧できません。");
      }
      return {
        parentId: channel.isThread() ? channel.parentId : null,
        send: async (payload) => {
          await channel.send(payload);
        },
        notifyPaused: async (recipientId, name) => {
          await channel.send({
            content: `<@${recipientId}> 定期実行「${name}」は 3 回連続で失敗したため停止しました。`,
            allowedMentions: { users: [recipientId], parse: [] },
          });
        },
      };
    },
  });
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
      cronService,
    },
  );
  const interactionCreateHandler = createInteractionCreateHandler(
    commandHandlers,
    settingsService,
    modelService,
    llmClient,
    chatService,
    config.webSearchEngine,
    cronService,
  );

  const releaseAnnouncer = new ReleaseAnnouncer(
    new BotStateRepository(db),
    settingsService,
    () => client.guilds.cache.keys(),
    createReleaseSender(client),
  );
  const replyRecordCleanup = createReplyRecordCleanupHandlers(replyRecordService, cronRepository);
  client.once(Events.ClientReady, () => {
    onReady(client);
    void startCronService(cronService, () =>
      replyRecordCleanup.reconcileGuilds(client.guilds.cache.keys()),
    );
    void releaseAnnouncer.announce(packageJson.version, releaseNotes);
  });
  client.on(Events.GuildDelete, (guild) => void replyRecordCleanup.guildDelete(guild));
  client.on(Events.ChannelDelete, (channel) => void replyRecordCleanup.channelDelete(channel));
  client.on(Events.ThreadDelete, (thread) => void replyRecordCleanup.threadDelete(thread));
  let shuttingDown = false;
  const tracker = createInFlightTracker();
  client.on("messageCreate", (message): void => {
    if (shuttingDown) return;
    // The tracker settles on rejection too, so log here or the error would vanish.
    tracker.track(
      messageCreateHandler(message).catch((error: unknown) => {
        logger.error("messageCreate handler failed", { error });
      }),
    );
  });
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
  const windowSweepTimer = setInterval(
    () => conversationWindow.sweepStaleChannels(),
    WINDOW_REBUILD_AFTER_MS,
  );
  windowSweepTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully...`);
    clearInterval(windowSweepTimer);
    httpServer.stop();
    chatService.cancelAll();
    const [unsettled] = await Promise.all([
      tracker.drain(CHAT_SHUTDOWN_TIMEOUT_MS),
      cronService.stop(),
    ]);
    if (unsettled > 0) logger.warn("Chat handlers still running at shutdown", { count: unsettled });
    client.destroy();
    db.close();
    logFileWriter.flush();
    logFileWriter.close();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason: unknown) => {
    logger.error("Unhandled rejection", { reason });
  });

  process.on("uncaughtException", (error: Error) => {
    logger.error("Uncaught exception, shutting down", { error });
    void shutdown("uncaughtException");
  });
}

bootstrap().catch((error) => {
  logger.error("DisQord failed to start", { error });
  process.exitCode = 1;
});
