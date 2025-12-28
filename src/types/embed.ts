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

/**
 * モデルごとのカラーパレット（16色）
 * モデルIDのハッシュ値から決定論的に色を選択するために使用
 */
export const MODEL_COLOR_PALETTE = [
  EmbedColors.BLURPLE, // Discord標準色
  0x3498db, // BLUE
  0x00d9ff, // CYAN
  EmbedColors.GREEN, // GREEN
  0x1f8b4c, // DARK_GREEN
  EmbedColors.YELLOW, // YELLOW
  0xf26522, // ORANGE
  EmbedColors.RED, // RED
  0xe91e63, // MAGENTA
  0xeb459e, // PINK
  0x9b59b6, // PURPLE
  0x8d6e63, // BROWN
  0x95a5a6, // GRAY
  0x607d8b, // DARK_GRAY
  0x23272a, // BLACK
  0xffffff, // WHITE
] as const;
