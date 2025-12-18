import type { IGuildSettingsRepository } from "../db/repositories/guildSettings";
import type { GuildSettings } from "../types";

export interface ISettingsService {
  getGuildSettings(guildId: string): Promise<GuildSettings>;
  setGuildModel(guildId: string, model: string): Promise<GuildSettings>;
}

export class SettingsService implements ISettingsService {
  constructor(
    private readonly repo: IGuildSettingsRepository,
    private readonly defaultModel: string,
  ) {}

  async getGuildSettings(guildId: string): Promise<GuildSettings> {
    const existing = await this.repo.findByGuildId(guildId);
    if (existing) {
      return existing;
    }

    const fallback: GuildSettings = {
      guildId,
      defaultModel: this.defaultModel,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.repo.upsert(guildId, fallback);
    return fallback;
  }

  async setGuildModel(guildId: string, model: string): Promise<GuildSettings> {
    return this.repo.upsert(guildId, {
      guildId,
      defaultModel: model,
      updatedAt: new Date().toISOString(),
    });
  }
}
