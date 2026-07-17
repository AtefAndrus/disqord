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
 * @param modelId - モデルID（例: "provider/model-id"）
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
