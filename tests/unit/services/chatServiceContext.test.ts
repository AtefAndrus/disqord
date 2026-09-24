import { describe, expect, mock, test } from "bun:test";
import { BadRequestError, WebSearchFailedError } from "../../../src/errors";
import type { IToolLoopUpdater } from "../../../src/llm/toolLoop";
import { createReadEarlierMessagesTool } from "../../../src/llm/tools/readEarlierMessages";
import { ToolRegistry } from "../../../src/llm/tools/registry";
import { PDF_PARSER_PLUGIN } from "../../../src/services/attachmentParser";
import { buildChatRequest, ChatService } from "../../../src/services/chatService";
import { ModelService } from "../../../src/services/modelService";
import type { ChatCompletionRequest } from "../../../src/types";
import {
  createMockGuildSettings,
  createMockLLMClient,
  createMockSettingsService,
  createMockTweetService,
} from "../../helpers/mockFactories";

async function* toolCallTurn(): AsyncGenerator<
  | { toolCall: { index: number; id: string; name: string; argumentsDelta: string }; done: false }
  | {
      done: true;
      fullText: string;
      finishReason: "tool_calls";
    },
  void,
  void
> {
  yield {
    toolCall: {
      index: 0,
      id: "call-1",
      name: "read_earlier_messages",
      argumentsDelta: '{"count":1}',
    },
    done: false,
  };
  yield { done: true, fullText: "", finishReason: "tool_calls" };
}

async function* webSearchFailedTurn(): AsyncGenerator<never, void, void> {
  yield* [];
  throw new WebSearchFailedError(
    'Server tool "openrouter:web_search" failed: invalid request (400)',
  );
}

async function* badRequestTurn(): AsyncGenerator<never, void, void> {
  yield* [];
  throw new BadRequestError("tweet image rejected");
}

async function* finalTurn(
  text: string,
): AsyncGenerator<
  { content: string; done: false } | { done: true; fullText: string; finishReason: "stop" },
  void,
  void
