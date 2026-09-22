import { describe, expect, test } from "bun:test";
import { PDF_PARSER_PLUGIN } from "../../../src/services/attachmentParser";
import { buildChatMessages, buildChatRequest } from "../../../src/services/chatService";

describe("chat service request helpers", () => {
  test("builds a text-only request without optional fields", () => {
    expect(buildChatRequest("model", { text: "hello" })).toEqual({
      model: "model",
      messages: [{ role: "user", content: "hello" }],
    });
  });

  test("builds a default prompt and attaches the parser for a file", () => {
    const parts = [{ type: "file" as const, file: { filename: "notes.pdf", file_data: "data" } }];

    expect(buildChatMessages({ text: "", parts })).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "添付された文書を要約してください。" }, ...parts],
      },
    ]);
    expect(buildChatRequest("model", { text: "", parts }).plugins).toEqual([PDF_PARSER_PLUGIN]);
  });
});
