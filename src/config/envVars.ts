export interface EnvVarDefinition {
  name: string;
  required: boolean;
  description: string;
  default?: string;
}

export const envVarDefinitions: EnvVarDefinition[] = [
  { name: "DISCORD_TOKEN", required: true, description: "Discord Bot Token" },
  { name: "DISCORD_APPLICATION_ID", required: true, description: "Discord Application ID" },
  { name: "OPENROUTER_API_KEY", required: true, description: "OpenRouter API Key" },
  {
    name: "DATABASE_PATH",
    required: false,
    description: "SQLiteパス",
    default: "data/disqord.db",
  },
  {
    name: "DEFAULT_MODEL",
    required: false,
    description: "デフォルトモデル",
    default: "deepseek/deepseek-r1-0528:free",
  },
  {
    name: "HEALTH_PORT",
    required: false,
    description: "ヘルスチェック用HTTPポート",
    default: "3000",
  },
  {
    name: "GITHUB_WEBHOOK_SECRET",
    required: false,
    description: "GitHub Webhook署名検証用（リリース通知使用時は必須）",
  },
];
