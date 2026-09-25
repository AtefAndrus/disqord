import type { IGuildSettingsRepository } from "../db/repositories/guildSettings";
import { SettingsConflictError, SettingsRuleError } from "../errors";
import type { GuildSettings } from "../types";

/** Model metadata is fetched outside the transaction, then checked against the stored model. */
export interface ModelCheck {
  model: string;
  isFree: boolean;
}

export interface ISettingsService {
  setReleaseAnnounceChannelId(
    guildId: string,
    channelId: string | null,
    actorId?: string,
  ): Promise<GuildSettings>;
  getGuildSettings(guildId: string): Promise<GuildSettings>;
  setGuildModel(guildId: string, check: ModelCheck, actorId?: string): Promise<GuildSettings>;
  setFreeModelsOnly(
    guildId: string,
    enabled: boolean,
    check?: ModelCheck,
    actorId?: string,
  ): Promise<GuildSettings>;
  setShowLlmDetails(guildId: string, enabled: boolean, actorId?: string): Promise<void>;
  addAutoReplyChannel(guildId: string, channelId: string, actorId?: string): Promise<void>;
  removeAutoReplyChannel(guildId: string, channelId: string, actorId?: string): Promise<boolean>;
  addAllowedChannel(guildId: string, channelId: string, actorId?: string): Promise<void>;
  removeAllowedChannel(guildId: string, channelId: string, actorId?: string): Promise<boolean>;
  /**
   * Adds and removes channels in one write, leaving every other entry as stored,
   * so an edit made from a stale view does not undo someone else's additions.
   * Emptying the allowed list turns the restriction off (null). With
   * `expectedVersion`, throws SettingsConflictError if the row has been written
   * since that version, checked in the same transaction as the write.
   */
  changeChannelList(
    guildId: string,
    list: "auto" | "allowed",
    change: { added: readonly string[]; removed: readonly string[]; expectedVersion?: number },
    actorId?: string,
  ): Promise<GuildSettings>;
  setAdminRoleId(guildId: string, roleId: string | null, actorId?: string): Promise<GuildSettings>;
  setWebSearchEnabled(guildId: string, enabled: boolean, actorId?: string): Promise<GuildSettings>;
  setReasoningDisplayEnabled(
    guildId: string,
    enabled: boolean,
    actorId?: string,
  ): Promise<GuildSettings>;
  setTwitterExpandEnabled(
    guildId: string,
    enabled: boolean,
    actorId?: string,
  ): Promise<GuildSettings>;
  setHistoryEnabled(guildId: string, enabled: boolean, actorId?: string): Promise<GuildSettings>;
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

export class SettingsService implements ISettingsService {
  constructor(private readonly repo: IGuildSettingsRepository) {}

  async setReleaseAnnounceChannelId(
    guildId: string,
    releaseAnnounceChannelId: string | null,
    actorId?: string,
  ): Promise<GuildSettings> {
    return this.repo.update(guildId, () => ({ releaseAnnounceChannelId }), actorId);
  }

  async getGuildSettings(guildId: string): Promise<GuildSettings> {
    return (await this.repo.findByGuildId(guildId)) ?? this.repo.update(guildId, () => ({}));
  }

  async setGuildModel(
    guildId: string,
    check: ModelCheck,
    actorId?: string,
  ): Promise<GuildSettings> {
    return this.repo.update(
      guildId,
      (current) => {
        if (current.freeModelsOnly && !check.isFree) {
          throw new SettingsRuleError(
            `model ${check.model} is not free while free-only is on`,
            `このサーバーは無料モデル限定に設定されています。モデル \`${check.model}\` は無料モデルではありません。`,
          );
        }
        return { defaultModel: check.model };
      },
      actorId,
    );
  }

  async setFreeModelsOnly(
    guildId: string,
    enabled: boolean,
    check?: ModelCheck,
    actorId?: string,
  ): Promise<GuildSettings> {
    return this.repo.update(
      guildId,
      (current) => {
        if (enabled) assertCanEnableFreeOnly(current, check);
        return { freeModelsOnly: enabled };
      },
      actorId,
    );
  }

