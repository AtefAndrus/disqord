import { beforeEach, describe, expect, type mock, test } from "bun:test";
import type { ILLMClient } from "../../../src/llm/openrouter";
import { ChatService } from "../../../src/services/chatService";
import type { ISettingsService } from "../../../src/services/settingsService";
import type { ChatCompletionResponse } from "../../../src/types";
import {
  createMockGuildSettings,
  createMockLLMClient,
  createMockSettingsService,
} from "../../helpers/mockFactories";

describe("ChatService", () => {
  let chatService: ChatService;
  let mockLLMClient: ILLMClient;
  let mockSettingsService: ISettingsService;

  beforeEach(() => {
    mockLLMClient = createMockLLMClient();
    mockSettingsService = createMockSettingsService();
    chatService = new ChatService(mockLLMClient, mockSettingsService);
  });

  test("SettingsServiceからギルド設定を取得する", async () => {
    await chatService.generateResponse("guild-123", { text: "Hello" });
    expect(mockSettingsService.getGuildSettings).toHaveBeenCalledWith("guild-123");
  });

  test("LLMClientにギルドのデフォルトモデルを使用してリクエスト (text-only)", async () => {
    const customSettings = createMockGuildSettings({
      guildId: "guild-123",
      defaultModel: "custom-model",
    });
    (mockSettingsService.getGuildSettings as ReturnType<typeof mock>).mockResolvedValueOnce(
      customSettings,
    );

    await chatService.generateResponse("guild-123", { text: "Hello" });

    expect(mockLLMClient.chat).toHaveBeenCalledWith({
      model: "custom-model",
      messages: [{ role: "user", content: "Hello" }],
    });
  });

  test("parts ありの場合は content を配列で送る (text + 画像)", async () => {
    await chatService.generateResponse("guild-123", {
      text: "Describe",
      parts: [{ type: "image_url", image_url: { url: "https://cdn.discord.test/a.png" } }],
    });

    expect(mockLLMClient.chat).toHaveBeenCalledWith({
      model: "test-model:fixture",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe" },
            { type: "image_url", image_url: { url: "https://cdn.discord.test/a.png" } },
          ],
        },
      ],
    });
  });

  test("text が空 + 画像 parts → default prompt (画像) を text part として補う", async () => {
    await chatService.generateResponse("guild-123", {
      text: "",
      parts: [{ type: "image_url", image_url: { url: "https://cdn.discord.test/a.png" } }],
    });

    expect(mockLLMClient.chat).toHaveBeenCalledWith({
      model: "test-model:fixture",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "添付された画像について説明してください。" },
            { type: "image_url", image_url: { url: "https://cdn.discord.test/a.png" } },
          ],
        },
      ],
    });
  });

  test("text が空 + file parts → default prompt (PDF) を text part として補う", async () => {
    await chatService.generateResponse("guild-123", {
      text: "",
      parts: [
        {
          type: "file",
          file: { filename: "spec.pdf", file_data: "data:application/pdf;base64,UERG" },
        },
      ],
    });

    expect(mockLLMClient.chat).toHaveBeenCalledWith({
      model: "test-model:fixture",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "添付された文書を要約してください。" },
            {
              type: "file",
              file: { filename: "spec.pdf", file_data: "data:application/pdf;base64,UERG" },
            },
          ],
        },
      ],
      plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }],
    });
  });

  test("text が空 + 画像 + file 混在 → default prompt (混在) を text part として補う", async () => {
    await chatService.generateResponse("guild-123", {
      text: "",
      parts: [
        { type: "image_url", image_url: { url: "https://cdn.discord.test/a.png" } },
        {
          type: "file",
          file: { filename: "spec.pdf", file_data: "data:application/pdf;base64,UERG" },
        },
      ],
    });

    const call = (mockLLMClient.chat as ReturnType<typeof mock>).mock.calls[0]?.[0];
    expect(call.messages[0].content[0]).toEqual({
      type: "text",
      text: "添付ファイルについて説明してください。",
    });
  });

  test("file パートを含む場合のみ plugins が付与される", async () => {
    await chatService.generateResponse("guild-123", {
      text: "Summarize",
      parts: [
        {
          type: "file",
          file: { filename: "spec.pdf", file_data: "https://cdn.discord.test/spec.pdf" },
        },
      ],
    });

    expect(mockLLMClient.chat).toHaveBeenCalledWith({
      model: "test-model:fixture",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize" },
            {
              type: "file",
              file: { filename: "spec.pdf", file_data: "https://cdn.discord.test/spec.pdf" },
            },
          ],
        },
      ],
      plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }],
    });
  });

  test("画像のみの場合は plugins を付与しない", async () => {
    await chatService.generateResponse("guild-123", {
      text: "Look",
      parts: [{ type: "image_url", image_url: { url: "https://cdn.discord.test/a.png" } }],
    });

    const call = (mockLLMClient.chat as ReturnType<typeof mock>).mock.calls[0];
    expect(call?.[0]).not.toHaveProperty("plugins");
  });

  test("LLMClientからのレスポンスを返す", async () => {
    const response: ChatCompletionResponse = {
      id: "resp-1",
      choices: [{ message: { role: "assistant", content: "Hello, user!" } }],
    };
    (mockLLMClient.chat as ReturnType<typeof mock>).mockResolvedValueOnce(response);

    const result = await chatService.generateResponse("guild-123", { text: "Hi" });

    expect(result.text).toBe("Hello, user!");
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.latency).toBeGreaterThanOrEqual(0);
  });

  test("choicesが空の場合は空文字を返す", async () => {
    const response: ChatCompletionResponse = {
      id: "resp-2",
      choices: [],
    };
    (mockLLMClient.chat as ReturnType<typeof mock>).mockResolvedValueOnce(response);

    const result = await chatService.generateResponse("guild-123", { text: "Hi" });

    expect(result.text).toBe("");
  });

  test("messageのcontentがundefinedの場合は空文字を返す", async () => {
    const response = {
      id: "resp-3",
      choices: [{ message: { role: "assistant", content: undefined } }],
    } as unknown as ChatCompletionResponse;
    (mockLLMClient.chat as ReturnType<typeof mock>).mockResolvedValueOnce(response);

    const result = await chatService.generateResponse("guild-123", { text: "Hi" });

    expect(result.text).toBe("");
  });

  test("LLMClientがエラーをスローした場合はそのまま伝播", async () => {
    const error = new Error("LLM error");
    (mockLLMClient.chat as ReturnType<typeof mock>).mockRejectedValueOnce(error);

    await expect(chatService.generateResponse("guild-123", { text: "Hi" })).rejects.toThrow(
      "LLM error",
    );
  });

  test("SettingsServiceがエラーをスローした場合はそのまま伝播", async () => {
    const error = new Error("Settings error");
    (mockSettingsService.getGuildSettings as ReturnType<typeof mock>).mockRejectedValueOnce(error);

    await expect(chatService.generateResponse("guild-123", { text: "Hi" })).rejects.toThrow(
      "Settings error",
    );
  });

  test("generateResponseStream も multimodal request (content 配列 + plugins) を chatStream に渡す", async () => {
    const stream = chatService.generateResponseStream(
      "guild-123",
      {
        text: "Summarize",
        parts: [
          {
            type: "file",
            file: { filename: "spec.pdf", file_data: "https://cdn.discord.test/spec.pdf" },
          },
        ],
      },
      "req-1",
    );
    // generator を駆動して chatStream を呼ばせる
    for await (const _ of stream) {
      // mock の chatStream は 3 chunk を yield する
    }

    expect(mockLLMClient.chatStream).toHaveBeenCalledWith(
      {
        model: "test-model:fixture",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Summarize" },
              {
                type: "file",
                file: { filename: "spec.pdf", file_data: "https://cdn.discord.test/spec.pdf" },
              },
            ],
          },
        ],
        plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }],
      },
      expect.any(AbortSignal),
    );
  });
});
