import { describe, expect, it } from "bun:test";
import {
  formatContextLength,
  formatModalities,
  formatPrice,
} from "../../../src/utils/modelDetailsFormatter";

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
  describe("無料モデル", () => {
    it('"0"の場合は"無料"と表示', () => {
      expect(formatPrice("0")).toBe("無料");
    });
  });

  describe("高価格帯（$1/1M以上）", () => {
    it("GPT-4o出力相当（$30/1M）", () => {
      expect(formatPrice("0.00003")).toBe("$30.00/1M");
    });

    it("Claude 3.5入力相当（$15/1M）", () => {
      expect(formatPrice("0.000015")).toBe("$15.00/1M");
    });

    it("高価格モデル（$100/1M）", () => {
      expect(formatPrice("0.0001")).toBe("$100.00/1M");
    });

    it("境界値 $1.00/1M", () => {
      expect(formatPrice("0.000001")).toBe("$1.00/1M");
    });
  });

  describe("中価格帯（$0.01〜$1/1M）", () => {
    it("$0.50/1M", () => {
      expect(formatPrice("0.0000005")).toBe("$0.50/1M");
    });

    it("$0.15/1M", () => {
      expect(formatPrice("0.00000015")).toBe("$0.15/1M");
    });

    it("境界値 $0.01/1M", () => {
      expect(formatPrice("0.00000001")).toBe("$0.01/1M");
    });
  });

  describe("低価格帯（$0.01/1M未満）", () => {
    it("$0.001/1M（3桁精度）", () => {
      expect(formatPrice("0.000000001")).toBe("$0.001/1M");
    });

    it("$0.0001/1M（4桁精度）", () => {
      expect(formatPrice("0.0000000001")).toBe("$0.0001/1M");
    });
  });
});

describe("formatModalities", () => {
  it("text-only モデル", () => {
    expect(formatModalities(["text"], ["text"])).toBe("入力: text / 出力: text");
  });

  it("画像入力対応モデル", () => {
    expect(formatModalities(["text", "image"], ["text"])).toBe("入力: text, image / 出力: text");
  });

  it("画像とファイル両対応モデル", () => {
    expect(formatModalities(["text", "image", "file"], ["text"])).toBe(
      "入力: text, image, file / 出力: text",
    );
  });

  it("出力モダリティが複数のモデル", () => {
    expect(formatModalities(["text"], ["text", "image"])).toBe("入力: text / 出力: text, image");
  });

  it("入力モダリティ空配列（メタ欠落）は不明を返す", () => {
    expect(formatModalities([], ["text"])).toBe("入力: 不明 / 出力: text");
  });

  it("出力モダリティ空配列（メタ欠落）は不明を返す", () => {
    expect(formatModalities(["text"], [])).toBe("入力: text / 出力: 不明");
  });

  it("両方空配列は両方不明", () => {
    expect(formatModalities([], [])).toBe("入力: 不明 / 出力: 不明");
  });
});
