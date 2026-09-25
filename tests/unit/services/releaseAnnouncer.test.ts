import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelType,
  type Client,
  type Guild,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import { BotStateRepository } from "../../../src/db/repositories/botState";
import { GuildSettingsRepository } from "../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../src/db/schema";
import {
  createReleaseSender,
  ReleaseAnnouncer,
  resolveReleaseChannel,
} from "../../../src/services/releaseAnnouncer";
import { parseChangelog, type ReleaseNotes } from "../../../src/services/releaseNotes";
import { SettingsService } from "../../../src/services/settingsService";

const KEY = "last_processed_release_version";
const section = (version: string): string => `## [${version}] - 2026-09-25\n- change ${version}\n`;
const notes = parseChangelog(["1.10.0", "1.4.0", "1.2.0", "1.0.0"].map(section).join("\n"));

describe("release announcements", () => {
  let db: Database;
  let settings: SettingsService;
  let state: BotStateRepository;
  let errorLog: ReturnType<typeof spyOn>;
  let infoLog: ReturnType<typeof spyOn>;
  const send = mock(async (_guild: string, _channel: string, _page: unknown): Promise<void> => {});
  function stored(): string | null {
    return (
      db.query<{ value: string }, [string]>("SELECT value FROM bot_state WHERE key = ?").get(KEY)
        ?.value ?? null
    );
  }
  function seed(value: string): void {
    db.query("INSERT OR REPLACE INTO bot_state VALUES (?, ?)").run(KEY, value);
  }
  function announcer(repository = state): ReleaseAnnouncer {
    return new ReleaseAnnouncer(repository, settings, () => ["a", "b"], send);
  }
  beforeEach(async () => {
    db = new Database(":memory:");
    applyMigrations(db);
    state = new BotStateRepository(db);
    settings = new SettingsService(new GuildSettingsRepository(db, "model"));
    await settings.setReleaseAnnounceChannelId("a", "channel-a");
    await settings.setReleaseAnnounceChannelId("b", "channel-b");
    send.mockReset();
    send.mockImplementation(async (): Promise<void> => {});
    errorLog = spyOn(console, "error").mockImplementation(() => {});
    infoLog = spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    db.close();
    errorLog.mockRestore();
    infoLog.mockRestore();
  });
  test("first startup records only the current version", async () => {
    await announcer().announce("1.4.0", notes);
    expect(stored()).toBe("1.4.0");
    expect(send).not.toHaveBeenCalled();
  });
  test.each(["1.4.0", "1.2.0"])(
    "same version or rollback %s never lowers the record",
    async (version) => {
      seed("1.4.0");
      await announcer().announce(version, notes);
      await announcer().announce("1.4.0", notes);
      expect(stored()).toBe("1.4.0");
      expect(send).not.toHaveBeenCalled();
    },
  );
  test("skipped versions send oldest first, with commit before the first send", async () => {
    seed("1.0.0");
    send.mockImplementation(async (): Promise<void> => {
      expect(db.inTransaction).toBe(false);
      expect(stored()).toBe("1.10.0");
    });
    await announcer().announce("1.10.0", notes);
    expect(send).toHaveBeenCalledTimes(6);
    for (const guild of ["a", "b"]) {
      const calls = send.mock.calls.filter(([id]) => id === guild);
      for (const [index, version] of ["1.2.0", "1.4.0", "1.10.0"].entries()) {
        const payload = calls[index]?.[2] as { flags: number; allowedMentions: unknown };
        expect(JSON.stringify(payload)).toContain(`DisQord v${version} をリリースしました`);
        expect(payload.allowedMentions).toEqual({ parse: [] });
        expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
      }
    }
  });
  test.each([
    ["1.4.0", section("1.0.0")],
    ["1.4.0", section("1.4.0") + section("1.4.0")],
    ["1.4.0", "## [1.4.0] - broken\n"],
    ["1.4.0-rc.1", section("1.4.0-rc.1")],
    ["1.4.0+build", section("1.4.0+build")],
  ])("invalid initial release %s leaves a fresh DB untouched", async (version, changelog) => {
    await announcer().announce(version, parseChangelog(changelog));
    expect(stored()).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalled();
  });
  test.each(["invalid", "1.2.0-rc.1", "1.2.0+build", ""])(
    "unreadable record %s is preserved",
    async (value) => {
      seed(value);
      await announcer().announce("1.4.0", notes);
      expect(stored()).toBe(value);
      expect(send).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalled();
    },
  );
  test.each([section("1.2.0") + section("1.2.0"), "## [1.2.0] - invalid\n"])(
    "broken intermediate section stops the whole range",
    async (broken) => {
      seed("1.0.0");
      await announcer().announce("1.4.0", parseChangelog(section("1.4.0") + broken));
      expect(stored()).toBe("1.0.0");
      expect(send).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalled();
    },
  );
  test("missing current section never advances a stored record", async () => {
    seed("1.0.0");
    await announcer().announce("1.5.0", notes);
    expect(stored()).toBe("1.0.0");
    expect(send).not.toHaveBeenCalled();
  });
  test("long announcements send every page with mentions suppressed and page results logged", async () => {
    seed("1.2.0");
    const long = `${section("1.4.0")}${"- @everyone 変更点の詳しい説明\n".repeat(600)}`;
    await announcer().announce("1.4.0", parseChangelog(long));
    const pages = send.mock.calls.filter(([guild]) => guild === "a");
    expect(pages.length).toBeGreaterThan(1);
    for (const [index, [, , payload]] of pages.entries()) {
      expect(JSON.stringify(payload)).toContain('"parse":[]');
      expect(JSON.stringify(payload).includes("DisQord v1.4.0 をリリースしました")).toBe(
        index === 0,
      );
      expect(infoLog).toHaveBeenCalledWith(
        expect.stringContaining(`"page":${index + 1},"result":"sent"`),
      );
    }
  });
  test("broken sections outside the range do not block valid releases", async () => {
    seed("1.0.0");
    await announcer().announce(
      "1.4.0",
      parseChangelog(`${section("1.4.0")}## [2.0.0] - broken\n## [0.5.0] - broken\n`),
    );
    expect(stored()).toBe("1.4.0");
    expect(send).toHaveBeenCalledTimes(2);
  });
  test("first startup ignores broken older sections", async () => {
    await announcer().announce("1.4.0", parseChangelog(`${section("1.4.0")}## [1.0.0] - broken\n`));
    expect(stored()).toBe("1.4.0");
  });
  test("no destinations still consumes the release opportunity", async () => {
    seed("1.0.0");
    await settings.setReleaseAnnounceChannelId("a", null);
    await settings.setReleaseAnnounceChannelId("b", null);
    await announcer().announce("1.4.0", notes);
    await settings.setReleaseAnnounceChannelId("a", "channel-a");
    await announcer().announce("1.4.0", notes);
    expect(stored()).toBe("1.4.0");
    expect(send).not.toHaveBeenCalled();
  });
  test("one guild failure does not stop another or cause retries on restart", async () => {
    seed("1.2.0");
    send.mockImplementation(async (guild): Promise<void> => {
      if (guild === "a") throw new Error("Forbidden");
    });
    await announcer().announce("1.4.0", notes);
    await announcer().announce("1.4.0", notes);
    expect(send.mock.calls.map(([guild]) => guild)).toEqual(["a", "b"]);
    expect(stored()).toBe("1.4.0");
    expect(errorLog).toHaveBeenCalled();
  });
  test("concurrent startup claims through separate connections send only once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "disqord-release-"));
    const first = new Database(join(dir, "state.db"));
    first.run("PRAGMA journal_mode = WAL");
    applyMigrations(first);
    first.query("INSERT INTO bot_state VALUES (?, ?)").run(KEY, "1.2.0");
    const second = new Database(join(dir, "state.db"));
    second.run("PRAGMA busy_timeout = 0");
    try {
      let competing: Promise<void> | undefined;
      const competingSend = mock(async (): Promise<void> => {});
      const other = new ReleaseAnnouncer(
        new BotStateRepository(second),
        settings,
        () => ["a", "b"],
        competingSend,
      );
      class OverlappingState extends BotStateRepository {
        override claimRelease<T>(
          version: string,
          select: (stored: string | null) => T | undefined,
        ): T | undefined {
          return super.claimRelease(version, (stored) => {
            // Enter the competing claim before this claim writes or commits, without scheduler timing.
            competing = other.announce("1.4.0", notes);
            return select(stored);
          });
        }
      }
      await announcer(new OverlappingState(first)).announce("1.4.0", notes);
      expect(competing).toBeDefined();
      await competing;
      expect(competingSend).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("SQLITE_BUSY"));
      expect(send).toHaveBeenCalledTimes(2);
      expect(
        first
          .query<{ value: string }, [string]>("SELECT value FROM bot_state WHERE key = ?")
          .get(KEY)?.value,
      ).toBe("1.4.0");
      await other.announce("1.4.0", notes);
      expect(competingSend).not.toHaveBeenCalled();
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true });
    }
  });
  test("missing notes, parsing failures, and DB errors are contained", async () => {
    await announcer().announce("1.4.0", undefined);
    const broken: ReleaseNotes = {
      versions: () => {
        throw new Error("render failed");
      },
      section: () => undefined,
    };
    await announcer().announce("1.4.0", broken);
    db.run("DROP TABLE bot_state");
    await announcer().announce("1.4.0", notes);
    expect(send).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(3);
  });
  test("legacy release_channel_id is never imported and settings retain audit metadata", async () => {
    db.run("ALTER TABLE guild_settings ADD COLUMN release_channel_id TEXT");
    await settings.setReleaseAnnounceChannelId("a", null);
    db.run("ALTER TABLE guild_settings DROP COLUMN release_announce_channel_id");
    db.run("UPDATE guild_settings SET release_channel_id = 'legacy'");
    applyMigrations(db);
    expect((await settings.getGuildSettings("a")).releaseAnnounceChannelId).toBeNull();
    const before = await settings.getGuildSettings("a");
    const after = await settings.setReleaseAnnounceChannelId("a", "new", "actor");
    expect(after.settingsVersion).toBe(before.settingsVersion + 1);
    expect(after.updatedBy).toBe("actor");
    expect(after.releaseAnnounceChannelId).toBe("new");
  });
});

