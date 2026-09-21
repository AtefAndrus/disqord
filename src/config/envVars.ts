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
    default: "google/gemma-4-26b-a4b-it:free",
  },
  {
    name: "HEALTH_PORT",
    required: false,
    description: "ヘルスチェック用HTTPポート",
    default: "3000",
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
  {
    name: "WEB_SEARCH_ENGINE",
    required: false,
    description:
      "Web検索のエンジン（perplexity / exa / parallel / native / auto / firecrawl）。料金はエンジンごとに異なる",
    default: "perplexity",
  },
  {
    name: "FXTWITTER_API_BASE",
    required: false,
    description: "ツイート展開に使う fxtwitter API のベース URL",
    default: "https://api.fxtwitter.com",
  },
  {
    name: "E2E_TESTER_BOT_ID",
    required: false,
    description:
      "e2e 用テスト bot のユーザ ID。この bot からの発言にだけ応答する（NODE_ENV=production では無視）",
  },
  {
    name: "E2E_TESTER_BOT_TOKEN",
    required: false,
    description: "e2e 用テスト bot のトークン（`bun run e2e` だけが使う）",
  },
  {
    name: "E2E_CHANNEL_ID",
    required: false,
    description: "e2e の発言を送るチャンネル ID（`bun run e2e` だけが使う）",
  },
];
