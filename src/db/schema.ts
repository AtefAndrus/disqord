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
}
