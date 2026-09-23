import { MODEL_COLOR_PALETTE } from "../types/embed";

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
