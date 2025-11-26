import { Client, GatewayIntentBits } from "discord.js";

export async function createBotClient(): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // TODO: wire up events and command registration
  return client;
}
