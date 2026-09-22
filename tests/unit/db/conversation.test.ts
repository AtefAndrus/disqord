import { describe, expect, mock, test } from "bun:test";
import {
  buildPersistedContent,
  estimatePersistedContentTokens,
  hydratePersistedContent,
  normalizeAuthorLabel,
  type PersistedContentPart,
  stripHistoricalMedia,
} from "../../../src/db/repositories/conversation";

describe("conversation content helpers", () => {
  test("normalizes author labels and falls back when no safe label remains", () => {
    const normalized = normalizeAuthorLabel(
      ` [Alice]\n\t\u0007A\u200b\u202e ${"x".repeat(40)}`,
      "author-id",
    );

    expect(normalized).toBe(`Alice  A ${"x".repeat(23)}`);
    expect(normalizeAuthorLabel("[]\u200b\u202e", "author-id")).toBe("author-id");
  });

  test("builds persisted refs without storing fetched PDF data", () => {
    expect(
      buildPersistedContent("question", [
        { type: "image-ref", url: "https://cdn.test/a.png", mime: "image/png" },
        {
          type: "file-ref",
          url: "https://cdn.test/a.pdf",
          filename: "a.pdf",
          mime: "application/pdf",
        },
      ]),
    ).toEqual([
      { type: "text", text: "question" },
      { type: "image-ref", url: "https://cdn.test/a.png", mime: "image/png" },
      {
        type: "file-ref",
        url: "https://cdn.test/a.pdf",
        filename: "a.pdf",
        mime: "application/pdf",
      },
    ]);
  });

  test("replaces the media of every turn but the current one, whichever turn has media", () => {
    const original: PersistedContentPart[][] = [
      [{ type: "image-ref", url: "https://cdn.test/old.png", mime: "image/png" }],
      [{ type: "text", text: "middle" }],
      [
        {
          type: "file-ref",
          url: "https://cdn.test/new.pdf",
          filename: "new.pdf",
          mime: "application/pdf",
        },
      ],
      [{ type: "text", text: "current" }],
    ];
    const copy = structuredClone(original);

    expect(stripHistoricalMedia(original)).toEqual([
      [{ type: "text", text: "[earlier image omitted]" }],
      [{ type: "text", text: "middle" }],
      [{ type: "text", text: "[earlier file omitted: new.pdf]" }],
      [{ type: "text", text: "current" }],
    ]);
    const withCurrentImage: PersistedContentPart[][] = [
      [{ type: "text", text: "before" }],
      [{ type: "image-ref", url: "https://cdn.test/now.png", mime: "image/png" }],
    ];
    expect(stripHistoricalMedia(withCurrentImage)).toEqual(withCurrentImage);
    expect(original).toEqual(copy);
  });

  test("estimates ASCII, non-ASCII, image, and unfetched PDF parts", () => {
    expect(
      estimatePersistedContentTokens([
        { type: "text", text: "abcdあい" },
        { type: "image-ref", url: "image", mime: "image/png" },
        { type: "file-ref", url: "file", filename: "doc.pdf", mime: "application/pdf" },
      ]),
    ).toBe(3_003);
  });

  test("hydrates images as-is, PDFs as base64, and failed PDFs as text", async () => {
    const fetcher = mock(async (url: string): Promise<Response> => {
      if (url.endsWith("ok.pdf")) return new Response(new Uint8Array([0x50, 0x44, 0x46]));
      return new Response("gone", { status: 404 });
    });
    const parts: PersistedContentPart[] = [
      { type: "text", text: "before" },
      { type: "image-ref", url: "https://cdn.test/image", mime: "image/png" },
      {
        type: "file-ref",
        url: "https://cdn.test/ok.pdf",
        filename: "ok.pdf",
        mime: "application/pdf",
      },
      {
        type: "file-ref",
        url: "https://cdn.test/gone.pdf",
        filename: "gone.pdf",
        mime: "application/pdf",
      },
    ];

    await expect(
      hydratePersistedContent(parts, fetcher as unknown as typeof fetch),
    ).resolves.toEqual([
      { type: "text", text: "before" },
      { type: "image_url", image_url: { url: "https://cdn.test/image" } },
      {
        type: "file",
        file: { filename: "ok.pdf", file_data: "data:application/pdf;base64,UERG" },
      },
      { type: "text", text: "[file unavailable: gone.pdf]" },
    ]);
    expect(fetcher).toHaveBeenNthCalledWith(1, "https://cdn.test/ok.pdf", {
      signal: expect.any(AbortSignal),
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://cdn.test/gone.pdf", {
      signal: expect.any(AbortSignal),
    });
  });
});
