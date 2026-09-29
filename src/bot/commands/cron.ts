import { SlashCommandBuilder } from "discord.js";

export const cronCommand = new SlashCommandBuilder()
  .setName("cron")
  .setDescription("定期実行のパネルを開く");
