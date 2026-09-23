import { ContainerBuilder } from "discord.js";
import type { ModelDetails } from "../services/modelService";
import { EmbedColors } from "../types/embed";
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

export interface ModelDetailsContainerOptions {
  title: string;
  description: string;
}

/** `/model current` と `/model set` が共有するモデル詳細表示。 */
export function buildModelDetailsContainer(
  details: ModelDetails,
  options: ModelDetailsContainerOptions,
): ContainerBuilder {
  const modelUrl = getOpenRouterModelUrl(details.id);
  const fields = [
    `**モデル名** ${details.name}`,
    `**コンテキスト長** ${formatContextLength(details.contextLength)}`,
    `**入力価格** ${formatPrice(details.pricing.prompt)}`,
    `**出力価格** ${formatPrice(details.pricing.completion)}`,
    `**対応モダリティ** ${formatModalities(details.inputModalities, details.outputModalities)}`,
    `**OpenRouter** <${modelUrl}>`,
  ];
  const content = [
    `## [${options.title}](${modelUrl})`,
    options.description,
    fields.join("\n"),
  ].join("\n\n");

  return new ContainerBuilder()
    .setAccentColor(EmbedColors.BLURPLE)
    .addTextDisplayComponents((td) => td.setContent(content.slice(0, 4000)));
}
