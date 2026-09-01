import type { EmbedBuilder } from "discord.js";
import type { ModelDetails } from "../services/modelService";
import { EmbedColors } from "../types/embed";
import { createEmbed } from "./embedBuilder";
import { formatContextLength, formatModalities, formatPrice } from "./modelDetailsFormatter";

const OPENROUTER_MODEL_BASE_URL = "https://openrouter.ai/";

/** OpenRouter の model ID を、同じ author/slug を持つモデル詳細ページへ安全に写像する。 */
export function getOpenRouterModelUrl(modelId: string): string {
  const encodedPath = modelId
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
  return `${OPENROUTER_MODEL_BASE_URL}${encodedPath}`;
}

export interface ModelDetailsEmbedOptions {
  title: string;
  description: string;
}

/** `/model current` と `/model set` が共有するモデル詳細表示。 */
export function createModelDetailsEmbed(
  details: ModelDetails,
  options: ModelDetailsEmbedOptions,
): EmbedBuilder {
  const modelUrl = getOpenRouterModelUrl(details.id);
  return createEmbed({
    color: EmbedColors.BLURPLE,
    title: options.title,
    description: options.description,
    url: modelUrl,
    fields: [
      { name: "モデル名", value: details.name, inline: true },
      {
        name: "コンテキスト長",
        value: formatContextLength(details.contextLength),
        inline: true,
      },
      { name: "入力価格", value: formatPrice(details.pricing.prompt), inline: true },
      { name: "出力価格", value: formatPrice(details.pricing.completion), inline: true },
      {
        name: "対応モダリティ",
        value: formatModalities(details.inputModalities, details.outputModalities),
        inline: false,
      },
      { name: "OpenRouter", value: `<${modelUrl}>`, inline: false },
    ],
    timestamp: null,
  });
}
