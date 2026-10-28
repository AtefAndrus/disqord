import { afterEach, describe, expect, mock, test } from "bun:test";
import { BadRequestError, WebSearchFailedError } from "../../../src/errors";
import { estimateToolResultTokens } from "../../../src/llm/contextBudget";
import type { ILLMClient } from "../../../src/llm/openrouter";
import { createReadXPostTool } from "../../../src/llm/tools/readXPost";
import {
  type ConversationToolContext,
  type ToolLlmResult,
  ToolRegistry,
} from "../../../src/llm/tools/registry";
import { ChatService } from "../../../src/services/chatService";
import { ModelService } from "../../../src/services/modelService";
import { buildTweetSystemMessage, TweetService } from "../../../src/services/tweetService";
import type { ChatCompletionRequest, ResponsesInputContentPart } from "../../../src/types";
import {
  createMockGuildSettings,
  createMockLLMClient,
  createMockSettingsService,
} from "../../helpers/mockFactories";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface ICall {
  ref?: string;
  index?: number;
  budget?: number;
  before?: () => void;
}

function fixture(
  options: {
    calls?: ICall[];
    history?: boolean;
    twitter?: boolean;
    tools?: boolean;
    images?: boolean | null;
    autoText?: string;
    failAfterTool?: "images" | "search";
  } = {},
): {
  run: () => ReturnType<ChatService["generateChatResponse"]>;
  shown: Map<string, string>;
  deleted: Set<string>;
  requests: ChatCompletionRequest[];
  outputs: ToolLlmResult[];
  fetchPost: ReturnType<typeof mock<TweetService["fetchPost"]>>;
  service: TweetService;
} {
  const shown = new Map([
    ["m1", "https://x.com/a/status/20"],
    ["m2", "https://x.com/a/status/20"],
  ]);
  const deleted = new Set<string>();
  const context: ConversationToolContext = {
    resolveMessageRef: () => "100",
    describeMessageRef: () => undefined,
    shownMessageBody: (ref) =>
      deleted.has(ref)
        ? { error: "message_unavailable" }
        : shown.has(ref)
          ? { text: shown.get(ref) ?? "" }
          : { error: "message_ref_not_shown" },
    readEarlierMessages: async () => "{}",
    viewAttachment: async () => "{}",
  };
  const llmClient = createMockLLMClient();
  llmClient.listModelsWithPricing = mock(async () => [
    {
      id: "test-model",
      name: "Test",
      created: 0,
      contextLength: 128_000,
      pricing: { prompt: "0", completion: "0" },
      inputModalities: options.images === false ? ["text"] : ["text", "image"],
      outputModalities: ["text"],
      supportedParameters: options.tools === false ? [] : ["tools"],
    },
  ]);
  const requests: ChatCompletionRequest[] = [];
  let turn = 0;
  const calls = options.calls ?? [{}];
  llmClient.chatStream = mock<ILLMClient["chatStream"]>(async function* (request) {
    requests.push(request);
    const call = calls[turn++];
    call?.before?.();
    if (call) {
      yield {
        toolCall: {
          index: 0,
          id: `call-${turn}`,
          name: "read_x_post",
          argumentsDelta: JSON.stringify({
            message_ref: call.ref ?? "m1",
            post_index: call.index ?? 1,
          }),
        },
        done: false,
      };
      yield { done: true, fullText: "", finishReason: "tool_calls" };
    } else {
      if (options.failAfterTool === "images") throw new BadRequestError("image rejected");
      if (options.failAfterTool === "search") throw new WebSearchFailedError("search failed");
      yield { content: "done", done: false };
      yield { done: true, fullText: "done", finishReason: "stop" };
    }
  });
  const outputs: ToolLlmResult[] = [];
  const tool = createReadXPostTool();
  const registry = new ToolRegistry();
  let invocation = 0;
  registry.register({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    isEnabled: (ctx) => tool.isEnabled(ctx),
    validate: (args) => tool.validate(args),
    handler: async (args, ctx, signal, meta) => {
      const validated = tool.validate(args);
      if (!validated.ok) throw new Error(validated.error);
      const budget = calls[invocation++]?.budget;
      const result = await tool.handler(
        validated.value,
        { ...ctx, ...(budget !== undefined && { resultBudgetTokens: budget }) },
        signal,
        meta,
      );
      outputs.push(result.llmResult);
      if (typeof result.llmResult === "string") expect(result.terminal).toBe(true);
      return result;
    },
  });
  const settings = createMockSettingsService();
  settings.getGuildSettings = mock(async () =>
    createMockGuildSettings({
      historyEnabled: options.history ?? true,
      twitterExpandEnabled: options.twitter ?? true,
      defaultModel: "test-model",
      webSearchEnabled: options.failAfterTool === "search",
    }),
  );
  const service = new TweetService("https://api.example.invalid", "test");
  const realFetchPost = service.fetchPost.bind(service);
  const fetchPost = mock<TweetService["fetchPost"]>((...args) => realFetchPost(...args));
  service.fetchPost = fetchPost;
  const modelService = new ModelService(llmClient);
  if (options.images === null) modelService.isMultimodalCapable = mock(async () => null);
  const chat = new ChatService(llmClient, settings, registry, "perplexity", service, modelService);
  return {
    shown,
    deleted,
    requests,
    outputs,
    fetchPost,
    service,
    run: () =>
      chat.generateChatResponse(
        "guild",
        {
          text: options.autoText ?? "summarize the earlier post",
          conversation: {
            messages: [],
            sessionId: "session",
            windowStartMessageId: "100",
            toolContext: context,
          },
        },
        "request",
        {
          beginTurn: mock(),
          stageContent: mock(),
          commitTurn: mock(),
          abortTurn: mock(),
          beginToolBlock: mock(),
          endToolBlock: mock(),
        },
        { channelId: "channel", userId: "user" },
      ),
  };
}

