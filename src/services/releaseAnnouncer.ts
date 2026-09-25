import {
  ChannelType,
  type Client,
  type Guild,
  type NewsChannel,
  PermissionFlagsBits,
  type TextChannel,
} from "discord.js";
import type { BotStateRepository } from "../db/repositories/botState";
import { logger } from "../utils/logger";
import {
  buildReleaseNotePages,
  compareVersions,
  formatVersion,
  parseVersion,
  type ReleaseNotes,
} from "./releaseNotes";
import type { ISettingsService } from "./settingsService";

type ReleasePage = ReturnType<typeof buildReleaseNotePages>[number];

export async function resolveReleaseChannel(
  guild: Guild,
  channelId: string,
): Promise<TextChannel | NewsChannel> {
  const channel = await guild.channels.fetch(channelId, { force: true });
  if (
    !channel ||
    channel.guildId !== guild.id ||
    (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
  ) {
    throw new Error(
      "通知先にはこのサーバーのテキストチャンネルかアナウンスチャンネルを選択してください。",
    );
  }
  const member = await guild.members.fetchMe();
  if (
    !channel
      .permissionsFor(member)
      ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
  ) {
    throw new Error("通知先で bot に「チャンネルを見る」と「メッセージを送信」の権限が必要です。");
  }
  return channel;
}

export function createReleaseSender(
  client: Client,
): (guildId: string, channelId: string, page: ReleasePage) => Promise<void> {
  return async (guildId, channelId, page): Promise<void> => {
    const guild = await client.guilds.fetch(guildId);
    const channel = await resolveReleaseChannel(guild, channelId);
    await channel.send({
      components: page.components,
      flags: "IsComponentsV2",
      allowedMentions: page.allowedMentions,
    });
  };
}

export class ReleaseAnnouncer {
  constructor(
    private readonly state: BotStateRepository,
    private readonly settings: ISettingsService,
    private readonly guildIds: () => Iterable<string>,
    private readonly send: (guildId: string, channelId: string, page: ReleasePage) => Promise<void>,
  ) {}

  async announce(versionText: string, notes: ReleaseNotes | undefined): Promise<void> {
    try {
      const current = parseVersion(versionText);
      if (!current || !notes) throw new Error("Release version or CHANGELOG is unreadable");
      const prepared = notes.versions().map((version) => {
        const section = notes.section(version);
        return {
          version,
          pages:
            section?.status === "ok"
              ? buildReleaseNotePages(
                  version,
                  section.body,
                  `DisQord v${formatVersion(version)} をリリースしました`,
                )
              : undefined,
        };
      });
      const releases = this.state.claimRelease(formatVersion(current), (stored) => {
        const previous = stored === null ? undefined : parseVersion(stored);
        if (stored !== null && !previous)
          throw new Error(`Unreadable stored release version: ${stored}`);
        if (previous && compareVersions(current, previous) <= 0) return undefined;
        if (notes.section(current)?.status !== "ok")
          throw new Error(`Missing or broken release section: ${versionText}`);
        const selected = prepared.filter(
          ({ version }) =>
            compareVersions(version, current) <= 0 &&
            (!previous || compareVersions(version, previous) > 0),
        );
        if (!previous) return [];
        if (selected.some(({ pages }) => !pages))
          throw new Error("Broken release section in announcement range");
        return selected.sort((a, b) => compareVersions(a.version, b.version));
      });
      if (!releases?.length) return;
      for (const guildId of this.guildIds()) {
        let version: string | undefined;
        let page = 0;
        try {
          const channelId = (await this.settings.getGuildSettings(guildId))
            .releaseAnnounceChannelId;
          if (!channelId) continue;
          for (const release of releases) {
            version = formatVersion(release.version);
            page = 0;
            for (const payload of release.pages ?? []) {
              page++;
              await this.send(guildId, channelId, payload);
              logger.info("Release announcement sent", { version, guildId, page, result: "sent" });
            }
          }
        } catch (error) {
          logger.error("Release announcement failed for guild", {
            version,
            guildId,
            page,
            result: "failed",
            error,
          });
        }
      }
    } catch (error) {
      logger.error("Release announcement skipped", { version: versionText, error });
    }
  }
}
