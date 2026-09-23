import { crc32, deflateSync } from "node:zlib";

/** 5x7 glyphs, one string per row, `#` for ink. Digits only: they are hard to misread. */
const DIGIT_GLYPHS: Record<string, string[]> = {
  "0": [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
  "1": ["  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  "2": [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
  "3": ["#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "],
  "4": ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
  "5": ["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "],
  "6": ["  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "],
  "7": ["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "],
  "8": [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
  "9": [" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "],
};

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** Builds a grayscale PNG with `digits` drawn large in black on white. */
export function buildDigitsPng(digits: string, scale: number = 16): Uint8Array<ArrayBuffer> {
  const glyphs = [...digits].map((digit) => {
    const glyph = DIGIT_GLYPHS[digit];
    if (!glyph) throw new Error(`buildDigitsPng draws digits only, got ${JSON.stringify(digit)}`);
    return glyph;
  });
  const margin = 2;
  const columns = margin * 2 + glyphs.length * 6 - 1;
  const rows = margin * 2 + 7;
  const width = columns * scale;
  const height = rows * scale;
  // Each scanline is a filter-type byte (0 = none) followed by one byte per pixel.
  const raw = Buffer.alloc((width + 1) * height, 0xff);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    const glyphRow = Math.floor(y / scale) - margin;
    if (glyphRow < 0 || glyphRow >= 7) continue;
    for (let x = 0; x < width; x++) {
      const column = Math.floor(x / scale) - margin;
      if (column < 0 || column % 6 === 5) continue;
      if (glyphs[Math.floor(column / 6)]?.[glyphRow]?.[column % 6] === "#") {
        raw[y * (width + 1) + 1 + x] = 0;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // color type: grayscale
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(raw)),
      pngChunk("IEND", new Uint8Array(0)),
    ]),
  );
}

/** A 256x256 solid red PNG. */
export const PNG_DATA: Uint8Array<ArrayBuffer> = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACwElEQVR4nO3TMQEAIAzAMEDI/ItCDDI4mijo031nFlSd3wHwkwFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkGYA0gxAmgFIMwBpBiDNAKQZgDQDkPYAdhEDGL4mMFkAAAAASUVORK5CYII=",
    "base64",
  ),
);

function buildPdfTextStream(text: string, fontSize: number): string {
  return `BT /F1 ${fontSize} Tf 20 80 Td (${text.replace(/[\\()]/g, "\\$&")}) Tj ET`;
}

/** Builds a one-page PDF whose only text is the supplied string. */
export function buildPdfData(
  text: string,
  declaredLength?: number,
  fontSize: number = 18,
): Uint8Array<ArrayBuffer> {
  const stream = buildPdfTextStream(text, fontSize);
  const length = declaredLength ?? new TextEncoder().encode(stream).byteLength;
  return new TextEncoder().encode(
    [
      "%PDF-1.4",
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
      `4 0 obj<</Length ${length}>>stream`,
      stream,
      "endstream endobj",
      "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
      "trailer<</Root 1 0 R>>",
      "%%EOF",
    ].join("\n"),
  );
}

/** A one-page PDF whose only text is "The secret word is PINEAPPLE.". */
export const PDF_DATA: Uint8Array<ArrayBuffer> = buildPdfData("The secret word is PINEAPPLE.", 58);
