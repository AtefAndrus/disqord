import { describe, expect, test } from "bun:test";
import { EmbedBuilder } from "discord.js";
import { EmbedColors } from "../../../src/types/embed";
import {
  createEmbed,
  createErrorEmbed,
  createSuccessEmbed,
  splitTextToMultipleMessages,
} from "../../../src/utils/embedBuilder";

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

  describe("splitTextToMultipleMessages", () => {
    test("4096文字以内のテキストは1メッセージ1 Embedになる", () => {
      const text = "a".repeat(4000);
      const messages = splitTextToMultipleMessages(text, {
        color: EmbedColors.BLURPLE,
      });

      expect(messages.length).toBe(1);
      expect(messages[0].length).toBe(1);
      expect(messages[0][0].data.description).toBe(text);
      expect(messages[0][0].data.footer).toBeUndefined(); // 1ページの場合footerなし
    });

    test("9000バイト超のテキストは複数メッセージに分割される（各メッセージ1 Embed）", () => {
      const text = "a".repeat(10000); // ASCII: 10000バイト
      const messages = splitTextToMultipleMessages(text, {
        color: EmbedColors.BLURPLE,
      });

      const expectedMessages = Math.ceil(10000 / 9000); // 2メッセージ
      expect(messages.length).toBe(expectedMessages);
      expect(messages[0].length).toBe(1); // 各メッセージに1 Embed
      expect(messages[1].length).toBe(1);
      expect(messages[0][0].data.footer?.text).toBe("ページ 1/2");
      expect(messages[1][0].data.footer?.text).toBe("ページ 2/2");
    });

    test("大量テキストは9000バイト単位で複数メッセージに分割される（各メッセージ1 Embed）", () => {
      const text = "a".repeat(100000); // 100000バイト（ASCII）
      const messages = splitTextToMultipleMessages(text, {
        color: EmbedColors.BLURPLE,
      });

      const expectedMessages = Math.ceil(100000 / 9000); // 12メッセージ

      expect(messages.length).toBe(expectedMessages); // 12メッセージ
      expect(messages[0].length).toBe(1); // 各メッセージに1 Embed
      expect(messages[11].length).toBe(1);

      // ページ番号確認（全体通し）
      expect(messages[0][0].data.footer?.text).toBe("ページ 1/12");
      expect(messages[5][0].data.footer?.text).toBe("ページ 6/12");
      expect(messages[11][0].data.footer?.text).toBe("ページ 12/12");
    });

    test("baseConfigの設定が各Embedに適用される", () => {
      const text = "a".repeat(10000);
      const testDate = new Date();
      const messages = splitTextToMultipleMessages(text, {
        color: EmbedColors.RED,
        title: "Test Title",
        timestamp: testDate,
      });

      messages.forEach((messageEmbeds) => {
        expect(messageEmbeds.length).toBe(1); // 各メッセージに1 Embed
        const embed = messageEmbeds[0];
        expect(embed.data.color).toBe(EmbedColors.RED);
        expect(embed.data.title).toBe("Test Title");
        expect(embed.data.timestamp).toBeDefined();
      });
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
