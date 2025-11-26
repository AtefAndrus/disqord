import { z } from "zod";

const configSchema = z.object({
  discordToken: z.string().min(1),
  openRouterApiKey: z.string().min(1),
  nodeEnv: z.enum(["development", "production"]).default("development"),
  databasePath: z.string().default("data/disqord.db"),
  applicationId: z.string().min(1),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(): AppConfig {
  const parsed = configSchema.parse({
    discordToken: process.env.DISCORD_TOKEN,
    openRouterApiKey: process.env.OPENROUTER_API_KEY,
    nodeEnv: process.env.NODE_ENV ?? "development",
    databasePath: process.env.DATABASE_PATH ?? "data/disqord.db",
    applicationId: process.env.DISCORD_APPLICATION_ID,
  });

  return parsed;
}
