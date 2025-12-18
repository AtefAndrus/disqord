import { beforeEach, describe, expect, type mock, test } from "bun:test";
import type { IGuildSettingsRepository } from "../../../src/db/repositories/guildSettings";
import { SettingsService } from "../../../src/services/settingsService";
import {
  createMockGuildSettings,
  createMockGuildSettingsRepository,
} from "../../helpers/mockFactories";

const TEST_DEFAULT_MODEL = "test/default-model";

describe("SettingsService", () => {
  let settingsService: SettingsService;
  let mockRepo: IGuildSettingsRepository;

  beforeEach(() => {
    mockRepo = createMockGuildSettingsRepository();
    settingsService = new SettingsService(mockRepo, TEST_DEFAULT_MODEL);
  });

  describe("getGuildSettings", () => {
    test("既存の設定がある場合はそれを返す", async () => {
      const existingSettings = createMockGuildSettings({
        guildId: "guild-123",
        defaultModel: "existing-model",
      });
      (mockRepo.findByGuildId as ReturnType<typeof mock>).mockResolvedValueOnce(existingSettings);

      const result = await settingsService.getGuildSettings("guild-123");

      expect(result).toEqual(existingSettings);
      expect(mockRepo.upsert).not.toHaveBeenCalled();
    });

    test("設定が存在しない場合はデフォルト設定を作成", async () => {
      (mockRepo.findByGuildId as ReturnType<typeof mock>).mockResolvedValueOnce(null);

      await settingsService.getGuildSettings("guild-456");

      expect(mockRepo.upsert).toHaveBeenCalled();
    });

    test("デフォルトモデルが正しい値", async () => {
      (mockRepo.findByGuildId as ReturnType<typeof mock>).mockResolvedValueOnce(null);

      const result = await settingsService.getGuildSettings("guild-789");

      expect(result.defaultModel).toBe(TEST_DEFAULT_MODEL);
    });
  });

  describe("setGuildModel", () => {
    test("指定したモデルでupsertを呼び出す", async () => {
      await settingsService.setGuildModel("guild-123", "new-model");

      expect(mockRepo.upsert).toHaveBeenCalledWith(
        "guild-123",
        expect.objectContaining({
          guildId: "guild-123",
          defaultModel: "new-model",
        }),
      );
    });

    test("更新後の設定を返す", async () => {
      const updatedSettings = createMockGuildSettings({
        guildId: "guild-123",
        defaultModel: "updated-model",
      });
      (mockRepo.upsert as ReturnType<typeof mock>).mockResolvedValueOnce(updatedSettings);

      const result = await settingsService.setGuildModel("guild-123", "updated-model");

      expect(result.defaultModel).toBe("updated-model");
    });

    test("updatedAtが含まれる", async () => {
      await settingsService.setGuildModel("guild-123", "some-model");

      expect(mockRepo.upsert).toHaveBeenCalledWith(
        "guild-123",
        expect.objectContaining({
          updatedAt: expect.any(String),
        }),
      );
    });
  });
});
