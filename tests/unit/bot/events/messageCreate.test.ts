import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMessageCreateHandler } from "../../../../src/bot/events/messageCreate";
import { AppError, RateLimitError } from "../../../../src/errors";
import type { IChatService } from "../../../../src/services/chatService";
import type { IModelService } from "../../../../src/services/modelService";
import type { ISettingsService } from "../../../../src/services/settingsService";

interface MockMessage {
  author: { bot: boolean };
  guild: { id: string } | null;
  client: { user: { id: string } | null };
  mentions: { has: ReturnType<typeof mock> };
  content: string;
  channel: {
    send: ReturnType<typeof mock>;
    sendTyping: ReturnType<typeof mock>;
  };
  reply: ReturnType<typeof mock>;
}

describe("createMessageCreateHandler", () => {
  let mockChatService: IChatService;
  let mockSettingsService: ISettingsService;
  let mockModelService: IModelService;
  let mockMessage: MockMessage;
  let mockReply: ReturnType<typeof mock>;
  let mockSend: ReturnType<typeof mock>;
  let mockSendTyping: ReturnType<typeof mock>;

  beforeEach(() => {
    mockChatService = {
      generateResponse: mock(() => Promise.resolve("Mock response")),
    };

    const mockGuildSettings = {
      guildId: "guild-123",
      defaultModel: "deepseek/deepseek-r1-0528:free",
      freeModelsOnly: false,
      releaseChannelId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    mockSettingsService = {
      getGuildSettings: mock(() => Promise.resolve(mockGuildSettings)),
      setGuildModel: mock(() => Promise.resolve(mockGuildSettings)),
      setFreeModelsOnly: mock(() => Promise.resolve(mockGuildSettings)),
      setReleaseChannel: mock(() => Promise.resolve(mockGuildSettings)),
      getGuildsWithReleaseChannel: mock(() => Promise.resolve([])),
    };

    mockModelService = {
      getAllModels: mock(() => Promise.resolve([])),
      getFreeModels: mock(() => Promise.resolve([])),
      isModelAvailable: mock(() => Promise.resolve(true)),
      isFreeModel: mock(() => Promise.resolve(true)),
      validateModelSelection: mock(() => Promise.resolve({ valid: true })),
      getModelName: mock(() => Promise.resolve("DeepSeek R1 0528 (free)")),
      refreshCache: mock(() => Promise.resolve()),
      getCacheStatus: mock(() => ({
        lastUpdatedAt: new Date(),
        modelCount: 0,
        isExpired: false,
      })),
    };

    mockReply = mock(() => Promise.resolve());
    mockSend = mock(() => Promise.resolve());
    mockSendTyping = mock(() => Promise.resolve());

    mockMessage = {
      author: { bot: false },
      guild: { id: "guild-123" },
      client: { user: { id: "123456789" } },
      mentions: { has: mock(() => true) },
      content: "<@123456789> Hello",
      channel: {
        send: mockSend,
        sendTyping: mockSendTyping,
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

    expect(mockChatService.generateResponse).not.toHaveBeenCalled();
  });

  test("Guild外のメッセージは無視する", async () => {
    mockMessage.guild = null;
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    expect(mockChatService.generateResponse).not.toHaveBeenCalled();
  });

  test("メンションがない場合は無視する", async () => {
    mockMessage.mentions.has.mockReturnValue(false);
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    expect(mockChatService.generateResponse).not.toHaveBeenCalled();
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
    expect(mockChatService.generateResponse).not.toHaveBeenCalled();
  });

  test("正常なメッセージに対してEmbed形式でレスポンスを生成する", async () => {
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    expect(mockChatService.generateResponse).toHaveBeenCalledWith("guild-123", "Hello");
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              color: 0x5865f2, // BLURPLE
              description: "Mock response",
            }),
          }),
        ]),
      }),
    );
  });

  test("AppErrorの場合は赤色EmbedでuserMessageを表示する", async () => {
    const error = new RateLimitError("Rate limited by API", 30);
    (mockChatService.generateResponse as ReturnType<typeof mock>).mockRejectedValueOnce(error);
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
    (mockChatService.generateResponse as ReturnType<typeof mock>).mockRejectedValueOnce(error);
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
    (mockChatService.generateResponse as ReturnType<typeof mock>).mockRejectedValueOnce(error);
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

  test("sendTypingが呼ばれる", async () => {
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    expect(mockSendTyping).toHaveBeenCalled();
  });

  test("10000文字の応答は複数メッセージに分割される（各メッセージ1 Embed）", async () => {
    const longResponse = "a".repeat(10000);
    (mockChatService.generateResponse as ReturnType<typeof mock>).mockResolvedValueOnce(
      longResponse,
    );
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    const sendCalls = (mockSend as ReturnType<typeof mock>).mock.calls;
    const expectedMessages = Math.ceil(10000 / 4096); // 3メッセージ

    expect(sendCalls.length).toBe(expectedMessages);
    expect(sendCalls[0][0].embeds.length).toBe(1); // 各メッセージに1 Embed
    expect(sendCalls[1][0].embeds.length).toBe(1);
    expect(sendCalls[2][0].embeds.length).toBe(1);
    expect(sendCalls[0][0].embeds[0].data.footer?.text).toContain("ページ 1/3");
    expect(sendCalls[1][0].embeds[0].data.footer?.text).toContain("ページ 2/3");
    expect(sendCalls[2][0].embeds[0].data.footer?.text).toContain("ページ 3/3");
  });

  test("50000文字の応答は複数メッセージに分割される（各メッセージ1 Embed）", async () => {
    const longResponse = "a".repeat(50000);
    (mockChatService.generateResponse as ReturnType<typeof mock>).mockResolvedValueOnce(
      longResponse,
    );
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    const sendCalls = (mockSend as ReturnType<typeof mock>).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(1); // 複数メッセージ

    const expectedMessages = Math.ceil(50000 / 4096); // 13メッセージ

    expect(sendCalls.length).toBe(expectedMessages);
    expect(sendCalls[0][0].embeds.length).toBe(1); // 各メッセージに1 Embed
    expect(sendCalls[12][0].embeds.length).toBe(1);

    // ページ番号確認（全体通し）
    expect(sendCalls[0][0].embeds[0].data.footer?.text).toContain("ページ 1/13");
    expect(sendCalls[9][0].embeds[0].data.footer?.text).toContain("ページ 10/13");
    expect(sendCalls[10][0].embeds[0].data.footer?.text).toContain("ページ 11/13");
    expect(sendCalls[12][0].embeds[0].data.footer?.text).toContain("ページ 13/13");
  });
});
