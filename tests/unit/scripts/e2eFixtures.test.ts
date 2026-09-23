import { describe, expect, test } from "bun:test";
import { crc32, inflateSync } from "node:zlib";
import { buildDigitsPng } from "../../../scripts/e2e/fixtures";

interface Chunk {
  type: string;
  data: Buffer;
  crcMatches: boolean;
}

function readChunks(png: Uint8Array): Chunk[] {
  const buffer = Buffer.from(png);
  const chunks: Chunk[] = [];
  let offset = 8;
  while (offset < buffer.byteLength) {
    const length = buffer.readUInt32BE(offset);
    const typeAndData = buffer.subarray(offset + 4, offset + 8 + length);
    chunks.push({
      type: typeAndData.subarray(0, 4).toString("latin1"),
      data: typeAndData.subarray(4),
      crcMatches: crc32(typeAndData) === buffer.readUInt32BE(offset + 8 + length),
    });
    offset += 12 + length;
  }
  return chunks;
}

describe("buildDigitsPng", () => {
  test("署名・IHDR・IDAT・IEND が揃い、各 chunk の CRC が合う", () => {
    const png = buildDigitsPng("42", 2);
    expect(Buffer.from(png.subarray(0, 8))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const chunks = readChunks(png);
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(chunks.every((c) => c.crcMatches)).toBe(true);
  });

  test("数字の glyph のとおりに黒い画素を描く", () => {
    const scale = 2;
    const [header, data] = readChunks(buildDigitsPng("1", scale)).map((c) => c.data);
    const width = header?.readUInt32BE(0) ?? 0;
    const height = header?.readUInt32BE(4) ?? 0;
    // 余白 2 セル + 1 桁 5 セル + 余白 2 セル、高さは余白 2 + 7 + 余白 2。
    expect([width, height]).toEqual([9 * scale, 11 * scale]);
    const pixels = inflateSync(data ?? Buffer.alloc(0));
    const at = (cellX: number, cellY: number): number | undefined =>
      pixels[cellY * scale * (width + 1) + 1 + cellX * scale];
    // "1" の最上段は "  #  "、最下段は " ### "。
    expect(at(2 + 2, 2)).toBe(0);
    expect(at(2 + 0, 2)).toBe(0xff);
    expect(at(2 + 1, 2 + 6)).toBe(0);
    expect(at(0, 0)).toBe(0xff);
  });

  test("数字以外は描かずに投げる", () => {
    expect(() => buildDigitsPng("1a")).toThrow("digits only");
  });
});
