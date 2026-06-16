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
    name: "NODE_ENV",
    required: false,
    description: "アプリ動作モード（development または production）",
    default: "development",
  },
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
    default: "deepseek/deepseek-v4-flash:free",
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
  {
    name: "ADMIN_API_SECRET",
    required: false,
    description: "管理API HMAC署名検証用シークレット（未設定時は /admin/* が 503）",
  },
  {
    name: "LOG_DIR",
    required: false,
    description: "ログファイル保存ディレクトリ（本番のみ書込み、未設定でno-op）",
  },
  {
    name: "LOG_MAX_BYTES",
    required: false,
    description: "ログローテーション閾値（バイト）",
    default: "10485760",
  },
];
