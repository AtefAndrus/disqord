import type { Database } from "bun:sqlite";

export function applyMigrations(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      default_model TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migration: Add free_models_only column
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(guild_settings)").all();
  const hasFreeModelsOnly = columns.some((c) => c.name === "free_models_only");
  if (!hasFreeModelsOnly) {
    db.run(`
      ALTER TABLE guild_settings
      ADD COLUMN free_models_only INTEGER NOT NULL DEFAULT 0
    `);
  }

  // Migration: Add show_llm_details column
  const columnsAfterFreeModels = db
    .query<{ name: string }, []>("PRAGMA table_info(guild_settings)")
    .all();
  const hasShowLlmDetails = columnsAfterFreeModels.some((c) => c.name === "show_llm_details");
  if (!hasShowLlmDetails) {
    db.run(`
      ALTER TABLE guild_settings
      ADD COLUMN show_llm_details INTEGER NOT NULL DEFAULT 1
    `);
  }

  // Migration: Add auto_reply_channels column (JSON array)
  const columnsAfterLlmDetails = db
    .query<{ name: string }, []>("PRAGMA table_info(guild_settings)")
    .all();
  const hasAutoReplyChannels = columnsAfterLlmDetails.some((c) => c.name === "auto_reply_channels");
  if (!hasAutoReplyChannels) {
    db.run(`
      ALTER TABLE guild_settings
      ADD COLUMN auto_reply_channels TEXT DEFAULT NULL
    `);
  }

  // Migration: Add web_search_enabled column (off by default: every search is billed)
  const columnsAfterAutoReply = db
    .query<{ name: string }, []>("PRAGMA table_info(guild_settings)")
    .all();
  const hasWebSearchEnabled = columnsAfterAutoReply.some((c) => c.name === "web_search_enabled");
  if (!hasWebSearchEnabled) {
    db.run(`
      ALTER TABLE guild_settings
      ADD COLUMN web_search_enabled INTEGER NOT NULL DEFAULT 0
    `);
  }

  // Migration: Add twitter_expand_enabled column (on by default: tweet expansion is free)
  const columnsAfterWebSearch = db
    .query<{ name: string }, []>("PRAGMA table_info(guild_settings)")
    .all();
  const hasTwitterExpandEnabled = columnsAfterWebSearch.some(
    (c) => c.name === "twitter_expand_enabled",
  );
  if (!hasTwitterExpandEnabled) {
    db.run(`
      ALTER TABLE guild_settings
      ADD COLUMN twitter_expand_enabled INTEGER NOT NULL DEFAULT 1
    `);
  }

  // Migration: Add history_enabled column (off by default: persistence is opt-in)
  const columnsAfterTwitterExpand = db
    .query<{ name: string }, []>("PRAGMA table_info(guild_settings)")
    .all();
  const hasHistoryEnabled = columnsAfterTwitterExpand.some((c) => c.name === "history_enabled");
  if (!hasHistoryEnabled) {
    db.run(`
      ALTER TABLE guild_settings
      ADD COLUMN history_enabled INTEGER NOT NULL DEFAULT 0
    `);
  }

  const turnsTable = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turns'",
    )
    .get();
  const hasTurns = turnsTable !== null && turnsTable !== undefined;
  if (hasTurns) {
    const migrateConversationStore = db.transaction(() => {
      db.run("DROP TABLE IF EXISTS turn_messages");
      db.run("DROP TABLE IF EXISTS turns");
      db.run("DROP TABLE IF EXISTS sessions");
      db.run("UPDATE guild_settings SET history_enabled = 0");
    });
    migrateConversationStore.immediate();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS reply_records (
      trigger_msg_id  TEXT PRIMARY KEY,         -- 返答した発言の message ID
      channel_id      TEXT NOT NULL,
      guild_id        TEXT NOT NULL,
      status          TEXT NOT NULL CHECK(status IN ('pending','completed','stopped','failed')),
      page_count      INTEGER,                  -- 確定時の総ページ数。pending の間は NULL
      finalized_at    INTEGER,                  -- 確定時刻（ms）。pending の間は NULL
      created_at      INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS reply_pages (
      page_msg_id     TEXT PRIMARY KEY,
      trigger_msg_id  TEXT NOT NULL REFERENCES reply_records(trigger_msg_id) ON DELETE CASCADE,
      seq             INTEGER NOT NULL,
      UNIQUE (trigger_msg_id, seq)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_reply_records_finalized ON reply_records(finalized_at)");
}
