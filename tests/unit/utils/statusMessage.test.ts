import { describe, expect, test } from "bun:test";
import { ComponentType, MessageFlags } from "discord.js";
import { buildStatusMessage } from "../../../src/utils/statusMessage";
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
  test("リリース通知先と未設定時の状態を表示する", () => {
    const data = statusData();
    expect(statusTextDisplays(buildStatusMessage(data))).toContain(
      "**リリース通知先**\n通知しない",
    );
    data.settings.releaseAnnounceChannelId = "channel";
    expect(statusTextDisplays(buildStatusMessage(data))).toContain(
      "**リリース通知先**\n<#channel>",
    );
  });
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
    expect(texts).toContain("## ステータス");
    expect(texts).toContain("**バージョン**\nv1.3.2");
    expect(texts).toContain("**OpenRouter残高**\n$100.0000");
    expect(texts).toContain("**モデルキャッシュ**\n<t:1735689600:R> (10件)");
    expect(texts).toContain("**無料モデル限定**\n有効");
    expect(texts).toContain("**LLM詳細表示**\n有効");
    expect(texts).toContain("**Web検索**\n無効");
    expect(texts).toContain("**ツイート展開**\n有効");
    expect(texts).toContain("**会話履歴**\n無効");
    expect(texts).toContain("**推論表示**\n無効");
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
      "## ステータス",
      "**バージョン**\nv1.3.2",
      "**OpenRouter残高**\n無制限",
      "**モデルキャッシュ**\n未取得",
    ]);
    expect(container.components.some((component) => component.type === ComponentType.Section)).toBe(
      false,
    );
    expect(
      container.components.some((component) => component.type === ComponentType.ActionRow),
    ).toBe(false);
  });
});
