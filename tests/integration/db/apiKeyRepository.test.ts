import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiKeyRepository } from "../../../src/db/repositories/apiKey";
import { ReplyRecordRepository } from "../../../src/db/repositories/replyRecord";
import { applyMigrations, assertEncryptionKeyConfigured } from "../../../src/db/schema";

describe("API key persistence", () => {
  let db: Database;
  let repo: ApiKeyRepository;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    repo = new ApiKeyRepository(db);
  });
  afterEach(() => db.close());
  test("isolates scopes, upserts, and deletes only departed guilds", () => {
    for (const scope of ["user", "guild"] as const)
      for (const ownerId of ["one", "two"])
        repo.upsert({ ownerId, scope, encryptedKey: "cipher", iv: "iv", authTag: "tag" });
    repo.upsert({ ownerId: "one", scope: "guild", encryptedKey: "new", iv: "iv", authTag: "tag" });
    expect(repo.find("one", "guild")?.encryptedKey).toBe("new");
    expect(repo.find("one", "user")?.encryptedKey).toBe("cipher");
    expect(repo.deleteGuildsNotIn(["two"])).toBe(1);
    expect(repo.find("one", "guild")).toBeNull();
    expect(repo.find("one", "user")).not.toBeNull();
    expect(repo.deleteGuildsNotIn([])).toBe(1);
    expect(repo.delete("one", "user")).toBe(true);
    expect(repo.delete("one", "user")).toBe(false);
  });
  test("startup rejects saved rows without ENCRYPTION_KEY", () => {
    expect(() => assertEncryptionKeyConfigured(db, undefined)).not.toThrow();
    repo.upsert({
      ownerId: "one",
      scope: "user",
      encryptedKey: "cipher",
      iv: "iv",
      authTag: "tag",
    });
    expect(() => assertEncryptionKeyConfigured(db, undefined)).toThrow(
      "ENCRYPTION_KEY is required while api_keys contains saved keys",
    );
    expect(() => assertEncryptionKeyConfigured(db, "12".repeat(32))).not.toThrow();
  });
  test("saves each generation's key source and migrates existing generations", () => {
    const replies = new ReplyRecordRepository(db);
    replies.createPending({ triggerMsgId: "trigger", channelId: "channel", guildId: "guild" });
    for (const keySource of ["user", "guild", "default"] as const)
      replies.appendGenerations("trigger", [{ id: keySource, serverTools: false, keySource }]);
    expect(replies.listGenerations("trigger").map((row) => row.keySource)).toEqual([
      "user",
      "guild",
      "default",
    ]);
    db.run("ALTER TABLE reply_generations DROP COLUMN key_source");
    applyMigrations(db);
    applyMigrations(db);
    expect(replies.listGenerations("trigger").map((row) => row.keySource)).toEqual([
      "default",
      "default",
      "default",
    ]);
  });
});
