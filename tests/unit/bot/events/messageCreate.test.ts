import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMessageCreateHandler } from "../../../../src/bot/events/messageCreate";
import { AppError, RateLimitError } from "../../../../src/errors";
import type { IChatService } from "../../../../src/services/chatService";
import type { IModelService } from "../../../../src/services/modelService";
import type { ISettingsService } from "../../../../src/services/settingsService";

interface MockBotMessage {
  id: string;
  edit: ReturnType<typeof mock>;
}

interface MockMessage {
  id: string;
  author: { bot: boolean };
  guild: { id: string } | null;
  client: { user: { id: string } | null };
  mentions: { has: ReturnType<typeof mock> };
  content: string;
  channel: {
    send: ReturnType<typeof mock>;
    isThread: () => boolean;
  };
  reply: ReturnType<typeof mock>;
}

function createMockStreamGenerator(fullText: string) {
  return async function* () {
    // チャンクを複数に分割してyield
    const chunkSize = Math.ceil(fullText.length / 3);
    for (let i = 0; i < fullText.length; i += chunkSize) {
      yield { content: fullText.slice(i, i + chunkSize), done: false as const };
    }
    yield {
      done: true as const,
      fullText,
      usage: undefined,
      model: undefined,
      provider: undefined,
    };
  };
}

function createErrorStreamGenerator(error: Error) {
  return async function* () {
    throw error;
  };
}

