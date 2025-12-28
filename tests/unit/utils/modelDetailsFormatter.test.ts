import { describe, expect, it } from "bun:test";
import { formatContextLength, formatPrice } from "../../../src/utils/modelDetailsFormatter";

describe("formatContextLength", () => {
  it("1000以上の場合K単位で表示", () => {
    expect(formatContextLength(128000)).toBe("128K (128,000)");
    expect(formatContextLength(8000)).toBe("8K (8,000)");
  });

  it("1000未満の場合そのまま表示", () => {
    expect(formatContextLength(512)).toBe("512");
  });

  it("エッジケース: 1000ちょうど", () => {
    expect(formatContextLength(1000)).toBe("1K (1,000)");
  });
});

describe("formatPrice", () => {
  it('"0"の場合は"無料"と表示', () => {
    expect(formatPrice("0")).toBe("無料");
  });

  it("小数の場合は6桁表示", () => {
    expect(formatPrice("0.000001")).toBe("$0.000001/1M");
    expect(formatPrice("0.5")).toBe("$0.500000/1M");
    expect(formatPrice("10")).toBe("$10.000000/1M");
  });
});
