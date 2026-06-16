import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { type Attachment, Collection } from "discord.js";
import {
  MAX_PDF_BYTES,
  MAX_TOTAL_PDF_BYTES,
  parseAttachments,
} from "../../../src/services/attachmentParser";

type AttachmentFixture = {
  id: string;
  name: string;
  url: string;
  contentType: string | null;
  size?: number;
};

const makeCollection = (fixtures: AttachmentFixture[]): Collection<string, Attachment> => {
  const collection = new Collection<string, Attachment>();
  for (const fixture of fixtures) {
    collection.set(fixture.id, {
      name: fixture.name,
      url: fixture.url,
      contentType: fixture.contentType,
      size: fixture.size ?? 1024,
    } as unknown as Attachment);
  }
  return collection;
};

describe("parseAttachments", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = mock();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("画像のみの場合は image_url part を返す (fetch されない)", async () => {
    const result = await parseAttachments(
      makeCollection([
        {
          id: "1",
          name: "photo.png",
          url: "https://cdn.discord.test/photo.png",
          contentType: "image/png",
        },
      ]),
    );

    expect(result).toEqual({
      parts: [{ type: "image_url", image_url: { url: "https://cdn.discord.test/photo.png" } }],
      hasImage: true,
      hasPdf: false,
      rejected: [],
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("PDF を fetch して base64 data URL に変換し file part を返す", async () => {
    // "PDF" の 3 バイトを base64 化 → "UERG"
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(new Uint8Array([0x50, 0x44, 0x46]).buffer satisfies ArrayBuffer),
    });

    const result = await parseAttachments(
      makeCollection([
        {
          id: "1",
          name: "spec.pdf",
          url: "https://cdn.discord.test/spec.pdf",
          contentType: "application/pdf",
        },
      ]),
    );

    expect(mockFetch.mock.calls[0]?.[0]).toBe("https://cdn.discord.test/spec.pdf");
    // 第二引数で AbortSignal (timeout) が渡されることを確認
    const options = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      parts: [
        {
          type: "file",
          file: { filename: "spec.pdf", file_data: "data:application/pdf;base64,UERG" },
        },
      ],
      hasImage: false,
      hasPdf: true,
      rejected: [],
    });
  });

  test("PDF fetch が ok=false を返す場合は FETCH_FAILED として rejected に積む", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    const result = await parseAttachments(
      makeCollection([
        {
          id: "1",
          name: "expired.pdf",
          url: "https://cdn.discord.test/expired.pdf",
          contentType: "application/pdf",
        },
      ]),
    );

    expect(result.parts).toEqual([]);
    expect(result.hasPdf).toBe(false);
    expect(result.rejected).toEqual([{ filename: "expired.pdf", reason: "FETCH_FAILED" }]);
  });

  test("PDF サイズが MAX_PDF_BYTES を超える場合は fetch せず FILE_TOO_LARGE で reject", async () => {
    const result = await parseAttachments(
      makeCollection([
        {
          id: "1",
          name: "huge.pdf",
          url: "https://cdn.discord.test/huge.pdf",
          contentType: "application/pdf",
          size: MAX_PDF_BYTES + 1,
        },
      ]),
    );

    expect(result.parts).toEqual([]);
    expect(result.hasPdf).toBe(false);
    expect(result.rejected).toEqual([{ filename: "huge.pdf", reason: "FILE_TOO_LARGE" }]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("PDF が複数あり合計が MAX_TOTAL_PDF_BYTES を超える場合は超過分のみ FILE_TOO_LARGE で reject", async () => {
    // 1 個目: MAX_PDF_BYTES ぎりぎり (20MB)、通る
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(new Uint8Array([0x50, 0x44, 0x46]).buffer satisfies ArrayBuffer),
    });
    // 2 個目: MAX_PDF_BYTES ぎりぎり (20MB)、通る (合計 40MB ちょうど)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(new Uint8Array([0x50, 0x44, 0x46]).buffer satisfies ArrayBuffer),
    });
    // 3 個目: 1MB だが合計を超える → reject

    const result = await parseAttachments(
      makeCollection([
        {
          id: "1",
          name: "first.pdf",
          url: "https://cdn.discord.test/first.pdf",
          contentType: "application/pdf",
          size: MAX_PDF_BYTES,
        },
        {
          id: "2",
          name: "second.pdf",
          url: "https://cdn.discord.test/second.pdf",
          contentType: "application/pdf",
          size: MAX_TOTAL_PDF_BYTES - MAX_PDF_BYTES,
        },
        {
          id: "3",
          name: "third.pdf",
          url: "https://cdn.discord.test/third.pdf",
          contentType: "application/pdf",
          size: 1024 * 1024,
        },
      ]),
    );

    expect(result.parts).toHaveLength(2);
    expect(result.hasPdf).toBe(true);
    expect(result.rejected).toEqual([{ filename: "third.pdf", reason: "FILE_TOO_LARGE" }]);
    // 3 個目は fetch されない（rejected で skip）
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("PDF サイズが MAX_PDF_BYTES ちょうどなら通す (境界値)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(new Uint8Array([0x50, 0x44, 0x46]).buffer satisfies ArrayBuffer),
    });

    const result = await parseAttachments(
      makeCollection([
        {
          id: "1",
          name: "edge.pdf",
          url: "https://cdn.discord.test/edge.pdf",
          contentType: "application/pdf",
          size: MAX_PDF_BYTES,
        },
      ]),
    );

    expect(result.hasPdf).toBe(true);
    expect(result.rejected).toEqual([]);
  });

  test("PDF fetch が throw した場合も FETCH_FAILED として rejected に積む", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const result = await parseAttachments(
      makeCollection([
        {
          id: "1",
          name: "broken.pdf",
          url: "https://cdn.discord.test/broken.pdf",
          contentType: "application/pdf",
        },
      ]),
    );

    expect(result.parts).toEqual([]);
    expect(result.rejected).toEqual([{ filename: "broken.pdf", reason: "FETCH_FAILED" }]);
  });

  test("画像と PDF が混在する場合は PDF だけ fetch する", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(new Uint8Array([0x50, 0x44, 0x46]).buffer satisfies ArrayBuffer),
    });

    const result = await parseAttachments(
      makeCollection([
        {
          id: "1",
          name: "photo.jpg",
          url: "https://cdn.discord.test/photo.jpg",
          contentType: "image/jpeg",
        },
        {
          id: "2",
          name: "doc.pdf",
          url: "https://cdn.discord.test/doc.pdf",
          contentType: "application/pdf",
        },
      ]),
    );

    expect(result.parts).toHaveLength(2);
    expect(result.hasImage).toBe(true);
    expect(result.hasPdf).toBe(true);
    expect(result.rejected).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toBe("https://cdn.discord.test/doc.pdf");
  });

  test("サポート外 MIME は UNSUPPORTED_MIME として rejected に積む", async () => {
    const result = await parseAttachments(
      makeCollection([
        {
          id: "1",
          name: "data.csv",
          url: "https://cdn.discord.test/data.csv",
          contentType: "text/csv",
        },
      ]),
    );

    expect(result.parts).toEqual([]);
    expect(result.hasImage).toBe(false);
    expect(result.hasPdf).toBe(false);
    expect(result.rejected).toEqual([{ filename: "data.csv", reason: "UNSUPPORTED_MIME" }]);
  });

  test("contentType が null の場合は MISSING_MIME として区別される", async () => {
    const result = await parseAttachments(
      makeCollection([
        {
          id: "1",
          name: "unknown.bin",
          url: "https://cdn.discord.test/unknown.bin",
          contentType: null,
        },
      ]),
    );

    expect(result.parts).toEqual([]);
    expect(result.rejected).toEqual([{ filename: "unknown.bin", reason: "MISSING_MIME" }]);
  });

  test("画像と未サポート MIME が混在する場合は画像のみ parts に積み、残りは rejected", async () => {
    const result = await parseAttachments(
      makeCollection([
        {
          id: "1",
          name: "photo.webp",
          url: "https://cdn.discord.test/photo.webp",
          contentType: "image/webp",
        },
        {
          id: "2",
          name: "audio.mp3",
          url: "https://cdn.discord.test/audio.mp3",
          contentType: "audio/mpeg",
        },
      ]),
    );

    expect(result.parts).toEqual([
      { type: "image_url", image_url: { url: "https://cdn.discord.test/photo.webp" } },
    ]);
    expect(result.rejected).toEqual([{ filename: "audio.mp3", reason: "UNSUPPORTED_MIME" }]);
  });

  test("空 collection の場合は空の結果を返す", async () => {
    const result = await parseAttachments(makeCollection([]));
    expect(result).toEqual({ parts: [], hasImage: false, hasPdf: false, rejected: [] });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
