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
 * 価格を"$X.XX/1M"形式にフォーマット
 * OpenRouter APIは「1トークンあたりのUSD」で返すため100万倍して表示
 * "0"の場合は"無料"と表示
 * 動的精度: $0.01以上は2桁、$0.0001以上は有効数字維持、それ未満は最大6桁
 */
export function formatPrice(price: string): string {
  if (price === "0") {
    return "無料";
  }

  const perToken = Number.parseFloat(price);
  const perMillion = perToken * 1_000_000;

  let formatted: string;

  if (perMillion >= 0.01) {
    formatted = perMillion.toFixed(2);
  } else if (perMillion >= 0.0001) {
    const precision = Math.ceil(-Math.log10(perMillion)) + 1;
    formatted = perMillion.toFixed(Math.min(precision, 4)).replace(/0+$/, "");
  } else {
    formatted = perMillion.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0");
  }

  return `$${formatted}/1M`;
}
