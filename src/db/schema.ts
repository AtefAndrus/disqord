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

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openrouter_session_id TEXT NOT NULL UNIQUE,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      parent_channel_id TEXT,
      started_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL
    )
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel_id, last_activity_at)",
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_channel_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_guild ON sessions(guild_id)");

  db.run(`
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      author_id TEXT,
      author_label TEXT,
      parent_user_turn_id INTEGER REFERENCES turns(id) ON DELETE CASCADE,
      reply_to_turn_id INTEGER REFERENCES turns(id) ON DELETE SET NULL,
      reply_to_discord_msg_id TEXT,
      status TEXT NOT NULL,
      content_schema_version INTEGER NOT NULL DEFAULT 1 CHECK(content_schema_version >= 1),
      content_json TEXT NOT NULL CHECK(json_valid(content_json)),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      discord_created_at INTEGER NOT NULL,
      finalized_at INTEGER,
      CHECK (
        (role='user'
          AND author_id IS NOT NULL AND author_label IS NOT NULL
          AND parent_user_turn_id IS NULL
          AND status IN ('completed','abandoned'))
        OR
        (role='assistant'
          AND author_id IS NULL AND author_label IS NULL
          AND parent_user_turn_id IS NOT NULL
          AND reply_to_turn_id IS NULL AND reply_to_discord_msg_id IS NULL
          AND status IN ('pending','completed','stopped','failed'))
      )
    )
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, discord_created_at, id)",
  );
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_one_assistant ON turns(parent_user_turn_id) WHERE role='assistant' AND status != 'failed'",
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_turns_created ON turns(discord_created_at)");
  // The unique index above is partial (role and status), so looking up the
  // assistant of a user turn cannot use it; without this one, building a
  // context scans every turn once per exchange and blocks the event loop.
  db.run("CREATE INDEX IF NOT EXISTS idx_turns_parent ON turns(parent_user_turn_id)");
  // `reply_to_turn_id ... ON DELETE SET NULL` looks up referencing rows on
  // every turn delete; without an index a large purge scans the table per row.
  db.run("CREATE INDEX IF NOT EXISTS idx_turns_reply_to ON turns(reply_to_turn_id)");

  db.run(`
    CREATE TABLE IF NOT EXISTS turn_messages (
      turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      discord_msg_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK(seq >= 0),
      PRIMARY KEY (turn_id, discord_msg_id),
      UNIQUE (turn_id, seq)
    )
  `);
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_messages_msg ON turn_messages(discord_msg_id)",
  );
}
