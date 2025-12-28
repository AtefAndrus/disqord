import { EmbedBuilder } from "discord.js";
import type { IEmbedConfig } from "../types/embed";
import { EmbedColors, MODEL_COLOR_PALETTE } from "../types/embed";

/**
 * FNV-1aハッシュ関数（決定論的）
 * 同じ文字列から常に同じハッシュ値を生成
 */
function hashString(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0; // 符号なし32bit整数
}

/**
 * モデルIDからEmbedカラーを決定
 * @param modelId - モデルID（例: "deepseek/deepseek-r1-0528:free"）
 * @returns 16色パレットから選択された色コード
 */
export function getColorForModel(modelId: string): number {
  const hash = hashString(modelId);
  return MODEL_COLOR_PALETTE[hash % MODEL_COLOR_PALETTE.length];
}

/**
 * Embedを構築する基本関数
 * Discord API制限を自動適用（title: 256文字、description: 4096文字等）
 */
export function createEmbed(config: IEmbedConfig): EmbedBuilder {
  const embed = new EmbedBuilder();

  if (config.color !== undefined) embed.setColor(config.color);
  if (config.title) embed.setTitle(config.title.slice(0, 256));
  if (config.description) embed.setDescription(config.description.slice(0, 4096));
  if (config.url) embed.setURL(config.url);

  // タイムスタンプ処理: nullの場合は明示的に未設定
  if (config.timestamp !== undefined) {
    if (config.timestamp !== null) {
      embed.setTimestamp(config.timestamp);
    }
  }

  if (config.footer) {
    embed.setFooter({
      text: config.footer.text.slice(0, 2048),
      iconURL: config.footer.iconURL,
    });
  }
  if (config.thumbnail) embed.setThumbnail(config.thumbnail);
  if (config.author) {
    embed.setAuthor({
      name: config.author.name.slice(0, 256),
      iconURL: config.author.iconURL,
      url: config.author.url,
    });
  }
  if (config.fields && config.fields.length > 0) {
    // 最大25フィールドまで
    const fields = config.fields.slice(0, 25).map((f) => ({
      name: f.name.slice(0, 256),
      value: f.value.slice(0, 1024),
      inline: f.inline ?? false,
    }));
    embed.addFields(fields);
  }

  return embed;
}

/**
 * 長文を複数メッセージ用Embedに分割
 * Discord API制限（1メッセージあたりEmbed合計6000文字）に対応し、
 * 各メッセージに1つのEmbedのみ配置。長文は複数メッセージに分割。
 *
 * @param text - 分割対象テキスト
 * @param baseConfig - description/footer以外のEmbed設定
 * @param metadata - LLM詳細情報（オプショナル）
 * @returns 分割されたEmbed配列の配列（各配列が1メッセージ分、各配列には1 Embedのみ）
 */
export function splitTextToMultipleMessages(
  text: string,
  baseConfig: Omit<IEmbedConfig, "description" | "footer">,
  metadata?: {
    showDetails: boolean;
    model?: string;
    provider?: string;
    latency?: number;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cost?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  },
): Array<EmbedBuilder[]> {
  const MAX_DESC_LENGTH = 4096;

  // テキストを4096文字単位で分割
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const chunk = remaining.slice(0, MAX_DESC_LENGTH);
    chunks.push(chunk);
    remaining = remaining.slice(MAX_DESC_LENGTH);
  }

  const totalChunks = chunks.length;

  // 各メッセージに1つのEmbedのみ（Discord API 6000文字制限対応）
  const messages: Array<EmbedBuilder[]> = chunks.map((chunk, index) => {
    const pageNumber = index + 1;
    const isLastPage = index === chunks.length - 1;

    // フッターパーツを構築
    const footerParts: string[] = [];

    // ページ番号（2ページ以上の場合のみ）
    if (totalChunks > 1) {
      footerParts.push(`ページ ${pageNumber}/${totalChunks}`);
    }

    // LLM詳細情報（最後のページ かつ showDetails=true）
    if (isLastPage && metadata?.showDetails && metadata.usage) {
      const details: string[] = [
        `Tokens: ${metadata.usage.prompt_tokens}+${metadata.usage.completion_tokens}=${metadata.usage.total_tokens}`,
      ];

      if (metadata.usage.cost !== undefined) {
        details.push(`Cost: $${metadata.usage.cost.toFixed(6)}`);
      }
      if (metadata.model) {
        details.push(`Model: ${metadata.model}`);
      }
      if (metadata.latency !== undefined) {
        details.push(`Latency: ${metadata.latency}ms`);
      }
      if (metadata.provider) {
        details.push(`Provider: ${metadata.provider}`);
      }
      if (metadata.usage.prompt_tokens_details?.cached_tokens) {
        details.push(`Cached: ${metadata.usage.prompt_tokens_details.cached_tokens}`);
      }
      if (metadata.usage.completion_tokens_details?.reasoning_tokens) {
        details.push(`Reasoning: ${metadata.usage.completion_tokens_details.reasoning_tokens}`);
      }
      if (metadata.usage.completion_tokens && metadata.latency) {
        const tokensPerSecond = metadata.usage.completion_tokens / (metadata.latency / 1000);
        details.push(`TPS: ${tokensPerSecond.toFixed(2)}`);
      }

      footerParts.push(details.join(" | "));
    }

    const footerText = footerParts.length > 0 ? footerParts.join("\n") : undefined;

    return [
      createEmbed({
        ...baseConfig,
        description: chunk,
        footer: footerText ? { text: footerText } : undefined,
      }),
    ];
  });

  return messages;
}

/**
 * エラーメッセージ用Embed生成
 * 赤色（#ED4245）、タイムスタンプ付き
 */
export function createErrorEmbed(message: string, title = "エラー"): EmbedBuilder {
  return createEmbed({
    color: EmbedColors.RED,
    title,
    description: message,
    timestamp: new Date(),
  });
}

/**
 * 成功メッセージ用Embed生成（汎用）
 * Blurple色（#5865F2）、タイムスタンプなし（スラッシュコマンド用）
 */
export function createSuccessEmbed(message: string, title?: string): EmbedBuilder {
  return createEmbed({
    color: EmbedColors.BLURPLE,
    title,
    description: message,
    timestamp: null, // スラッシュコマンドではタイムスタンプ不要
  });
}
