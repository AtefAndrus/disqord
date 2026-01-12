import type { Database } from "bun:sqlite";
import type { GuildId, GuildSettings } from "../../types";

export interface IGuildSettingsRepository {
  findByGuildId(guildId: GuildId): Promise<GuildSettings | null>;
  findAllWithReleaseChannel(): Promise<GuildSettings[]>;
  upsert(guildId: GuildId, settings: Partial<GuildSettings>): Promise<GuildSettings>;
  updateShowLlmDetails(guildId: GuildId, showLlmDetails: boolean): Promise<void>;
  updateAutoReplyChannels(guildId: GuildId, channels: string[]): Promise<void>;
  delete(guildId: GuildId): Promise<boolean>;
}

interface RawGuildSettings {
  guildId: GuildId;
  defaultModel: string;
  freeModelsOnly: number;
  releaseChannelId: string | null;
  showLlmDetails: number;
  autoReplyChannels: string | null;
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
    releaseChannelId: raw.releaseChannelId,
    showLlmDetails: Boolean(raw.showLlmDetails ?? 1),
    autoReplyChannels: parseAutoReplyChannels(raw.autoReplyChannels),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export class GuildSettingsRepository implements IGuildSettingsRepository {
  constructor(
    private readonly db: Database,
    private readonly defaultModel: string,
  ) {}

  async findByGuildId(guildId: GuildId): Promise<GuildSettings | null> {
    const stmt = this.db.query<RawGuildSettings, [string]>(
      `SELECT guild_id as guildId, default_model as defaultModel, free_models_only as freeModelsOnly,
       release_channel_id as releaseChannelId, show_llm_details as showLlmDetails,
       auto_reply_channels as autoReplyChannels, created_at as createdAt, updated_at as updatedAt
       FROM guild_settings WHERE guild_id = ?`,
    );
    const result = stmt.get(guildId);
    if (!result) return null;
    return rawToGuildSettings(result);
  }

  async findAllWithReleaseChannel(): Promise<GuildSettings[]> {
    const stmt = this.db.query<RawGuildSettings, []>(
      `SELECT guild_id as guildId, default_model as defaultModel, free_models_only as freeModelsOnly,
       release_channel_id as releaseChannelId, show_llm_details as showLlmDetails,
       auto_reply_channels as autoReplyChannels, created_at as createdAt, updated_at as updatedAt
       FROM guild_settings WHERE release_channel_id IS NOT NULL`,
    );
    const results = stmt.all();
    return results.map(rawToGuildSettings);
  }

  async upsert(guildId: GuildId, settings: Partial<GuildSettings>): Promise<GuildSettings> {
    const defaults: GuildSettings = {
      guildId,
      defaultModel: settings.defaultModel ?? this.defaultModel,
      freeModelsOnly: settings.freeModelsOnly ?? false,
      releaseChannelId: settings.releaseChannelId ?? null,
      showLlmDetails: settings.showLlmDetails ?? true,
      autoReplyChannels: settings.autoReplyChannels ?? [],
      createdAt: settings.createdAt ?? new Date().toISOString(),
      updatedAt: settings.updatedAt ?? new Date().toISOString(),
    };

    const autoReplyChannelsJson =
      defaults.autoReplyChannels.length > 0 ? JSON.stringify(defaults.autoReplyChannels) : null;

    this.db
      .query(
        `INSERT INTO guild_settings (guild_id, default_model, free_models_only, release_channel_id, show_llm_details, auto_reply_channels, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET
         default_model = excluded.default_model,
         free_models_only = excluded.free_models_only,
         release_channel_id = excluded.release_channel_id,
         show_llm_details = excluded.show_llm_details,
         auto_reply_channels = excluded.auto_reply_channels,
         updated_at = excluded.updated_at`,
      )
      .run(
        guildId,
        defaults.defaultModel,
        defaults.freeModelsOnly ? 1 : 0,
        defaults.releaseChannelId,
        defaults.showLlmDetails ? 1 : 0,
        autoReplyChannelsJson,
        defaults.createdAt,
        defaults.updatedAt,
      );

    return defaults;
  }

  async updateShowLlmDetails(guildId: GuildId, showLlmDetails: boolean): Promise<void> {
    this.db
      .query(
        `UPDATE guild_settings
         SET show_llm_details = ?, updated_at = datetime('now')
         WHERE guild_id = ?`,
      )
      .run(showLlmDetails ? 1 : 0, guildId);
  }

  async updateAutoReplyChannels(guildId: GuildId, channels: string[]): Promise<void> {
    const autoReplyChannelsJson = channels.length > 0 ? JSON.stringify(channels) : null;
    this.db
      .query(
        `UPDATE guild_settings
         SET auto_reply_channels = ?, updated_at = datetime('now')
         WHERE guild_id = ?`,
      )
      .run(autoReplyChannelsJson, guildId);
  }

  async delete(guildId: GuildId): Promise<boolean> {
    const result = this.db.query("DELETE FROM guild_settings WHERE guild_id = ?").run(guildId);
    return result.changes > 0;
  }
}
