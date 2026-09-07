import { ActivityType, Client, GatewayIntentBits } from "discord.js";
import packageJson from "../../package.json";

export async function createBotClient(): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    // ClientUser#setActivity では IDENTIFY 時の presence が更新されないため、
    // 再セッション後に表示が消える。ClientOptions 側に持たせて毎回の IDENTIFY に載せる。
    presence: {
      activities: [{ name: `v${packageJson.version}`, type: ActivityType.Playing }],
    },
  });

  // TODO: wire up events and command registration
  return client;
}
