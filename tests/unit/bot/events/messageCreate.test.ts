import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMessageCreateHandler } from "../../../../src/bot/events/messageCreate";
import { AppError, RateLimitError } from "../../../../src/errors";
import type { IChatService } from "../../../../src/services/chatService";

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
  let mockMessage: MockMessage;
  let mockReply: ReturnType<typeof mock>;
  let mockSend: ReturnType<typeof mock>;
  let mockSendTyping: ReturnType<typeof mock>;

  beforeEach(() => {
    mockChatService = {
      generateResponse: mock(() => Promise.resolve("Mock response")),
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
    const handler = createMessageCreateHandler(mockChatService);

    await handler(mockMessage as never);

    expect(mockChatService.generateResponse).not.toHaveBeenCalled();
  });

  test("Guild外のメッセージは無視する", async () => {
    mockMessage.guild = null;
    const handler = createMessageCreateHandler(mockChatService);

    await handler(mockMessage as never);

    expect(mockChatService.generateResponse).not.toHaveBeenCalled();
  });

  test("メンションがない場合は無視する", async () => {
    mockMessage.mentions.has.mockReturnValue(false);
    const handler = createMessageCreateHandler(mockChatService);

    await handler(mockMessage as never);

    expect(mockChatService.generateResponse).not.toHaveBeenCalled();
  });

  test("空のコンテンツは入力を求めるメッセージを返す", async () => {
    mockMessage.content = "<@123456789>";
    const handler = createMessageCreateHandler(mockChatService);

    await handler(mockMessage as never);

    expect(mockReply).toHaveBeenCalledWith({
      content: "メッセージを入力してください。",
      allowedMentions: { repliedUser: false },
    });
    expect(mockChatService.generateResponse).not.toHaveBeenCalled();
  });

  test("正常なメッセージに対してレスポンスを生成する", async () => {
    const handler = createMessageCreateHandler(mockChatService);

    await handler(mockMessage as never);

    expect(mockChatService.generateResponse).toHaveBeenCalledWith("guild-123", "Hello");
    expect(mockSend).toHaveBeenCalledWith("Mock response");
  });

  test("AppErrorの場合はuserMessageを表示する", async () => {
    const error = new RateLimitError("Rate limited by API", 30);
    (mockChatService.generateResponse as ReturnType<typeof mock>).mockRejectedValueOnce(error);
    const handler = createMessageCreateHandler(mockChatService);

    await handler(mockMessage as never);

    expect(mockReply).toHaveBeenCalledWith({
      content: "リクエスト制限に達しました。30秒後に再度お試しください。",
      allowedMentions: { repliedUser: false },
    });
  });

  test("一般的なErrorの場合は汎用メッセージを表示する", async () => {
    const error = new Error("Unknown error");
    (mockChatService.generateResponse as ReturnType<typeof mock>).mockRejectedValueOnce(error);
    const handler = createMessageCreateHandler(mockChatService);

    await handler(mockMessage as never);

    expect(mockReply).toHaveBeenCalledWith({
      content: "予期しないエラーが発生しました。問題が続く場合は管理者にお問い合わせください。",
      allowedMentions: { repliedUser: false },
    });
  });

  test("カスタムAppErrorの場合はそのuserMessageを表示する", async () => {
    const error = new AppError("Technical message", "カスタムエラーメッセージ", 500);
    (mockChatService.generateResponse as ReturnType<typeof mock>).mockRejectedValueOnce(error);
    const handler = createMessageCreateHandler(mockChatService);

    await handler(mockMessage as never);

    expect(mockReply).toHaveBeenCalledWith({
      content: "カスタムエラーメッセージ",
      allowedMentions: { repliedUser: false },
    });
  });

  test("sendTypingが呼ばれる", async () => {
    const handler = createMessageCreateHandler(mockChatService);

    await handler(mockMessage as never);

    expect(mockSendTyping).toHaveBeenCalled();
  });
});
