import type { Interaction } from "discord.js";

export async function onInteractionCreate(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  // TODO: route to command handlers once implemented
}
