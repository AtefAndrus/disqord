import { SlashCommandBuilder } from "discord.js";

export const modelsCommand = new SlashCommandBuilder()
  .setName("disqord-models")
  .setDescription("List available OpenRouter models for this bot");
