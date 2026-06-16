import { describe, expect, test } from "bun:test";
import { type Attachment, Collection } from "discord.js";
import { parseAttachments } from "../../../src/services/attachmentParser";

type AttachmentFixture = {
  id: string;
  name: string;
  url: string;
  contentType: string | null;
};

const makeCollection = (fixtures: AttachmentFixture[]): Collection<string, Attachment> => {
  const collection = new Collection<string, Attachment>();
  for (const fixture of fixtures) {
    collection.set(fixture.id, {
      name: fixture.name,
      url: fixture.url,
      contentType: fixture.contentType,
    } as unknown as Attachment);
  }
  return collection;
};

describe("parseAttachments", () => {
  test("画像のみの場合は image_url part を返す", () => {
    const result = parseAttachments(
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
  });

  test("PDF のみの場合は file part を返す", () => {
    const result = parseAttachments(
      makeCollection([
        {
          id: "1",
          name: "spec.pdf",
          url: "https://cdn.discord.test/spec.pdf",
          contentType: "application/pdf",
        },
      ]),
    );

    expect(result).toEqual({
      parts: [
        {
          type: "file",
          file: { filename: "spec.pdf", file_data: "https://cdn.discord.test/spec.pdf" },
        },
      ],
      hasImage: false,
      hasPdf: true,
      rejected: [],
    });
  });

  test("画像と PDF が混在する場合は両方を parts に積む", () => {
    const result = parseAttachments(
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
  });

  test("サポート外 MIME は UNSUPPORTED_MIME として rejected に積む", () => {
    const result = parseAttachments(
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

  test("contentType が null の場合は MISSING_MIME として区別される", () => {
    const result = parseAttachments(
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

  test("画像と未サポート MIME が混在する場合は画像のみ parts に積み、残りは rejected", () => {
    const result = parseAttachments(
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

  test("空 collection の場合は空の結果を返す", () => {
    const result = parseAttachments(makeCollection([]));
    expect(result).toEqual({ parts: [], hasImage: false, hasPdf: false, rejected: [] });
  });
});
