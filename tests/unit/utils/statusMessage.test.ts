import { describe, expect, test } from "bun:test";
import { ComponentType, MessageFlags } from "discord.js";
import {
  buildStatusMessage,
  parseStatusSetCustomId,
  STATUS_SWITCHES,
  statusSetCustomId,
} from "../../../src/utils/statusMessage";
import { createMockGuildSettings } from "../../helpers/mockFactories";

function statusTextDisplays(message: ReturnType<typeof buildStatusMessage>): string[] {
  const container = message.components[0]?.toJSON();
  if (!container) throw new Error("Expected the status Container");
  return container.components.flatMap((component) => {
    if (component.type === ComponentType.TextDisplay) return [component.content];
    if (component.type === ComponentType.Section) {
      return component.components.map((inner) => inner.content);
    }
    return [];
  });
}

function statusData(overrides: { freeModelsOnly?: boolean; showLlmDetails?: boolean } = {}) {
  return {
    credits: { remaining: 100 },
    cacheStatus: { lastUpdatedAt: new Date("2025-01-01T00:00:00.000Z"), modelCount: 10 },
    settings: createMockGuildSettings(overrides),
    webSearchEngine: "perplexity",
    version: "1.3.2",
  };
}

describe("buildStatusMessage", () => {
  test("Components V2 Container に状態と各設定の現在値を表示する", () => {
    const message = buildStatusMessage(
      statusData({
        freeModelsOnly: true,
        showLlmDetails: true,
      }),
    );
    const texts = statusTextDisplays(message);

    expect(message.flags).toBe(MessageFlags.IsComponentsV2);
    expect(message.embeds).toEqual([]);
    expect(message.allowedMentions).toEqual({ parse: [] });
    expect(texts).toContain(
      "## ステータス\n**バージョン** v1.3.2\n**OpenRouter残高** $100.0000\n**モデルキャッシュ** <t:1735689600:R> (10件)",
    );
    expect(texts).toContain("**無料モデル限定** 有効");
    expect(texts).toContain("**LLM詳細表示** 有効");
    expect(texts).toContain("**Web検索** 無効");
    expect(texts).toContain("**ツイート展開** 有効");
    expect(texts).toContain("**会話履歴** 無効");
  });

  test("各設定の Section ボタンは現在値と反対の値を指定する", () => {
    const message = buildStatusMessage(statusData());
    const container = message.components[0]?.toJSON();
    if (!container) throw new Error("Expected the status Container");
    const sections = container.components.filter(
      (component) => component.type === ComponentType.Section,
    );

    expect(
      sections.map((section) =>
        "custom_id" in section.accessory ? section.accessory.custom_id : undefined,
      ),
    ).toEqual([
      "status_set:free_only:on",
      "status_set:llm_details:off",
      "status_set:web_search:on",
      "status_set:twitter_expand:off",
      "status_set:history:on",
    ]);
  });

  test("ギルド設定がない場合は設定行と操作ボタンを表示しない", () => {
    const message = buildStatusMessage({
      credits: { remaining: Number.POSITIVE_INFINITY },
      cacheStatus: { lastUpdatedAt: null, modelCount: 0 },
      webSearchEngine: "perplexity",
      version: "1.3.2",
    });
    const container = message.components[0]?.toJSON();
    if (!container) throw new Error("Expected the status Container");

    expect(statusTextDisplays(message)).toEqual([
      "## ステータス\n**バージョン** v1.3.2\n**OpenRouter残高** 無制限\n**モデルキャッシュ** 未取得",
    ]);
    expect(container.components.some((component) => component.type === ComponentType.Section)).toBe(
      false,
    );
    expect(
      container.components.some((component) => component.type === ComponentType.ActionRow),
    ).toBe(false);
  });

  test.each(STATUS_SWITCHES.flatMap((key) => [[key, true] as const, [key, false] as const]))(
    "%s の %s custom ID を解析する",
    (key, enabled) => {
      expect(statusSetCustomId(key, enabled)).toBe(`status_set:${key}:${enabled ? "on" : "off"}`);
      expect(parseStatusSetCustomId(statusSetCustomId(key, enabled))).toEqual({ key, enabled });
    },
  );

  test("未対応の custom ID を解析しない", () => {
    expect(parseStatusSetCustomId("status_set:unknown:on")).toBeUndefined();
    expect(parseStatusSetCustomId("status_set:history:maybe")).toBeUndefined();
    expect(parseStatusSetCustomId("other_button")).toBeUndefined();
  });
});
