import { describe, expect, it, mock } from "bun:test";
import { ReleaseNotificationService } from "../../src/services/releaseNotificationService";
import type { GitHubReleasePayload } from "../../src/types/github";
import { createMockGuildSettings, createMockSettingsService } from "../helpers/mockFactories";

function createMockClient() {
  return {
    channels: {
      fetch: mock(() => Promise.resolve(null)),
    },
  } as unknown as import("discord.js").Client;
}

function createMockTextChannel() {
  return {
    isTextBased: () => true,
    send: mock(() => Promise.resolve()),
  };
}

function createReleasePayload(overrides?: Partial<GitHubReleasePayload>): GitHubReleasePayload {
  return {
    action: "released",
    release: {
      id: 123,
      tag_name: "v1.0.0",
      name: "Release 1.0.0",
      body: "This is a test release with some notes.",
      html_url: "https://github.com/test/repo/releases/tag/v1.0.0",
      prerelease: false,
      draft: false,
      created_at: "2025-01-01T00:00:00Z",
      published_at: "2025-01-01T00:00:00Z",
      author: {
        login: "testuser",
        avatar_url: "https://example.com/avatar.png",
      },
    },
    repository: {
      id: 456,
      name: "repo",
      full_name: "test/repo",
      html_url: "https://github.com/test/repo",
    },
    sender: {
      login: "testuser",
      avatar_url: "https://example.com/avatar.png",
    },
    ...overrides,
  };
}

