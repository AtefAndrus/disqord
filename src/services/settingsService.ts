import type { IGuildSettingsRepository } from "../db/repositories/guildSettings";
import { SettingsConflictError, SettingsRuleError } from "../errors";
import type { GuildSettings } from "../types";

/**
 * What the caller learned about a model before saving. Model metadata comes
 * from the OpenRouter API, so it is fetched outside the settings transaction;
 * the save then checks it against the settings as stored.
 */
export interface ModelCheck {
  model: string;
  isFree: boolean;
}

export interface ISettingsService {
  getGuildSettings(guildId: string): Promise<GuildSettings>;
  /** Throws SettingsRuleError when free-only is on and `check.isFree` is false. */
  setGuildModel(guildId: string, check: ModelCheck): Promise<GuildSettings>;
  /**
   * Turning free-only on needs the check of the model it was validated
   * against; throws SettingsConflictError if the stored model has changed
   * since, and SettingsRuleError if that model is not free.
   */
  setFreeModelsOnly(guildId: string, enabled: boolean, check?: ModelCheck): Promise<GuildSettings>;
  /** Flips free-only on the stored value; the same checks apply when it turns on. */
  toggleFreeModelsOnly(guildId: string, check: ModelCheck): Promise<boolean>;
  setShowLlmDetails(guildId: string, showLlmDetails: boolean): Promise<void>;
  toggleShowLlmDetails(guildId: string): Promise<boolean>;
  addAutoReplyChannel(guildId: string, channelId: string): Promise<void>;
  removeAutoReplyChannel(guildId: string, channelId: string): Promise<boolean>;
  setWebSearchEnabled(guildId: string, webSearchEnabled: boolean): Promise<GuildSettings>;
}

function assertCanEnableFreeOnly(current: GuildSettings, check: ModelCheck | undefined): void {
  if (!check || check.model !== current.defaultModel) {
    throw new SettingsConflictError(
      `free-only was validated against ${check?.model ?? "no model"} but the stored model is ${current.defaultModel}`,
    );
  }
  if (!check.isFree) {
    throw new SettingsRuleError(
      `model ${current.defaultModel} is not free`,
      `現在のモデル \`${current.defaultModel}\` は無料モデルではありません。先に無料モデルに変更してから有効化してください。`,
    );
  }
}

/**
 * Every write goes through `repo.update`, whose `mutate` sees the stored row
 * inside the write transaction. A value computed from an earlier read (a
 * toggle's negation, an edited channel list, a model check) is decided in
 * `mutate`, never before it.
 */
export class SettingsService implements ISettingsService {
  constructor(private readonly repo: IGuildSettingsRepository) {}

  async getGuildSettings(guildId: string): Promise<GuildSettings> {
    return (await this.repo.findByGuildId(guildId)) ?? this.repo.update(guildId, () => ({}));
  }

  async setGuildModel(guildId: string, check: ModelCheck): Promise<GuildSettings> {
    return this.repo.update(guildId, (current) => {
      if (current.freeModelsOnly && !check.isFree) {
        throw new SettingsRuleError(
          `model ${check.model} is not free while free-only is on`,
          `このサーバーは無料モデル限定に設定されています。モデル \`${check.model}\` は無料モデルではありません。`,
        );
      }
      return { defaultModel: check.model };
    });
  }

  async setFreeModelsOnly(
    guildId: string,
    enabled: boolean,
    check?: ModelCheck,
  ): Promise<GuildSettings> {
    return this.repo.update(guildId, (current) => {
      if (enabled) assertCanEnableFreeOnly(current, check);
      return { freeModelsOnly: enabled };
    });
  }

  async toggleFreeModelsOnly(guildId: string, check: ModelCheck): Promise<boolean> {
    const updated = await this.repo.update(guildId, (current) => {
      const enabled = !current.freeModelsOnly;
      if (enabled) assertCanEnableFreeOnly(current, check);
      return { freeModelsOnly: enabled };
    });
    return updated.freeModelsOnly;
  }

  async setShowLlmDetails(guildId: string, showLlmDetails: boolean): Promise<void> {
    await this.repo.update(guildId, () => ({ showLlmDetails }));
  }

  async toggleShowLlmDetails(guildId: string): Promise<boolean> {
    const updated = await this.repo.update(guildId, (current) => ({
      showLlmDetails: !current.showLlmDetails,
    }));
    return updated.showLlmDetails;
  }

  async addAutoReplyChannel(guildId: string, channelId: string): Promise<void> {
    await this.repo.update(guildId, (current) =>
      current.autoReplyChannels.includes(channelId)
        ? {}
        : { autoReplyChannels: [...current.autoReplyChannels, channelId] },
    );
  }

  async removeAutoReplyChannel(guildId: string, channelId: string): Promise<boolean> {
    let removed = false;
    await this.repo.update(guildId, (current) => {
      if (!current.autoReplyChannels.includes(channelId)) return {};
      removed = true;
      return { autoReplyChannels: current.autoReplyChannels.filter((id) => id !== channelId) };
    });
    return removed;
  }

  async setWebSearchEnabled(guildId: string, webSearchEnabled: boolean): Promise<GuildSettings> {
    return this.repo.update(guildId, () => ({ webSearchEnabled }));
  }
}
