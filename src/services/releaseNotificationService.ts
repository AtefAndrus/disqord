import type { Client, TextChannel } from "discord.js";
import type { GitHubReleasePayload, NotificationResult } from "../types/github";
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

    const message = this.formatMessage(payload);

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

        await (channel as TextChannel).send(message);
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

  private formatMessage(payload: GitHubReleasePayload): string {
    const { release, repository } = payload;
    const title = release.name || release.tag_name;
    const body = release.body ? this.truncateBody(release.body) : "";

    let message = `**${repository.name} ${title} がリリースされました**`;

    if (body) {
      message += `\n\n${body}`;
    }

    message += `\n\n詳細: <${release.html_url}>`;

    return message;
  }

  private truncateBody(body: string, maxLength = 1500): string {
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
