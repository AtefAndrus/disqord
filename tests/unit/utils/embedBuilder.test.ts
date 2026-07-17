import { describe, expect, test } from "bun:test";
import { EmbedBuilder } from "discord.js";
import { EmbedColors } from "../../../src/types/embed";
import { createEmbed, createErrorEmbed, createSuccessEmbed } from "../../../src/utils/embedBuilder";

describe("embedBuilder", () => {
  describe("createEmbed", () => {
    test("基本的なEmbedを生成できる", () => {
      const embed = createEmbed({
        color: EmbedColors.BLURPLE,
        title: "Test Title",
        description: "Test Description",
      });

      expect(embed).toBeInstanceOf(EmbedBuilder);
      expect(embed.data.color).toBe(EmbedColors.BLURPLE);
      expect(embed.data.title).toBe("Test Title");
      expect(embed.data.description).toBe("Test Description");
    });

    test("titleが256文字を超える場合は切り詰める", () => {
      const longTitle = "a".repeat(300);
      const embed = createEmbed({ title: longTitle });
      expect(embed.data.title?.length).toBe(256);
    });

    test("descriptionが4096文字を超える場合は切り詰める", () => {
      const longDesc = "a".repeat(5000);
      const embed = createEmbed({ description: longDesc });
      expect(embed.data.description?.length).toBe(4096);
    });

    test("timestampにnullを指定した場合は未設定", () => {
      const embed = createEmbed({ timestamp: null });
      expect(embed.data.timestamp).toBeUndefined();
    });

    test("timestampにDateを指定した場合は設定される", () => {
      const date = new Date("2025-01-01T00:00:00Z");
      const embed = createEmbed({ timestamp: date });
      expect(embed.data.timestamp).toBeDefined();
    });

    test("fieldsが25個を超える場合は最初の25個のみ追加", () => {
      const fields = Array.from({ length: 30 }, (_, i) => ({
        name: `Field ${i}`,
        value: `Value ${i}`,
      }));
      const embed = createEmbed({ fields });
      expect(embed.data.fields?.length).toBe(25);
    });

    test("author情報を設定できる", () => {
      const embed = createEmbed({
        author: {
          name: "Test Author",
          iconURL: "https://example.com/avatar.png",
          url: "https://example.com",
        },
      });
      expect(embed.data.author?.name).toBe("Test Author");
      expect(embed.data.author?.icon_url).toBe("https://example.com/avatar.png");
      expect(embed.data.author?.url).toBe("https://example.com");
    });
  });

  describe("createErrorEmbed", () => {
    test("赤色のエラーEmbedを生成する", () => {
      const embed = createErrorEmbed("エラーメッセージ");
      expect(embed.data.color).toBe(EmbedColors.RED);
      expect(embed.data.title).toBe("エラー");
      expect(embed.data.description).toBe("エラーメッセージ");
      expect(embed.data.timestamp).toBeDefined();
    });

    test("カスタムタイトルを指定できる", () => {
      const embed = createErrorEmbed("エラーメッセージ", "カスタムエラー");
      expect(embed.data.title).toBe("カスタムエラー");
    });
  });

  describe("createSuccessEmbed", () => {
    test("Blurple色の成功Embedを生成する（タイムスタンプなし）", () => {
      const embed = createSuccessEmbed("成功メッセージ");
      expect(embed.data.color).toBe(EmbedColors.BLURPLE);
      expect(embed.data.description).toBe("成功メッセージ");
      expect(embed.data.timestamp).toBeUndefined();
    });

    test("タイトルを指定できる", () => {
      const embed = createSuccessEmbed("成功メッセージ", "成功");
      expect(embed.data.title).toBe("成功");
    });
  });
});