  async setShowLlmDetails(
    guildId: string,
    showLlmDetails: boolean,
    actorId?: string,
  ): Promise<void> {
    await this.repo.update(guildId, () => ({ showLlmDetails }), actorId);
  }

  async addAutoReplyChannel(guildId: string, channelId: string, actorId?: string): Promise<void> {
    await this.repo.update(
      guildId,
      (current) =>
        current.autoReplyChannels.includes(channelId)
          ? {}
          : { autoReplyChannels: [...current.autoReplyChannels, channelId] },
      actorId,
    );
  }

  async removeAutoReplyChannel(
    guildId: string,
    channelId: string,
    actorId?: string,
  ): Promise<boolean> {
    let removed = false;
    await this.repo.update(
      guildId,
      (current) => {
        if (!current.autoReplyChannels.includes(channelId)) return {};
        removed = true;
        return { autoReplyChannels: current.autoReplyChannels.filter((id) => id !== channelId) };
      },
      actorId,
    );
    return removed;
  }

  async addAllowedChannel(guildId: string, channelId: string, actorId?: string): Promise<void> {
    await this.repo.update(
      guildId,
      (current) => {
        const channels = current.allowedChannels ?? [];
        return channels.includes(channelId) ? {} : { allowedChannels: [...channels, channelId] };
      },
      actorId,
    );
  }

  async changeChannelList(
    guildId: string,
    list: "auto" | "allowed",
    change: { added: readonly string[]; removed: readonly string[]; expectedVersion?: number },
    actorId?: string,
  ): Promise<GuildSettings> {
    return this.repo.update(
      guildId,
      (current) => {
        if (
          change.expectedVersion !== undefined &&
          current.settingsVersion !== change.expectedVersion
        ) {
          throw new SettingsConflictError(
            `channel list edit expected version ${change.expectedVersion} but the stored version is ${current.settingsVersion}`,
          );
        }
        const stored =
          list === "auto" ? current.autoReplyChannels : (current.allowedChannels ?? []);
        const next = [
          ...stored.filter((id) => !change.removed.includes(id)),
          ...change.added.filter((id) => !stored.includes(id)),
        ];
        if (next.length === stored.length && next.every((id, i) => id === stored[i])) return {};
        return list === "auto"
          ? { autoReplyChannels: next }
          : { allowedChannels: next.length ? next : null };
      },
      actorId,
    );
  }

  async removeAllowedChannel(
    guildId: string,
    channelId: string,
    actorId?: string,
  ): Promise<boolean> {
    let removed = false;
    await this.repo.update(
      guildId,
      (current) => {
        if (!current.allowedChannels?.includes(channelId)) return {};
        removed = true;
        const channels = current.allowedChannels.filter((id) => id !== channelId);
        return { allowedChannels: channels.length ? channels : null };
      },
      actorId,
    );
    return removed;
  }

  async setAdminRoleId(
    guildId: string,
    adminRoleId: string | null,
    actorId?: string,
  ): Promise<GuildSettings> {
    return this.repo.update(guildId, () => ({ adminRoleId }), actorId);
  }

  async setWebSearchEnabled(
    guildId: string,
    webSearchEnabled: boolean,
    actorId?: string,
  ): Promise<GuildSettings> {
    return this.repo.update(guildId, () => ({ webSearchEnabled }), actorId);
  }

  async setReasoningDisplayEnabled(
    guildId: string,
    reasoningDisplayEnabled: boolean,
    actorId?: string,
  ): Promise<GuildSettings> {
    return this.repo.update(guildId, () => ({ reasoningDisplayEnabled }), actorId);
  }

  async setTwitterExpandEnabled(
    guildId: string,
    twitterExpandEnabled: boolean,
    actorId?: string,
  ): Promise<GuildSettings> {
    return this.repo.update(guildId, () => ({ twitterExpandEnabled }), actorId);
  }

  async setHistoryEnabled(
    guildId: string,
    historyEnabled: boolean,
    actorId?: string,
  ): Promise<GuildSettings> {
    return this.repo.update(guildId, () => ({ historyEnabled }), actorId);
  }
}
