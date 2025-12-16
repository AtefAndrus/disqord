import type { Database } from "bun:sqlite";
import type { GuildId, GuildSettings } from "../../types";

export interface IGuildSettingsRepository {
  findByGuildId(guildId: GuildId): Promise<GuildSettings | null>;
  upsert(guildId: GuildId, settings: Partial<GuildSettings>): Promise<GuildSettings>;
  delete(guildId: GuildId): Promise<boolean>;
}

export class GuildSettingsRepository implements IGuildSettingsRepository {
  constructor(private readonly db: Database) {}

  async findByGuildId(guildId: GuildId): Promise<GuildSettings | null> {
    const stmt = this.db.query<GuildSettings, [string]>(
      "SELECT guild_id as guildId, default_model as defaultModel, created_at as createdAt, updated_at as updatedAt FROM guild_settings WHERE guild_id = ?",
    );
    return stmt.get(guildId) ?? null;
  }

  async upsert(guildId: GuildId, settings: Partial<GuildSettings>): Promise<GuildSettings> {
    const defaults: GuildSettings = {
      guildId,
      defaultModel: settings.defaultModel ?? "google/gemini-2.0-flash-exp:free",
      createdAt: settings.createdAt ?? new Date().toISOString(),
      updatedAt: settings.updatedAt ?? new Date().toISOString(),
    };

    this.db
      .query(
        `INSERT INTO guild_settings (guild_id, default_model, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET default_model = excluded.default_model, updated_at = excluded.updated_at`,
      )
      .run(guildId, defaults.defaultModel, defaults.createdAt, defaults.updatedAt);

    return defaults;
  }

  async delete(guildId: GuildId): Promise<boolean> {
    const result = this.db.query("DELETE FROM guild_settings WHERE guild_id = ?").run(guildId);
    return result.changes > 0;
  }
}
