import { describe, expect, test } from "bun:test";
import type { ModelDetails } from "../../../src/services/modelService";
import {
  createModelDetailsEmbed,
  getOpenRouterModelUrl,
} from "../../../src/utils/modelDetailsEmbed";

const details: ModelDetails = {
  id: "google/gemma-4-26b-a4b-it:free",
  name: "Google: Gemma 4 26B A4B (free)",
  contextLength: 128000,
  pricing: { prompt: "0", completion: "0" },
  isFree: true,
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
};

describe("modelDetailsEmbed", () => {
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

  test("共通のモデル詳細とモデルページURLをEmbedへ含める", () => {
    const embed = createModelDetailsEmbed(details, {
      title: "現在のモデル",
      description: `現在のモデルは \`${details.id}\` です。`,
    }).toJSON();

    expect(embed.title).toBe("現在のモデル");
    expect(embed.url).toBe("https://openrouter.ai/google/gemma-4-26b-a4b-it%3Afree");
    expect(embed.fields?.map((field) => field.name)).toEqual([
      "モデル名",
      "コンテキスト長",
      "入力価格",
      "出力価格",
      "対応モダリティ",
      "OpenRouter",
    ]);
    expect(embed.fields?.at(-1)?.value).toBe(
      "<https://openrouter.ai/google/gemma-4-26b-a4b-it%3Afree>",
    );
  });
});
