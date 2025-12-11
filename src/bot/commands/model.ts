import { SlashCommandBuilder } from "discord.js";

export const modelCommand = new SlashCommandBuilder()
  .setName("disqord-model")
  .setDescription("Manage DisQord model settings")
  .addSubcommand((sub) =>
    sub.setName("current").setDescription("Show the current default model for this guild"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Update the default model for this guild")
      .addStringOption((option) =>
        option
          .setName("model")
          .setDescription("Model identifier as provided by OpenRouter")
          .setRequired(true),
      ),
  );