describe("Discord release destination", () => {
  test.each([
    [
      ChannelType.GuildText,
      "guild",
      [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      true,
    ],
    [
      ChannelType.GuildAnnouncement,
      "guild",
      [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      true,
    ],
    [
      ChannelType.PublicThread,
      "guild",
      [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      false,
    ],
    [
      ChannelType.GuildText,
      "other",
      [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      false,
    ],
    [ChannelType.GuildText, "guild", [PermissionFlagsBits.ViewChannel], false],
    [ChannelType.GuildText, "guild", [PermissionFlagsBits.SendMessages], false],
  ] as const)(
    "validates type %s, guild %s and permissions %s",
    async (type, guildId, permissions, valid) => {
      const channel = {
        type,
        guildId,
        permissionsFor: () => new PermissionsBitField([...permissions]),
        send: mock(async (_payload: unknown) => {}),
      };
      const guild = {
        id: "guild",
        channels: { fetch: mock(async () => channel) },
        members: { fetchMe: mock(async () => ({})) },
      } as unknown as Guild;
      const client = { guilds: { fetch: mock(async () => guild) } } as unknown as Client;
      const send = createReleaseSender(client);
      if (valid) {
        await send("guild", "channel", { components: [], allowedMentions: { parse: [] } });
        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(channel.send.mock.calls[0]).toEqual([
          { components: [], flags: "IsComponentsV2", allowedMentions: { parse: [] } },
        ]);
      } else {
        await expect(send("guild", "channel", {})).rejects.toThrow();
        expect(channel.send).not.toHaveBeenCalled();
      }
      expect(guild.channels.fetch).toHaveBeenCalledWith("channel", { force: true });
    },
  );
  test("deleted channels are rejected", async () => {
    const guild = { id: "guild", channels: { fetch: async () => null } } as unknown as Guild;
    await expect(resolveReleaseChannel(guild, "deleted")).rejects.toThrow();
  });
});
