import type { Database } from "bun:sqlite";
import type { GuildId, GuildSettings } from "../../types";

/** The columns a settings change may set; ids and timestamps are the repository's. */
export type GuildSettingsChanges = Partial<
  Pick<
    GuildSettings,
    | "defaultModel"
    | "freeModelsOnly"
    | "showLlmDetails"
    | "autoReplyChannels"
    | "webSearchEnabled"
    | "twitterExpandEnabled"
  >
>;

export interface IGuildSettingsRepository {
  findByGuildId(guildId: GuildId): Promise<GuildSettings | null>;
  /**
   * Creates the guild's row with defaults if it is missing, passes the stored
   * row to `mutate`, and writes back only the fields `mutate` returns, all in
   * one transaction. `mutate` must be synchronous; a throw from it rolls the
   * transaction back (including a row it created) and propagates.
   */
  update(
    guildId: GuildId,
    mutate: (current: GuildSettings) => GuildSettingsChanges,
  ): Promise<GuildSettings>;
  delete(guildId: GuildId): Promise<boolean>;
}

interface RawGuildSettings {
  guildId: GuildId;
  defaultModel: string;
  freeModelsOnly: number;
  showLlmDetails: number;
  autoReplyChannels: string | null;
  webSearchEnabled: number;
  twitterExpandEnabled: number;
  createdAt: string;
  updatedAt: string;
}

function parseAutoReplyChannels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rawToGuildSettings(raw: RawGuildSettings): GuildSettings {
  return {
    guildId: raw.guildId,
    defaultModel: raw.defaultModel,
    freeModelsOnly: Boolean(raw.freeModelsOnly),
    showLlmDetails: Boolean(raw.showLlmDetails ?? 1),
    autoReplyChannels: parseAutoReplyChannels(raw.autoReplyChannels),
    webSearchEnabled: Boolean(raw.webSearchEnabled),
    twitterExpandEnabled: Boolean(raw.twitterExpandEnabled ?? 1),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

const SELECT_ROW = `SELECT guild_id as guildId, default_model as defaultModel, free_models_only as freeModelsOnly,
  show_llm_details as showLlmDetails, auto_reply_channels as autoReplyChannels,
  web_search_enabled as webSearchEnabled, twitter_expand_enabled as twitterExpandEnabled,
  created_at as createdAt, updated_at as updatedAt
  FROM guild_settings WHERE guild_id = ?`;

export class GuildSettingsRepository implements IGuildSettingsRepository {
  /**
   * Read, change, and write run in one synchronous transaction: bun:sqlite
   * does not yield inside it, so no other settings write in this process can
   * interleave, and the read cannot be a stale snapshot. IMMEDIATE takes the
   * write lock at BEGIN, so another connection waits or fails before reading
   * rather than at the write. A read-then-write split across `await`s lost
   * concurrent changes (turning web search back on, dropping a toggle or a
   * channel), which is why nothing here writes a caller's snapshot.
   */
  private readonly updateInTransaction: {
    immediate: (
      guildId: GuildId,
      mutate: (current: GuildSettings) => GuildSettingsChanges,
    ) => GuildSettings;
  };

  constructor(
    private readonly db: Database,
    private readonly defaultModel: string,
  ) {
    this.updateInTransaction = this.db.transaction(
      (guildId: GuildId, mutate: (current: GuildSettings) => GuildSettingsChanges) => {
        this.insertDefaultRow(guildId);
        const current = this.readRow(guildId);
        if (!current) {
          throw new Error(`guild_settings row for ${guildId} is missing after insert`);
        }
        const changes = mutate(current);
        if (Object.keys(changes).length === 0) return current;
        const next: GuildSettings = { ...current, ...changes, updatedAt: new Date().toISOString() };
        this.writeRow(next);
        return next;
      },
    );
  }

  async findByGuildId(guildId: GuildId): Promise<GuildSettings | null> {
    return this.readRow(guildId);
  }

  async update(
    guildId: GuildId,
    mutate: (current: GuildSettings) => GuildSettingsChanges,
  ): Promise<GuildSettings> {
    return this.updateInTransaction.immediate(guildId, mutate);
  }

  async delete(guildId: GuildId): Promise<boolean> {
    const result = this.db.query("DELETE FROM guild_settings WHERE guild_id = ?").run(guildId);
    return result.changes > 0;
  }

  private readRow(guildId: GuildId): GuildSettings | null {
    const row = this.db.query<RawGuildSettings, [string]>(SELECT_ROW).get(guildId);
    return row ? rawToGuildSettings(row) : null;
  }

  /** Leaves an existing row untouched, whoever created it. */
  private insertDefaultRow(guildId: GuildId): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO guild_settings (guild_id, default_model, free_models_only, show_llm_details, auto_reply_channels, web_search_enabled, twitter_expand_enabled, created_at, updated_at)
         VALUES (?, ?, 0, 1, NULL, 0, 1, ?, ?)
         ON CONFLICT(guild_id) DO NOTHING`,
      )
      .run(guildId, this.defaultModel, now, now);
  }

  private writeRow(settings: GuildSettings): void {
    const autoReplyChannelsJson =
      settings.autoReplyChannels.length > 0 ? JSON.stringify(settings.autoReplyChannels) : null;
    this.db
      .query(
        `UPDATE guild_settings
         SET default_model = ?, free_models_only = ?, show_llm_details = ?,
             auto_reply_channels = ?, web_search_enabled = ?, twitter_expand_enabled = ?, updated_at = ?
         WHERE guild_id = ?`,
      )
      .run(
        settings.defaultModel,
        settings.freeModelsOnly ? 1 : 0,
        settings.showLlmDetails ? 1 : 0,
        autoReplyChannelsJson,
        settings.webSearchEnabled ? 1 : 0,
        settings.twitterExpandEnabled ? 1 : 0,
        settings.updatedAt,
        settings.guildId,
      );
  }
}
