import { Database } from "bun:sqlite";
import { applyMigrations } from "./schema";

let dbInstance: Database | null = null;

export function getDatabase(): Database {
  if (!dbInstance) {
    const databasePath = process.env.DATABASE_PATH ?? "data/disqord.db";
    dbInstance = new Database(databasePath, { create: true });
    dbInstance.run("PRAGMA journal_mode = WAL");
    applyMigrations(dbInstance);
  }

  return dbInstance;
}
