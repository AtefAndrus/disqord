import { describe, expect, test } from "bun:test";
import { splitIntoChunks } from "../../../src/utils/message";

const DISCORD_MESSAGE_LIMIT = 2000;

describe("splitIntoChunks", () => {
  test("空文字列は単一要素の配列を返す", () => {
    const result = splitIntoChunks("");
    expect(result).toEqual([""]);
  });

  test("制限以下の文字列は分割しない", () => {
    const content = "a".repeat(1999);
    const result = splitIntoChunks(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(content);
  });

  test("制限ちょうどの文字列は分割しない", () => {
    const content = "a".repeat(DISCORD_MESSAGE_LIMIT);
    const result = splitIntoChunks(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(content);
  });

  test("制限を1文字超える場合は2チャンクに分割", () => {
    const content = "a".repeat(DISCORD_MESSAGE_LIMIT + 1);
    const result = splitIntoChunks(content);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(DISCORD_MESSAGE_LIMIT);
    expect(result[1]).toHaveLength(1);
  });

  test("制限の2倍の長さは2チャンクに分割", () => {
    const content = "a".repeat(DISCORD_MESSAGE_LIMIT * 2);
    const result = splitIntoChunks(content);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(DISCORD_MESSAGE_LIMIT);
    expect(result[1]).toHaveLength(DISCORD_MESSAGE_LIMIT);
  });

  test("制限の2倍+1の長さは3チャンクに分割", () => {
    const content = "a".repeat(DISCORD_MESSAGE_LIMIT * 2 + 1);
    const result = splitIntoChunks(content);
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(DISCORD_MESSAGE_LIMIT);
    expect(result[1]).toHaveLength(DISCORD_MESSAGE_LIMIT);
    expect(result[2]).toHaveLength(1);
  });

  test("大きな文字列も正しく分割される（各チャンク<=2000）", () => {
    const content = "a".repeat(10000);
    const result = splitIntoChunks(content);
    expect(result).toHaveLength(5);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }
  });

  test("分割後の結合が元の文字列と一致する", () => {
    const content = "abcdefghij".repeat(500);
    const result = splitIntoChunks(content);
    const rejoined = result.join("");
    expect(rejoined).toBe(content);
  });

  test("マルチバイト文字を含む文字列も処理できる", () => {
    const content = "あ".repeat(1000);
    const result = splitIntoChunks(content);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const rejoined = result.join("");
    expect(rejoined).toBe(content);
  });
});
