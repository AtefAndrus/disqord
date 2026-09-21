import { beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { getEventListeners } from "node:events";
import { BadRequestError } from "../../../src/errors";
import type { ILLMClient } from "../../../src/llm/openrouter";
import type { IToolLoopUpdater } from "../../../src/llm/toolLoop";
import { ToolRegistry } from "../../../src/llm/tools/registry";
import { ChatService } from "../../../src/services/chatService";
import { ModelService } from "../../../src/services/modelService";
import type { ISettingsService } from "../../../src/services/settingsService";
import { TWEET_FETCH_DEADLINE_MS, TweetService } from "../../../src/services/tweetService";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  GuildSettings,
} from "../../../src/types";
import {
  createMockGuildSettings,
  createMockLLMClient,
  createMockSettingsService,
  createMockTweetService,
} from "../../helpers/mockFactories";

/** Records every IToolLoopUpdater callback invocation for assertions, without touching Discord. */
function createSpyUpdater(): {
  updater: IToolLoopUpdater;
  calls: { begins: number; staged: string[]; commits: string[]; aborts: string[] };
} {
  const calls = {
    begins: 0,
    staged: [] as string[],
    commits: [] as string[],
    aborts: [] as string[],
  };
  const updater: IToolLoopUpdater = {
    beginTurn: () => {
      calls.begins++;
    },
    stageContent: (text: string) => {
      calls.staged.push(text);
    },
    commitTurn: (kind: "tool_calls" | "final") => {
      calls.commits.push(kind);
    },
    abortTurn: (reason: string) => {
      calls.aborts.push(reason);
    },
    beginToolBlock: () => {},
    endToolBlock: () => {},
  };
  return { updater, calls };
}