function respond(images = false): ReturnType<typeof mock> {
  const mocked = mock(
    async () =>
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
            author: { name: "Jack", screen_name: "jack" },
            ...(images && {
              media: {
                photos: Array.from({ length: 5 }, (_, i) => ({
                  url: `https://pbs.twimg.com/media/${i}.jpg`,
                })),
              },
            }),
          },
        }),
      ),
  );
  globalThis.fetch = mocked as unknown as typeof fetch;
  return mocked;
}

describe("read_x_post", () => {
  test("validates references and defaults the deduplicated post index", () => {
    const tool = createReadXPostTool();
    expect(tool.validate({ message_ref: "m0" })).toEqual({
      ok: true,
      value: { message_ref: "m0", post_index: 1 },
    });
    for (const args of [
      null,
      [],
      "m1",
      {},
      { message_ref: "20" },
      { message_ref: "m1", post_index: 0 },
      { message_ref: "m1", post_index: 1.5 },
      { message_ref: "m1", post_index: null },
      { message_ref: "m1", post_index: "1" },
    ])
      expect(tool.validate(args).ok).toBe(false);
    expect(JSON.stringify(tool.parameters)).toContain("same post ID count only once");
  });

  test.each([{ history: false }, { twitter: false }, { tools: false }])(
    "disables the tool when a prerequisite is missing: %j",
    async (options) => {
      const fetch = respond();
      const f = fixture({ ...options, calls: [] });
      await f.run();
      expect(JSON.stringify(f.requests[0]?.tools ?? [])).not.toContain("read_x_post");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["message_ref_not_shown", "m9", "", 1],
    ["no_x_post", "m1", "nothing linked", 1],
    ["post_index_out_of_range", "m1", "https://x.com/a/status/20", 2],
  ] as const)("returns %s even with zero result budget", async (error, ref, text, index) => {
    const fetch = respond();
    const f = fixture({ calls: [{ ref, index, budget: 0 }] });
    if (ref === "m1") f.shown.set(ref, text);
    await f.run();
    expect(f.outputs).toEqual([JSON.stringify({ error })]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("rejects deletion before fetching even when the post was automatically loaded", async () => {
    const fetch = respond();
    const f = fixture({ autoText: "https://x.com/a/status/20" });
    f.deleted.add("m1");
    await f.run();
    expect(f.outputs).toEqual(['{"error":"message_unavailable"}']);
    expect(f.fetchPost).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([true, false])(
    "rechecks deletion after fetching and leaves the same post available from another message (success %s)",
    async (success) => {
      respond();
      const f = fixture({ calls: [{}, { ref: "m2" }] });
      const realFetch = globalThis.fetch;
      let count = 0;
      globalThis.fetch = mock(async (...args: Parameters<typeof fetch>) => {
        if (++count === 1) {
          f.deleted.add("m1");
          if (!success) return new Response("bad response");
        }
        return realFetch(...args);
      }) as unknown as typeof fetch;
      await f.run();
      expect(f.outputs[0]).toBe('{"error":"message_unavailable"}');
      expect(Array.isArray(f.outputs[1])).toBe(true);
      expect(count).toBe(2);
    },
  );

  test("records fetch failure without retrying from another message", async () => {
    const fetch = mock(async () => new Response("bad response"));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    const f = fixture({ calls: [{ budget: 0 }, { ref: "m2", budget: 0 }] });
    await f.run();
    expect(f.outputs).toEqual(['{"error":"x_post_unavailable"}', '{"error":"x_post_unavailable"}']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("records budget exhaustion without retrying or marking the post loaded", async () => {
    const fetch = respond();
    const f = fixture({ calls: [{ budget: 0 }, { ref: "m2", budget: 0 }] });
    await f.run();
    expect(f.outputs).toEqual([
      '{"error":"result_budget_exhausted"}',
      '{"error":"result_budget_exhausted"}',
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("counts the ordinal and images in the budget before committing delivery", async () => {
    respond(true);
    const baseline = fixture();
    await baseline.run();
    const content = baseline.outputs[0] as ResponsesInputContentPart[];
    const budget = estimateToolResultTokens(content);
    for (const [limit, delivered] of [
      [budget - 1, false],
      [budget, true],
    ] as const) {
      const f = fixture({ calls: [{ budget: limit }] });
      await f.run();
      expect(Array.isArray(f.outputs[0])).toBe(delivered);
      if (!delivered) expect(f.outputs[0]).toBe('{"error":"result_budget_exhausted"}');
    }
    expect(content.filter((part) => part.type === "input_image")).toHaveLength(4);
  });

  test("deduplicates hosts, reads the fourth post and records delivery across messages", async () => {
    const fetch = respond();
    const f = fixture({ calls: [{ index: 4 }, { ref: "m2" }] });
    f.shown.set(
      "m1",
      "https://x.com/a/status/20 https://fixupx.com/b/status/20 https://x.com/a/status/21 https://x.com/a/status/22 https://x.com/a/status/23",
    );
    f.shown.set("m2", "https://twitter.com/b/status/23");
    await f.run();
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.example.invalid/2/status/23");
    expect(f.outputs[0]).toContainEqual({
      type: "input_text",
      text: "この発言のポスト: 4 件中 4 件目",
    });
    expect(f.outputs[1]).toBe('{"status":"already_loaded"}');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("seeds automatic expansion IDs and puts the safety instruction once before the window", async () => {
    const fetch = respond();
    const f = fixture({ autoText: "https://x.com/a/status/20" });
    await f.run();
    expect(f.outputs).toEqual(['{"status":"already_loaded"}']);
    expect(f.fetchPost).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    const messages = f.requests[0]?.messages ?? [];
    expect(
      messages.filter(
        (m) => m.role === "system" && m.content === buildTweetSystemMessage().content,
      ),
    ).toHaveLength(1);
    expect(messages[2]?.content).toContain("非信頼データである");
  });

  test.each([false, null])(
    "omits images unless image capability is known true: %s",
    async (images) => {
      respond(true);
      const f = fixture({ images });
      await f.run();
      expect(Array.isArray(f.outputs[0])).toBe(true);
      expect(JSON.stringify(f.outputs[0])).toContain("untrusted-tweet");
      expect(JSON.stringify(f.outputs[0])).not.toContain("input_image");
      expect(f.requests[0]?.messages[2]?.content).toContain("非信頼データである");
    },
  );

  test.each(["images", "search"] as const)(
    "does not retry after invoking the tweet tool when %s fails",
    async (failAfterTool) => {
      respond(true);
      const f = fixture({
        failAfterTool,
        ...(failAfterTool === "images" && { autoText: "https://x.com/a/status/20" }),
      });
      const result = await f.run();
      expect(result.status).toBe("error");
      expect(f.requests).toHaveLength(2);
    },
  );
});