describe("ReleaseNotificationService", () => {
  describe("notify", () => {
    it("should skip non-released actions", async () => {
      const client = createMockClient();
      const settingsService = createMockSettingsService();
      const service = new ReleaseNotificationService(client, settingsService);

      const payload = createReleasePayload({ action: "published" });
      const result = await service.notify(payload);

      expect(result.skipped).toBe(1);
      expect(result.success).toBe(0);
      expect(result.failed).toBe(0);
    });

    it("should return empty result when no guilds have release channel", async () => {
      const client = createMockClient();
      const settingsService = createMockSettingsService();
      const service = new ReleaseNotificationService(client, settingsService);

      const payload = createReleasePayload();
      const result = await service.notify(payload);

      expect(result.success).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it("should send notification to configured channels", async () => {
      const mockChannel = createMockTextChannel();
      const client = createMockClient();
      (client.channels.fetch as ReturnType<typeof mock>).mockResolvedValue(mockChannel);

      const settingsService = createMockSettingsService();
      (settingsService.getGuildsWithReleaseChannel as ReturnType<typeof mock>).mockResolvedValue([
        createMockGuildSettings({ releaseChannelId: "channel-1" }),
      ]);

      const service = new ReleaseNotificationService(client, settingsService);

      const payload = createReleasePayload();
      const result = await service.notify(payload);

      expect(result.success).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockChannel.send).toHaveBeenCalled();
    });

    it("should count failed when channel not found", async () => {
      const client = createMockClient();
      (client.channels.fetch as ReturnType<typeof mock>).mockResolvedValue(null);

      const settingsService = createMockSettingsService();
      (settingsService.getGuildsWithReleaseChannel as ReturnType<typeof mock>).mockResolvedValue([
        createMockGuildSettings({ releaseChannelId: "channel-1" }),
      ]);

      const service = new ReleaseNotificationService(client, settingsService);

      const payload = createReleasePayload();
      const result = await service.notify(payload);

      expect(result.success).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].error).toContain("not found");
    });

    it("should count failed when send throws error", async () => {
      const mockChannel = createMockTextChannel();
      (mockChannel.send as ReturnType<typeof mock>).mockRejectedValue(
        new Error("Permission denied"),
      );

      const client = createMockClient();
      (client.channels.fetch as ReturnType<typeof mock>).mockResolvedValue(mockChannel);

      const settingsService = createMockSettingsService();
      (settingsService.getGuildsWithReleaseChannel as ReturnType<typeof mock>).mockResolvedValue([
        createMockGuildSettings({ releaseChannelId: "channel-1" }),
      ]);

      const service = new ReleaseNotificationService(client, settingsService);

      const payload = createReleasePayload();
      const result = await service.notify(payload);

      expect(result.success).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toBe("Permission denied");
    });

    it("should handle multiple guilds", async () => {
      const mockChannel = createMockTextChannel();
      const client = createMockClient();
      (client.channels.fetch as ReturnType<typeof mock>).mockResolvedValue(mockChannel);

      const settingsService = createMockSettingsService();
      (settingsService.getGuildsWithReleaseChannel as ReturnType<typeof mock>).mockResolvedValue([
        createMockGuildSettings({ guildId: "guild-1", releaseChannelId: "channel-1" }),
        createMockGuildSettings({ guildId: "guild-2", releaseChannelId: "channel-2" }),
        createMockGuildSettings({ guildId: "guild-3", releaseChannelId: "channel-3" }),
      ]);

      const service = new ReleaseNotificationService(client, settingsService);

      const payload = createReleasePayload();
      const result = await service.notify(payload);

      expect(result.success).toBe(3);
      expect(result.failed).toBe(0);
    });

    it("should format message correctly", async () => {
      const mockChannel = createMockTextChannel();
      const client = createMockClient();
      (client.channels.fetch as ReturnType<typeof mock>).mockResolvedValue(mockChannel);

      const settingsService = createMockSettingsService();
      (settingsService.getGuildsWithReleaseChannel as ReturnType<typeof mock>).mockResolvedValue([
        createMockGuildSettings({ releaseChannelId: "channel-1" }),
      ]);

      const service = new ReleaseNotificationService(client, settingsService);

      const payload = createReleasePayload({
        release: {
          id: 123,
          tag_name: "v2.0.0",
          name: "Version 2.0.0",
          body: "New features and bug fixes.",
          html_url: "https://github.com/test/repo/releases/tag/v2.0.0",
          prerelease: false,
          draft: false,
          created_at: "2025-01-01T00:00:00Z",
          published_at: "2025-01-01T00:00:00Z",
          author: {
            login: "testuser",
            avatar_url: "https://example.com/avatar.png",
          },
        },
      });

      await service.notify(payload);

      const sendCall = (mockChannel.send as ReturnType<typeof mock>).mock.calls[0];
      const message = sendCall[0] as string;

      expect(message).toContain("**repo Version 2.0.0 がリリースされました**");
      expect(message).toContain("New features and bug fixes.");
      expect(message).toContain("https://github.com/test/repo/releases/tag/v2.0.0");
    });

    it("should use tag_name when release name is null", async () => {
      const mockChannel = createMockTextChannel();
      const client = createMockClient();
      (client.channels.fetch as ReturnType<typeof mock>).mockResolvedValue(mockChannel);

      const settingsService = createMockSettingsService();
      (settingsService.getGuildsWithReleaseChannel as ReturnType<typeof mock>).mockResolvedValue([
        createMockGuildSettings({ releaseChannelId: "channel-1" }),
      ]);

      const service = new ReleaseNotificationService(client, settingsService);

      const payload = createReleasePayload({
        release: {
          id: 123,
          tag_name: "v1.0.0",
          name: null,
          body: null,
          html_url: "https://github.com/test/repo/releases/tag/v1.0.0",
          prerelease: false,
          draft: false,
          created_at: "2025-01-01T00:00:00Z",
          published_at: null,
          author: {
            login: "testuser",
            avatar_url: "https://example.com/avatar.png",
          },
        },
      });

      await service.notify(payload);

      const sendCall = (mockChannel.send as ReturnType<typeof mock>).mock.calls[0];
      const message = sendCall[0] as string;

      expect(message).toContain("v1.0.0");
    });
  });
});
