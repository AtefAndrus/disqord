import { describe, expect, it } from "bun:test";
import { ButtonStyle } from "discord.js";
import type { GuildSettings } from "../../../src/types";
import { buildStatusMessage } from "../../../src/utils/statusMessage";

describe("buildStatusMessage - 言語統一", () => {
  it("LLM詳細表示が有効/無効で表示される", () => {
    const dataOn = {
      credits: { remaining: 100 },
      rateLimited: false,
      cacheStatus: { lastUpdatedAt: new Date(), modelCount: 10 },
      settings: {
        guildId: "test",
        defaultModel: "test-model",
        freeModelsOnly: false,
        showLlmDetails: true,
        releaseChannelId: null,
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      } as GuildSettings,
      version: "1.3.2",
    };

    const result = buildStatusMessage(dataOn);
    const embed = result.embeds[0];
    const llmDetailsField = embed.toJSON().fields?.find((f) => f.name === "LLM詳細表示");

    expect(llmDetailsField?.value).toBe("有効");
  });

  it("LLM詳細表示が無効の場合は「無効」と表示される", () => {
    const dataOff = {
      credits: { remaining: 100 },
      rateLimited: false,
      cacheStatus: { lastUpdatedAt: new Date(), modelCount: 10 },
      settings: {
        guildId: "test",
        defaultModel: "test-model",
        freeModelsOnly: false,
        showLlmDetails: false,
        releaseChannelId: null,
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      } as GuildSettings,
      version: "1.3.2",
    };

    const result = buildStatusMessage(dataOff);
    const embed = result.embeds[0];
    const llmDetailsField = embed.toJSON().fields?.find((f) => f.name === "LLM詳細表示");

    expect(llmDetailsField?.value).toBe("無効");
  });
});

describe("buildStatusMessage - ボタンUX", () => {
  it("無料モデル限定ボタンがトグル形式で表示される（有効→無効）", () => {
    const data = {
      credits: { remaining: 100 },
      rateLimited: false,
      cacheStatus: { lastUpdatedAt: new Date(), modelCount: 10 },
      settings: {
        guildId: "test",
        defaultModel: "test-model",
        freeModelsOnly: true,
        showLlmDetails: false,
        releaseChannelId: null,
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      } as GuildSettings,
      version: "1.3.2",
    };

    const result = buildStatusMessage(data);
    const button = result.components[0].components[0].toJSON();

    expect("label" in button && button.label).toBe("無料モデル限定: 有効 → 無効");
    expect(button.style).toBe(ButtonStyle.Success);
  });

  it("無料モデル限定ボタンがトグル形式で表示される（無効→有効）", () => {
    const data = {
      credits: { remaining: 100 },
      rateLimited: false,
      cacheStatus: { lastUpdatedAt: new Date(), modelCount: 10 },
      settings: {
        guildId: "test",
        defaultModel: "test-model",
        freeModelsOnly: false,
        showLlmDetails: false,
        releaseChannelId: null,
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      } as GuildSettings,
      version: "1.3.2",
    };

    const result = buildStatusMessage(data);
    const button = result.components[0].components[0].toJSON();

    expect("label" in button && button.label).toBe("無料モデル限定: 無効 → 有効");
    expect(button.style).toBe(ButtonStyle.Secondary);
  });

  it("LLM詳細表示ボタンがトグル形式で表示される（無効→有効）", () => {
    const data = {
      credits: { remaining: 100 },
      rateLimited: false,
      cacheStatus: { lastUpdatedAt: new Date(), modelCount: 10 },
      settings: {
        guildId: "test",
        defaultModel: "test-model",
        freeModelsOnly: false,
        showLlmDetails: false,
        releaseChannelId: null,
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      } as GuildSettings,
      version: "1.3.2",
    };

    const result = buildStatusMessage(data);
    const button = result.components[0].components[1].toJSON();

    expect("label" in button && button.label).toBe("LLM詳細表示: 無効 → 有効");
    expect(button.style).toBe(ButtonStyle.Secondary);
  });

  it("LLM詳細表示ボタンがトグル形式で表示される（有効→無効）", () => {
    const data = {
      credits: { remaining: 100 },
      rateLimited: false,
      cacheStatus: { lastUpdatedAt: new Date(), modelCount: 10 },
      settings: {
        guildId: "test",
        defaultModel: "test-model",
        freeModelsOnly: false,
        showLlmDetails: true,
        releaseChannelId: null,
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      } as GuildSettings,
      version: "1.3.2",
    };

    const result = buildStatusMessage(data);
    const button = result.components[0].components[1].toJSON();

    expect("label" in button && button.label).toBe("LLM詳細表示: 有効 → 無効");
    expect(button.style).toBe(ButtonStyle.Success);
  });
});
