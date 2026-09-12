import type { Database } from "bun:sqlite";

export function applyMigrations(db: Database) {
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
}
