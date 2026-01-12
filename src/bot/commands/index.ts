import { REST, Routes } from "discord.js";
import { configCommand } from "./config";
import { helpCommand } from "./help";
import { modelCommand } from "./model";
import { statusCommand } from "./status";

export const commandDefinitions = [helpCommand, statusCommand, modelCommand, configCommand];

export async function registerCommands(applicationId: string, token: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  const commands = commandDefinitions.map((command) => command.toJSON());

  await rest.put(Routes.applicationCommands(applicationId), { body: commands });
}
