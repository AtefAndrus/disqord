import { ActivityType, type Client } from "discord.js";
import packageJson from "../../../package.json";

export function onReady(client: Client) {
  console.info(`DisQord logged in as ${client.user?.tag ?? "unknown user"}`);

  // Botのステータスメッセージにバージョン表示
  client.user?.setActivity(`v${packageJson.version}`, { type: ActivityType.Playing });
}
