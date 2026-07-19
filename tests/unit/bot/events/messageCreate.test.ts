import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { type Attachment, Collection, MessageFlags, MessageType } from "discord.js";
import { createMessageCreateHandler } from "../../../../src/bot/events/messageCreate";
import { AppError, RateLimitError } from "../../../../src/errors";
import type { IToolLoopUpdater, ToolLoopResult } from "../../../../src/llm/toolLoop";
import type {
  ChatRequestContext,
  ChatUserInput,
  IChatService,
} from "../../../../src/services/chatService";
import type { IModelService } from "../../../../src/services/modelService";
import type { ISettingsService } from "../../../../src/services/settingsService";

interface MockBotMessage {
  id: string;
  edit: ReturnType<typeof mock>;
  delete: ReturnType<typeof mock>;
}

interface ContainerComponentJSON {
  type: number;
  content?: string;
  components?: ContainerComponentJSON[];
}

interface ContainerJSON {
  type: number;
  accent_color?: number;
  components: ContainerComponentJSON[];
}

interface ComponentsV2CallArg {
  components: Array<{ toJSON: () => ContainerJSON }>;
  flags: number;
  allowedMentions: { parse: readonly string[]; repliedUser?: boolean };
}

/** mock関数の最後の呼び出しの第1引数（Components V2 payload）を取得する */
function lastCallArg(fn: ReturnType<typeof mock>): ComponentsV2CallArg {
  const calls = fn.mock.calls;
  return calls[calls.length - 1]?.[0] as ComponentsV2CallArg;
}

/** Components V2 payload の第1引数（Container）をJSONにシリアライズする */
function toContainerJSON(payload: ComponentsV2CallArg): ContainerJSON {
  return payload.components[0].toJSON();
}

/** Container 内の全 TextDisplay（Section内の子も含む）のcontentを抽出する */
function extractTextContents(container: ContainerJSON): string[] {
  const out: string[] = [];
  for (const component of container.components) {
    if (component.type === 10 && component.content) {
      out.push(component.content);
    }
    if (component.type === 9 && component.components) {
      for (const child of component.components) {
        if (child.type === 10 && child.content) {
          out.push(child.content);
        }
      }
    }
  }
  return out;
}

/** Container が Section（type 9、停止ボタン用）を含むか */
function hasSection(container: ContainerJSON): boolean {
  return container.components.some((c) => c.type === 9);
}

/**
 * Components V2 payload から本文（badge/footerを除いた最後のTextDisplay）を取り出す。
 * buildFinalContainer 系（badge + 本文 [+ footer]）の構造を前提とする。
 */
function bodyOf(payload: ComponentsV2CallArg): string {
  const contents = extractTextContents(toContainerJSON(payload));
  return contents.at(-1) ?? "";
}

