import type { IGuildSettingsRepository } from "../db/repositories/guildSettings";
import type { GuildSettings } from "../types";

export interface ISettingsService {
  getGuildSettings(guildId: string): Promise<GuildSettings>;
  setGuildModel(guildId: string, model: string): Promise<GuildSettings>;
  setFreeModelsOnly(guildId: string, freeModelsOnly: boolean): Promise<GuildSettings>;
  setReleaseChannel(guildId: string, channelId: string | null): Promise<GuildSettings>;
  setShowLlmDetails(guildId: string, showLlmDetails: boolean): Promise<void>;
  toggleShowLlmDetails(guildId: string): Promise<boolean>;
  getGuildsWithReleaseChannel(): Promise<GuildSettings[]>;
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
      freeModelsOnly: false,
      releaseChannelId: null,
      showLlmDetails: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.repo.upsert(guildId, fallback);
    return fallback;
  }

  async setGuildModel(guildId: string, model: string): Promise<GuildSettings> {
    const existing = await this.getGuildSettings(guildId);
    return this.repo.upsert(guildId, {
      ...existing,
      defaultModel: model,
      updatedAt: new Date().toISOString(),
    });
  }

  async setFreeModelsOnly(guildId: string, freeModelsOnly: boolean): Promise<GuildSettings> {
    const existing = await this.getGuildSettings(guildId);
    return this.repo.upsert(guildId, {
      ...existing,
      freeModelsOnly,
      updatedAt: new Date().toISOString(),
    });
  }

  async setReleaseChannel(guildId: string, channelId: string | null): Promise<GuildSettings> {
    const existing = await this.getGuildSettings(guildId);
    return this.repo.upsert(guildId, {
      ...existing,
      releaseChannelId: channelId,
      updatedAt: new Date().toISOString(),
    });
  }

  async setShowLlmDetails(guildId: string, showLlmDetails: boolean): Promise<void> {
    await this.repo.updateShowLlmDetails(guildId, showLlmDetails);
  }

  async toggleShowLlmDetails(guildId: string): Promise<boolean> {
    const settings = await this.getGuildSettings(guildId);
    const newValue = !settings.showLlmDetails;
    await this.repo.updateShowLlmDetails(guildId, newValue);
    return newValue;
  }

  async getGuildsWithReleaseChannel(): Promise<GuildSettings[]> {
    return this.repo.findAllWithReleaseChannel();
  }
}
