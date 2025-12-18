import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Load .env file manually.
 * Bun's automatic .env loading doesn't work reliably with `bun run` commands.
 * See: https://github.com/oven-sh/bun/issues/23962
 */
function loadEnvFile(): void {
  const envFiles = [".env.local", ".env"];

  for (const envFile of envFiles) {
    if (!existsSync(envFile)) continue;

    try {
      const content = readFileSync(envFile, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;

        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();

        // Remove surrounding quotes
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")) ||
          (value.startsWith("`") && value.endsWith("`"))
        ) {
          value = value.slice(1, -1);
        }

        // Don't override existing non-empty env vars
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    } catch {
      // File can't be read, skip silently
    }
  }
}

// Load .env file before config validation
loadEnvFile();

const configSchema = z.object({
  discordToken: z.string().min(1),
  openRouterApiKey: z.string().min(1),
  nodeEnv: z.enum(["development", "production"]).default("development"),
  databasePath: z.string().default("data/disqord.db"),
  applicationId: z.string().min(1),
  defaultModel: z.string().default("deepseek/deepseek-r1-0528:free"),
  healthPort: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(): AppConfig {
  const parsed = configSchema.parse({
    discordToken: process.env.DISCORD_TOKEN,
    openRouterApiKey: process.env.OPENROUTER_API_KEY,
    nodeEnv: process.env.NODE_ENV ?? "development",
    databasePath: process.env.DATABASE_PATH ?? "data/disqord.db",
    applicationId: process.env.DISCORD_APPLICATION_ID,
    defaultModel: process.env.DEFAULT_MODEL,
    healthPort: process.env.HEALTH_PORT,
  });

  return parsed;
}
