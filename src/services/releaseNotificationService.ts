import type { Client, EmbedBuilder, TextChannel } from "discord.js";
import { EmbedColors } from "../types/embed";
import type { GitHubReleasePayload, NotificationResult } from "../types/github";
import { createEmbed } from "../utils/embedBuilder";
import { logger } from "../utils/logger";
import type { ISettingsService } from "./settingsService";

export interface IReleaseNotificationService {
  notify(payload: GitHubReleasePayload): Promise<NotificationResult>;
}

export class ReleaseNotificationService implements IReleaseNotificationService {
  constructor(
    private readonly client: Client,
    private readonly settingsService: ISettingsService,
  ) {}

  async notify(payload: GitHubReleasePayload): Promise<NotificationResult> {
    const result: NotificationResult = {
      success: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    };

    // Only process "released" action (excludes pre-releases)
    if (payload.action !== "released") {
      logger.info("Skipping non-released action", { action: payload.action });
      result.skipped = 1;
      return result;
    }

    const guilds = await this.settingsService.getGuildsWithReleaseChannel();

    if (guilds.length === 0) {
      logger.info("No guilds with release channel configured");
      return result;
    }

    const embed = this.createReleaseEmbed(payload);

    for (const guild of guilds) {
      if (!guild.releaseChannelId) {
        continue;
      }

      try {
        const channel = await this.client.channels.fetch(guild.releaseChannelId);

        if (!channel || !channel.isTextBased()) {
          result.failed++;
          result.errors.push({
            guildId: guild.guildId,
            channelId: guild.releaseChannelId,
            error: "Channel not found or not a text channel",
          });
          continue;
        }

        await (channel as TextChannel).send({ embeds: [embed] });
        result.success++;

        logger.info("Release notification sent", {
          guildId: guild.guildId,
          channelId: guild.releaseChannelId,
          tag: payload.release.tag_name,
        });
      } catch (error) {
        result.failed++;
        result.errors.push({
          guildId: guild.guildId,
          channelId: guild.releaseChannelId,
          error: error instanceof Error ? error.message : String(error),
        });

        logger.error("Failed to send release notification", {
          guildId: guild.guildId,
          channelId: guild.releaseChannelId,
          error,
        });
      }
    }

    return result;
  }

  private createReleaseEmbed(payload: GitHubReleasePayload): EmbedBuilder {
    const { release, repository } = payload;
    const title = release.name || release.tag_name;
    const body = release.body ? this.truncateBody(release.body, 3800) : "";

    const timestamp = release.published_at ? new Date(release.published_at) : new Date();

    return createEmbed({
      color: EmbedColors.BLURPLE,
      title: `${repository.name} ${title}`,
      description: body || "リリースノートはありません。",
      url: release.html_url,
      author: {
        name: release.author.login,
        iconURL: release.author.avatar_url,
        url: `https://github.com/${release.author.login}`,
      },
      thumbnail: release.author.avatar_url,
      timestamp,
      footer: {
        text: `GitHub Release - ${repository.full_name}`,
      },
    });
  }

  private truncateBody(body: string, maxLength = 3800): string {
    // Remove markdown images and links to keep it concise
    const cleaned = body
      .replace(/!\[.*?\]\(.*?\)/g, "") // Remove images
      .replace(/\r\n/g, "\n") // Normalize line endings
      .trim();

    if (cleaned.length <= maxLength) {
      return cleaned;
    }

    return `${cleaned.slice(0, maxLength)}...`;
  }
}
