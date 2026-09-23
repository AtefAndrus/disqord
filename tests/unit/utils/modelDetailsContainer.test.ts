import { describe, expect, test } from "bun:test";
import { ComponentType } from "discord.js";
import type { ModelDetails } from "../../../src/services/modelService";
import {
  buildModelDetailsContainer,
  getOpenRouterModelUrl,
} from "../../../src/utils/modelDetailsContainer";

const details: ModelDetails = {
  id: "google/gemma-4-26b-a4b-it:free",
  name: "Google: Gemma 4 26B A4B (free)",
  contextLength: 128000,
  pricing: { prompt: "0", completion: "0" },
  isFree: true,
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  supportedParameters: [],
  supportsTools: false,
};

describe("modelDetailsContainer", () => {
  test("model IDからOpenRouterのモデルページURLを生成する", () => {
    expect(getOpenRouterModelUrl(details.id)).toBe(
      "https://openrouter.ai/google/gemma-4-26b-a4b-it%3Afree",
    );
  });

  test("外部URLとして解釈されうるmodel IDもOpenRouter配下のpathに閉じ込める", () => {
    expect(getOpenRouterModelUrl("https://example.com/model")).toBe(
      "https://openrouter.ai/https%3A/example.com/model",
    );
    expect(getOpenRouterModelUrl("//example.com/model")).toBe(
      "https://openrouter.ai/example.com/model",
    );
  });

  test("title linkと5項目、OpenRouter URLをTextDisplayに表示する", () => {
    const url = getOpenRouterModelUrl(details.id);
    const container = buildModelDetailsContainer(details, {
      title: "現在のモデル",
      description: `現在のモデルは \`${details.id}\` です。`,
    }).toJSON();
    const text = container.components.find(
      (component) => component.type === ComponentType.TextDisplay,
    );
    const expectedContent = [
      `## [現在のモデル](${url})`,
      `現在のモデルは \`${details.id}\` です。`,
      [
        `**モデル名** ${details.name}`,
        "**コンテキスト長** 128K (128,000)",
        "**入力価格** 無料",
        "**出力価格** 無料",
        "**対応モダリティ** 入力: text, image / 出力: text",
        `**OpenRouter** <${url}>`,
      ].join("\n"),
    ].join("\n\n");

    expect(container.accent_color).toBeDefined();
    expect(text?.type).toBe(ComponentType.TextDisplay);
    expect(text?.content).toBe(expectedContent);
  });
});
