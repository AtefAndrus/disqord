import type { Database } from "bun:sqlite";

export function applyMigrations(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      default_model TEXT NOT NULL DEFAULT 'deepseek/deepseek-r1-0528:free',
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

  // Migration: Add release_channel_id column
  const columnsAfterFreeModels = db
    .query<{ name: string }, []>("PRAGMA table_info(guild_settings)")
    .all();
  const hasReleaseChannelId = columnsAfterFreeModels.some((c) => c.name === "release_channel_id");
  if (!hasReleaseChannelId) {
    db.run(`
      ALTER TABLE guild_settings
      ADD COLUMN release_channel_id TEXT DEFAULT NULL
    `);
  }
}
