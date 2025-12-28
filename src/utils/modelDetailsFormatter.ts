/**
 * コンテキスト長をフォーマット
 * 例: 128000 → "128K (128,000)"
 */
export function formatContextLength(length: number): string {
  if (length >= 1000) {
    const k = Math.floor(length / 1000);
    return `${k}K (${length.toLocaleString()})`;
  }
  return length.toString();
}

/**
 * 価格を"$X.XXXXXX/1M"形式にフォーマット
 * "0"の場合は"無料"と表示
 */
export function formatPrice(price: string): string {
  if (price === "0") {
    return "無料";
  }
  const numPrice = Number.parseFloat(price);
  return `$${numPrice.toFixed(6)}/1M`;
}
