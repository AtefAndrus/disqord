import { createBotClient } from "./bot/client";

async function bootstrap() {
  const client = await createBotClient();
  if (!process.env.DISCORD_TOKEN) {
    throw new Error("DISCORD_TOKEN is not set");
  }

  await client.login(process.env.DISCORD_TOKEN);
}

bootstrap().catch((error) => {
  console.error("DisQord failed to start", error);
  process.exitCode = 1;
});
