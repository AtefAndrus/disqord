import type { Database } from "bun:sqlite";
import type { GuildId, GuildSettings } from "../../types";

export interface IGuildSettingsRepository {
  findByGuildId(guildId: GuildId): Promise<GuildSettings | null>;
  upsert(guildId: GuildId, settings: Partial<GuildSettings>): Promise<GuildSettings>;
  delete(guildId: GuildId): Promise<boolean>;
}

export class GuildSettingsRepository implements IGuildSettingsRepository {
  constructor(
    private readonly db: Database,
    private readonly defaultModel: string,
  ) {}

  async findByGuildId(guildId: GuildId): Promise<GuildSettings | null> {
    interface RawGuildSettings {
      guildId: GuildId;
      defaultModel: string;
      freeModelsOnly: number;
      createdAt: string;
      updatedAt: string;
    }
    const stmt = this.db.query<RawGuildSettings, [string]>(
      "SELECT guild_id as guildId, default_model as defaultModel, free_models_only as freeModelsOnly, created_at as createdAt, updated_at as updatedAt FROM guild_settings WHERE guild_id = ?",
    );
    const result = stmt.get(guildId);
    if (!result) return null;
    // SQLite stores boolean as 0/1, convert to boolean
    return { ...result, freeModelsOnly: Boolean(result.freeModelsOnly) };
  }

  async upsert(guildId: GuildId, settings: Partial<GuildSettings>): Promise<GuildSettings> {
    const defaults: GuildSettings = {
      guildId,
      defaultModel: settings.defaultModel ?? this.defaultModel,
      freeModelsOnly: settings.freeModelsOnly ?? false,
      createdAt: settings.createdAt ?? new Date().toISOString(),
      updatedAt: settings.updatedAt ?? new Date().toISOString(),
    };

    this.db
      .query(
        `INSERT INTO guild_settings (guild_id, default_model, free_models_only, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET default_model = excluded.default_model, free_models_only = excluded.free_models_only, updated_at = excluded.updated_at`,
      )
      .run(
        guildId,
        defaults.defaultModel,
        defaults.freeModelsOnly ? 1 : 0,
        defaults.createdAt,
        defaults.updatedAt,
      );

    return defaults;
  }

  async delete(guildId: GuildId): Promise<boolean> {
    const result = this.db.query("DELETE FROM guild_settings WHERE guild_id = ?").run(guildId);
    return result.changes > 0;
  }
}