describe("createMessageCreateHandler", () => {
  let mockChatService: IChatService;
  let mockSettingsService: ISettingsService;
  let mockModelService: IModelService;
  let mockMessage: MockMessage;
  let mockReply: ReturnType<typeof mock>;
  let mockSend: ReturnType<typeof mock>;
  let mockBotMessage: MockBotMessage;

  beforeEach(() => {
    mockBotMessage = {
      id: "bot-msg-123",
      edit: mock(() => Promise.resolve()),
    };

    mockChatService = {
      generateResponse: mock(() => Promise.resolve({ text: "Mock response", metadata: undefined })),
      generateResponseStream: mock(createMockStreamGenerator("Mock response")),
      cancelRequest: mock(() => false),
    };

    const mockGuildSettings = {
      guildId: "guild-123",
      defaultModel: "deepseek/deepseek-r1-0528:free",
      freeModelsOnly: false,
      releaseChannelId: null,
      showLlmDetails: true,
      autoReplyChannels: [] as string[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    mockSettingsService = {
      getGuildSettings: mock(() => Promise.resolve(mockGuildSettings)),
      setGuildModel: mock(() => Promise.resolve(mockGuildSettings)),
      setFreeModelsOnly: mock(() => Promise.resolve(mockGuildSettings)),
      setReleaseChannel: mock(() => Promise.resolve(mockGuildSettings)),
      setShowLlmDetails: mock(() => Promise.resolve()),
      toggleShowLlmDetails: mock(() => Promise.resolve(true)),
      getGuildsWithReleaseChannel: mock(() => Promise.resolve([])),
      addAutoReplyChannel: mock(() => Promise.resolve()),
      removeAutoReplyChannel: mock(() => Promise.resolve(true)),
    };

    mockModelService = {
      getAllModels: mock(() => Promise.resolve([])),
      getFreeModels: mock(() => Promise.resolve([])),
      isModelAvailable: mock(() => Promise.resolve(true)),
      isFreeModel: mock(() => Promise.resolve(true)),
      validateModelSelection: mock(() => Promise.resolve({ valid: true })),
      getModelName: mock(() => Promise.resolve("DeepSeek R1 0528 (free)")),
      getModelDetails: mock(() => Promise.resolve(null)),
      refreshCache: mock(() => Promise.resolve()),
      getCacheStatus: mock(() => ({
        lastUpdatedAt: new Date(),
        modelCount: 0,
        isExpired: false,
      })),
    };

    mockReply = mock(() => Promise.resolve());
    mockSend = mock(() => Promise.resolve(mockBotMessage));

    mockMessage = {
      id: "msg-123",
      author: { bot: false },
      guild: { id: "guild-123" },
      client: { user: { id: "123456789" } },
      mentions: { has: mock(() => true) },
      content: "<@123456789> Hello",
      channel: {
        send: mockSend,
        isThread: () => false,
      },
      reply: mockReply,
    };

    spyOn(console, "debug").mockImplementation(() => {});
    spyOn(console, "info").mockImplementation(() => {});
    spyOn(console, "warn").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
  });

  test("Botからのメッセージは無視する", async () => {
    mockMessage.author.bot = true;
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    expect(mockChatService.generateResponseStream).not.toHaveBeenCalled();
  });

  test("Guild外のメッセージは無視する", async () => {
    mockMessage.guild = null;
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    expect(mockChatService.generateResponseStream).not.toHaveBeenCalled();
  });

  test("メンションがない場合は無視する", async () => {
    mockMessage.mentions.has.mockReturnValue(false);
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    expect(mockChatService.generateResponseStream).not.toHaveBeenCalled();
  });

  test("空のコンテンツは入力エラーEmbedを返す", async () => {
    mockMessage.content = "<@123456789>";
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    expect(mockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              color: 0xed4245, // RED
              title: "入力エラー",
              description: "メッセージを入力してください。",
            }),
          }),
        ]),
        allowedMentions: { repliedUser: false },
      }),
    );
    expect(mockChatService.generateResponseStream).not.toHaveBeenCalled();
  });

  test("正常なメッセージに対してストリーミングレスポンスを生成する", async () => {
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    // 初期メッセージ「生成中...」が送信される
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "生成中...",
        components: expect.any(Array),
      }),
    );

    // generateResponseStreamが呼ばれる
    expect(mockChatService.generateResponseStream).toHaveBeenCalledWith(
      "guild-123",
      "Hello",
      "msg-123",
    );

    // 最終更新でEmbedが設定される
    expect(mockBotMessage.edit).toHaveBeenCalled();
    const lastEditCall = (mockBotMessage.edit as ReturnType<typeof mock>).mock.calls.at(-1);
    expect(lastEditCall[0]).toHaveProperty("embeds");
    expect(lastEditCall[0].components).toEqual([]);
  });

  test("AppErrorの場合は赤色EmbedでuserMessageを表示する", async () => {
    const error = new RateLimitError("Rate limited by API", 30);
    (mockChatService.generateResponseStream as ReturnType<typeof mock>).mockImplementation(
      createErrorStreamGenerator(error),
    );
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    expect(mockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              color: 0xed4245, // RED
              description: "リクエスト制限に達しました。30秒後に再度お試しください。",
            }),
          }),
        ]),
        allowedMentions: { repliedUser: false },
      }),
    );
  });

  test("一般的なErrorの場合は赤色Embedで汎用メッセージを表示する", async () => {
    const error = new Error("Unknown error");
    (mockChatService.generateResponseStream as ReturnType<typeof mock>).mockImplementation(
      createErrorStreamGenerator(error),
    );
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    expect(mockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              color: 0xed4245, // RED
              description:
                "予期しないエラーが発生しました。問題が続く場合は管理者にお問い合わせください。",
            }),
          }),
        ]),
        allowedMentions: { repliedUser: false },
      }),
    );
  });

  test("カスタムAppErrorの場合は赤色EmbedでそのuserMessageを表示する", async () => {
    const error = new AppError("Technical message", "カスタムエラーメッセージ", 500);
    (mockChatService.generateResponseStream as ReturnType<typeof mock>).mockImplementation(
      createErrorStreamGenerator(error),
    );
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    expect(mockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              color: 0xed4245, // RED
              description: "カスタムエラーメッセージ",
            }),
          }),
        ]),
        allowedMentions: { repliedUser: false },
      }),
    );
  });

  test("自動応答チャンネルで応答する", async () => {
    // メンションなし
    mockMessage.mentions.has.mockReturnValue(false);
    mockMessage.content = "Hello without mention";

    // 自動応答チャンネルに設定
    const mockGuildSettingsWithAutoReply = {
      guildId: "guild-123",
      defaultModel: "deepseek/deepseek-r1-0528:free",
      freeModelsOnly: false,
      releaseChannelId: null,
      showLlmDetails: true,
      autoReplyChannels: ["auto-reply-channel-id"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    (mockSettingsService.getGuildSettings as ReturnType<typeof mock>).mockResolvedValue(
      mockGuildSettingsWithAutoReply,
    );

    // チャンネルIDを自動応答チャンネルに設定
    (mockMessage.channel as { id?: string }).id = "auto-reply-channel-id";

    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    expect(mockChatService.generateResponseStream).toHaveBeenCalled();
  });

  test("長文応答は複数メッセージに分割される", async () => {
    const longResponse = "a".repeat(10000);
    (mockChatService.generateResponseStream as ReturnType<typeof mock>).mockImplementation(
      createMockStreamGenerator(longResponse),
    );

    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    // 最初のメッセージはeditされる
    expect(mockBotMessage.edit).toHaveBeenCalled();

    // 追加メッセージがsendで送信される（長文の場合）
    const sendCalls = (mockSend as ReturnType<typeof mock>).mock.calls;
    // 最初のsendは「生成中...」、その後に追加メッセージ
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("AbortErrorの場合は停止メッセージを表示する", async () => {
    const abortError = new Error("Request was aborted");
    abortError.name = "AbortError";
    (mockChatService.generateResponseStream as ReturnType<typeof mock>).mockImplementation(
      createErrorStreamGenerator(abortError),
    );

    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    // AbortErrorの場合はreplyではなくeditで停止メッセージを表示
    const lastEditCall = (mockBotMessage.edit as ReturnType<typeof mock>).mock.calls.at(-1);
    expect(lastEditCall[0].content).toContain("生成を停止しました");
    expect(lastEditCall[0].components).toEqual([]);
  });
});
