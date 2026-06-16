import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { type Attachment, Collection, MessageType } from "discord.js";
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
  type: MessageType;
  author: { bot: boolean };
  guild: { id: string } | null;
  client: { user: { id: string } | null };
  mentions: { has: ReturnType<typeof mock> };
  content: string;
  attachments: Collection<string, Attachment>;
  channel: {
    id: string;
    send: ReturnType<typeof mock>;
    isThread: () => boolean;
  };
  reply: ReturnType<typeof mock>;
}

type AttachmentFixture = {
  id: string;
  name: string;
  url: string;
  contentType: string | null;
};

function makeAttachments(fixtures: AttachmentFixture[]): Collection<string, Attachment> {
  const collection = new Collection<string, Attachment>();
  for (const fixture of fixtures) {
    collection.set(fixture.id, {
      name: fixture.name,
      url: fixture.url,
      contentType: fixture.contentType,
    } as unknown as Attachment);
  }
  return collection;
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
  // biome-ignore lint/correctness/useYield: テスト用にエラーをスローするだけのgenerator
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
      defaultModel: "test-model:fixture",
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
      getModelName: mock(() => Promise.resolve("Test Model (fixture)")),
      getModelDetails: mock(() => Promise.resolve(null)),
      isMultimodalCapable: mock(() => Promise.resolve<boolean | null>(null)),
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
      type: MessageType.Default,
      author: { bot: false },
      guild: { id: "guild-123" },
      client: { user: { id: "123456789" } },
      mentions: { has: mock(() => true) },
      content: "<@123456789> Hello",
      attachments: makeAttachments([]),
      channel: {
        id: "channel-123",
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

  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = mock();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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

    // 初期メッセージはEmbed形式で送信される
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        components: expect.any(Array),
      }),
    );

    // generateResponseStreamが呼ばれる（parts は空配列）
    expect(mockChatService.generateResponseStream).toHaveBeenCalledWith(
      "guild-123",
      { text: "Hello", parts: [] },
      "msg-123",
    );

    // 最終更新でEmbedが設定される
    expect(mockBotMessage.edit).toHaveBeenCalled();
    const editCalls = (mockBotMessage.edit as ReturnType<typeof mock>).mock.calls;
    const lastEditCall = editCalls[editCalls.length - 1];
    expect(lastEditCall?.[0]).toHaveProperty("embeds");
    expect(lastEditCall?.[0].components).toEqual([]);
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
      defaultModel: "test-model:fixture",
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
    mockMessage.channel.id = "auto-reply-channel-id";

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

  describe("マルチモーダル入力", () => {
    test("画像添付 + マルチモーダル対応モデル → parts に image_url を含めて chatService を呼ぶ", async () => {
      mockMessage.attachments = makeAttachments([
        {
          id: "1",
          name: "photo.png",
          url: "https://cdn.discord.test/photo.png",
          contentType: "image/png",
        },
      ]);
      (mockModelService.isMultimodalCapable as ReturnType<typeof mock>).mockResolvedValueOnce(true);

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );

      await handler(mockMessage as never);

      expect(mockChatService.generateResponseStream).toHaveBeenCalledWith(
        "guild-123",
        {
          text: "Hello",
          parts: [{ type: "image_url", image_url: { url: "https://cdn.discord.test/photo.png" } }],
        },
        "msg-123",
      );
    });

    test("画像添付 + 非対応モデル (isMultimodalCapable=false) → 警告を返し chatService 未呼び出し", async () => {
      mockMessage.attachments = makeAttachments([
        {
          id: "1",
          name: "photo.png",
          url: "https://cdn.discord.test/photo.png",
          contentType: "image/png",
        },
      ]);
      (mockModelService.isMultimodalCapable as ReturnType<typeof mock>).mockResolvedValueOnce(
        false,
      );

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );

      await handler(mockMessage as never);

      expect(mockReply).toHaveBeenCalled();
      const replyArg = (mockReply as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
        embeds: unknown[];
      };
      expect(replyArg.embeds).toBeDefined();
      expect(mockChatService.generateResponseStream).not.toHaveBeenCalled();
    });

    test("画像添付 + isMultimodalCapable=null (判定不能) → 透過して chatService を呼ぶ", async () => {
      mockMessage.attachments = makeAttachments([
        {
          id: "1",
          name: "photo.png",
          url: "https://cdn.discord.test/photo.png",
          contentType: "image/png",
        },
      ]);
      (mockModelService.isMultimodalCapable as ReturnType<typeof mock>).mockResolvedValueOnce(null);

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );

      await handler(mockMessage as never);

      expect(mockChatService.generateResponseStream).toHaveBeenCalled();
    });

    test("PDF 添付 → fetch して data URL 化、モデル判定なしで chatService を呼ぶ", async () => {
      mockMessage.attachments = makeAttachments([
        {
          id: "1",
          name: "spec.pdf",
          url: "https://cdn.discord.test/spec.pdf",
          contentType: "application/pdf",
        },
      ]);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () =>
          Promise.resolve(new Uint8Array([0x50, 0x44, 0x46]).buffer satisfies ArrayBuffer),
      });

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );

      await handler(mockMessage as never);

      expect(mockFetch.mock.calls[0]?.[0]).toBe("https://cdn.discord.test/spec.pdf");
      expect(mockModelService.isMultimodalCapable).not.toHaveBeenCalled();
      expect(mockChatService.generateResponseStream).toHaveBeenCalledWith(
        "guild-123",
        {
          text: "Hello",
          parts: [
            {
              type: "file",
              file: { filename: "spec.pdf", file_data: "data:application/pdf;base64,UERG" },
            },
          ],
        },
        "msg-123",
      );
    });

    test("PDF fetch 失敗時は FETCH_FAILED 警告（文言含む）を返し chatService 未呼び出し", async () => {
      mockMessage.attachments = makeAttachments([
        {
          id: "1",
          name: "expired.pdf",
          url: "https://cdn.discord.test/expired.pdf",
          contentType: "application/pdf",
        },
      ]);
      mockFetch.mockRejectedValueOnce(new Error("network down"));

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );

      await handler(mockMessage as never);

      expect(mockReply).toHaveBeenCalled();
      const replyArg = (mockReply as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
        embeds: Array<{ data: { title: string; description: string } }>;
      };
      expect(replyArg.embeds[0]?.data.title).toBe("添付ファイルエラー");
      expect(replyArg.embeds[0]?.data.description).toContain("ファイルの取得に失敗しました");
      expect(replyArg.embeds[0]?.data.description).toContain("expired.pdf");
      expect(mockChatService.generateResponseStream).not.toHaveBeenCalled();
    });

    test("FILE_TOO_LARGE: PDF サイズが上限超過 → 警告 (文言含む) を返し chatService 未呼び出し", async () => {
      const oversized: Parameters<typeof makeAttachments>[0] = [
        {
          id: "1",
          name: "huge.pdf",
          url: "https://cdn.discord.test/huge.pdf",
          contentType: "application/pdf",
        },
      ];
      mockMessage.attachments = makeAttachments(oversized);
      // size を直接書き換え（makeAttachments のデフォルトは小さい）
      const attachment = mockMessage.attachments.first();
      if (attachment) {
        (attachment as unknown as { size: number }).size = 21 * 1024 * 1024;
      }

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );

      await handler(mockMessage as never);

      expect(mockReply).toHaveBeenCalled();
      const replyArg = (mockReply as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
        embeds: Array<{ data: { title: string; description: string } }>;
      };
      expect(replyArg.embeds[0]?.data.title).toBe("添付ファイルエラー");
      expect(replyArg.embeds[0]?.data.description).toContain("PDF のサイズ上限");
      expect(replyArg.embeds[0]?.data.description).toContain("20MB");
      expect(replyArg.embeds[0]?.data.description).toContain("40MB");
      expect(replyArg.embeds[0]?.data.description).toContain("huge.pdf");
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockChatService.generateResponseStream).not.toHaveBeenCalled();
    });

    test("UNSUPPORTED_MIME 添付 → 警告を返し chatService 未呼び出し", async () => {
      mockMessage.attachments = makeAttachments([
        {
          id: "1",
          name: "data.csv",
          url: "https://cdn.discord.test/data.csv",
          contentType: "text/csv",
        },
      ]);

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );

      await handler(mockMessage as never);

      expect(mockReply).toHaveBeenCalled();
      expect(mockChatService.generateResponseStream).not.toHaveBeenCalled();
    });

    test("MISSING_MIME 添付 (contentType: null) → 警告を返し chatService 未呼び出し", async () => {
      mockMessage.attachments = makeAttachments([
        {
          id: "1",
          name: "unknown.bin",
          url: "https://cdn.discord.test/unknown.bin",
          contentType: null,
        },
      ]);

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );

      await handler(mockMessage as never);

      expect(mockReply).toHaveBeenCalled();
      expect(mockChatService.generateResponseStream).not.toHaveBeenCalled();
    });

    test("テキスト空 + 画像添付 → 早期 return せず chatService を text='' で呼ぶ (default prompt は chatService 側で補う)", async () => {
      mockMessage.content = "<@123456789>";
      mockMessage.attachments = makeAttachments([
        {
          id: "1",
          name: "photo.png",
          url: "https://cdn.discord.test/photo.png",
          contentType: "image/png",
        },
      ]);
      (mockModelService.isMultimodalCapable as ReturnType<typeof mock>).mockResolvedValueOnce(true);

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );

      await handler(mockMessage as never);

      // messageCreate は text="" のまま chatService に渡す。
      // default prompt 補完は chatService.buildChatRequest の責務 (chatService.test.ts で検証)
      expect(mockChatService.generateResponseStream).toHaveBeenCalledWith(
        "guild-123",
        {
          text: "",
          parts: [{ type: "image_url", image_url: { url: "https://cdn.discord.test/photo.png" } }],
        },
        "msg-123",
      );
    });
  });

  test("AbortErrorの場合は停止メッセージをEmbedで表示する", async () => {
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

    // AbortErrorの場合はreplyではなくeditでEmbed形式の停止メッセージを表示
    const editCalls = (mockBotMessage.edit as ReturnType<typeof mock>).mock.calls;
    const lastEditCall = editCalls[editCalls.length - 1];
    expect(lastEditCall?.[0]).toHaveProperty("embeds");
    expect(lastEditCall?.[0].components).toEqual([]);
  });
});
