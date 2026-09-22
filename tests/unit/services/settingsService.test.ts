import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GuildSettingsRepository } from "../../../src/db/repositories/guildSettings";
import { applyMigrations } from "../../../src/db/schema";
import { SettingsConflictError, SettingsRuleError } from "../../../src/errors";
import { SettingsService } from "../../../src/services/settingsService";

const DEFAULT_MODEL = "test/default-model";
const G = "guild-1";
const FREE = { model: "free/model:free", isFree: true };
const PAID = { model: "paid/model", isFree: false };

// A real SQLite database: the behaviour under test is what ends up stored
// when writes overlap, which a mocked repository cannot show.
describe("SettingsService", () => {
  let db: Database;
  let repo: GuildSettingsRepository;
  let service: SettingsService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    applyMigrations(db);
    repo = new GuildSettingsRepository(db, DEFAULT_MODEL);
    service = new SettingsService(repo);
  });

  afterEach(() => {
    db.close();
  });

  describe("getGuildSettings", () => {
    test("行が無ければ既定値の行を作り、保存された行を返す", async () => {
      const settings = await service.getGuildSettings(G);

      expect(settings).toMatchObject({
        guildId: G,
        defaultModel: DEFAULT_MODEL,
        freeModelsOnly: false,
        showLlmDetails: true,
        autoReplyChannels: [],
        webSearchEnabled: false,
        twitterExpandEnabled: true,
      });
      expect(await repo.findByGuildId(G)).toEqual(settings);
    });

    test("行の作成と同時に書き込みがあっても、書き込みを消さない", async () => {
      const [read, afterWrite] = await Promise.all([
        service.getGuildSettings(G),
        service.setWebSearchEnabled(G, true),
      ]);

      expect(afterWrite.webSearchEnabled).toBe(true);
      const stored = await repo.findByGuildId(G);
      if (!stored) throw new Error("row missing");
      expect(stored.webSearchEnabled).toBe(true);
      // 書き込みが先に確定するので、返すのはその後の保存された行で、手元で作った既定値ではない
      expect(read).toEqual(stored);
    });
  });

  describe("行が無いギルドへの各 setter", () => {
    test("setter ごとに、その値を持つ行を作る", async () => {
      await service.setShowLlmDetails("g-llm", false);
      await service.setWebSearchEnabled("g-ws", true);
      await service.setTwitterExpandEnabled("g-twitter", false);
      await service.setGuildModel("g-model", PAID);
      await service.addAutoReplyChannel("g-ch", "c1");
      expect(await service.toggleShowLlmDetails("g-toggle")).toBe(false);
      await service.setFreeModelsOnly("g-free", true, { model: DEFAULT_MODEL, isFree: true });

      expect((await repo.findByGuildId("g-llm"))?.showLlmDetails).toBe(false);
      expect((await repo.findByGuildId("g-ws"))?.webSearchEnabled).toBe(true);
      expect((await repo.findByGuildId("g-twitter"))?.twitterExpandEnabled).toBe(false);
      expect((await repo.findByGuildId("g-model"))?.defaultModel).toBe(PAID.model);
      expect((await repo.findByGuildId("g-ch"))?.autoReplyChannels).toEqual(["c1"]);
      expect((await repo.findByGuildId("g-toggle"))?.showLlmDetails).toBe(false);
      expect((await repo.findByGuildId("g-free"))?.freeModelsOnly).toBe(true);
    });
  });

  describe("別の列を変える操作は、互いの変更を消さない", () => {
    test("逐次でも", async () => {
      await service.setWebSearchEnabled(G, true);
      await service.addAutoReplyChannel(G, "c1");
      await service.setGuildModel(G, PAID);

      expect(await repo.findByGuildId(G)).toMatchObject({
        webSearchEnabled: true,
        autoReplyChannels: ["c1"],
        defaultModel: PAID.model,
      });
    });

    test("同時でも（Web 検索の OFF がモデル変更で ON に戻らない）", async () => {
      await service.setWebSearchEnabled(G, true);

      await Promise.all([service.setWebSearchEnabled(G, false), service.setGuildModel(G, PAID)]);

      expect(await repo.findByGuildId(G)).toMatchObject({
        webSearchEnabled: false,
        defaultModel: PAID.model,
      });
    });
  });

  describe("トグルは保存された値を反転する", () => {
    test.each([true, false])("LLM 詳細表示を %p から 2 回同時に押すと元に戻る", async (initial) => {
      await service.setShowLlmDetails(G, initial);

      const results = await Promise.all([
        service.toggleShowLlmDetails(G),
        service.toggleShowLlmDetails(G),
      ]);

      expect(results).toEqual([!initial, initial]);
      expect((await repo.findByGuildId(G))?.showLlmDetails).toBe(initial);
    });

    test.each([true, false])(
      "無料モデル限定を %p から 2 回同時に押すと元に戻る",
      async (initial) => {
        await service.setGuildModel(G, FREE);
        await service.setFreeModelsOnly(G, initial, FREE);

        await Promise.all([
          service.toggleFreeModelsOnly(G, FREE),
          service.toggleFreeModelsOnly(G, FREE),
        ]);

        expect((await repo.findByGuildId(G))?.freeModelsOnly).toBe(initial);
      },
    );
  });

  describe("自動応答チャンネル", () => {
    test("異なるチャンネルの同時追加は両方残る", async () => {
      await Promise.all([
        service.addAutoReplyChannel(G, "c1"),
        service.addAutoReplyChannel(G, "c2"),
      ]);

      expect((await repo.findByGuildId(G))?.autoReplyChannels.sort()).toEqual(["c1", "c2"]);
    });

    test("同じチャンネルの二重追加は 1 つにまとまる", async () => {
      await Promise.all([
        service.addAutoReplyChannel(G, "c1"),
        service.addAutoReplyChannel(G, "c1"),
      ]);

      expect((await repo.findByGuildId(G))?.autoReplyChannels).toEqual(["c1"]);
    });

    test("異なるチャンネルの同時削除は両方消える", async () => {
      await service.addAutoReplyChannel(G, "c1");
      await service.addAutoReplyChannel(G, "c2");
      await service.addAutoReplyChannel(G, "c3");

      await Promise.all([
        service.removeAutoReplyChannel(G, "c1"),
        service.removeAutoReplyChannel(G, "c2"),
      ]);

      expect((await repo.findByGuildId(G))?.autoReplyChannels).toEqual(["c3"]);
    });

    test("同じチャンネルの二重削除は、一方だけが削除したと返す", async () => {
      await service.addAutoReplyChannel(G, "c1");

      const results = await Promise.all([
        service.removeAutoReplyChannel(G, "c1"),
        service.removeAutoReplyChannel(G, "c1"),
      ]);

      expect(results.sort()).toEqual([false, true]);
      expect((await repo.findByGuildId(G))?.autoReplyChannels).toEqual([]);
    });
  });

  describe("無料モデル限定とモデルの組み合わせは、保存された設定に対して確かめる", () => {
    test("限定が ON のとき、有料モデルへの変更は規則違反で、モデルは変わらない", async () => {
      await service.setGuildModel(G, FREE);
      await service.setFreeModelsOnly(G, true, FREE);

      await expect(service.setGuildModel(G, PAID)).rejects.toBeInstanceOf(SettingsRuleError);
      expect((await repo.findByGuildId(G))?.defaultModel).toBe(FREE.model);
    });

    test("有料モデルのまま限定を ON にするのは規則違反", async () => {
      await service.setGuildModel(G, PAID);

      await expect(service.setFreeModelsOnly(G, true, PAID)).rejects.toBeInstanceOf(
        SettingsRuleError,
      );
      expect((await repo.findByGuildId(G))?.freeModelsOnly).toBe(false);
    });

    test("限定を ON にする確認の後に有料モデルへ変わったら、限定の保存は競合になる", async () => {
      await service.setGuildModel(G, FREE);
      // 限定の有効化が FREE を確認した後、保存する前にモデルが変わった
      await service.setGuildModel(G, PAID);

      await expect(service.setFreeModelsOnly(G, true, FREE)).rejects.toBeInstanceOf(
        SettingsConflictError,
      );
      expect(await repo.findByGuildId(G)).toMatchObject({
        defaultModel: PAID.model,
        freeModelsOnly: false,
      });
    });

    test("有料モデルを確認した後に限定が ON になったら、モデルの保存は規則違反になる", async () => {
      await service.setGuildModel(G, FREE);
      // モデル変更が PAID を確認した後、保存する前に限定が ON になった
      await service.setFreeModelsOnly(G, true, FREE);

      await expect(service.setGuildModel(G, PAID)).rejects.toBeInstanceOf(SettingsRuleError);
      expect(await repo.findByGuildId(G)).toMatchObject({
        defaultModel: FREE.model,
        freeModelsOnly: true,
      });
    });

    test.each([
      ["モデル変更が先", true],
      ["限定の有効化が先", false],
    ])("無料モデルへの変更と限定の有効化は、%s でも両方成功する", async (_label, modelFirst) => {
      const OTHER_FREE = { model: "other/model:free", isFree: true };
      await service.setGuildModel(G, FREE);

      if (modelFirst) {
        await service.setGuildModel(G, OTHER_FREE);
        await service.setFreeModelsOnly(G, true, OTHER_FREE);
      } else {
        await service.setFreeModelsOnly(G, true, FREE);
        await service.setGuildModel(G, OTHER_FREE);
      }

      expect(await repo.findByGuildId(G)).toMatchObject({
        defaultModel: OTHER_FREE.model,
        freeModelsOnly: true,
      });
    });

    test("無料モデルを確認した後に別の無料モデルへ変わったら、古い確認での有効化は競合になる", async () => {
      const OTHER_FREE = { model: "other/model:free", isFree: true };
      await service.setGuildModel(G, FREE);
      // 限定の有効化が FREE を確認した後、保存する前に別の操作が OTHER_FREE を保存した
      await service.setGuildModel(G, OTHER_FREE);

      await expect(service.setFreeModelsOnly(G, true, FREE)).rejects.toBeInstanceOf(
        SettingsConflictError,
      );
      expect(await repo.findByGuildId(G)).toMatchObject({
        defaultModel: OTHER_FREE.model,
        freeModelsOnly: false,
      });
    });

    test("限定を OFF にするのにモデルの確認は要らない", async () => {
      await service.setGuildModel(G, FREE);
      await service.setFreeModelsOnly(G, true, FREE);

      await service.setFreeModelsOnly(G, false);

      expect((await repo.findByGuildId(G))?.freeModelsOnly).toBe(false);
    });
  });

  test("失敗した変更は、その変更で作った行ごと取り消される", async () => {
    await expect(service.setFreeModelsOnly("new-guild", true, PAID)).rejects.toBeInstanceOf(
      SettingsConflictError,
    );

    expect(await repo.findByGuildId("new-guild")).toBeNull();
  });
});
