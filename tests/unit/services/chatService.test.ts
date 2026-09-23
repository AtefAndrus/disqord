import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { getEventListeners } from "node:events";
import { BadRequestError } from "../../../src/errors";
import type { IToolLoopUpdater } from "../../../src/llm/toolLoop";
import { ToolRegistry } from "../../../src/llm/tools/registry";
import { PDF_PARSER_PLUGIN } from "../../../src/services/attachmentParser";
import { ChatService } from "../../../src/services/chatService";
import type { ConversationWindowContext } from "../../../src/services/conversationWindow";
import { ModelService } from "../../../src/services/modelService";
import { TWEET_FETCH_DEADLINE_MS, TweetService } from "../../../src/services/tweetService";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  GuildSettings,
  StreamChunk,
  StreamFinalResult,
  StreamHeartbeatChunk,
} from "../../../src/types";
import {
  createMockGuildSettings,
  createMockLLMClient,
  createMockSettingsService,
  createMockTweetService,
} from "../../helpers/mockFactories";

type MockedLlmClient = ReturnType<typeof createMockLLMClient> & {
  chat: ReturnType<typeof mock>;
  chatStream: ReturnType<typeof mock>;
  listModelsWithPricing: ReturnType<typeof mock>;
};
type MockedSettingsService = ReturnType<typeof createMockSettingsService> & {
  getGuildSettings: ReturnType<typeof mock>;
};
type MockedTweetService = ReturnType<typeof createMockTweetService> & {
  extractTweetIds: ReturnType<typeof mock>;
  expandTweets: ReturnType<typeof mock>;
};

interface ChatFixture {
  chatService: ChatService;
  llmClient: MockedLlmClient;
  settingsService: MockedSettingsService;
  tweetService: MockedTweetService;
}

function createUpdater(): IToolLoopUpdater {
  return {
    beginTurn: mock(() => {}),
    stageContent: mock(() => {}),
    commitTurn: mock(() => {}),
    abortTurn: mock(() => {}),
    beginToolBlock: mock(() => {}),
    endToolBlock: mock(() => {}),
  };
}

function createFixture(overrides: Partial<GuildSettings> = {}): ChatFixture {
  const llmClient = createMockLLMClient() as MockedLlmClient;
  const settingsService = createMockSettingsService() as MockedSettingsService;
  settingsService.getGuildSettings = mock(async (guildId: string) =>
    createMockGuildSettings({ guildId, ...overrides }),
  );
  const tweetService = createMockTweetService() as MockedTweetService;
  const chatService = new ChatService(
    llmClient,
    settingsService,
    new ToolRegistry(),
    "perplexity",
    tweetService,
    new ModelService(llmClient),
  );
  return { chatService, llmClient, settingsService, tweetService };
}

function conversationContext(): ConversationWindowContext {
  return {
    messages: [
      {
        id: "1",
        channelId: "channel",
        kind: "user",
        author: "Prior",
        time: "2026-09-22T11:59:00.000Z",
        timestampMs: Date.parse("2026-09-22T11:59:00.000Z"),
        text: "before",
        attachments: [
          {
            index: 1,
            id: "attachment-1",
            kind: "pdf",
            filename: "history.pdf",
            sizeBytes: 123,
            mimeType: "application/pdf",
            url: "https://cdn.example.invalid/history.pdf",
          },
        ],
        exchangeId: "1",
        ref: "m1",
      },
      {
        id: "2",
        channelId: "channel",
        kind: "assistant",
        author: "assistant",
        time: "2026-09-22T11:59:01.000Z",
        timestampMs: Date.parse("2026-09-22T11:59:01.000Z"),
        text: "answer",
        attachments: [],
        exchangeId: "1",
        triggerMsgId: "1",
        pageIds: ["2"],
        ref: "m2",
      },
    ],
    sessionId: "opaque-session-id",
    windowStartMessageId: "1",
    toolContext: {
      readEarlierMessages: async () => '{"messages":[]}',
      viewAttachment: async () => '{"error":"unused"}',
    },
  };
}

