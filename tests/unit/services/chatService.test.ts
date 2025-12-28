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
    await chatService.generateResponse("guild-123", "Hello");
    expect(mockSettingsService.getGuildSettings).toHaveBeenCalledWith("guild-123");
  });

  test("LLMClientにギルドのデフォルトモデルを使用してリクエスト", async () => {
    const customSettings = createMockGuildSettings({
      guildId: "guild-123",
      defaultModel: "custom-model",
    });
    (mockSettingsService.getGuildSettings as ReturnType<typeof mock>).mockResolvedValueOnce(
      customSettings,
    );

    await chatService.generateResponse("guild-123", "Hello");

    expect(mockLLMClient.chat).toHaveBeenCalledWith({
      model: "custom-model",
      messages: [{ role: "user", content: "Hello" }],
    });
  });

  test("LLMClientからのレスポンスを返す", async () => {
    const response: ChatCompletionResponse = {
      id: "resp-1",
      choices: [{ message: { role: "assistant", content: "Hello, user!" } }],
    };
    (mockLLMClient.chat as ReturnType<typeof mock>).mockResolvedValueOnce(response);

    const result = await chatService.generateResponse("guild-123", "Hi");

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

    const result = await chatService.generateResponse("guild-123", "Hi");

    expect(result.text).toBe("");
  });

  test("messageのcontentがundefinedの場合は空文字を返す", async () => {
    const response = {
      id: "resp-3",
      choices: [{ message: { role: "assistant", content: undefined } }],
    } as unknown as ChatCompletionResponse;
    (mockLLMClient.chat as ReturnType<typeof mock>).mockResolvedValueOnce(response);

    const result = await chatService.generateResponse("guild-123", "Hi");

    expect(result.text).toBe("");
  });

  test("LLMClientがエラーをスローした場合はそのまま伝播", async () => {
    const error = new Error("LLM error");
    (mockLLMClient.chat as ReturnType<typeof mock>).mockRejectedValueOnce(error);

    await expect(chatService.generateResponse("guild-123", "Hi")).rejects.toThrow("LLM error");
  });

  test("SettingsServiceがエラーをスローした場合はそのまま伝播", async () => {
    const error = new Error("Settings error");
    (mockSettingsService.getGuildSettings as ReturnType<typeof mock>).mockRejectedValueOnce(error);

    await expect(chatService.generateResponse("guild-123", "Hi")).rejects.toThrow("Settings error");
  });
});