interface MockMessage {
  id: string;
  type: MessageType;
  author: { bot: boolean; id: string };
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

type ChatResponseFn = (
  guildId: string,
  input: ChatUserInput,
  requestId: string,
  updater: IToolLoopUpdater,
  ctx: ChatRequestContext,
) => Promise<ToolLoopResult>;

/**
 * chatService.generateChatResponse() のフェイク実装。runToolLoop() 自体は経由せず、
 * updater へ累積 stageContent を流したうえで status: "final" の ToolLoopResult を返す
 * （tool 未登録時の実際の1ターン完結挙動を模倣する）。
 */
function createMockChatResponseFn(
  fullText: string,
  finishReason: "stop" | "length" | "content_filter" = "stop",
): ChatResponseFn {
  return async (_guildId, _input, _requestId, updater) => {
    updater.beginTurn();
    const chunkSize = Math.max(1, Math.ceil(fullText.length / 3));
    let acc = "";
    for (let i = 0; i < fullText.length; i += chunkSize) {
      acc += fullText.slice(i, i + chunkSize);
      await updater.stageContent(acc);
    }
    if (fullText.length === 0) {
      await updater.stageContent("");
    }
    updater.commitTurn("final");
    return {
      status: "final",
      text: fullText,
      finishReason,
      history: [],
      usage: undefined,
      model: undefined,
      provider: undefined,
    };
  };
}

/**
 * tool_calls の preamble ターンを commit したうえで、続く最終ターンを別途 commit するフェイク。
 * runToolLoop の実際の状態機械（updater.beginTurn → stageContent → commitTurn("tool_calls") →
 * beginTurn → stageContent → commitTurn("final")）をそのままなぞり、ToolLoopResult.text には
 * 最終ターンの content のみを載せる（tool_calls を挟んだ場合の実際の返り値契約）。
 */
function createPreambleThenFinalChatResponseFn(
  preamble: string,
  finalTurnText: string,
  finishReason: "stop" | "length" | "content_filter" = "stop",
): ChatResponseFn {
  return async (_guildId, _input, _requestId, updater) => {
    updater.beginTurn();
    await updater.stageContent(preamble);
    updater.commitTurn("tool_calls");

    updater.beginTurn();
    await updater.stageContent(finalTurnText);
    updater.commitTurn("final");

    return {
      status: "final",
      text: finalTurnText,
      finishReason,
      history: [],
      usage: undefined,
      model: undefined,
      provider: undefined,
    };
  };
}

/** 停止ボタン（cancelRequest）経路相当の status: "cancelled" を返すフェイク。 */
function createCancelledChatResponseFn(partialText = ""): ChatResponseFn {
  return async (_guildId, _input, _requestId, updater) => {
    updater.beginTurn();
    if (partialText) {
      await updater.stageContent(partialText);
    }
    updater.abortTurn("cancelled (test)");
    return { status: "cancelled", history: [] };
  };
}

/** 致命的エラー（非キャンセル）経路相当の status: "error" を返すフェイク。partialText 省略時は無入力のまま失敗する。 */
function createFatalErrorChatResponseFn(partialText: string, error: unknown): ChatResponseFn {
  return async (_guildId, _input, _requestId, updater) => {
    updater.beginTurn();
    if (partialText) {
      await updater.stageContent(partialText);
    }
    updater.abortTurn("error (test)");
    return { status: "error", error, history: [] };
  };
}

/**
 * setSystemTime でシステム時計を進めながら updater.stageContent を呼ぶフェイク。
 * STREAM_UPDATE_INTERVAL (2秒) の経過判定を実時間の待機なしに決定的にテストするために使う。
 * 最終 commit 直前に `finalFullText` を改めて stage する（updater.text と ToolLoopResult.text が
 * 一致するという実際の契約を保つ。最終描画は updater.text を読むため、両者が食い違うとテストの
 * 前提が崩れる）。
 */
function createTimedChatResponseFn(
  steps: Array<{ content: string; advanceMs: number }>,
  finalFullText: string,
): ChatResponseFn {
  return async (_guildId, _input, _requestId, updater) => {
    updater.beginTurn();
    let acc = "";
    for (const step of steps) {
      setSystemTime(new Date(Date.now() + step.advanceMs));
      acc += step.content;
      await updater.stageContent(acc);
    }
    await updater.stageContent(finalFullText);
    updater.commitTurn("final");
    return {
      status: "final",
      text: finalFullText,
      finishReason: "stop",
      history: [],
      usage: undefined,
      model: undefined,
      provider: undefined,
    };
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
  // 2番目以降にsendされたbotMessage（1→2 message遷移等の検証に使用）
  let extraBotMessages: MockBotMessage[];
  // 指定したidのbotMessageの delete() を意図的に失敗させるための述語（指摘4のテスト用）
  let deleteShouldFail: (id: string) => boolean;

  function createMockBotMessage(id: string): MockBotMessage {
    return {
      id,
      edit: mock(() => Promise.resolve()),
      delete: mock(() =>
        deleteShouldFail(id)
          ? Promise.reject(new Error(`delete failed: ${id}`))
          : Promise.resolve(),
      ),
    };
  }

  beforeEach(() => {
    deleteShouldFail = () => false;
    extraBotMessages = [];
    mockBotMessage = createMockBotMessage("bot-msg-123");

    mockChatService = {
      generateResponse: mock(() => Promise.resolve({ text: "Mock response", metadata: undefined })),
      generateChatResponse: mock(createMockChatResponseFn("Mock response")),
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
    // 1回目のsendは初期placeholder(mockBotMessage)、2回目以降は新規botMessageを都度生成する
    let sendCallCount = 0;
    mockSend = mock(() => {
      if (sendCallCount === 0) {
        sendCallCount++;
        return Promise.resolve(mockBotMessage);
      }
      const extra = createMockBotMessage(`bot-msg-extra-${sendCallCount}`);
      extraBotMessages.push(extra);
      sendCallCount++;
      return Promise.resolve(extra);
    });

    mockMessage = {
      id: "msg-123",
      type: MessageType.Default,
      author: { bot: false, id: "author-123" },
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
    // setSystemTime を使うテストが時計を書き換えたままにしないよう、実時間に戻す
    setSystemTime();
  });

  test("Botからのメッセージは無視する", async () => {
    mockMessage.author.bot = true;
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    expect(mockChatService.generateChatResponse).not.toHaveBeenCalled();
  });

  test("Guild外のメッセージは無視する", async () => {
    mockMessage.guild = null;
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    expect(mockChatService.generateChatResponse).not.toHaveBeenCalled();
  });

  test("メンションがない場合は無視する", async () => {
    mockMessage.mentions.has.mockReturnValue(false);
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    expect(mockChatService.generateChatResponse).not.toHaveBeenCalled();
  });

  describe("@everyone/@here メンション処理", () => {
    test("@everyoneのみを含むメッセージには応答しない（ignoreEveryone:trueを渡す）", async () => {
      // 実際のdiscord.jsでは、@everyoneのみのメッセージはhas(botId, {ignoreEveryone:true})がfalseを返す
      (mockMessage.mentions.has as ReturnType<typeof mock>).mockImplementation(
        (_id: string, options?: { ignoreEveryone?: boolean }) => options?.ignoreEveryone !== true,
      );
      mockMessage.content = "@everyone こんにちは";

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );
      await handler(mockMessage as never);

      expect(mockMessage.mentions.has).toHaveBeenCalledWith("123456789", {
        ignoreEveryone: true,
      });
      expect(mockChatService.generateChatResponse).not.toHaveBeenCalled();
    });

    test("Botへの直接メンションには応答する", async () => {
      (mockMessage.mentions.has as ReturnType<typeof mock>).mockImplementation(() => true);

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );
      await handler(mockMessage as never);

      expect(mockMessage.mentions.has).toHaveBeenCalledWith("123456789", {
        ignoreEveryone: true,
      });
      expect(mockChatService.generateChatResponse).toHaveBeenCalled();
    });
  });

  test("空のコンテンツは入力エラーContainerを返す", async () => {
    mockMessage.content = "<@123456789>";
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    expect(mockReply).toHaveBeenCalledTimes(1);
    const replyArg = lastCallArg(mockReply);
    expect(replyArg.flags).toBe(MessageFlags.IsComponentsV2);
    expect(replyArg.allowedMentions).toEqual({ parse: [], repliedUser: false });
    const container = toContainerJSON(replyArg);
    expect(container.accent_color).toBe(0xed4245); // RED
    expect(extractTextContents(container).join("\n")).toContain("## ⚠️ 入力エラー");
    expect(extractTextContents(container).join("\n")).toContain("メッセージを入力してください。");
    expect(mockChatService.generateChatResponse).not.toHaveBeenCalled();
  });

  test("正常なメッセージに対してストリーミングレスポンスを生成する", async () => {
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    // 初期メッセージはComponents V2形式（停止ボタン付きSection）で送信される
    const initialSendArg = (mockSend as ReturnType<typeof mock>).mock.calls[0]?.[0] as
      | ComponentsV2CallArg
      | undefined;
    expect(initialSendArg?.flags).toBe(MessageFlags.IsComponentsV2);
    expect(initialSendArg?.allowedMentions).toEqual({ parse: [] });
    expect(initialSendArg && hasSection(toContainerJSON(initialSendArg))).toBe(true);

    // generateChatResponseが呼ばれる（parts は空配列）
    expect(mockChatService.generateChatResponse).toHaveBeenCalledWith(
      "guild-123",
      { text: "Hello", parts: [] },
      "msg-123",
      expect.anything(),
      { channelId: "channel-123", userId: "author-123" },
    );

    // 最終更新でComponents V2 Containerが設定され、Section（停止ボタン）は付かない
    expect(mockBotMessage.edit).toHaveBeenCalled();
    const lastEditArg = lastCallArg(mockBotMessage.edit as ReturnType<typeof mock>);
    expect(lastEditArg.flags).toBe(MessageFlags.IsComponentsV2);
    expect(hasSection(toContainerJSON(lastEditArg))).toBe(false);
  });

  test("AppErrorの場合は赤色ContainerでuserMessageを表示する", async () => {
    const error = new RateLimitError("Rate limited by API", 30);
    (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
      createFatalErrorChatResponseFn("", error),
    );
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    const replyArg = lastCallArg(mockReply);
    expect(replyArg.flags).toBe(MessageFlags.IsComponentsV2);
    expect(replyArg.allowedMentions).toEqual({ parse: [], repliedUser: false });
    const container = toContainerJSON(replyArg);
    expect(container.accent_color).toBe(0xed4245); // RED
    expect(extractTextContents(container).join("\n")).toContain(
      "リクエスト制限に達しました。30秒後に再度お試しください。",
    );
  });

  test("一般的なErrorの場合は赤色Containerで汎用メッセージを表示する", async () => {
    const error = new Error("Unknown error");
    (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
      createFatalErrorChatResponseFn("", error),
    );
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    const replyArg = lastCallArg(mockReply);
    expect(replyArg.flags).toBe(MessageFlags.IsComponentsV2);
    expect(replyArg.allowedMentions).toEqual({ parse: [], repliedUser: false });
    const container = toContainerJSON(replyArg);
    expect(container.accent_color).toBe(0xed4245); // RED
    expect(extractTextContents(container).join("\n")).toContain(
      "予期しないエラーが発生しました。問題が続く場合は管理者にお問い合わせください。",
    );
  });

  test("予期しないエラー時、エラーreplyにエラーIDが含まれ、ログに同じIDが渡る", async () => {
    const consoleErrorSpy = spyOn(console, "error");
    const error = new Error("Unexpected failure");
    (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
      createFatalErrorChatResponseFn("", error),
    );

    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );
    await handler(mockMessage as never);

    // console.error はspyOnの実装上、以前のテストの呼び出し履歴を引き継ぎうるため、
    // 最後に一致した呼び出し（＝このテストで実際に発生したもの）を採用する
    const errorLogCall = consoleErrorSpy.mock.calls.findLast((call) =>
      String(call[0]).includes("Failed to generate response"),
    );
    expect(errorLogCall).toBeDefined();
    const errorIdMatch = String(errorLogCall?.[0]).match(/"errorId":"([0-9a-f]{8})"/);
    expect(errorIdMatch).not.toBeNull();
    const errorId = errorIdMatch?.[1];

    // エラーreply本文の末尾に同じエラーIDが含まれる
    const replyArg = lastCallArg(mockReply);
    const replyText = extractTextContents(toContainerJSON(replyArg)).join("\n");
    expect(replyText).toContain(`エラーID: \`${errorId}\``);

    // 内部エラーメッセージ（error.message 等）がユーザーに漏れない
    expect(replyText).not.toContain("Unexpected failure");
  });

  test("カスタムAppErrorの場合は赤色ContainerでそのuserMessageを表示する", async () => {
    const error = new AppError("Technical message", "カスタムエラーメッセージ", 500);
    (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
      createFatalErrorChatResponseFn("", error),
    );
    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    const replyArg = lastCallArg(mockReply);
    expect(replyArg.flags).toBe(MessageFlags.IsComponentsV2);
    expect(replyArg.allowedMentions).toEqual({ parse: [], repliedUser: false });
    const container = toContainerJSON(replyArg);
    expect(container.accent_color).toBe(0xed4245); // RED
    expect(extractTextContents(container).join("\n")).toContain("カスタムエラーメッセージ");
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

    expect(mockChatService.generateChatResponse).toHaveBeenCalled();
  });

  test("長文応答は複数メッセージに分割される", async () => {
    const longResponse = "a".repeat(10000);
    (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
      createMockChatResponseFn(longResponse),
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

  test("長文応答(複数message)は非最終messageにも「ページ n/N」footerを表示する（旧embed挙動の復元）", async () => {
    const longResponse = "y".repeat(10000);
    (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
      createMockChatResponseFn(longResponse),
    );

    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );
    await handler(mockMessage as never);

    // 複数messageに分割されていること
    const sendCalls = (mockSend as ReturnType<typeof mock>).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(1);

    // 先頭message(mockBotMessage)の最終editにも「ページ 1/N」footerが付く
    // (旧実装ではLLM詳細と同様、最終messageのみにしかfooterが付かなかった)
    const message0FinalEdit = lastCallArg(mockBotMessage.edit as ReturnType<typeof mock>);
    const message0Text = extractTextContents(toContainerJSON(message0FinalEdit)).join("\n");
    expect(message0Text).toMatch(/ページ 1\/\d+/);
  });

  test("日本語長文応答は、streaming途中を含む全send/edit payloadでUTF-8バイト内部制限に収まるよう分割される", async () => {
    // 文字数上限(3800字)だけで分割すると、日本語(約3bytes/字)は1 chunk ≈ 11.4KBになり、
    // 実測されたDiscordのUTF-8バイト内部制限(≈10.17KB)を超えてHTTP 500になる。
    // createMockStreamGenerator（時計を進めない）だとupdateStreamingMessagesが一度も走らず
    // 最終renderのeditしか検証できないため、createTimedStreamGeneratorで複数のstreamingサイクルを
    // 実際に発生させ、途中のeditも含めて検証する。
    setSystemTime(new Date(2020, 0, 1, 0, 0, 0));
    const longJapaneseResponse = "あ".repeat(12000);
    (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
      createTimedChatResponseFn(
        [
          { content: "あ".repeat(4000), advanceMs: 2100 },
          { content: "あ".repeat(4000), advanceMs: 2100 },
          { content: "あ".repeat(4000), advanceMs: 2100 },
        ],
        longJapaneseResponse,
      ),
    );

    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );
    await handler(mockMessage as never);

    // 複数messageに分割されていること
    const sendCalls = (mockSend as ReturnType<typeof mock>).mock.calls;
    expect(sendCalls.length).toBeGreaterThan(1);

    // streaming途中のedit・最終renderのeditを含む全send/edit呼び出し(mock.calls全件)について、
    // 各payloadの「全TextDisplay(Section内の子も含む)の合計」が文字数3800以下 かつ
    // UTF-8バイト数9000以下であること（Discordの制限は per-component ではなく
    // 1 message の全TextDisplay合計にかかるため、個別ではなく合計で検証する）
    const textEncoder = new TextEncoder();
    const allSendArgs = sendCalls.map((c) => c[0] as ComponentsV2CallArg);
    const allEditArgs = (mockBotMessage.edit as ReturnType<typeof mock>).mock.calls.map(
      (c) => c[0] as ComponentsV2CallArg,
    );
    const allExtraEditArgs = extraBotMessages.flatMap((m) =>
      (m.edit as ReturnType<typeof mock>).mock.calls.map((c) => c[0] as ComponentsV2CallArg),
    );

    expect(allEditArgs.length).toBeGreaterThan(1); // streaming途中editが実際に発生していること

    for (const payload of [...allSendArgs, ...allEditArgs, ...allExtraEditArgs]) {
      const container = toContainerJSON(payload);
      const allText = extractTextContents(container).join("");
      expect(allText.length).toBeLessThanOrEqual(3800);
      expect(textEncoder.encode(allText).length).toBeLessThanOrEqual(9000);
    }
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

      expect(mockChatService.generateChatResponse).toHaveBeenCalledWith(
        "guild-123",
        {
          text: "Hello",
          parts: [{ type: "image_url", image_url: { url: "https://cdn.discord.test/photo.png" } }],
        },
        "msg-123",
        expect.anything(),
        { channelId: "channel-123", userId: "author-123" },
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
      const replyArg = lastCallArg(mockReply);
      expect(replyArg.flags).toBe(MessageFlags.IsComponentsV2);
      expect(extractTextContents(toContainerJSON(replyArg)).length).toBeGreaterThan(0);
      expect(mockChatService.generateChatResponse).not.toHaveBeenCalled();
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

      expect(mockChatService.generateChatResponse).toHaveBeenCalled();
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
      expect(mockChatService.generateChatResponse).toHaveBeenCalledWith(
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
        expect.anything(),
        { channelId: "channel-123", userId: "author-123" },
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
      const replyArg = lastCallArg(mockReply);
      const text = extractTextContents(toContainerJSON(replyArg)).join("\n");
      expect(text).toContain("添付ファイルエラー");
      expect(text).toContain("ファイルの取得に失敗しました");
      expect(text).toContain("expired.pdf");
      expect(mockChatService.generateChatResponse).not.toHaveBeenCalled();
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
      const replyArg = lastCallArg(mockReply);
      const text = extractTextContents(toContainerJSON(replyArg)).join("\n");
      expect(text).toContain("添付ファイルエラー");
      expect(text).toContain("PDF のサイズ上限");
      expect(text).toContain("20MB");
      expect(text).toContain("40MB");
      expect(text).toContain("huge.pdf");
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockChatService.generateChatResponse).not.toHaveBeenCalled();
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
      expect(mockChatService.generateChatResponse).not.toHaveBeenCalled();
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
      expect(mockChatService.generateChatResponse).not.toHaveBeenCalled();
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
      expect(mockChatService.generateChatResponse).toHaveBeenCalledWith(
        "guild-123",
        {
          text: "",
          parts: [{ type: "image_url", image_url: { url: "https://cdn.discord.test/photo.png" } }],
        },
        "msg-123",
        expect.anything(),
        { channelId: "channel-123", userId: "author-123" },
      );
    });
  });

  test("停止（cancelled）の場合は停止メッセージをComponents V2で表示する", async () => {
    (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
      createCancelledChatResponseFn(),
    );

    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    await handler(mockMessage as never);

    // 停止（cancelled）の場合はreplyではなくeditでComponents V2形式の停止メッセージを表示、Sectionは無い
    const lastEditArg = lastCallArg(mockBotMessage.edit as ReturnType<typeof mock>);
    expect(lastEditArg.flags).toBe(MessageFlags.IsComponentsV2);
    const container = toContainerJSON(lastEditArg);
    expect(hasSection(container)).toBe(false);
    expect(extractTextContents(container).join("\n")).toContain("🛑 Stopped");
  });

  test("停止（cancelled）時、受信済みテキストがあればfooterに受信文字数を含める", async () => {
    const partialText = "partial😀"; // コードポイント数 8（UTF-16 コードユニット数だと 9）
    (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
      createCancelledChatResponseFn(partialText),
    );

    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );
    await handler(mockMessage as never);

    const lastEditArg = lastCallArg(mockBotMessage.edit as ReturnType<typeof mock>);
    const container = toContainerJSON(lastEditArg);
    const text = extractTextContents(container).join("\n");
    // コードポイント数で数える（UTF-16 の `partialText.length` は 9 になる）
    expect(text).toContain(`${Array.from(partialText).length}字`);
    expect(text).not.toContain(`${partialText.length}字`);
    expect(text).not.toContain("Tokens");
  });

