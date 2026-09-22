import { Database } from "bun:sqlite";
import { applyMigrations } from "./schema";

let dbInstance: Database | null = null;

export function getDatabase(): Database {
  if (!dbInstance) {
    const databasePath = process.env.DATABASE_PATH ?? "data/disqord.db";
    dbInstance = new Database(databasePath, { create: true });
    dbInstance.run("PRAGMA journal_mode = WAL");
    dbInstance.run("PRAGMA foreign_keys = ON");
    dbInstance.run("PRAGMA busy_timeout = 5000");
    applyMigrations(dbInstance);
  }

  return dbInstance;
}
