import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { applyMigrations } from "../../../src/db/schema";

describe("conversation-context migration", () => {
  const databases: Database[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  test("drops the old tables and disables history in an old database", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.run("PRAGMA foreign_keys = ON");
    database.run(`
      CREATE TABLE guild_settings (
        guild_id TEXT PRIMARY KEY,
        default_model TEXT NOT NULL,
        free_models_only INTEGER NOT NULL DEFAULT 0,
        show_llm_details INTEGER NOT NULL DEFAULT 1,
        auto_reply_channels TEXT,
        web_search_enabled INTEGER NOT NULL DEFAULT 0,
        twitter_expand_enabled INTEGER NOT NULL DEFAULT 1,
        history_enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    database
      .query(
        `INSERT INTO guild_settings
         (guild_id, default_model, history_enabled, created_at, updated_at)
         VALUES ('guild-1', 'model', 1, 'now', 'now')`,
      )
      .run();
    database.run(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY,
        openrouter_session_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL
      )
    `);
    database.run(
      "CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id INTEGER REFERENCES sessions(id))",
    );
    database.run(
      "CREATE TABLE turn_messages (turn_id INTEGER REFERENCES turns(id), discord_msg_id TEXT)",
    );
    database.run("INSERT INTO sessions VALUES (1, 'session', 'guild-1', 'channel', 1, 1)");
    database.run("INSERT INTO turns VALUES (1, 1)");
    database.run("INSERT INTO turn_messages VALUES (1, 'message')");

    applyMigrations(database);

    for (const table of ["sessions", "turns", "turn_messages"]) {
      expect(
        database
          .query<{ name: string }, [string]>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(table),
      ).toBeNull();
    }
    expect(database.query("SELECT history_enabled FROM guild_settings").get()).toEqual({
      history_enabled: 0,
    });
    expect(
      database.query("SELECT name FROM sqlite_master WHERE name = 'reply_records'").get(),
    ).not.toBeNull();

    database.query("UPDATE guild_settings SET history_enabled = 1").run();
    applyMigrations(database);
    expect(database.query("SELECT history_enabled FROM guild_settings").get()).toEqual({
      history_enabled: 1,
    });
  });

  test("leaves a fresh database unchanged by the old-store migration and is a no-op on the second startup", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.run("PRAGMA foreign_keys = ON");

    applyMigrations(database);
    database
      .query(
        `INSERT INTO reply_records
         (trigger_msg_id, channel_id, guild_id, status, created_at)
         VALUES ('trigger', 'channel', 'guild', 'pending', 1)`,
      )
      .run();
    database
      .query("INSERT INTO guild_settings (guild_id, default_model) VALUES ('guild', 'model')")
      .run();
    database.query("UPDATE guild_settings SET history_enabled = 1").run();
    applyMigrations(database);

    expect(database.query("SELECT COUNT(*) as count FROM reply_records").get()).toEqual({
      count: 1,
    });
    expect(database.query("SELECT name FROM sqlite_master WHERE name = 'turns'").get()).toBeNull();
    expect(database.query("SELECT history_enabled FROM guild_settings").get()).toEqual({
      history_enabled: 1,
    });
  });
});
