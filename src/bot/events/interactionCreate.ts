import type { ChatInputCommandInteraction, Interaction } from "discord.js";
import { logger } from "../../utils/logger";

export interface CommandHandlers {
  help: (interaction: ChatInputCommandInteraction) => Promise<void>;
  modelCurrent: (interaction: ChatInputCommandInteraction) => Promise<void>;
  modelSet: (interaction: ChatInputCommandInteraction) => Promise<void>;
  models: (interaction: ChatInputCommandInteraction) => Promise<void>;
  status: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export function createInteractionCreateHandler(handlers: CommandHandlers) {
  return async function onInteractionCreate(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      const { commandName } = interaction;

      switch (commandName) {
        case "disqord": {
          const subcommand = interaction.options.getSubcommand();
          if (subcommand === "help") {
            await handlers.help(interaction);
          }
          break;
        }
        case "disqord-model": {
          const subcommand = interaction.options.getSubcommand();
          if (subcommand === "current") {
            await handlers.modelCurrent(interaction);
          } else if (subcommand === "set") {
            await handlers.modelSet(interaction);
          }
          break;
        }
        case "disqord-models":
          await handlers.models(interaction);
          break;
        case "disqord-status":
          await handlers.status(interaction);
          break;
        default:
          logger.warn("Unknown command", { commandName });
      }
    } catch (error) {
      logger.error("Command execution failed", { error });
      const reply =
        interaction.replied || interaction.deferred
          ? interaction.followUp.bind(interaction)
          : interaction.reply.bind(interaction);
      await reply("コマンドの実行中にエラーが発生しました。");
    }
  };
}