describe("ChatService", () => {
  let chatService: ChatService;
  let mockLLMClient: ILLMClient;
  let mockSettingsService: ISettingsService;
  let mockTweetService: ReturnType<typeof createMockTweetService>;
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    mockLLMClient = createMockLLMClient();
    mockSettingsService = createMockSettingsService();
    mockTweetService = createMockTweetService();
    toolRegistry = new ToolRegistry();
    chatService = new ChatService(
      mockLLMClient,
      mockSettingsService,
      toolRegistry,
      "perplexity",
      mockTweetService,
      new ModelService(mockLLMClient),
    );
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

  describe("generateChatResponse", () => {
    test("multimodal request (content 配列 + plugins) を chatStream に渡す", async () => {
      const { updater } = createSpyUpdater();

      await chatService.generateChatResponse(
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
        updater,
        { channelId: "channel-1", userId: "user-1" },
      );

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

    // 設計 Open Questions「既存単発チャットとの等価性」: tool 未登録時、runToolLoop 経由でも
    // 現行の単発チャットと完全に等価（chatStream は1回だけ、tools/tool_choice は送信しない）であることを、
    // 実 ChatService + 実 ToolRegistry（空）+ mock llmClient で検証する。
    test("等価性: tool 未登録時は chatStream が1回だけ呼ばれ、tools/tool_choice を含まないリクエストになる", async () => {
      const { updater } = createSpyUpdater();

      const result = await chatService.generateChatResponse(
        "guild-123",
        { text: "Hello" },
        "req-2",
        updater,
        { channelId: "channel-1", userId: "user-1" },
      );

      expect(mockLLMClient.chatStream).toHaveBeenCalledTimes(1);
      const [request] = (mockLLMClient.chatStream as ReturnType<typeof mock>).mock.calls[0] as [
        Record<string, unknown>,
        AbortSignal,
      ];
      expect("tools" in request).toBe(false);
      expect("tool_choice" in request).toBe(false);
      expect(request).toEqual({
        model: "test-model:fixture",
        messages: [{ role: "user", content: "Hello" }],
      });
      expect(result.status).toBe("final");
    });

    test("Web検索が有効なギルドでは web_search server tool と日時・非信頼データの system を付けて送る", async () => {
      setSystemTime(new Date("2026-09-22T05:00:00Z"));
      try {
        (mockSettingsService.getGuildSettings as ReturnType<typeof mock>).mockResolvedValueOnce(
          createMockGuildSettings({ webSearchEnabled: true }),
        );
        const { updater } = createSpyUpdater();
        // A non-default engine shows the configured one reaches the request.
        const exaChat = new ChatService(
          mockLLMClient,
          mockSettingsService,
          toolRegistry,
          "exa",
          mockTweetService,
          new ModelService(mockLLMClient),
        );

        await exaChat.generateChatResponse("guild-123", { text: "Hello" }, "req-ws", updater, {
          channelId: "channel-1",
          userId: "user-1",
        });

        const [request] = (mockLLMClient.chatStream as ReturnType<typeof mock>).mock.calls[0] as [
          ChatCompletionRequest,
          AbortSignal,
        ];
        // Literal values: the per-request cap is what bounds the bill.
        expect(request.tools).toEqual([
          {
            type: "openrouter:web_search",
            parameters: { engine: "exa", max_results: 5, max_total_results: 20, max_uses: 4 },
          },
        ]);
        expect(request.tool_choice).toBe("auto");
        expect(request.messages).toHaveLength(2);
        expect(request.messages[1]).toEqual({ role: "user", content: "Hello" });
        const system = request.messages[0];
        expect(system?.role).toBe("system");
        expect(system?.content).toContain("2026/09/22(火) 14:00 (JST)");
        expect(system?.content).toContain("非信頼データ");
      } finally {
        setSystemTime();
      }
    });

    test("ツイートURLを展開し、Web検索のsystemより後ろに非信頼データのsystemを置く", async () => {
      mockTweetService.extractTweetIds = mock(() => ["20"]);
      mockTweetService.expandTweets = mock(() =>
        Promise.resolve({
          status: "expanded" as const,
          parts: [{ type: "text" as const, text: "<untrusted-tweet>tweet</untrusted-tweet>" }],
          textParts: [{ type: "text" as const, text: "<untrusted-tweet>tweet</untrusted-tweet>" }],
          imageParts: [],
        }),
      );
      (mockSettingsService.getGuildSettings as ReturnType<typeof mock>).mockResolvedValueOnce(
        createMockGuildSettings({ webSearchEnabled: true, twitterExpandEnabled: true }),
      );
      const { updater } = createSpyUpdater();
      const exaChat = new ChatService(
        mockLLMClient,
        mockSettingsService,
        toolRegistry,
        "exa",
        mockTweetService,
        new ModelService(mockLLMClient),
      );

      await exaChat.generateChatResponse("guild-123", { text: "read this" }, "req-tweet", updater, {
        channelId: "channel-1",
        userId: "user-1",
      });

      const [request] = (mockLLMClient.chatStream as ReturnType<typeof mock>).mock.calls[0] as [
        ChatCompletionRequest,
        AbortSignal,
      ];
      expect(request.messages.map((message) => message.role)).toEqual(["system", "system", "user"]);
      expect(request.messages[1]?.content).toContain("非信頼データ");
      expect(request.messages[2]?.content).toEqual([
        { type: "text", text: "read this" },
        { type: "text", text: "<untrusted-tweet>tweet</untrusted-tweet>" },
      ]);
    });

    test("実TweetServiceの画像対応判定に期限signalを渡し、生成signalのlistenerを残さない", async () => {
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
      const mockFetch = mock(() =>
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
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;
      globalThis.AbortController = TrackingAbortController;
      globalThis.setTimeout = ((...args: Parameters<typeof originalSetTimeout>) => {
        const [handler, delay, ...rest] = args;
        return originalSetTimeout(handler, delay === TWEET_FETCH_DEADLINE_MS ? 0 : delay, ...rest);
      }) as typeof globalThis.setTimeout;
      mockLLMClient.listModelsWithPricing = mock(() => new Promise<never>(() => {}));
      (mockSettingsService.getGuildSettings as ReturnType<typeof mock>).mockResolvedValueOnce(
        createMockGuildSettings({ twitterExpandEnabled: true }),
      );
      const realTweetService = new TweetService("https://api.fxtwitter.test", "1.5.0");
      const realChatService = new ChatService(
        mockLLMClient,
        mockSettingsService,
        toolRegistry,
        "perplexity",
        realTweetService,
        new ModelService(mockLLMClient),
      );
      const { updater } = createSpyUpdater();

      try {
        const result = await realChatService.generateChatResponse(
          "guild-123",
          { text: "https://x.com/a/status/20" },
          "req-real-tweet",
          updater,
          { channelId: "channel-1", userId: "user-1" },
        );

        expect(result.status).toBe("final");
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockLLMClient.listModelsWithPricing).toHaveBeenCalledTimes(1);
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

    test("ツイート展開がOFFならサービスもネットワークも呼ばず、リクエストを変えない", async () => {
      mockTweetService.extractTweetIds = mock(() => {
        throw new Error("must not extract when disabled");
      });
      (mockSettingsService.getGuildSettings as ReturnType<typeof mock>).mockResolvedValueOnce(
        createMockGuildSettings({ twitterExpandEnabled: false }),
      );
      const { updater } = createSpyUpdater();

      await chatService.generateChatResponse(
        "guild-123",
        { text: "https://x.com/a/status/20" },
        "req-off",
        updater,
        {
          channelId: "channel-1",
          userId: "user-1",
        },
      );

      expect(mockTweetService.extractTweetIds).not.toHaveBeenCalled();
      const [request] = (mockLLMClient.chatStream as ReturnType<typeof mock>).mock.calls[0] as [
        ChatCompletionRequest,
        AbortSignal,
      ];
      expect(request.messages).toEqual([{ role: "user", content: "https://x.com/a/status/20" }]);
    });

    test("ツイートURLが無ければ展開せず、system messageもpartsも足さない", async () => {
      const { updater } = createSpyUpdater();

      await chatService.generateChatResponse(
        "guild-123",
        { text: "通常の質問" },
        "req-no-tweet",
        updater,
        {
          channelId: "channel-1",
          userId: "user-1",
        },
      );

      expect(mockTweetService.extractTweetIds).toHaveBeenCalledWith("通常の質問");
      expect(mockTweetService.expandTweets).not.toHaveBeenCalled();
      const [request] = (mockLLMClient.chatStream as ReturnType<typeof mock>).mock.calls[0] as [
        ChatCompletionRequest,
        AbortSignal,
      ];
      expect(request.messages).toEqual([{ role: "user", content: "通常の質問" }]);
    });

    test("画像付きリクエストのBadRequestErrorは本文未表示時だけ画像を外して一度再試行する", async () => {
      mockTweetService.extractTweetIds = mock(() => ["20"]);
      const imagePart = {
        type: "image_url" as const,
        image_url: { url: "https://pbs.twimg.com/a" },
      };
      mockTweetService.expandTweets = mock(() =>
        Promise.resolve({
          status: "expanded" as const,
          parts: [{ type: "text" as const, text: "tweet" }, imagePart],
          textParts: [{ type: "text" as const, text: "tweet" }],
          imageParts: [imagePart],
        }),
      );
      const imageModelService = new ModelService(mockLLMClient);
      (mockLLMClient.listModelsWithPricing as ReturnType<typeof mock>).mockResolvedValueOnce([
        {
          id: "test-model:fixture",
          name: "fixture",
          created: 0,
          contextLength: 4096,
          pricing: { prompt: "0", completion: "0" },
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
        },
      ]);
      (mockLLMClient.chatStream as ReturnType<typeof mock>).mockImplementationOnce(
        async function* () {
          yield* [];
          throw new BadRequestError("image rejected");
        },
      );
      const { updater } = createSpyUpdater();
      const imageChat = new ChatService(
        mockLLMClient,
        mockSettingsService,
        toolRegistry,
        "perplexity",
        mockTweetService,
        imageModelService,
      );

      const result = await imageChat.generateChatResponse(
        "guild-123",
        { text: "read" },
        "req-retry",
        updater,
        {
          channelId: "channel-1",
          userId: "user-1",
        },
      );

      expect(result.status).toBe("final");
      expect(mockLLMClient.chatStream).toHaveBeenCalledTimes(2);
      const calls = (mockLLMClient.chatStream as ReturnType<typeof mock>).mock.calls as [
        ChatCompletionRequest,
        AbortSignal,
      ][];
      expect(calls[0]?.[0].messages[1]?.content).toEqual([
        { type: "text", text: "read" },
        { type: "text", text: "tweet" },
        imagePart,
      ]);
      expect(calls[1]?.[0].messages[1]?.content).toEqual([
        { type: "text", text: "read" },
        { type: "text", text: "tweet" },
      ]);
    });

    test("BadRequestErrorの前に本文をstageした場合は画像を外して再試行しない", async () => {
      mockTweetService.extractTweetIds = mock(() => ["20"]);
      const imagePart = {
        type: "image_url" as const,
        image_url: { url: "https://pbs.twimg.com/a" },
      };
      mockTweetService.expandTweets = mock(() =>
        Promise.resolve({
          status: "expanded" as const,
          parts: [{ type: "text" as const, text: "tweet" }, imagePart],
          textParts: [{ type: "text" as const, text: "tweet" }],
          imageParts: [imagePart],
        }),
      );
      const imageModelService = new ModelService(mockLLMClient);
      (mockLLMClient.listModelsWithPricing as ReturnType<typeof mock>).mockResolvedValueOnce([
        {
          id: "test-model:fixture",
          name: "fixture",
          created: 0,
          contextLength: 4096,
          pricing: { prompt: "0", completion: "0" },
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
        },
      ]);
      (mockLLMClient.chatStream as ReturnType<typeof mock>).mockImplementationOnce(
        async function* () {
          yield { content: "partial", done: false as const };
          throw new BadRequestError("after text");
        },
      );
      const { updater } = createSpyUpdater();
      const imageChat = new ChatService(
        mockLLMClient,
        mockSettingsService,
        toolRegistry,
        "perplexity",
        mockTweetService,
        imageModelService,
      );

      const result = await imageChat.generateChatResponse(
        "guild-123",
        { text: "read" },
        "req-no-retry",
        updater,
        {
          channelId: "channel-1",
          userId: "user-1",
        },
      );

      expect(result.status).toBe("error");
      expect(mockLLMClient.chatStream).toHaveBeenCalledTimes(1);
    });

    test("streaming 中の content は累積で updater.stageContent に渡る", async () => {
      const { updater, calls } = createSpyUpdater();

      await chatService.generateChatResponse("guild-123", { text: "Hello" }, "req-3", updater, {
        channelId: "channel-1",
        userId: "user-1",
      });

      // createMockLLMClient の chatStream は "Mock " → "Mock response"（累積）の順に content を yield する
      expect(calls.staged).toEqual(["Mock ", "Mock response"]);
      expect(calls.begins).toBe(1);
      expect(calls.commits).toEqual(["final"]);
      expect(calls.aborts).toEqual([]);
    });

    test("結果は status: final で text/usage/model/provider を含む", async () => {
      (mockLLMClient.chatStream as ReturnType<typeof mock>).mockImplementationOnce(
        async function* () {
          yield { content: "Hi", done: false as const };
          yield {
            done: true as const,
            fullText: "Hi",
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            model: "resolved-model",
            provider: "resolved-provider",
            finishReason: "stop" as const,
          };
        },
      );
      const { updater } = createSpyUpdater();

      const result = await chatService.generateChatResponse(
        "guild-123",
        { text: "Hi" },
        "req-4",
        updater,
        { channelId: "channel-1", userId: "user-1" },
      );

      expect(result).toMatchObject({
        status: "final",
        text: "Hi",
        finishReason: "stop",
        model: "resolved-model",
        provider: "resolved-provider",
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
    });

    test("cancelRequest 呼び出し後は status: cancelled になる（停止ボタン経路）", async () => {
      (mockLLMClient.chatStream as ReturnType<typeof mock>).mockImplementationOnce(async function* (
        _request: unknown,
        signal?: AbortSignal,
      ) {
        yield { content: "partial", done: false as const };
        // cancel されるまでハング（実 abort/timeout 経路と同じ形）。実 chatStream の
        // `reader.read()` は transport abort で reject するため、signal を無視して無条件に
        // ハングすると runToolLoop 側の iterator finalization (`iterator.return()`) が
        // 永久に解決せずテスト自体がハングする — 実装と同じく signal を尊重する。
        await new Promise<never>((_resolve, reject) => {
          const onAbort = (): void => reject(new Error("aborted"));
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      });
      const { updater } = createSpyUpdater();

      const resultPromise = chatService.generateChatResponse(
        "guild-123",
        { text: "Hi" },
        "req-5",
        updater,
        { channelId: "channel-1", userId: "user-1" },
      );

      setTimeout(() => {
        expect(chatService.cancelRequest("req-5")).toBe(true);
      }, 15);

      const result = await resultPromise;
      expect(result.status).toBe("cancelled");
    });

    test("cancelRequest は未知の requestId には false を返す", () => {
      expect(chatService.cancelRequest("unknown-request")).toBe(false);
    });

    test(
      "getGuildSettings が解決する前（最初の await 中）でも cancelRequest が true を返し、" +
        "結果は status: cancelled になる",
      async () => {
        let resolveSettings!: (value: GuildSettings) => void;
        const pendingSettings = new Promise<GuildSettings>((resolve) => {
          resolveSettings = resolve;
        });
        (mockSettingsService.getGuildSettings as ReturnType<typeof mock>).mockImplementationOnce(
          () => pendingSettings,
        );
        const { updater } = createSpyUpdater();

        const resultPromise = chatService.generateChatResponse(
          "guild-123",
          { text: "Hi" },
          "req-6",
          updater,
          { channelId: "channel-1", userId: "user-1" },
        );

        // マイクロタスクを1つ挟み、generateChatResponse が controller を activeRequests に
        // 登録するところまで進んだこと（かつ getGuildSettings がまだ pending であること）を保証する。
        await Promise.resolve();
        expect(chatService.cancelRequest("req-6")).toBe(true);

        // 設定取得はその後に解決させる。ここで controller が登録済みであれば、
        // runToolLoop は最初のモデルリクエスト前の abort チェックで即座に cancelled を返す。
        resolveSettings(createMockGuildSettings({ guildId: "guild-123" }));

        const result = await resultPromise;
        expect(result.status).toBe("cancelled");
        expect(mockLLMClient.chatStream).not.toHaveBeenCalled();
      },
    );

    test(
      "getGuildSettings が pending のままでも cancelRequest 後は settings を待たず " +
        "status: cancelled で解決する",
      async () => {
        const pendingSettings = new Promise<GuildSettings>(() => {}); // never resolves
        (mockSettingsService.getGuildSettings as ReturnType<typeof mock>).mockImplementationOnce(
          () => pendingSettings,
        );
        const { updater } = createSpyUpdater();

        const resultPromise = chatService.generateChatResponse(
          "guild-123",
          { text: "Hi" },
          "req-7",
          updater,
          { channelId: "channel-1", userId: "user-1" },
        );

        // マイクロタスクを1つ挟み、controller が activeRequests に登録済みであることを保証する。
        await Promise.resolve();
        expect(chatService.cancelRequest("req-7")).toBe(true);

        // getGuildSettings は永久に pending のまま — それでも resultPromise は
        // settings の解決を待たずに cancelled で解決しなければならない。
        const result = await resultPromise;
        expect(result.status).toBe("cancelled");
        expect(mockLLMClient.chatStream).not.toHaveBeenCalled();
      },
    );

    test(
      "設定取得中（getGuildSettings pending 中）に cancel された場合でも、" +
        "history には user message が含まれる（cancel タイミングで入力が落ちない）",
      async () => {
        const pendingSettings = new Promise<GuildSettings>(() => {}); // never resolves
        (mockSettingsService.getGuildSettings as ReturnType<typeof mock>).mockImplementationOnce(
          () => pendingSettings,
        );
        const { updater } = createSpyUpdater();

        const resultPromise = chatService.generateChatResponse(
          "guild-123",
          { text: "Hi there" },
          "req-8",
          updater,
          { channelId: "channel-1", userId: "user-1" },
        );

        await Promise.resolve();
        expect(chatService.cancelRequest("req-8")).toBe(true);

        const result = await resultPromise;
        expect(result.status).toBe("cancelled");
        // 設定取得後に cancel された場合と同じ history（user message 入り）が返る。
        expect(result.history).toEqual([{ role: "user", content: "Hi there" }]);
      },
    );

    test("abort 後に getGuildSettings が reject しても、reject は伝播せず status: cancelled で解決する", async () => {
      let rejectSettings!: (error: unknown) => void;
      const pendingSettings = new Promise<GuildSettings>((_resolve, reject) => {
        rejectSettings = reject;
      });
      (mockSettingsService.getGuildSettings as ReturnType<typeof mock>).mockImplementationOnce(
        () => pendingSettings,
      );
      const { updater } = createSpyUpdater();

      const resultPromise = chatService.generateChatResponse(
        "guild-123",
        { text: "Hi" },
        "req-9",
        updater,
        { channelId: "channel-1", userId: "user-1" },
      );

      await Promise.resolve();
      expect(chatService.cancelRequest("req-9")).toBe(true);

      // abort → reject の順で発火させる。cancel が既に成功している以上、
      // settings fetch の失敗は無視され cancelled のまま解決しなければならない。
      rejectSettings(new Error("settings fetch failed"));

      const result = await resultPromise;
      expect(result.status).toBe("cancelled");
      expect(mockLLMClient.chatStream).not.toHaveBeenCalled();
    });
  });
});
