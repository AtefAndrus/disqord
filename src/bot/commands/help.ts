import { SlashCommandBuilder } from "discord.js";

export const helpCommand = new SlashCommandBuilder()
  .setName("disqord")
  .setDescription("DisQord helper commands")
  .addSubcommand((sub) => sub.setName("help").setDescription("Show DisQord usage guidance"));
