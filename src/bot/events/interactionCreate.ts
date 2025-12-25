import type { ChatInputCommandInteraction, Interaction } from "discord.js";
import { logger } from "../../utils/logger";

export interface CommandHandlers {
  help: (interaction: ChatInputCommandInteraction) => Promise<void>;
  modelCurrent: (interaction: ChatInputCommandInteraction) => Promise<void>;
  modelSet: (interaction: ChatInputCommandInteraction) => Promise<void>;
  modelList: (interaction: ChatInputCommandInteraction) => Promise<void>;
  modelRefresh: (interaction: ChatInputCommandInteraction) => Promise<void>;
  status: (interaction: ChatInputCommandInteraction) => Promise<void>;
  configFreeOnly: (interaction: ChatInputCommandInteraction) => Promise<void>;
  configReleaseChannel: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export function createInteractionCreateHandler(handlers: CommandHandlers) {
  return async function onInteractionCreate(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      const { commandName } = interaction;

      if (commandName !== "disqord") {
        logger.warn("Unknown command", { commandName });
        return;
      }

      const subcommandGroup = interaction.options.getSubcommandGroup(false);
      const subcommand = interaction.options.getSubcommand();

      if (subcommandGroup === "model") {
        switch (subcommand) {
          case "current":
            await handlers.modelCurrent(interaction);
            break;
          case "set":
            await handlers.modelSet(interaction);
            break;
          case "list":
            await handlers.modelList(interaction);
            break;
          case "refresh":
            await handlers.modelRefresh(interaction);
            break;
        }
      } else if (subcommandGroup === "config") {
        switch (subcommand) {
          case "free-only":
            await handlers.configFreeOnly(interaction);
            break;
          case "release-channel":
            await handlers.configReleaseChannel(interaction);
            break;
        }
      } else {
        switch (subcommand) {
          case "help":
            await handlers.help(interaction);
            break;
          case "status":
            await handlers.status(interaction);
            break;
        }
      }
    } catch (error) {
      logger.error("Command execution failed", { error });
      try {
        const reply =
          interaction.replied || interaction.deferred
            ? interaction.followUp.bind(interaction)
            : interaction.reply.bind(interaction);
        await reply("コマンドの実行中にエラーが発生しました。");
      } catch (replyError) {
        logger.error("Failed to send error message", { replyError });
      }
    }
  };
}
