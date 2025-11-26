import { SlashCommandBuilder } from "discord.js";

export const statusCommand = new SlashCommandBuilder()
  .setName("disqord-status")
  .setDescription("Display bot health information, such as OpenRouter credits");
