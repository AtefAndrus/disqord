import { SlashCommandBuilder } from "discord.js";

export const statusCommand = new SlashCommandBuilder()
  .setName("status")
  .setDescription("Botのステータス（OpenRouter残高等）を表示");