  describe("最終描画: preamble commit + 最終ターンの合成、finishReason 注記", () => {
    test("tool_calls preamble が commit 済みの場合、最終描画は preamble + 最終ターンの合成テキストになる（result.text だけでは preamble が消える）", async () => {
      (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
        createPreambleThenFinalChatResponseFn("確認します...\n", "晴れです。"),
      );

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );
      await handler(mockMessage as never);

      const lastEditArg = lastCallArg(mockBotMessage.edit as ReturnType<typeof mock>);
      expect(bodyOf(lastEditArg)).toBe("確認します...\n晴れです。");
    });

    test("tool 未登録相当（preamble 無し）の場合は従来どおり最終ターンの content のみが描画される", async () => {
      (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
        createMockChatResponseFn("Mock response"),
      );

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );
      await handler(mockMessage as never);

      const lastEditArg = lastCallArg(mockBotMessage.edit as ReturnType<typeof mock>);
      expect(bodyOf(lastEditArg)).toBe("Mock response");
    });

    test('finishReason "length" のとき、最終描画に打ち切り注記が付く', async () => {
      (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
        createMockChatResponseFn("途中まで...", "length"),
      );

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );
      await handler(mockMessage as never);

      const lastEditArg = lastCallArg(mockBotMessage.edit as ReturnType<typeof mock>);
      const contents = extractTextContents(toContainerJSON(lastEditArg));
      expect(contents.join("\n")).toContain("応答が最大出力長に達したため途中で打ち切られました");
      // 履歴に積む raw text 自体は変えない（注記は footer 側の別 TextDisplay として付く）
      expect(contents).toContain("途中まで...");
    });

    test('finishReason "content_filter" のとき、最終描画にモデレーション注記が付く', async () => {
      (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
        createMockChatResponseFn("穏当な内容", "content_filter"),
      );

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );
      await handler(mockMessage as never);

      const lastEditArg = lastCallArg(mockBotMessage.edit as ReturnType<typeof mock>);
      const text = extractTextContents(toContainerJSON(lastEditArg)).join("\n");
      expect(text).toContain("プロバイダのコンテンツフィルタにより応答が制限されました");
    });

    test('finishReason "stop" のときは注記が付かない', async () => {
      (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
        createMockChatResponseFn("普通の応答", "stop"),
      );

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );
      await handler(mockMessage as never);

      const lastEditArg = lastCallArg(mockBotMessage.edit as ReturnType<typeof mock>);
      const text = extractTextContents(toContainerJSON(lastEditArg)).join("\n");
      expect(text).not.toContain("打ち切られました");
      expect(text).not.toContain("コンテンツフィルタ");
    });
  });

  describe("ストリーミング再調整ロジック（コードレビュー指摘 3・5）", () => {
    test("1→2 messageに増える際、旧messageはSectionなしでedit・新messageはSectionありでsendされる", async () => {
      setSystemTime(new Date(2020, 0, 1, 0, 0, 0));
      const bigChunk = "x".repeat(4000); // 単一チャンクで1 messageの本文予算(~3762字)を超える
      (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
        createTimedChatResponseFn([{ content: bigChunk, advanceMs: 2100 }], bigChunk),
      );

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );
      await handler(mockMessage as never);

      // ストリーミング更新サイクルで最初に発生するeditは旧message(index0)向けで、Sectionが外れている
      const firstEditArg = (mockBotMessage.edit as ReturnType<typeof mock>).mock
        .calls[0]?.[0] as ComponentsV2CallArg;
      expect(firstEditArg.flags).toBe(MessageFlags.IsComponentsV2);
      expect(firstEditArg.allowedMentions).toEqual({ parse: [] });
      expect(hasSection(toContainerJSON(firstEditArg))).toBe(false);

      // 初期placeholder送信の次に発生するsendは新message(index1)向けで、Sectionが付いている
      const secondSendArg = (mockSend as ReturnType<typeof mock>).mock
        .calls[1]?.[0] as ComponentsV2CallArg;
      expect(secondSendArg.flags).toBe(MessageFlags.IsComponentsV2);
      expect(secondSendArg.allowedMentions).toEqual({ parse: [] });
      expect(hasSection(toContainerJSON(secondSendArg))).toBe(true);
    });

    test("streaming更新でeditが失敗した場合、そのサイクル内では新規message(Section付き)をsendしない", async () => {
      setSystemTime(new Date(2020, 0, 1, 0, 0, 0));
      const bigChunk = "x".repeat(4000);
      (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
        createTimedChatResponseFn([{ content: bigChunk, advanceMs: 2100 }], bigChunk),
      );
      // ストリーミングサイクル中最初のeditを失敗させる（429等を想定）
      (mockBotMessage.edit as ReturnType<typeof mock>).mockImplementationOnce(() =>
        Promise.reject(new Error("simulated 429")),
      );

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );
      await handler(mockMessage as never);

      // break していなければ、editが失敗した直後にそのサイクル内でSection付きの新message(index1)を
      // sendしてしまう（buildStreamingContainerはisLast=trueならSectionを付与するため）。
      // break していれば、そのサイクルでのsendは発生せず、新message自体は最終render(buildFinalContainer、
      // Sectionなし)で作られるため、初期placeholder以降のsendにSection付きのものは存在しないはず。
      const sendCallsAfterInitial = (mockSend as ReturnType<typeof mock>).mock.calls.slice(1);
      const sendWithSection = sendCallsAfterInitial.some((call) =>
        hasSection(toContainerJSON(call[0] as ComponentsV2CallArg)),
      );
      expect(sendWithSection).toBe(false);

      // ハンドラ全体としては異常終了せず、エラーreplyも送られない（次サイクル/最終renderで自己修復する）
      expect(mockReply).not.toHaveBeenCalled();
    });

    test("1→2 message遷移でsendが失敗した場合、旧messageにSection(停止ボタン)を復元する", async () => {
      setSystemTime(new Date(2020, 0, 1, 0, 0, 0));
      const bigChunk = "x".repeat(4000); // 単一チャンクで1 messageの本文予算(~3762字)を超える
      (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
        createTimedChatResponseFn([{ content: bigChunk, advanceMs: 2100 }], bigChunk),
      );

      // streamingサイクルで新message(index1)を作るsendだけを失敗させ、以降は成功させる
      let sendCallIndex = 0;
      (mockSend as ReturnType<typeof mock>).mockImplementation(() => {
        sendCallIndex++;
        if (sendCallIndex === 1) {
          return Promise.resolve(mockBotMessage); // 初期placeholder
        }
        if (sendCallIndex === 2) {
          // streamingサイクルの新message送信を失敗させる
          return Promise.reject(new Error("simulated send failure (e.g. 429/5xx)"));
        }
        const extra = createMockBotMessage(`bot-msg-extra-${sendCallIndex}`);
        extraBotMessages.push(extra);
        return Promise.resolve(extra);
      });

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );
      await handler(mockMessage as never);

      // streamingサイクル内でmockBotMessageは最低2回editされる:
      // 1回目 = 旧末尾のSectionを剥がすedit(isLast=false)、
      // 2回目 = sendが失敗した直後にbreakする前のSection復元edit(isLast=true)。
      const editCalls = (mockBotMessage.edit as ReturnType<typeof mock>).mock.calls;
      expect(editCalls.length).toBeGreaterThanOrEqual(2);

      const strippedEditArg = editCalls[0]?.[0] as ComponentsV2CallArg;
      expect(hasSection(toContainerJSON(strippedEditArg))).toBe(false);

      const restoredEditArg = editCalls[1]?.[0] as ComponentsV2CallArg;
      expect(restoredEditArg.flags).toBe(MessageFlags.IsComponentsV2);
      expect(restoredEditArg.allowedMentions).toEqual({ parse: [] });
      expect(hasSection(toContainerJSON(restoredEditArg))).toBe(true);

      // 復元は先頭message(isFirst)でもあるため、Model badgeも保持される
      expect(extractTextContents(toContainerJSON(restoredEditArg))[0]).toContain("**Model:**");

      // send失敗はcatch内でbest-effort処理されるため、ハンドラ全体としては異常終了しない
      expect(mockReply).not.toHaveBeenCalled();
    });

    test("全てのsend/edit payloadにIsComponentsV2フラグとallowedMentions.parse:[]が付与される", async () => {
      const longResponse = "y".repeat(10000);
      (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
        createMockChatResponseFn(longResponse),
      );

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );
      await handler(mockMessage as never);

      const allSendArgs = (mockSend as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0] as ComponentsV2CallArg,
      );
      const allEditArgs = (mockBotMessage.edit as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0] as ComponentsV2CallArg,
      );
      const allExtraEditArgs = extraBotMessages.flatMap((m) =>
        (m.edit as ReturnType<typeof mock>).mock.calls.map((c) => c[0] as ComponentsV2CallArg),
      );

      expect(allSendArgs.length).toBeGreaterThan(1); // 長文なので複数messageに分割される
      for (const arg of [...allSendArgs, ...allEditArgs, ...allExtraEditArgs]) {
        expect(arg.flags).toBe(MessageFlags.IsComponentsV2);
        expect(arg.allowedMentions).toEqual(expect.objectContaining({ parse: [] }));
      }
    });
  });

  test('空応答で完了した場合はsetContent("")で例外にならず、「（応答なし）」を含む最終Containerでeditする', async () => {
    (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
      createMockChatResponseFn(""),
    );

    const handler = createMessageCreateHandler(
      mockChatService,
      mockSettingsService,
      mockModelService,
    );

    // 例外が投げられず正常完了すること自体もこのawaitが検証する
    await handler(mockMessage as never);

    expect(mockReply).not.toHaveBeenCalled(); // エラー経路に落ちない
    const lastEditArg = lastCallArg(mockBotMessage.edit as ReturnType<typeof mock>);
    expect(lastEditArg.flags).toBe(MessageFlags.IsComponentsV2);
    const container = toContainerJSON(lastEditArg);
    expect(extractTextContents(container).join("\n")).toContain("（応答なし）");
  });

  describe("致命的エラー時のクリーンアップ（コードレビュー指摘 1・4）", () => {
    test("非cancelledエラーがストリーム途中で発生した場合、部分textをSectionなしのContainerとして保持してからエラーreplyする", async () => {
      (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
        createFatalErrorChatResponseFn(
          "partial response text",
          new Error("fatal upstream failure"),
        ),
      );

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );

      await handler(mockMessage as never);

      // クリーンアップ: 「生成中...」+ 停止ボタン(Section) は残らず、部分テキストを保持したまま Section なしで edit される
      expect(mockBotMessage.edit).toHaveBeenCalled();
      const cleanupEditArg = lastCallArg(mockBotMessage.edit as ReturnType<typeof mock>);
      expect(cleanupEditArg.flags).toBe(MessageFlags.IsComponentsV2);
      const cleanupContainer = toContainerJSON(cleanupEditArg);
      expect(hasSection(cleanupContainer)).toBe(false);
      expect(extractTextContents(cleanupContainer).join("\n")).toContain("partial response text");

      // クリーンアップの後、エラーreplyも送られる
      expect(mockReply).toHaveBeenCalled();
      const replyArg = lastCallArg(mockReply);
      const replyContainer = toContainerJSON(replyArg);
      expect(replyContainer.accent_color).toBe(0xed4245); // RED
    });

    test("非cancelledエラーが大量の部分text(複数message分)受信後に発生した場合、chunks全体をedit/sendして復元してからエラーreplyする", async () => {
      // reconciliation(2秒間隔のstreaming更新)が一度も走る前に、1 messageに収まらない量のテキストが
      // 届いてからthrowするケース。既存botMessagesは初期placeholderの1件のみ。
      const bigPartial = "z".repeat(8000);
      (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
        createFatalErrorChatResponseFn(
          bigPartial,
          new Error("fatal upstream failure after large partial output"),
        ),
      );

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );

      await handler(mockMessage as never);

      // 既存message(mockBotMessage)はeditされ、Sectionは無い
      const editArg = lastCallArg(mockBotMessage.edit as ReturnType<typeof mock>);
      expect(editArg.flags).toBe(MessageFlags.IsComponentsV2);
      expect(hasSection(toContainerJSON(editArg))).toBe(false);

      // 不足分は新規message(s)としてsendされる（calls[0]は初期placeholder送信）
      const overflowSendArgs = (mockSend as ReturnType<typeof mock>).mock.calls
        .slice(1)
        .map((c) => c[0] as ComponentsV2CallArg);
      expect(overflowSendArgs.length).toBeGreaterThan(0);
      for (const arg of overflowSendArgs) {
        expect(arg.flags).toBe(MessageFlags.IsComponentsV2);
        expect(arg.allowedMentions).toEqual({ parse: [] });
        expect(hasSection(toContainerJSON(arg))).toBe(false);
      }

      // edit分 + 新規send分の本文を連結すると、元のfullTextを過不足なく再現する
      const reconstructed = [editArg, ...overflowSendArgs].map(bodyOf).join("");
      expect(reconstructed).toBe(bigPartial);

      expect(mockReply).toHaveBeenCalled();
    });

    test("最終renderの複数send中に1つが失敗した場合、クリーンアップは既に成功した送信済みmessageを重複送信しない", async () => {
      // 3 message構成になる長さの最終応答。message0はedit、message1(あふれ1つ目)はsend成功、
      // message2(あふれ2つ目)のsendが失敗して致命的エラー経路に落ちるシナリオを再現する。
      const longText = "w".repeat(11000);
      (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
        createMockChatResponseFn(longText),
      );

      let sendCallIndex = 0;
      (mockSend as ReturnType<typeof mock>).mockImplementation(() => {
        sendCallIndex++;
        if (sendCallIndex === 1) {
          return Promise.resolve(mockBotMessage); // 初期placeholder
        }
        if (sendCallIndex === 2) {
          // 最終renderのあふれ1つ目（message1）は成功させる
          const extra = createMockBotMessage("bot-msg-extra-1");
          extraBotMessages.push(extra);
          return Promise.resolve(extra);
        }
        // 3回目以降（最終renderのあふれ2つ目、および万一の再送）は失敗させる
        return Promise.reject(new Error("simulated send failure (e.g. 429/5xx)"));
      });

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );

      await handler(mockMessage as never);

      // message1(2回目のsendで作られたmessage)の本文が、以降のsend呼び出しで再度送信されていないこと
      // （botMessagesにpushされずクリーンアップから「未送信」と誤認されると、この内容が再送されてしまう）
      const sendCalls = (mockSend as ReturnType<typeof mock>).mock.calls;
      const message1Body = bodyOf(sendCalls[1]?.[0] as ComponentsV2CallArg);
      const laterSendBodies = sendCalls.slice(2).map((c) => bodyOf(c[0] as ComponentsV2CallArg));
      expect(laterSendBodies).not.toContain(message1Body);

      // 代わりに、クリーンアップはmessage1を「既存message」として認識しeditで更新する
      expect(extraBotMessages.length).toBe(1);
      expect(extraBotMessages[0].edit).toHaveBeenCalled();

      expect(mockReply).toHaveBeenCalled();
    });

    test("フォールバック cleanup 経路で delete が失敗した場合、中立プレースホルダーへのeditにフォールバックする", async () => {
      // mockBotMessage("bot-msg-123")のdeleteを強制失敗させる
      deleteShouldFail = (id) => id === "bot-msg-123";

      (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
        createFatalErrorChatResponseFn("", new Error("fatal upstream failure before first chunk")),
      );

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );

      await handler(mockMessage as never);

      // delete が試みられて失敗し、中立プレースホルダーへのeditにフォールバックする
      expect(mockBotMessage.delete).toHaveBeenCalled();
      const neutralizeEditArg = lastCallArg(mockBotMessage.edit as ReturnType<typeof mock>);
      expect(neutralizeEditArg.flags).toBe(MessageFlags.IsComponentsV2);
      const neutralContainer = toContainerJSON(neutralizeEditArg);
      expect(hasSection(neutralContainer)).toBe(false);
      expect(extractTextContents(neutralContainer).join("\n")).toContain(
        "（このメッセージは不要になりました）",
      );

      expect(mockReply).toHaveBeenCalled();
    });

    test("非cancelledエラーが最初のチャンク受信前に発生した場合（部分textなし）、botMessageをdeleteしてからエラーreplyする", async () => {
      (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
        createFatalErrorChatResponseFn("", new Error("fatal upstream failure before first chunk")),
      );

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );

      await handler(mockMessage as never);

      // 部分textが無いため「生成中...」placeholderをeditで保持する意味が無く、deleteされる
      expect(mockBotMessage.delete).toHaveBeenCalled();
      expect(mockBotMessage.edit).not.toHaveBeenCalled();
      expect(mockReply).toHaveBeenCalled();
    });

    test("最終render時、余剰messageのdeleteが失敗した場合は中立プレースホルダーへのeditで残置を防ぐ", async () => {
      setSystemTime(new Date(2020, 0, 1, 0, 0, 0));
      // streaming中に2 messageへ増えた後、最終確定テキストが短くなり1 messageに収まるケースを再現
      (mockChatService.generateChatResponse as ReturnType<typeof mock>).mockImplementation(
        createTimedChatResponseFn(
          [{ content: "x".repeat(4000), advanceMs: 2100 }],
          "short final text",
        ),
      );

      const handler = createMessageCreateHandler(
        mockChatService,
        mockSettingsService,
        mockModelService,
      );

      // streamingサイクルで生成される2番目のmessageのidを狙ってdelete失敗させる
      deleteShouldFail = (id) => id === "bot-msg-extra-1";

      await handler(mockMessage as never);

      expect(extraBotMessages.length).toBe(1);
      const surplusMessage = extraBotMessages[0];
      expect(surplusMessage.delete).toHaveBeenCalled();

      // delete失敗後、中立プレースホルダーへのeditが試みられ、Sectionは無い
      const neutralizeEditArg = lastCallArg(surplusMessage.edit as ReturnType<typeof mock>);
      expect(neutralizeEditArg.flags).toBe(MessageFlags.IsComponentsV2);
      const neutralContainer = toContainerJSON(neutralizeEditArg);
      expect(hasSection(neutralContainer)).toBe(false);
      expect(extractTextContents(neutralContainer).join("\n")).toContain(
        "（このメッセージは不要になりました）",
      );
    });
  });
});
