/**
 * Embed構築用設定インターフェース
 */
export interface IEmbedConfig {
  color?: number; // 10進数カラーコード
  title?: string;
  description?: string;
  url?: string;
  timestamp?: Date | number | null; // null = タイムスタンプなし
  footer?: {
    text: string;
    iconURL?: string;
  };
  thumbnail?: string;
  author?: {
    name: string;
    iconURL?: string;
    url?: string;
  };
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
}

/**
 * Embedカラーパレット
 */
export const EmbedColors = {
  BLURPLE: 0x5865f2, // Discord標準色（通常時）
  RED: 0xed4245, // エラー時
  GREEN: 0x57f287, // 成功時（将来用）
  YELLOW: 0xfee75c, // 警告時（将来用）
} as const;
