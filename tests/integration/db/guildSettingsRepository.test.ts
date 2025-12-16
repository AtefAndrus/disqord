import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GuildSettingsRepository } from "../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../src/db/schema";

describe("GuildSettingsRepository", () => {
  let db: Database;
  let repo: GuildSettingsRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    repo = new GuildSettingsRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("findByGuildId", () => {
    test("存在しないギルドIDはnullを返す", async () => {
      const result = await repo.findByGuildId("non-existent-guild");
      expect(result).toBeNull();
    });

    test("存在するギルドの設定を返す", async () => {
      await repo.upsert("guild-123", { defaultModel: "test-model" });

      const result = await repo.findByGuildId("guild-123");

      expect(result).not.toBeNull();
      expect(result?.guildId).toBe("guild-123");
      expect(result?.defaultModel).toBe("test-model");
    });

    test("カラムマッピングが正しい（snake_case → camelCase）", async () => {
      await repo.upsert("guild-456", { defaultModel: "model-x" });

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

  describe("upsert", () => {
    test("新規レコードを挿入する", async () => {
      const result = await repo.upsert("new-guild", { defaultModel: "new-model" });

      expect(result.guildId).toBe("new-guild");
      expect(result.defaultModel).toBe("new-model");

      const found = await repo.findByGuildId("new-guild");
      expect(found).not.toBeNull();
    });

    test("既存レコードを更新する", async () => {
      await repo.upsert("guild-update", { defaultModel: "old-model" });
      await repo.upsert("guild-update", { defaultModel: "updated-model" });

      const result = await repo.findByGuildId("guild-update");

      expect(result?.defaultModel).toBe("updated-model");
    });

    test("defaultModelが未指定の場合はデフォルト値を使用", async () => {
      const result = await repo.upsert("guild-default", {});

      expect(result.defaultModel).toBe("google/gemini-2.0-flash-exp:free");
    });

    test("createdAtとupdatedAtが設定される", async () => {
      const result = await repo.upsert("guild-timestamps", { defaultModel: "test" });

      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
      expect(typeof result.createdAt).toBe("string");
      expect(typeof result.updatedAt).toBe("string");
    });

    test("更新時にupdatedAtのみ変更される", async () => {
      const original = await repo.upsert("guild-partial", { defaultModel: "v1" });
      const originalCreatedAt = original.createdAt;

      await new Promise((resolve) => setTimeout(resolve, 10));

      await repo.upsert("guild-partial", {
        defaultModel: "v2",
        updatedAt: new Date().toISOString(),
      });

      const found = await repo.findByGuildId("guild-partial");
      expect(found?.createdAt).toBe(originalCreatedAt);
    });
  });

  describe("delete", () => {
    test("存在するレコードを削除してtrueを返す", async () => {
      await repo.upsert("guild-to-delete", { defaultModel: "test" });

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
        repo.upsert("guild-a", { defaultModel: "model-a" }),
        repo.upsert("guild-b", { defaultModel: "model-b" }),
        repo.upsert("guild-c", { defaultModel: "model-c" }),
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
