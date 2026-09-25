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
    | "reasoningDisplayEnabled"
    | "twitterExpandEnabled"
    | "historyEnabled"
    | "allowedChannels"
    | "adminRoleId"
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
    updatedBy?: string,
  ): Promise<GuildSettings>;
  delete(guildId: GuildId): Promise<boolean>;
  setHistoryEnabled(guildId: GuildId, enabled: boolean, updatedBy?: string): Promise<GuildSettings>;
}

interface RawGuildSettings {
  guildId: GuildId;
  adminRoleId: string | null;
  allowedChannels: string | null;
  settingsVersion: number;
  updatedBy: string | null;
  defaultModel: string;
  freeModelsOnly: number;
  showLlmDetails: number;
  autoReplyChannels: string | null;
  webSearchEnabled: number;
  reasoningDisplayEnabled: number;
  twitterExpandEnabled: number;
  historyEnabled: number;
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
    adminRoleId: raw.adminRoleId ?? null,
    allowedChannels:
      raw.allowedChannels === null ? null : parseAutoReplyChannels(raw.allowedChannels),
    settingsVersion: raw.settingsVersion,
    updatedBy: raw.updatedBy,
    defaultModel: raw.defaultModel,
    freeModelsOnly: Boolean(raw.freeModelsOnly),
    showLlmDetails: Boolean(raw.showLlmDetails ?? 1),
    autoReplyChannels: parseAutoReplyChannels(raw.autoReplyChannels),
    webSearchEnabled: Boolean(raw.webSearchEnabled),
    reasoningDisplayEnabled: Boolean(raw.reasoningDisplayEnabled),
    twitterExpandEnabled: Boolean(raw.twitterExpandEnabled ?? 1),
    historyEnabled: Boolean(raw.historyEnabled),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

const SELECT_ROW = `SELECT guild_id as guildId, admin_role_id as adminRoleId, default_model as defaultModel, free_models_only as freeModelsOnly,
  show_llm_details as showLlmDetails, auto_reply_channels as autoReplyChannels,
  web_search_enabled as webSearchEnabled, reasoning_display_enabled as reasoningDisplayEnabled,
  twitter_expand_enabled as twitterExpandEnabled,
  history_enabled as historyEnabled, allowed_channels as allowedChannels,
  settings_version as settingsVersion, updated_by as updatedBy,
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
      updatedBy?: string,
    ) => GuildSettings;
  };

  constructor(
    private readonly db: Database,
    private readonly defaultModel: string,
  ) {
    this.updateInTransaction = this.db.transaction(
      (
        guildId: GuildId,
        mutate: (current: GuildSettings) => GuildSettingsChanges,
        updatedBy?: string,
      ): GuildSettings => {
        this.insertDefaultRow(guildId);
        const current = this.readRow(guildId);
        if (!current) {
          throw new Error(`guild_settings row for ${guildId} is missing after insert`);
        }
        const changes = mutate(current);
        if (Object.keys(changes).length === 0) return current;
        const next: GuildSettings = {
          ...current,
          ...changes,
          updatedAt: new Date().toISOString(),
          settingsVersion: current.settingsVersion + 1,
          updatedBy: updatedBy ?? null,
        };
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
    updatedBy?: string,
  ): Promise<GuildSettings> {
    return this.updateInTransaction.immediate(guildId, mutate, updatedBy);
  }

  async delete(guildId: GuildId): Promise<boolean> {
    const result = this.db.query("DELETE FROM guild_settings WHERE guild_id = ?").run(guildId);
    return result.changes > 0;
  }

  async setHistoryEnabled(
    guildId: GuildId,
    enabled: boolean,
    updatedBy?: string,
  ): Promise<GuildSettings> {
    return this.update(guildId, () => ({ historyEnabled: enabled }), updatedBy);
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
        `INSERT INTO guild_settings (guild_id, default_model, free_models_only, show_llm_details, auto_reply_channels, web_search_enabled, reasoning_display_enabled, twitter_expand_enabled, history_enabled, created_at, updated_at)
         VALUES (?, ?, 0, 1, NULL, 0, 0, 1, 0, ?, ?)
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
             auto_reply_channels = ?, web_search_enabled = ?, reasoning_display_enabled = ?,
             twitter_expand_enabled = ?, history_enabled = ?, updated_at = ?,
             allowed_channels = ?, admin_role_id = ?, settings_version = ?, updated_by = ?
         WHERE guild_id = ?`,
      )
      .run(
        settings.defaultModel,
        settings.freeModelsOnly ? 1 : 0,
        settings.showLlmDetails ? 1 : 0,
        autoReplyChannelsJson,
        settings.webSearchEnabled ? 1 : 0,
        settings.reasoningDisplayEnabled ? 1 : 0,
        settings.twitterExpandEnabled ? 1 : 0,
        settings.historyEnabled ? 1 : 0,
        settings.updatedAt,
        settings.allowedChannels === null ? null : JSON.stringify(settings.allowedChannels),
        settings.adminRoleId,
        settings.settingsVersion,
        settings.updatedBy,
        settings.guildId,
      );
  }
}
