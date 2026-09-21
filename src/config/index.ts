import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { envVarDefinitions } from "./envVars";

function envDefault(name: string): string {
  const def = envVarDefinitions.find((v) => v.name === name)?.default;
  if (!def) {
    throw new Error(`Default value for ${name} not found in envVarDefinitions`);
  }
  return def;
}

export function normalizeFxtwitterApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FXTWITTER_API_BASE must be a valid URL");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    /[?#]/u.test(value)
  ) {
    throw new Error("FXTWITTER_API_BASE must use http(s) without query, fragment, or userinfo");
  }

  const pathname = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${pathname}`;
}

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
  defaultModel: z.string().min(1),
  healthPort: z.coerce.number().int().min(1).max(65535).default(3000),
  adminApiSecret: z.string().optional(),
  logDir: z.string().optional(),
  logMaxBytes: z.coerce.number().int().min(1024).default(10_485_760),
  // The values of OpenRouter's WebSearchEngineEnum. A typo fails at startup
  // instead of as an HTTP 400 on every search-enabled reply.
  webSearchEngine: z.enum(["perplexity", "exa", "parallel", "native", "auto", "firecrawl"]),
  fxtwitterApiBase: z.string().transform((value, ctx) => {
    try {
      return normalizeFxtwitterApiBase(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid FXTWITTER_API_BASE",
      });
      return z.NEVER;
    }
  }),
  e2eTesterBotId: z.string().regex(/^\d+$/).optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(): AppConfig {
  const parsed = configSchema.parse({
    discordToken: process.env.DISCORD_TOKEN,
    openRouterApiKey: process.env.OPENROUTER_API_KEY,
    nodeEnv: process.env.NODE_ENV ?? "development",
    databasePath: process.env.DATABASE_PATH ?? "data/disqord.db",
    applicationId: process.env.DISCORD_APPLICATION_ID,
    defaultModel: process.env.DEFAULT_MODEL ?? envDefault("DEFAULT_MODEL"),
    healthPort: process.env.HEALTH_PORT,
    adminApiSecret: process.env.ADMIN_API_SECRET,
    logDir: process.env.LOG_DIR,
    logMaxBytes: process.env.LOG_MAX_BYTES,
    webSearchEngine: process.env.WEB_SEARCH_ENGINE || envDefault("WEB_SEARCH_ENGINE"),
    fxtwitterApiBase: process.env.FXTWITTER_API_BASE || envDefault("FXTWITTER_API_BASE"),
    // Dropped before validation rather than checked by each reader: a
    // production bot must never answer another bot, and a malformed value of
    // a setting production ignores must not stop it from starting either.
    e2eTesterBotId:
      process.env.NODE_ENV === "production"
        ? undefined
        : process.env.E2E_TESTER_BOT_ID || undefined,
  });

  return parsed;
}
