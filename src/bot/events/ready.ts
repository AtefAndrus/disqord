import { Client } from "discord.js";

export function onReady(client: Client) {
  console.info(`DisQord logged in as ${client.user?.tag ?? "unknown user"}`);
}
