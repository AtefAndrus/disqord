import { SlashCommandBuilder } from "discord.js";

export const disqordCommand = new SlashCommandBuilder()
  .setName("disqord")
  .setDescription("DisQord Bot commands")
  .addSubcommand((sub) => sub.setName("help").setDescription("Show DisQord usage guidance"))
  .addSubcommand((sub) =>
    sub
      .setName("status")
      .setDescription("Display bot health information, such as OpenRouter credits"),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("model")
      .setDescription("Model management commands")
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
      )
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("List available OpenRouter models"),
      )
      .addSubcommand((sub) => sub.setName("refresh").setDescription("Refresh the model cache")),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("config")
      .setDescription("Guild configuration commands")
      .addSubcommand((sub) =>
        sub
          .setName("free-only")
          .setDescription("Restrict to free models only")
          .addStringOption((option) =>
            option
              .setName("enabled")
              .setDescription("Enable or disable free models only restriction")
              .setRequired(true)
              .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }),
          ),
      ),
  );
