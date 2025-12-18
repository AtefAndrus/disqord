import { REST, Routes } from "discord.js";
import { disqordCommand } from "./disqord";

export const commandDefinitions = [disqordCommand];

export async function registerCommands(applicationId: string, token: string) {
  const rest = new REST({ version: "10" }).setToken(token);
  const commands = commandDefinitions.map((command) => command.toJSON());

  await rest.put(Routes.applicationCommands(applicationId), { body: commands });
}
