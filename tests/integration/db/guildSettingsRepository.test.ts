import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GuildSettingsRepository } from "../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../src/db/schema";

const TEST_DEFAULT_MODEL = "test/default-model";

describe("GuildSettingsRepository", () => {
  let db: Database;
  let repo: GuildSettingsRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    applyMigrations(db);
    repo = new GuildSettingsRepository(db, TEST_DEFAULT_MODEL);
  });

  afterEach(() => {
    db.close();
  });

  describe("findByGuildId", () => {
    test("version and actor change only for nonempty mutations, including history", async () => {
      const initial = await repo.update("guild", () => ({}));
      expect(initial.settingsVersion).toBe(0);
      expect(initial.updatedBy).toBeNull();
      expect(initial.allowedChannels).toBeNull();
      await repo.update(
        "guild",
        () => ({ allowedChannels: ["channel"], adminRoleId: "role" }),
        "actor",
      );
      const changed = await repo.findByGuildId("guild");
      if (!changed) throw new Error("missing guild");
      expect(changed).toMatchObject({
        settingsVersion: 1,
        updatedBy: "actor",
        allowedChannels: ["channel"],
        adminRoleId: "role",
      });
      expect(await repo.update("guild", () => ({}), "ignored")).toEqual(changed);
      expect(await repo.setHistoryEnabled("guild", true, "history-actor")).toMatchObject({
        settingsVersion: 2,
        updatedBy: "history-actor",
        historyEnabled: true,
      });
      expect(await repo.update("guild", () => ({ showLlmDetails: false }))).toMatchObject({
        settingsVersion: 3,
        updatedBy: null,
      });
      await expect(
        repo.update(
          "guild",
          () => {
            throw new Error("rejected");
          },
          "bad",
        ),
      ).rejects.toThrow("rejected");
      expect((await repo.findByGuildId("guild"))?.settingsVersion).toBe(3);
    });
    test("存在しないギルドIDはnullを返す", async () => {
      const result = await repo.findByGuildId("non-existent-guild");
      expect(result).toBeNull();
    });

    test("存在するギルドの設定を返す", async () => {
      await repo.update("guild-123", () => ({ defaultModel: "test-model" }));

      const result = await repo.findByGuildId("guild-123");

      expect(result).not.toBeNull();
      expect(result?.guildId).toBe("guild-123");
      expect(result?.defaultModel).toBe("test-model");
    });

    test("カラムマッピングが正しい（snake_case → camelCase）", async () => {
      await repo.update("guild-456", () => ({ defaultModel: "model-x" }));

      const result = await repo.findByGuildId("guild-456");

      expect(result).toHaveProperty("guildId");
      expect(result).toHaveProperty("defaultModel");
      expect(result).toHaveProperty("createdAt");
      expect(result).toHaveProperty("updatedAt");
      expect(result).not.toHaveProperty("guild_id");
      expect(result).not.toHaveProperty("default_model");
      expect(result).not.toHaveProperty("created_at");
      expect(result).not.toHaveProperty("updated_at");
    });
  });

  describe("update", () => {
    test("行が無ければ既定値で作ってから、返した列を書く", async () => {
      const result = await repo.update("new-guild", () => ({ defaultModel: "new-model" }));

      expect(result).toMatchObject({
        guildId: "new-guild",
        defaultModel: "new-model",
        freeModelsOnly: false,
        showLlmDetails: true,
        autoReplyChannels: [],
        webSearchEnabled: false,
        reasoningDisplayEnabled: false,
        twitterExpandEnabled: true,
        historyEnabled: false,
      });
      expect(await repo.findByGuildId("new-guild")).toEqual(result);
    });

    test("何も返さなければ既定値の行を作るだけで、既定のモデルが入る", async () => {
      const result = await repo.update("guild-default", () => ({}));

      expect(result.defaultModel).toBe(TEST_DEFAULT_MODEL);
    });

    test("返さなかった列は保存された値のまま残す", async () => {
      await repo.update("guild-keep", () => ({
        webSearchEnabled: true,
        reasoningDisplayEnabled: true,
        twitterExpandEnabled: false,
        autoReplyChannels: ["c1"],
        showLlmDetails: false,
      }));

      await repo.update("guild-keep", () => ({ defaultModel: "other" }));

      expect(await repo.findByGuildId("guild-keep")).toMatchObject({
        defaultModel: "other",
        webSearchEnabled: true,
        reasoningDisplayEnabled: true,
        twitterExpandEnabled: false,
        autoReplyChannels: ["c1"],
        showLlmDetails: false,
      });
    });

    test("mutate には保存されている行が渡る", async () => {
      await repo.update("guild-seen", () => ({ webSearchEnabled: true }));

      let seen: boolean | undefined;
      await repo.update("guild-seen", (current) => {
        seen = current.webSearchEnabled;
        return {};
      });

      expect(seen).toBe(true);
    });

    test("ツイート展開の設定を読み書きできる", async () => {
      await repo.update("guild-twitter", () => ({ twitterExpandEnabled: false }));

      expect((await repo.findByGuildId("guild-twitter"))?.twitterExpandEnabled).toBe(false);

      await repo.update("guild-twitter", () => ({ twitterExpandEnabled: true }));
      expect((await repo.findByGuildId("guild-twitter"))?.twitterExpandEnabled).toBe(true);
    });

    test("会話履歴を切り替えても本文ストアを削除する処理は実行しない", async () => {
      await repo.setHistoryEnabled("guild-history", true);
      expect((await repo.findByGuildId("guild-history"))?.historyEnabled).toBe(true);

      await repo.setHistoryEnabled("guild-history", false);

      expect((await repo.findByGuildId("guild-history"))?.historyEnabled).toBe(false);
    });

    test("createdAt は変えず、書いたときだけ updatedAt を進める", async () => {
      const original = await repo.update("guild-time", () => ({ defaultModel: "v1" }));
      await new Promise((resolve) => setTimeout(resolve, 5));

      const unchanged = await repo.update("guild-time", () => ({}));
      expect(unchanged.updatedAt).toBe(original.updatedAt);

      const changed = await repo.update("guild-time", () => ({ defaultModel: "v2" }));
      expect(changed.createdAt).toBe(original.createdAt);
      expect(changed.updatedAt > original.updatedAt).toBe(true);
    });

    test("mutate が例外を投げたら、既存の行は変わらず、作りかけの行は残らない", async () => {
      await repo.update("guild-rollback", () => ({ defaultModel: "kept" }));

      await expect(
        repo.update("guild-rollback", () => {
          throw new Error("rejected");
        }),
      ).rejects.toThrow("rejected");
      await expect(
        repo.update("guild-never", () => {
          throw new Error("rejected");
        }),
      ).rejects.toThrow("rejected");

      expect((await repo.findByGuildId("guild-rollback"))?.defaultModel).toBe("kept");
      expect(await repo.findByGuildId("guild-never")).toBeNull();
    });
  });

  describe("旧スキーマ互換", () => {
    test("新規DBにrelease_channel_idカラムを作成しない", () => {
      const columns = db
        .query<{ name: string }, []>("PRAGMA table_info(guild_settings)")
        .all()
        .map((column) => column.name);

      expect(columns).not.toContain("release_channel_id");
    });

    test("既存のrelease_channel_idカラムを保持したまま他の設定を読み書きできる", async () => {
      const legacyDb = new Database(":memory:");
      legacyDb.run("PRAGMA foreign_keys = ON");
      try {
        legacyDb.run(`
          CREATE TABLE guild_settings (
            guild_id TEXT PRIMARY KEY,
            default_model TEXT NOT NULL,
            free_models_only INTEGER NOT NULL DEFAULT 0,
            release_channel_id TEXT DEFAULT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        legacyDb
          .query(
            `INSERT INTO guild_settings (guild_id, default_model, release_channel_id)
             VALUES (?, ?, ?)`,
          )
          .run("legacy-guild", "legacy-model", "legacy-channel");

        applyMigrations(legacyDb);
        const legacyRepo = new GuildSettingsRepository(legacyDb, TEST_DEFAULT_MODEL);

        const before = await legacyRepo.findByGuildId("legacy-guild");
        expect(before?.defaultModel).toBe("legacy-model");
        expect(before).not.toHaveProperty("releaseChannelId");
        // Existing guilds must not start paying for searches because of a migration.
        expect(before?.webSearchEnabled).toBe(false);
        expect(before?.reasoningDisplayEnabled).toBe(false);
        expect(before?.twitterExpandEnabled).toBe(true);

        await legacyRepo.update("legacy-guild", () => ({
          defaultModel: "updated-model",
          freeModelsOnly: true,
          showLlmDetails: false,
          autoReplyChannels: ["channel-1"],
        }));

        const after = await legacyRepo.findByGuildId("legacy-guild");
        const legacyColumn = legacyDb
          .query<{ releaseChannelId: string | null }, [string]>(
            `SELECT release_channel_id as releaseChannelId
             FROM guild_settings WHERE guild_id = ?`,
          )
          .get("legacy-guild");
        expect(after).toMatchObject({
          defaultModel: "updated-model",
          freeModelsOnly: true,
          showLlmDetails: false,
          autoReplyChannels: ["channel-1"],
        });
        expect(legacyColumn?.releaseChannelId).toBe("legacy-channel");
      } finally {
        legacyDb.close();
      }
    });
  });

  describe("delete", () => {
    test("存在するレコードを削除してtrueを返す", async () => {
      await repo.update("guild-to-delete", () => ({ defaultModel: "test" }));

      const result = await repo.delete("guild-to-delete");

      expect(result).toBe(true);

      const found = await repo.findByGuildId("guild-to-delete");
      expect(found).toBeNull();
    });

    test("存在しないレコードの削除はfalseを返す", async () => {
      const result = await repo.delete("non-existent-guild");

      expect(result).toBe(false);
    });
  });

  describe("並行操作", () => {
    test("複数の異なるギルドを同時に操作できる", async () => {
      const promises = [
        repo.update("guild-a", () => ({ defaultModel: "model-a" })),
        repo.update("guild-b", () => ({ defaultModel: "model-b" })),
        repo.update("guild-c", () => ({ defaultModel: "model-c" })),
      ];

      await Promise.all(promises);

      const [a, b, c] = await Promise.all([
        repo.findByGuildId("guild-a"),
        repo.findByGuildId("guild-b"),
        repo.findByGuildId("guild-c"),
      ]);

      expect(a?.defaultModel).toBe("model-a");
      expect(b?.defaultModel).toBe("model-b");
      expect(c?.defaultModel).toBe("model-c");
    });
  });
});
