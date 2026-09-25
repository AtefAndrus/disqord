import { SlashCommandBuilder } from "discord.js";

export const releaseNoteCommand = new SlashCommandBuilder()
  .setName("release-note")
  .setDescription("リリースノート（変更点）を表示")
  .addStringOption((option) =>
    option
      .setName("version")
      .setDescription("版（例: 1.7.0）。省略時は動いている版")
      .setRequired(false)
      .setAutocomplete(true),
  );
