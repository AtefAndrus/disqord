import { SlashCommandBuilder } from "discord.js";

export const configCommand = new SlashCommandBuilder()
  .setName("config")
  .setDescription("設定パネルを開く");
