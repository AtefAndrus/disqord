import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { helpCommand } from "./help";
import { modelCommand } from "./model";
import { modelsCommand } from "./models";
import { statusCommand } from "./status";

export const commandDefinitions: SlashCommandBuilder[] = [
  helpCommand,
  modelCommand,
  modelsCommand,
  statusCommand,
];

export async function registerCommands(applicationId: string, token: string) {
  const rest = new REST({ version: "10" }).setToken(token);
  const commands = commandDefinitions.map((command) => command.toJSON());

  await rest.put(Routes.applicationCommands(applicationId), { body: commands });
}