describe("ChatService", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("SettingsServiceからギルド設定を取得する", async () => {
    const fixture = createFixture();

    await fixture.chatService.generateResponse("guild-123", { text: "Hello" });

    expect(fixture.settingsService.getGuildSettings).toHaveBeenCalledWith("guild-123");
  });

  test("LLMClientにギルドのデフォルトモデルを使用してリクエスト (text-only)", async () => {
    const fixture = createFixture({ defaultModel: "custom-model" });

    await fixture.chatService.generateResponse("guild-123", { text: "Hello" });

    expect(fixture.llmClient.chat).toHaveBeenCalledWith({
      model: "custom-model",
      messages: [{ role: "user", content: "Hello" }],
    });
  });

  test("parts ありの場合は content を配列で送る (text + 画像)", async () => {
    const fixture = createFixture();
    const parts = [{ type: "image_url" as const, image_url: { url: "https://cdn.example/a.png" } }];

    await fixture.chatService.generateResponse("guild-123", { text: "Describe", parts });

    expect(fixture.llmClient.chat).toHaveBeenCalledWith({
      model: "test-model:fixture",
      messages: [{ role: "user", content: [{ type: "text", text: "Describe" }, ...parts] }],
    });
  });

  test("text が空 + 画像 parts → default prompt (画像) を text part として補う", async () => {
    const fixture = createFixture();
    const parts = [{ type: "image_url" as const, image_url: { url: "https://cdn.example/a.png" } }];

    await fixture.chatService.generateResponse("guild-123", { text: "", parts });

    expect(fixture.llmClient.chat).toHaveBeenCalledWith({
      model: "test-model:fixture",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "添付された画像について説明してください。" }, ...parts],
        },
      ],
    });
  });

  test("text が空 + file parts → default prompt (PDF) を text part として補う", async () => {
    const fixture = createFixture();
    const parts = [{ type: "file" as const, file: { filename: "spec.pdf", file_data: "data" } }];

    await fixture.chatService.generateResponse("guild-123", { text: "", parts });

    expect(fixture.llmClient.chat).toHaveBeenCalledWith({
      model: "test-model:fixture",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "添付された文書を要約してください。" }, ...parts],
        },
      ],
      plugins: [PDF_PARSER_PLUGIN],
    });
  });

  test("text が空 + 画像 + file 混在 → default prompt (混在) を text part として補う", async () => {
    const fixture = createFixture();
    const parts = [
      { type: "image_url" as const, image_url: { url: "https://cdn.example/a.png" } },
      { type: "file" as const, file: { filename: "spec.pdf", file_data: "data" } },
    ];

    await fixture.chatService.generateResponse("guild-123", { text: "", parts });

    const call = fixture.llmClient.chat.mock.calls[0]?.[0] as ChatCompletionRequest;
    expect(call.messages[0]?.content).toEqual([
      { type: "text", text: "添付ファイルについて説明してください。" },
      ...parts,
    ]);
  });

  test("file パートを含む場合のみ plugins が付与される", async () => {
    const fixture = createFixture();

    await fixture.chatService.generateResponse("guild-123", {
      text: "Summarize",
      parts: [{ type: "file", file: { filename: "spec.pdf", file_data: "data" } }],
    });

    const call = fixture.llmClient.chat.mock.calls[0]?.[0] as ChatCompletionRequest;
    expect(call.plugins).toEqual([PDF_PARSER_PLUGIN]);
  });

  test("画像のみの場合は plugins を付与しない", async () => {
    const fixture = createFixture();

    await fixture.chatService.generateResponse("guild-123", {
      text: "Look",
      parts: [{ type: "image_url", image_url: { url: "https://cdn.example/a.png" } }],
    });

    const call = fixture.llmClient.chat.mock.calls[0]?.[0] as ChatCompletionRequest;
    expect(call.plugins).toBeUndefined();
  });

  test("LLMClientからのレスポンスを返す", async () => {
    const fixture = createFixture();
    const response: ChatCompletionResponse = {
      id: "resp-1",
      choices: [{ message: { role: "assistant", content: "Hello, user!" } }],
    };
    fixture.llmClient.chat.mockResolvedValueOnce(response);

    const result = await fixture.chatService.generateResponse("guild-123", { text: "Hi" });

    expect(result.text).toBe("Hello, user!");
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.latency).toBeGreaterThanOrEqual(0);
  });

  test("choicesが空の場合は空文字を返す", async () => {
    const fixture = createFixture();
    fixture.llmClient.chat.mockResolvedValueOnce({ choices: [] });

    const result = await fixture.chatService.generateResponse("guild-123", { text: "Hi" });

    expect(result.text).toBe("");
  });

  test("messageのcontentがundefinedの場合は空文字を返す", async () => {
    const fixture = createFixture();
    fixture.llmClient.chat.mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: undefined } }],
    } as unknown as ChatCompletionResponse);

    const result = await fixture.chatService.generateResponse("guild-123", { text: "Hi" });

    expect(result.text).toBe("");
  });

  test("LLMClientがエラーをスローした場合はそのまま伝播", async () => {
    const fixture = createFixture();
    fixture.llmClient.chat.mockRejectedValueOnce(new Error("LLM error"));

    await expect(fixture.chatService.generateResponse("guild-123", { text: "Hi" })).rejects.toThrow(
      "LLM error",
    );
  });

  test("SettingsServiceがエラーをスローした場合はそのまま伝播", async () => {
    const fixture = createFixture();
    fixture.settingsService.getGuildSettings.mockRejectedValueOnce(new Error("Settings error"));

    await expect(fixture.chatService.generateResponse("guild-123", { text: "Hi" })).rejects.toThrow(
      "Settings error",
    );
  });

  test("history places static systems first, prefixes authors, and sends session_id", async () => {
    const fixture = createFixture({ historyEnabled: true, webSearchEnabled: true });
    const updater = createUpdater();
    fixture.llmClient.listModelsWithPricing = mock(async () => []);

    await fixture.chatService.generateChatResponse(
      "guild-123",
      { text: "now", authorLabel: "Current", conversation: conversationContext() },
      "req-history",
      updater,
      { channelId: "channel-1", userId: "user-1" },
    );

    const [request] = fixture.llmClient.chatStream.mock.calls[0] as [ChatCompletionRequest];
    expect(request.session_id).toBe("opaque-session-id");
    expect(request.messages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "user",
      "assistant",
      "system",
      "user",
    ]);
    expect(request.messages[0]?.content).toContain("非信頼データ");
    expect(request.messages[1]?.content).toContain("非信頼データ");
    expect(request.messages[2]?.content).toContain("[m1] Prior: before");
    expect(request.messages[2]?.content).toContain("添付 m1/1: PDF");
    expect(request.messages[4]?.content).toContain("現在日時");
    expect(request.messages[5]?.content).toBe("[current] Current: now");
  });

  test.each([
    ["supported", true, ["reasoning"], { summary: "auto" }],
    ["unsupported", true, ["tools"], undefined],
    ["disabled", false, ["reasoning"], undefined],
  ] as const)(
    "reasoning summary is sent only when display is enabled and the model supports it (%s)",
    async (_label, displayEnabled, supportedParameters, expected) => {
      const fixture = createFixture({ reasoningDisplayEnabled: displayEnabled });
      fixture.llmClient.listModelsWithPricing = mock(async () => [
        {
          id: "test-model:fixture",
          name: "Fixture",
          created: 1640000000,
          contextLength: 4096,
          pricing: { prompt: "0", completion: "0" },
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportedParameters: [...supportedParameters],
        },
      ]);

      await fixture.chatService.generateChatResponse(
        "guild-123",
        { text: "Hello" },
        `req-reasoning-${_label}`,
        createUpdater(),
        { channelId: "channel-1", userId: "user-1" },
      );

      const [request] = fixture.llmClient.chatStream.mock.calls[0] as [ChatCompletionRequest];
      if (expected) {
        expect(request.reasoning).toEqual(expected);
        expect("effort" in (request.reasoning ?? {})).toBe(false);
      } else {
        expect("reasoning" in request).toBe(false);
      }
    },
  );

  test("cancel races the model-details lookup", async () => {
    const fixture = createFixture({ historyEnabled: true });
    fixture.llmClient.listModelsWithPricing = mock(() => new Promise<never>(() => {}));
    const resultPromise = fixture.chatService.generateChatResponse(
      "guild-123",
      { text: "now", conversation: conversationContext() },
      "req-model-details-cancel",
      createUpdater(),
      { channelId: "channel-1", userId: "user-1" },
    );

    for (
      let attempt = 0;
      attempt < 5 && fixture.llmClient.listModelsWithPricing.mock.calls.length === 0;
      attempt++
    ) {
      await Promise.resolve();
    }
    expect(fixture.llmClient.listModelsWithPricing).toHaveBeenCalled();
    expect(fixture.chatService.cancelRequest("req-model-details-cancel")).toBe(true);
    const result = await resultPromise;

    expect(result.status).toBe("cancelled");
    expect(fixture.llmClient.chatStream).not.toHaveBeenCalled();
  });

  test("multimodal request (content 配列 + plugins) を chatStream に渡す", async () => {
    const fixture = createFixture();
    const updater = createUpdater();

    await fixture.chatService.generateChatResponse(
      "guild-123",
      {
        text: "Summarize",
        parts: [{ type: "file", file: { filename: "spec.pdf", file_data: "data" } }],
      },
      "req-file",
      updater,
      { channelId: "channel-1", userId: "user-1" },
    );

    expect(fixture.llmClient.chatStream).toHaveBeenCalledWith(
      {
        model: "test-model:fixture",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Summarize" },
              { type: "file", file: { filename: "spec.pdf", file_data: "data" } },
            ],
          },
        ],
        plugins: [PDF_PARSER_PLUGIN],
      },
      expect.any(AbortSignal),
    );
  });

  test("等価性: tool 未登録時は chatStream が1回だけ呼ばれ、tools/tool_choice を含まないリクエストになる", async () => {
    const fixture = createFixture();
    const result = await fixture.chatService.generateChatResponse(
      "guild-123",
      { text: "Hello" },
      "req-equivalent",
      createUpdater(),
      { channelId: "channel-1", userId: "user-1" },
    );

    expect(fixture.llmClient.chatStream).toHaveBeenCalledTimes(1);
    const [request] = fixture.llmClient.chatStream.mock.calls[0] as [ChatCompletionRequest];
    expect(request).not.toHaveProperty("tools");
    expect(request).not.toHaveProperty("tool_choice");
    expect(result.status).toBe("final");
  });

  test("Web検索が有効なギルドでは web_search server tool と日時・非信頼データの system を付けて送る", async () => {
    setSystemTime(new Date("2026-09-22T05:00:00Z"));
    const fixture = createFixture({ webSearchEnabled: true });
    const chatService = new ChatService(
      fixture.llmClient,
      fixture.settingsService,
      new ToolRegistry(),
      "exa",
      fixture.tweetService,
      new ModelService(fixture.llmClient),
    );

    await chatService.generateChatResponse(
      "guild-123",
      { text: "Hello" },
      "req-web-search",
      createUpdater(),
      { channelId: "channel-1", userId: "user-1" },
    );

    const [request] = fixture.llmClient.chatStream.mock.calls[0] as [ChatCompletionRequest];
    expect(request.tools).toEqual([
      {
        type: "openrouter:web_search",
        parameters: { engine: "exa", max_results: 5, max_total_results: 20, max_uses: 4 },
      },
    ]);
    expect(request.messages[0]?.content).toContain("非信頼データ");
    expect(request.messages[1]?.content).toContain("2026/09/22(火) 14:00 (JST)");
  });

  test("ツイートURLを展開し、Web検索のsystemより後ろに非信頼データのsystemを置く", async () => {
    const fixture = createFixture({ webSearchEnabled: true });
    fixture.tweetService.extractTweetIds = mock(() => ["20"]);
    fixture.tweetService.expandTweets = mock(async () => ({
      status: "expanded" as const,
      parts: [{ type: "text" as const, text: "tweet" }],
      textParts: [{ type: "text" as const, text: "tweet" }],
      imageParts: [],
    }));

    await fixture.chatService.generateChatResponse(
      "guild-123",
      { text: "read this" },
      "req-tweet",
      createUpdater(),
      { channelId: "channel-1", userId: "user-1" },
    );

    const [request] = fixture.llmClient.chatStream.mock.calls[0] as [ChatCompletionRequest];
    expect(request.messages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
      "user",
    ]);
    expect(request.messages[1]?.content).toContain("tweet");
    expect(request.messages[3]?.content).toEqual([
      { type: "text", text: "read this" },
      { type: "text", text: "tweet" },
    ]);
  });

  test("ツイート展開がOFFならサービスもネットワークも呼ばず、リクエストを変えない", async () => {
    const fixture = createFixture({ twitterExpandEnabled: false });
    fixture.tweetService.extractTweetIds = mock(() => ["20"]);

    await fixture.chatService.generateChatResponse(
      "guild-123",
      { text: "https://x.com/example/status/20" },
      "req-tweet-off",
      createUpdater(),
      { channelId: "channel-1", userId: "user-1" },
    );

    expect(fixture.tweetService.extractTweetIds).not.toHaveBeenCalled();
    expect(fixture.tweetService.expandTweets).not.toHaveBeenCalled();
    expect(fixture.llmClient.chatStream.mock.calls[0]?.[0]).toEqual({
      model: "test-model:fixture",
      messages: [{ role: "user", content: "https://x.com/example/status/20" }],
    });
  });

  test("実TweetServiceの画像対応判定に期限signalを渡し、生成signalのlistenerを残さない", async () => {
    const fixture = createFixture();
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const originalAbortController = globalThis.AbortController;
    const createdControllers: AbortController[] = [];
    class TrackingAbortController extends originalAbortController {
      constructor() {
        super();
        createdControllers.push(this);
      }
    }
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: 200,
            status: {
              type: "status",
              text: "tweet",
              created_timestamp: 0,
              likes: 1,
              reposts: 2,
              replies: 3,
              author: { name: "Alice", screen_name: "alice" },
              media: { photos: [{ url: "https://pbs.twimg.com/photo.jpg" }], videos: [] },
            },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;
    globalThis.AbortController = TrackingAbortController;
    globalThis.setTimeout = ((...args: Parameters<typeof originalSetTimeout>) => {
      const [handler, delay, ...rest] = args;
      return originalSetTimeout(handler, delay === TWEET_FETCH_DEADLINE_MS ? 0 : delay, ...rest);
    }) as typeof globalThis.setTimeout;
    fixture.llmClient.listModelsWithPricing = mock(() => new Promise<never>(() => {}));
    const realChatService = new ChatService(
      fixture.llmClient,
      fixture.settingsService,
      new ToolRegistry(),
      "perplexity",
      new TweetService("https://api.fxtwitter.test", "1.5.0"),
      new ModelService(fixture.llmClient),
    );

    try {
      const result = await realChatService.generateChatResponse(
        "guild-123",
        { text: "https://x.com/a/status/20" },
        "req-real-tweet",
        createUpdater(),
        { channelId: "channel-1", userId: "user-1" },
      );

      expect(result.status).toBe("final");
      expect(fixture.llmClient.listModelsWithPricing).toHaveBeenCalledTimes(1);
      const generationController = createdControllers[0];
      if (!generationController) throw new Error("generation controller was not created");
      expect(generationController.signal.aborted).toBe(false);
      expect(getEventListeners(generationController.signal, "abort")).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.AbortController = originalAbortController;
    }
  });

  test("実TweetService経由で、取得したポストの本文と画像がモデルへのリクエストに入る", async () => {
    const fixture = createFixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: 200,
            status: {
              type: "status",
              text: "just setting up my twttr",
              created_timestamp: 0,
              likes: 1,
              reposts: 2,
              replies: 3,
              author: { name: "jack", screen_name: "jack" },
              media: { photos: [{ url: "https://pbs.twimg.com/photo.jpg" }], videos: [] },
            },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;
    fixture.llmClient.listModelsWithPricing = mock(async () => [
      {
        id: "test-model:fixture",
        name: "Fixture",
        created: 1640000000,
        contextLength: 4096,
        pricing: { prompt: "0", completion: "0" },
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
      },
    ]);
    const chatService = new ChatService(
      fixture.llmClient,
      fixture.settingsService,
      new ToolRegistry(),
      "perplexity",
      new TweetService("https://api.fxtwitter.test", "1.5.0"),
      new ModelService(fixture.llmClient),
    );

    try {
      const result = await chatService.generateChatResponse(
        "guild-123",
        { text: "これ何? https://x.com/jack/status/20" },
        "req-real-tweet-content",
        createUpdater(),
        { channelId: "channel-1", userId: "user-1" },
      );

      expect(result.status).toBe("final");
      const [request] = fixture.llmClient.chatStream.mock.calls[0] as [ChatCompletionRequest];
      const system = request.messages.find((message) => message.role === "system");
      expect(JSON.stringify(system?.content)).toContain("untrusted-tweet");
      const user = request.messages.find((message) => message.role === "user");
      if (!user || !Array.isArray(user.content)) throw new Error("user content must be parts");
      const texts = user.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
      expect(texts[0]).toBe("これ何? https://x.com/jack/status/20");
      expect(texts[1]).toContain("just setting up my twttr");
      expect(user.content).toContainEqual({
        type: "image_url",
        image_url: { url: "https://pbs.twimg.com/photo.jpg" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("ツイートURLが無ければ展開せず、system messageもpartsも足さない", async () => {
    const fixture = createFixture();

    await fixture.chatService.generateChatResponse(
      "guild-123",
      { text: "通常の質問" },
      "req-no-tweet",
      createUpdater(),
      { channelId: "channel-1", userId: "user-1" },
    );

    expect(fixture.tweetService.extractTweetIds).toHaveBeenCalledWith("通常の質問");
    expect(fixture.tweetService.expandTweets).not.toHaveBeenCalled();
    expect(fixture.llmClient.chatStream.mock.calls[0]?.[0]).toEqual({
      model: "test-model:fixture",
      messages: [{ role: "user", content: "通常の質問" }],
    });
  });

  test("BadRequestErrorの前に本文をstageした場合は画像を外して再試行しない", async () => {
    const fixture = createFixture();
    const imagePart = {
      type: "image_url" as const,
      image_url: { url: "https://pbs.twimg.com/a" },
    };
    fixture.tweetService.extractTweetIds = mock(() => ["20"]);
    fixture.tweetService.expandTweets = mock(async () => ({
      status: "expanded" as const,
      parts: [{ type: "text" as const, text: "tweet" }, imagePart],
      textParts: [{ type: "text" as const, text: "tweet" }],
      imageParts: [imagePart],
    }));
    fixture.llmClient.chatStream = mock(async function* () {
      yield { content: "partial", done: false as const };
      throw new BadRequestError("after text");
    });

    const result = await fixture.chatService.generateChatResponse(
      "guild-123",
      { text: "read" },
      "req-no-retry",
      createUpdater(),
      { channelId: "channel-1", userId: "user-1" },
    );

    expect(result.status).toBe("error");
    expect(fixture.llmClient.chatStream).toHaveBeenCalledTimes(1);
  });

  test("streaming 中の content は累積で updater.stageContent に渡る", async () => {
    const fixture = createFixture();
    const updater = createUpdater();

    await fixture.chatService.generateChatResponse(
      "guild-123",
      { text: "Hello" },
      "req-stream",
      updater,
      { channelId: "channel-1", userId: "user-1" },
    );

    expect(updater.stageContent).toHaveBeenCalledWith("Mock ");
    expect(updater.stageContent).toHaveBeenCalledWith("Mock response");
    expect(updater.commitTurn).toHaveBeenCalledWith("final");
  });

  test("結果は status: final で text/usage/model/provider を含む", async () => {
    const fixture = createFixture();
    fixture.llmClient.chatStream = mock(async function* () {
      yield { content: "Hi", done: false as const };
      yield {
        done: true as const,
        fullText: "Hi",
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        model: "resolved-model",
        provider: "resolved-provider",
        finishReason: "stop",
      } satisfies StreamFinalResult;
    });

    const result = await fixture.chatService.generateChatResponse(
      "guild-123",
      { text: "Hi" },
      "req-final",
      createUpdater(),
      { channelId: "channel-1", userId: "user-1" },
    );

    expect(result).toMatchObject({
      status: "final",
      text: "Hi",
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      model: "resolved-model",
      provider: "resolved-provider",
    });
  });

  test("cancelRequest 呼び出し後は status: cancelled になる（停止ボタン経路）", async () => {
    const fixture = createFixture();
    const updater = createUpdater();
    let resolvePartial: (() => void) | undefined;
    const partialStaged = new Promise<void>((resolve) => {
      resolvePartial = resolve;
    });
    updater.stageContent = mock((content: string) => {
      if (content === "partial") resolvePartial?.();
    });
    let streamSignal: AbortSignal | undefined;
    fixture.llmClient.chatStream = mock(async function* (
      _request: ChatCompletionRequest,
      signal?: AbortSignal,
    ) {
      streamSignal = signal;
      yield { content: "partial", done: false as const };
      await new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => reject(new Error("aborted"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    });
    const resultPromise = fixture.chatService.generateChatResponse(
      "guild-123",
      { text: "Hi" },
      "req-cancel",
      updater,
      { channelId: "channel-1", userId: "user-1" },
    );

    await partialStaged;
    expect(fixture.llmClient.chatStream).toHaveBeenCalled();
    expect(updater.stageContent).toHaveBeenCalledWith("partial");
    expect(fixture.chatService.cancelRequest("req-cancel")).toBe(true);
    const result = await resultPromise;

    expect(result.status).toBe("cancelled");
    expect(streamSignal?.aborted).toBe(true);
  });

  test("cancelRequest は未知の requestId には false を返す", () => {
    const fixture = createFixture();

    expect(fixture.chatService.cancelRequest("unknown-request")).toBe(false);
  });

  test("getGuildSettings が解決する前でも cancelRequest が true を返し、結果は cancelled になる", async () => {
    const fixture = createFixture();
    let resolveSettings!: (value: GuildSettings) => void;
    fixture.settingsService.getGuildSettings = mock(
      () =>
        new Promise<GuildSettings>((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const resultPromise = fixture.chatService.generateChatResponse(
      "guild-123",
      { text: "Hi" },
      "req-settings-cancel",
      createUpdater(),
      { channelId: "channel-1", userId: "user-1" },
    );

    await Promise.resolve();
    expect(fixture.chatService.cancelRequest("req-settings-cancel")).toBe(true);
    resolveSettings(createMockGuildSettings({ guildId: "guild-123" }));
    const result = await resultPromise;

    expect(result.status).toBe("cancelled");
    expect(fixture.llmClient.chatStream).not.toHaveBeenCalled();
  });

  test("getGuildSettings が pending のままでも cancelRequest 後は settings を待たず解決する", async () => {
    const fixture = createFixture();
    fixture.settingsService.getGuildSettings = mock(() => new Promise<GuildSettings>(() => {}));
    const resultPromise = fixture.chatService.generateChatResponse(
      "guild-123",
      { text: "Hi" },
      "req-settings-never",
      createUpdater(),
      { channelId: "channel-1", userId: "user-1" },
    );

    await Promise.resolve();
    expect(fixture.chatService.cancelRequest("req-settings-never")).toBe(true);
    const result = await resultPromise;

    expect(result.status).toBe("cancelled");
  });

  test("設定取得中に cancel された場合でも history には user message が含まれる", async () => {
    const fixture = createFixture();
    fixture.settingsService.getGuildSettings = mock(() => new Promise<GuildSettings>(() => {}));
    const resultPromise = fixture.chatService.generateChatResponse(
      "guild-123",
      { text: "Hi there" },
      "req-history-cancel",
      createUpdater(),
      { channelId: "channel-1", userId: "user-1" },
    );

    await Promise.resolve();
    expect(fixture.chatService.cancelRequest("req-history-cancel")).toBe(true);
    const result = await resultPromise;

    expect(result.status).toBe("cancelled");
    expect(result.history).toEqual([{ role: "user", content: "Hi there" }]);
  });

  test("abort 後に getGuildSettings が reject しても status: cancelled で解決する", async () => {
    const fixture = createFixture();
    let rejectSettings!: (error: unknown) => void;
    fixture.settingsService.getGuildSettings = mock(
      () =>
        new Promise<GuildSettings>((_resolve, reject) => {
          rejectSettings = reject;
        }),
    );
    const resultPromise = fixture.chatService.generateChatResponse(
      "guild-123",
      { text: "Hi" },
      "req-settings-reject",
      createUpdater(),
      { channelId: "channel-1", userId: "user-1" },
    );

    await Promise.resolve();
    expect(fixture.chatService.cancelRequest("req-settings-reject")).toBe(true);
    rejectSettings(new Error("settings fetch failed"));
    const result = await resultPromise;

    expect(result.status).toBe("cancelled");
  });

  test("tweet-image retry sums usage from both attempts", async () => {
    const fixture = createFixture();
    const imagePart = {
      type: "image_url" as const,
      image_url: { url: "https://images.example.invalid/tweet.png" },
    };
    fixture.tweetService.extractTweetIds = mock(() => ["20"]);
    fixture.tweetService.expandTweets = mock(async () => ({
      status: "expanded" as const,
      parts: [imagePart],
      textParts: [],
      imageParts: [imagePart],
    }));
    let streamCall = 0;
    fixture.llmClient.chatStream = mock(() => {
      streamCall += 1;
      if (streamCall === 1) return firstRetryTurn();
      return secondRetryTurn();
    });

    const result = await fixture.chatService.generateChatResponse(
      "guild-123",
      { text: "https://x.com/example/status/20" },
      "req-retry-usage",
      createUpdater(),
      { channelId: "channel-1", userId: "user-1" },
    );

    expect(result.status).toBe("final");
    expect(result.usage).toMatchObject({
      prompt_tokens: 33,
      completion_tokens: 3,
      total_tokens: 36,
    });
    expect(result.usage?.cost).toBeCloseTo(0.03);
  });
});

async function* firstRetryTurn(): AsyncGenerator<StreamHeartbeatChunk, void, void> {
  yield {
    heartbeat: true,
    done: false,
    usage: { prompt_tokens: 11, completion_tokens: 0, total_tokens: 11, cost: 0.01 },
  };
  throw new BadRequestError("tweet image rejected");
}

async function* secondRetryTurn(): AsyncGenerator<StreamChunk | StreamFinalResult, void, void> {
  yield { content: "retry succeeded", done: false };
  yield {
    done: true,
    fullText: "retry succeeded",
    usage: { prompt_tokens: 22, completion_tokens: 3, total_tokens: 25, cost: 0.02 },
    model: "model",
    provider: "provider",
    finishReason: "stop",
  };
}