> {
  yield { content: text, done: false };
  yield { done: true, fullText: text, finishReason: "stop" };
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

function createRetryFixture(webSearchEnabled = false): {
  chatService: ChatService;
  llmClient: ReturnType<typeof createMockLLMClient>;
  requests: ChatCompletionRequest[];
  readEarlier: ReturnType<typeof mock>;
} {
  const llmClient = createMockLLMClient();
  llmClient.listModelsWithPricing = mock(async () => [
    {
      id: "test-model:fixture",
      name: "Fixture",
      created: 0,
      contextLength: 4_096,
      pricing: { prompt: "0", completion: "0" },
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportedParameters: ["tools"],
    },
  ]);
  const settingsService = createMockSettingsService();
  settingsService.getGuildSettings = mock(async (guildId: string) =>
    createMockGuildSettings({ guildId, historyEnabled: true, webSearchEnabled }),
  );
  const tweetService = createMockTweetService();
  const imagePart = {
    type: "image_url" as const,
    image_url: { url: "https://images.example.invalid/tweet.png" },
  };
  tweetService.extractTweetIds = mock(() => ["20"]);
  tweetService.expandTweets = mock(async () => ({
    status: "expanded" as const,
    parts: [imagePart],
    textParts: [],
    imageParts: [imagePart],
  }));
  const readEarlier = mock(async () => '{"messages":[]}');
  const registry = new ToolRegistry();
  registry.register(createReadEarlierMessagesTool());
  const requests: ChatCompletionRequest[] = [];
  const chatService = new ChatService(
    llmClient,
    settingsService,
    registry,
    "perplexity",
    tweetService,
    new ModelService(llmClient),
  );
  return { chatService, llmClient, requests, readEarlier };
}

function retryInput(readEarlier: ReturnType<typeof mock>): {
  text: string;
  conversation: {
    messages: [];
    sessionId: string;
    windowStartMessageId: string;
    toolContext: {
      readEarlierMessages: typeof readEarlier;
      viewAttachment: () => Promise<string>;
    };
  };
} {
  return {
    text: "https://x.com/example/status/20",
    conversation: {
      messages: [],
      sessionId: "session",
      windowStartMessageId: "start",
      toolContext: {
        readEarlierMessages: readEarlier,
        viewAttachment: async () => '{"error":"unused"}',
      },
    },
  };
}

describe("conversation-context request construction", () => {
  test("attaches file-parser from the first request when view_attachment is offered without a file part", () => {
    const request = buildChatRequest("model", { text: "question" }, [], undefined, true);

    expect(request.plugins).toEqual([PDF_PARSER_PLUGIN]);
    expect(request.messages).toEqual([{ role: "user", content: "question" }]);
  });

  test("history-off construction retains the no-history request shape", () => {
    expect(buildChatRequest("model", { text: "question" })).toEqual({
      model: "model",
      messages: [{ role: "user", content: "question" }],
    });
  });

  test("history-off generation does not forward a supplied window, tools, or session_id", async () => {
    const llmClient = createMockLLMClient();
    const chatService = new ChatService(
      llmClient,
      createMockSettingsService(),
      new ToolRegistry(),
      "perplexity",
      createMockTweetService(),
      new ModelService(llmClient),
    );
    const updater = {
      beginTurn: mock(() => {}),
      stageContent: mock(() => {}),
      commitTurn: mock(() => {}),
      abortTurn: mock(() => {}),
      beginToolBlock: mock(() => {}),
      endToolBlock: mock(() => {}),
    };

    await chatService.generateChatResponse(
      "guild",
      {
        text: "question",
        conversation: {
          messages: [],
          sessionId: "must-not-be-sent",
          windowStartMessageId: "start",
          toolContext: {
            readEarlierMessages: async () => "history",
            viewAttachment: async () => "attachment",
          },
        },
      },
      "request",
      updater,
      { channelId: "channel", userId: "user" },
    );

    expect(llmClient.chatStream).toHaveBeenCalledTimes(1);
    const [request] = (llmClient.chatStream as ReturnType<typeof mock>).mock.calls[0] as [
      ChatCompletionRequest,
      AbortSignal,
    ];
    const expected = buildChatRequest("test-model:fixture", { text: "question" });
    expect(request).toEqual({
      ...expected,
      messages: [
        { role: "system", content: expect.stringContaining("現在日時") },
        ...expected.messages,
      ],
    });
  });

  test("does not retry without web search after a client tool was invoked", async () => {
    const fixture = createRetryFixture(true);
    let streamCall = 0;
    fixture.llmClient.chatStream = mock((request) => {
      fixture.requests.push(request);
      streamCall += 1;
      return streamCall === 1 ? toolCallTurn() : webSearchFailedTurn();
    });

    const result = await fixture.chatService.generateChatResponse(
      "guild",
      retryInput(fixture.readEarlier),
      "request",
      createUpdater(),
      { channelId: "channel", userId: "user" },
    );

    expect(fixture.readEarlier).toHaveBeenCalledTimes(1);
    expect(fixture.requests).toHaveLength(2);
    expect(result.status === "error" && result.error).toBeInstanceOf(WebSearchFailedError);
  });

  test("drops tweet images and then web search when each fails before anything is shown", async () => {
    const fixture = createRetryFixture(true);
    let streamCall = 0;
    fixture.llmClient.chatStream = mock((request) => {
      fixture.requests.push(request);
      streamCall += 1;
      if (streamCall === 1) return badRequestTurn();
      if (streamCall === 2) return webSearchFailedTurn();
      return finalTurn("answer");
    });

    const result = await fixture.chatService.generateChatResponse(
      "guild",
      retryInput(fixture.readEarlier),
      "request",
      createUpdater(),
      { channelId: "channel", userId: "user" },
    );

    expect(fixture.requests).toHaveLength(3);
    const images = (request: ChatCompletionRequest): number =>
      request.messages
        .flatMap((message) =>
          message.role === "user" && Array.isArray(message.content) ? message.content : [],
        )
        .filter((part) => part.type === "image_url").length;
    const searches = (request: ChatCompletionRequest): boolean =>
      request.tools?.some((tool) => tool.type === "openrouter:web_search") ?? false;
    const instructed = (request: ChatCompletionRequest): boolean =>
      request.messages.some(
        (message) =>
          message.role === "system" && String(message.content).includes("Web 検索ツールを使える"),
      );
    const [first, second, third] = fixture.requests;
    expect(first && [images(first), searches(first), instructed(first)]).toEqual([1, true, true]);
    expect(second && [images(second), searches(second), instructed(second)]).toEqual([
      0,
      true,
      true,
    ]);
    expect(third && [images(third), searches(third), instructed(third)]).toEqual([0, false, false]);
    expect(result).toMatchObject({ status: "final", webSearchSkipped: true });
  });

  test("drops web search and then tweet images when they fail in that order", async () => {
    const fixture = createRetryFixture(true);
    let streamCall = 0;
    fixture.llmClient.chatStream = mock((request) => {
      fixture.requests.push(request);
      streamCall += 1;
      if (streamCall === 1) return webSearchFailedTurn();
      if (streamCall === 2) return badRequestTurn();
      return finalTurn("answer");
    });

    const result = await fixture.chatService.generateChatResponse(
      "guild",
      retryInput(fixture.readEarlier),
      "request",
      createUpdater(),
      { channelId: "channel", userId: "user" },
    );

    expect(fixture.requests).toHaveLength(3);
    const images = (request: ChatCompletionRequest): number =>
      request.messages
        .flatMap((message) =>
          message.role === "user" && Array.isArray(message.content) ? message.content : [],
        )
        .filter((part) => part.type === "image_url").length;
    const searches = (request: ChatCompletionRequest): boolean =>
      request.tools?.some((tool) => tool.type === "openrouter:web_search") ?? false;
    const instructed = (request: ChatCompletionRequest): boolean =>
      request.messages.some(
        (message) =>
          message.role === "system" && String(message.content).includes("Web 検索ツールを使える"),
      );
    const [first, second, third] = fixture.requests;
    expect(first && [images(first), searches(first), instructed(first)]).toEqual([1, true, true]);
    expect(second && [images(second), searches(second), instructed(second)]).toEqual([
      1,
      false,
      false,
    ]);
    expect(third && [images(third), searches(third), instructed(third)]).toEqual([0, false, false]);
    expect(result).toMatchObject({ status: "final", webSearchSkipped: true });
  });

  test("does not retry tweet images after a client tool was invoked", async () => {
    const fixture = createRetryFixture();
    let streamCall = 0;
    fixture.llmClient.chatStream = mock((request) => {
      fixture.requests.push(request);
      streamCall += 1;
      return streamCall === 1 ? toolCallTurn() : badRequestTurn();
    });

    const result = await fixture.chatService.generateChatResponse(
      "guild",
      retryInput(fixture.readEarlier),
      "request",
      createUpdater(),
      { channelId: "channel", userId: "user" },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toBeInstanceOf(BadRequestError);
    expect(fixture.llmClient.chatStream).toHaveBeenCalledTimes(2);
    expect(fixture.readEarlier).toHaveBeenCalledTimes(1);
  });

  test("still retries tweet images when the first attempt invokes no client tool", async () => {
    const fixture = createRetryFixture();
    let streamCall = 0;
    fixture.llmClient.chatStream = mock((request) => {
      fixture.requests.push(request);
      streamCall += 1;
      return streamCall === 1 ? badRequestTurn() : finalTurn("retry succeeded");
    });

    const result = await fixture.chatService.generateChatResponse(
      "guild",
      retryInput(fixture.readEarlier),
      "request",
      createUpdater(),
      { channelId: "channel", userId: "user" },
    );

    expect(result.status).toBe("final");
    if (result.status === "final") expect(result.text).toBe("retry succeeded");
    expect(fixture.llmClient.chatStream).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(fixture.requests[0]?.messages)).toContain("image_url");
    expect(JSON.stringify(fixture.requests[1]?.messages)).not.toContain("image_url");
  });
});
