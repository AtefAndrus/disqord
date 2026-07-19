import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { StreamProtocolError, ToolProtocolError } from "../../../src/errors";
import type { ILLMClient } from "../../../src/llm/openrouter";
import { MAX_TOOL_CALL_INDEX, OpenRouterClient } from "../../../src/llm/openrouter";
import type { IToolLoopParams, IToolLoopUpdater, ToolLoopResult } from "../../../src/llm/toolLoop";
import {
  ITERATOR_CLEANUP_TIMEOUT_MS,
  MAX_DISTINCT_TOOL_CALLS_HARD_CAP,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TURN_ACCUM_BYTES,
  MAX_TURNS,
  runToolLoop,
  TOOL_CALL_FRAGMENT_OVERHEAD_BYTES,
} from "../../../src/llm/toolLoop";
import type { IClientTool, IToolContext } from "../../../src/llm/tools/registry";
import { ToolRegistry } from "../../../src/llm/tools/registry";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  StreamChunk,
  StreamFinalResult,
  StreamHeartbeatChunk,
  StreamToolCallChunk,
} from "../../../src/types";

type StreamYield = StreamChunk | StreamToolCallChunk | StreamHeartbeatChunk | StreamFinalResult;
type TurnScript = (
  request: ChatCompletionRequest,
  signal: AbortSignal,
) => AsyncGenerator<StreamYield, void, void>;

const ctx: IToolContext = { guildId: "g1", channelId: "c1", userId: "u1" };
const FAST_TIMEOUTS = { idleMs: 2_000, wallMs: 5_000 };

// ---------------------------------------------------------------------------
// Stream chunk builders
// ---------------------------------------------------------------------------

function content(text: string): StreamChunk {
  return { content: text, done: false };
}

function toolCall(delta: {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}): StreamToolCallChunk {
  return { toolCall: delta, done: false };
}

function final(overrides: Partial<StreamFinalResult> = {}): StreamFinalResult {
  return {
    done: true,
    fullText: "",
    finishReason: null,
    ...overrides,
  };
}

function heartbeat(): StreamHeartbeatChunk {
  return { heartbeat: true, done: false };
}

const usage1 = (n: number): NonNullable<ChatCompletionResponse["usage"]> => ({
  prompt_tokens: n,
  completion_tokens: n * 2,
  total_tokens: n * 3,
});

// ---------------------------------------------------------------------------
// Mock ILLMClient: pops one scripted async generator per chatStream() call.
// ---------------------------------------------------------------------------

function makeClient(scripts: TurnScript[]): {
  client: ILLMClient;
  requests: ChatCompletionRequest[];
  callCount: () => number;
} {
  const requests: ChatCompletionRequest[] = [];
  let i = 0;
  const client: ILLMClient = {
    chat: async () => {
      throw new Error("chat() is not used by the tool loop");
    },
    chatStream: (request, signal) => {
      requests.push(request);
      const script = scripts[i++];
      if (!script) {
        throw new Error(`no scripted turn for chatStream() call #${i}`);
      }
      return script(request, signal ?? new AbortController().signal);
    },
    listModels: async () => [],
    listModelsWithPricing: async () => [],
    getCredits: async () => ({ remaining: 0 }),
    isRateLimited: () => false,
  };
  return { client, requests, callCount: () => i };
}

/** Turn script that yields a fixed sequence of chunks, ignoring the signal. */
function scripted(...chunks: StreamYield[]): TurnScript {
  return async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  };
}

/**
 * Resolves once `signal` aborts. Mirrors the real `chatStream()`'s
 * `reader.read()`, which rejects promptly once its underlying fetch is
 * aborted — a fake generator that instead hangs on an unconditional
 * `await new Promise(() => {})` would make `runTurn()`'s `iterator.return()`
 * wait forever, since an async generator's `.return()` can only take effect
 * once its current pending `await` settles.
 */
function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 手動で resolve タイミングを制御できる Promise。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Recording updater
// ---------------------------------------------------------------------------

class RecordedUpdater implements IToolLoopUpdater {
  events: string[] = [];
  beginCount = 0;
  commitCount = 0;
  abortCount = 0;
  commits: ("tool_calls" | "final")[] = [];

  constructor(private readonly throwOn: Set<string> = new Set()) {}

  private maybeThrow(name: string): void {
    if (this.throwOn.has(name)) throw new Error(`boom:${name}`);
  }

  beginTurn(): void {
    this.beginCount++;
    this.events.push("beginTurn");
    this.maybeThrow("beginTurn");
  }
  stageContent(text: string): void {
    this.events.push(`stageContent:${text}`);
    this.maybeThrow("stageContent");
  }
  commitTurn(kind: "tool_calls" | "final"): void {
    this.commitCount++;
    this.commits.push(kind);
    this.events.push(`commitTurn:${kind}`);
    this.maybeThrow("commitTurn");
  }
  abortTurn(reason: string): void {
    this.abortCount++;
    this.events.push(`abortTurn:${reason}`);
    this.maybeThrow("abortTurn");
  }
  beginToolBlock(name: string): void {
    this.events.push(`beginToolBlock:${name}`);
    this.maybeThrow("beginToolBlock");
  }
  endToolBlock(name: string): void {
    this.events.push(`endToolBlock:${name}`);
    this.maybeThrow("endToolBlock");
  }
}

// ---------------------------------------------------------------------------
// Fake tool
// ---------------------------------------------------------------------------

function makeEchoTool(overrides: Partial<IClientTool> = {}): IClientTool {
  return {
    name: "echo_tool",
    description: "Echoes arguments back as JSON.",
    parameters: { type: "object", properties: {} },
    isEnabled: () => true,
    validate: (args: unknown) => ({ ok: true, value: args }),
    handler: async (args: unknown) => ({ llmResult: `echo:${JSON.stringify(args)}` }),
    ...overrides,
  };
}

function baseParams(overrides: Partial<IToolLoopParams> = {}): IToolLoopParams {
  const { client } = makeClient([
    scripted(content("hi"), final({ fullText: "hi", finishReason: "stop" })),
  ]);
  return {
    llmClient: client,
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
    registry: new ToolRegistry(),
    ctx,
    updater: new RecordedUpdater(),
    requestId: "req-1",
    timeouts: FAST_TIMEOUTS,
    ...overrides,
  };
}

function expectFinal(
  result: ToolLoopResult,
): asserts result is Extract<ToolLoopResult, { status: "final" }> {
  expect(result.status).toBe("final");
}
function expectError(
  result: ToolLoopResult,
): asserts result is Extract<ToolLoopResult, { status: "error" }> {
  expect(result.status).toBe("error");
}
function expectCancelled(
  result: ToolLoopResult,
): asserts result is Extract<ToolLoopResult, { status: "cancelled" }> {
  expect(result.status).toBe("cancelled");
}

// ---------------------------------------------------------------------------
// No tools registered
// ---------------------------------------------------------------------------

describe("runToolLoop: no tools", () => {
  test("single request, tools/tool_choice omitted, content staged and committed as final", async () => {
    const { client, requests, callCount } = makeClient([
      scripted(
        content("Hello"),
        content(", world"),
        final({
          fullText: "Hello, world",
          finishReason: "stop",
          model: "m1",
          provider: "p1",
          usage: usage1(1),
        }),
      ),
    ]);
    const updater = new RecordedUpdater();
    const initialMessages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const result = await runToolLoop(
      baseParams({ llmClient: client, updater, messages: initialMessages }),
    );

    expect(callCount()).toBe(1);
    expect(requests[0]?.tools).toBeUndefined();
    expect(requests[0]?.tool_choice).toBeUndefined();

    expectFinal(result);
    expect(result.text).toBe("Hello, world");
    expect(result.finishReason).toBe("stop");
    expect(result.model).toBe("m1");
    expect(result.provider).toBe("p1");
    expect(result.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    expect(result.history).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello, world" },
    ]);

    // Caller's original array is untouched.
    expect(initialMessages).toEqual([{ role: "user", content: "hi" }]);

    expect(updater.events).toEqual([
      "beginTurn",
      "stageContent:Hello",
      "stageContent:Hello, world",
      "commitTurn:final",
    ]);
    expect(updater.beginCount).toBe(1);
    expect(updater.commitCount).toBe(1);
    expect(updater.abortCount).toBe(0);
  });

  test("empty registry + no serverTools behaves as a single-turn transport (no extra latency/turn)", async () => {
    const { client, callCount } = makeClient([
      scripted(content("ok"), final({ fullText: "ok", finishReason: "stop" })),
    ]);
    const result = await runToolLoop(baseParams({ llmClient: client }));
    expectFinal(result);
    expect(callCount()).toBe(1);
  });

  test('finish_reason:"tool_calls" with no tools offered fails the turn instead of dispatching a hallucinated call (no second request)', async () => {
    const { client, callCount } = makeClient([
      scripted(
        toolCall({ index: 0, id: "call_1", name: "made_up_tool", argumentsDelta: "{}" }),
        final({ fullText: "", finishReason: "tool_calls" }),
      ),
    ]);
    const updater = new RecordedUpdater();
    const result = await runToolLoop(baseParams({ llmClient: client, updater }));

    expectError(result);
    expect(result.error).toBeInstanceOf(ToolProtocolError);
    // No follow-up request was made to resolve the hallucinated call.
    expect(callCount()).toBe(1);
    expect(updater.commitCount).toBe(0);
    expect(updater.abortCount).toBe(1);
    // Nothing beyond the initial user message was pushed to history.
    expect(result.history).toEqual([{ role: "user", content: "hi" }]);
  });

  test('tool_call fragments accumulated with no tools offered fail the turn (as the "no tools offered" guard, not the generic "stop"-with-fragments error) even when finish_reason ultimately arrives as "stop"', async () => {
    // Fragments alone (condition (a) in the design) must trip the no-tools
    // guard even when finish_reason never comes back as "tool_calls" —
    // exercised here via finish_reason:"stop", which without this guard's
    // priority would instead surface the older/generic 'received tool_call
    // fragments with finish_reason "stop"' error.
    const { client, callCount } = makeClient([
      scripted(
        toolCall({ index: 0, id: "call_1", name: "made_up_tool", argumentsDelta: "{}" }),
        final({ fullText: "", finishReason: "stop" }),
      ),
    ]);
    const updater = new RecordedUpdater();
    const result = await runToolLoop(baseParams({ llmClient: client, updater }));

    expectError(result);
    expect(result.error).toBeInstanceOf(ToolProtocolError);
    expect((result.error as Error).message).toContain("no tools were offered");
    expect(callCount()).toBe(1);
  });

  test(
    'finish_reason:"tool_calls" with zero tool_call fragments and no tools offered also fails the turn ' +
      "(condition (b) alone, independent of the fragment-present case above)",
    async () => {
      // Unlike the two tests above, the model here never emits a single
      // tool_call delta — only the terminal finish_reason claims "tool_calls".
      // The "no tools offered" guard's `hasToolFragments || finishReason ===
      // "tool_calls"` condition must still trip on finishReason alone; without
      // that disjunct this would instead fall through to
      // `normalizeToolCalls()`'s empty-accumulation path.
      const { client, callCount } = makeClient([
        scripted(final({ fullText: "", finishReason: "tool_calls" })),
      ]);
      const updater = new RecordedUpdater();
      const result = await runToolLoop(baseParams({ llmClient: client, updater }));

      expectError(result);
      expect(result.error).toBeInstanceOf(ToolProtocolError);
      // No follow-up request was made to resolve the (nonexistent) call.
      expect(callCount()).toBe(1);
    },
  );
});

// ---------------------------------------------------------------------------
// Server tool only
// ---------------------------------------------------------------------------

describe("runToolLoop: server tool only", () => {
  test("client + server tools combine in the request, but only the client tool is ever dispatchable", async () => {
    let handlerCalls = 0;
    const registry = new ToolRegistry();
    registry.register(
      makeEchoTool({
        handler: async (args) => {
          handlerCalls++;
          return { llmResult: `echo:${JSON.stringify(args)}` };
        },
      }),
    );
    // The model never emits a tool_calls delta here (as if the server tool
    // fully handled the turn server-side); the client tool is still offered
    // but is never invoked.
    const { client, requests } = makeClient([
      scripted(
        content("no tools needed"),
        final({ fullText: "no tools needed", finishReason: "stop" }),
      ),
    ]);
    const result = await runToolLoop(
      baseParams({
        llmClient: client,
        registry,
        serverTools: [{ type: "openrouter:web_search" }],
      }),
    );

    expectFinal(result);
    expect(requests[0]?.tool_choice).toBe("auto");
    expect(requests[0]?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "echo_tool",
          description: "Echoes arguments back as JSON.",
          parameters: { type: "object", properties: {} },
        },
      },
      { type: "openrouter:web_search" },
    ]);
    expect(handlerCalls).toBe(0);
  });

  test("server-tool-only registry (no client tools) still sends tools, omits nothing", async () => {
    const { client, requests } = makeClient([
      scripted(content("done"), final({ fullText: "done", finishReason: "stop" })),
    ]);
    const result = await runToolLoop(
      baseParams({
        llmClient: client,
        registry: new ToolRegistry(),
        serverTools: [{ type: "openrouter:web_search" }],
      }),
    );
    expectFinal(result);
    expect(requests[0]?.tools).toEqual([{ type: "openrouter:web_search" }]);
    expect(requests[0]?.tool_choice).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// 2-turn normal tool-call flow
// ---------------------------------------------------------------------------

describe("runToolLoop: 2-turn tool call", () => {
  test("turn1 tool_calls (split id/name/arguments) -> dispatch -> turn2 stop", async () => {
    const registry = new ToolRegistry();
    const receivedArgs: unknown[] = [];
    registry.register(
      makeEchoTool({
        name: "get_weather",
        handler: async (args) => {
          receivedArgs.push(args);
          return { llmResult: `sunny:${JSON.stringify(args)}` };
        },
      }),
    );

    const { client, requests } = makeClient([
      scripted(
        content("Let me check."),
        toolCall({ index: 0, id: "call_abc" }),
        toolCall({ index: 0, name: "get_weather" }),
        toolCall({ index: 0, argumentsDelta: '{"city":' }),
        toolCall({ index: 0, argumentsDelta: '"Tokyo"}' }),
        final({ fullText: "Let me check.", finishReason: "tool_calls", usage: usage1(1) }),
      ),
      scripted(
        content("It's sunny in Tokyo."),
        final({ fullText: "It's sunny in Tokyo.", finishReason: "stop", usage: usage1(2) }),
      ),
    ]);

    const updater = new RecordedUpdater();
    const initialMessages: ChatMessage[] = [{ role: "user", content: "weather?" }];
    const result = await runToolLoop(
      baseParams({ llmClient: client, registry, updater, messages: initialMessages }),
    );

    expectFinal(result);
    expect(result.text).toBe("It's sunny in Tokyo.");
    expect(receivedArgs).toEqual([{ city: "Tokyo" }]);

    expect(result.history).toHaveLength(4);
    expect(result.history[0]).toEqual({ role: "user", content: "weather?" });
    expect(result.history[1]).toEqual({
      role: "assistant",
      content: "Let me check.",
      tool_calls: [
        {
          id: "call_abc",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
        },
      ],
    });
    expect(result.history[2]).toEqual({
      role: "tool",
      tool_call_id: "call_abc",
      content: 'sunny:{"city":"Tokyo"}',
    });
    expect(result.history[3]).toEqual({ role: "assistant", content: "It's sunny in Tokyo." });

    // Aggregated usage across both turns.
    expect(result.usage).toEqual({ prompt_tokens: 3, completion_tokens: 6, total_tokens: 9 });

    // Caller's array untouched.
    expect(initialMessages).toEqual([{ role: "user", content: "weather?" }]);
    // Each request carries a snapshot, not a shared mutated reference.
    expect(requests[0]?.messages).toHaveLength(1);
    expect(requests[1]?.messages).toHaveLength(3);

    expect(updater.beginCount).toBe(2);
    expect(updater.commitCount).toBe(2);
    expect(updater.abortCount).toBe(0);
    expect(updater.commits).toEqual(["tool_calls", "final"]);
    expect(updater.events).toContain("beginToolBlock:get_weather");
    expect(updater.events).toContain("endToolBlock:get_weather");
  });

  test(
    "turn 1 の dispatch 中に tool.parameters を変異させても、frozen tools は turn 1/turn 2 で" +
      "同一内容（変異前の内容）のまま再送される",
    async () => {
      const registry = new ToolRegistry();
      const mutableParams: Record<string, unknown> = {
        type: "object",
        properties: { city: { type: "string" } },
      };
      registry.register(
        makeEchoTool({
          name: "get_weather",
          parameters: mutableParams,
          handler: async () => {
            // turn 1 の dispatch 中（frozen tools 構築後）に、登録済みツールの
            // スキーマオブジェクトを直接変異させる。frozen tools が参照のまま
            // このオブジェクトを保持していれば、turn 2 の request にこの変異が
            // 漏れてしまう。
            (mutableParams.properties as Record<string, unknown>).city = { type: "mutated" };
            return { llmResult: "sunny" };
          },
        }),
      );

      const { client, requests } = makeClient([
        scripted(
          toolCall({
            index: 0,
            id: "call_1",
            name: "get_weather",
            argumentsDelta: '{"city":"Tokyo"}',
          }),
          final({ fullText: "", finishReason: "tool_calls" }),
        ),
        scripted(content("done"), final({ fullText: "done", finishReason: "stop" })),
      ]);

      const result = await runToolLoop(baseParams({ llmClient: client, registry }));
      expectFinal(result);

      const expectedTools = [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Echoes arguments back as JSON.",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ];
      expect(requests[0]?.tools).toEqual(expectedTools);
      expect(requests[1]?.tools).toEqual(expectedTools);
      // 凍結された同一の tools 配列オブジェクトがそのまま再送されている
      // （毎ターン同一の凍結 tools を再送する、という規約）。
      expect(requests[0]?.tools).toBe(requests[1]?.tools);
    },
  );
});

// ---------------------------------------------------------------------------
// tool_choice across turns / MAX_TURNS
// ---------------------------------------------------------------------------

describe("runToolLoop: tool_choice across turns / MAX_TURNS", () => {
  test('turn 1 uses "auto", final turn uses "none"; tool_calls on the final turn is a protocol error', async () => {
    const registry = new ToolRegistry();
    let handlerCalls = 0;
    registry.register(
      makeEchoTool({
        name: "loopy",
        handler: async () => {
          handlerCalls++;
          return { llmResult: "ok" };
        },
      }),
    );

    const toolTurn = (n: number): TurnScript =>
      scripted(
        toolCall({ index: 0, id: `call_${n}`, name: "loopy", argumentsDelta: "{}" }),
        final({ fullText: "", finishReason: "tool_calls" }),
      );

    const { client, requests, callCount } = makeClient([
      toolTurn(1),
      toolTurn(2),
      toolTurn(3),
      toolTurn(4),
      toolTurn(5), // MAX_TURNS-th request: tool_choice "none", but model returns tool_calls anyway
    ]);

    const updater = new RecordedUpdater();
    const result = await runToolLoop(baseParams({ llmClient: client, registry, updater }));

    expect(callCount()).toBe(MAX_TURNS);
    for (let i = 0; i < MAX_TURNS - 1; i++) {
      expect(requests[i]?.tool_choice).toBe("auto");
    }
    expect(requests[MAX_TURNS - 1]?.tool_choice).toBe("none");
    expect(requests[MAX_TURNS - 1]?.tools).toBeDefined();

    expectError(result);
    expect(result.error).toBeInstanceOf(ToolProtocolError);
    expect(handlerCalls).toBe(MAX_TURNS - 1); // dispatched for turns 1..4, not turn 5

    // Turn 5's assistant tool_calls message must not be committed to history.
    expect(updater.beginCount).toBe(MAX_TURNS);
    expect(updater.commitCount + updater.abortCount).toBe(MAX_TURNS);
    expect(updater.abortCount).toBe(1);
    expect(updater.commits).toEqual(["tool_calls", "tool_calls", "tool_calls", "tool_calls"]);
  });
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe("runToolLoop: normalization", () => {
  test("call with missing function.name is dropped (warned); the other call still dispatches", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new ToolRegistry();
      registry.register(makeEchoTool({ name: "valid_tool" }));

      const { client } = makeClient([
        scripted(
          toolCall({ index: 0, id: "call_valid", name: "valid_tool", argumentsDelta: "{}" }),
          toolCall({ index: 1, id: "call_noname", argumentsDelta: "{}" }), // no name ever set
          final({ fullText: "", finishReason: "tool_calls" }),
        ),
        scripted(content("done"), final({ fullText: "done", finishReason: "stop" })),
      ]);

      const result = await runToolLoop(baseParams({ llmClient: client, registry }));
      expectFinal(result);

      const toolMessages = result.history.filter((m) => m.role === "tool");
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]?.tool_call_id).toBe("call_valid");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("all calls dropped for missing name -> ToolProtocolError, no dispatch, no history push", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new ToolRegistry();
      let handlerCalls = 0;
      registry.register(
        makeEchoTool({
          handler: async () => {
            handlerCalls++;
            return { llmResult: "ok" };
          },
        }),
      );

      const { client } = makeClient([
        scripted(
          toolCall({ index: 0, id: "call_1", argumentsDelta: "{}" }), // no name
          final({ fullText: "", finishReason: "tool_calls" }),
        ),
      ]);

      const updater = new RecordedUpdater();
      const result = await runToolLoop(baseParams({ llmClient: client, registry, updater }));

      expectError(result);
      expect(result.error).toBeInstanceOf(ToolProtocolError);
      expect(handlerCalls).toBe(0);
      expect(result.history).toEqual([{ role: "user", content: "hi" }]);
      expect(updater.commitCount).toBe(0);
      expect(updater.abortCount).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("missing id gets a synthetic id shared by the assistant tool_calls entry and the tool result", async () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool({ name: "no_id_tool" }));

    const { client } = makeClient([
      scripted(
        toolCall({ index: 0, name: "no_id_tool", argumentsDelta: "{}" }), // no id ever set
        final({ fullText: "", finishReason: "tool_calls" }),
      ),
      scripted(content("done"), final({ fullText: "done", finishReason: "stop" })),
    ]);

    const result = await runToolLoop(baseParams({ llmClient: client, registry }));
    expectFinal(result);

    const assistantMsg = result.history[1];
    expect(assistantMsg?.role).toBe("assistant");
    const toolCalls =
      assistantMsg && "tool_calls" in assistantMsg ? assistantMsg.tool_calls : undefined;
    const generatedId = toolCalls?.[0]?.id;
    expect(generatedId).toMatch(/^synthetic-[0-9a-f-]{36}$/);

    const toolMsg = result.history[2];
    expect(toolMsg?.role).toBe("tool");
    expect(toolMsg && "tool_call_id" in toolMsg ? toolMsg.tool_call_id : undefined).toBe(
      generatedId,
    );
  });

  test("duplicate id: first call keeps it, the later one gets a new synthetic id in both assistant and result", async () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool({ name: "dup_a" }));
    registry.register(makeEchoTool({ name: "dup_b" }));

    const { client } = makeClient([
      scripted(
        toolCall({ index: 0, id: "dup", name: "dup_a", argumentsDelta: "{}" }),
        toolCall({ index: 1, id: "dup", name: "dup_b", argumentsDelta: "{}" }),
        final({ fullText: "", finishReason: "tool_calls" }),
      ),
      scripted(content("done"), final({ fullText: "done", finishReason: "stop" })),
    ]);

    const result = await runToolLoop(baseParams({ llmClient: client, registry }));
    expectFinal(result);

    const assistantMsg = result.history[1];
    const toolCalls =
      assistantMsg && "tool_calls" in assistantMsg ? assistantMsg.tool_calls : undefined;
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls?.[0]?.id).toBe("dup");
    const replacedId = toolCalls?.[1]?.id;
    expect(replacedId).toMatch(/^synthetic-[0-9a-f-]{36}$/);
    expect(replacedId).not.toBe("dup");

    const toolMsgs = result.history.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(
      toolMsgs[0] && "tool_call_id" in toolMsgs[0] ? toolMsgs[0].tool_call_id : undefined,
    ).toBe("dup");
    expect(
      toolMsgs[1] && "tool_call_id" in toolMsgs[1] ? toolMsgs[1].tool_call_id : undefined,
    ).toBe(replacedId);
  });

  test("tool calls are normalized/dispatched in ascending index order regardless of arrival order", async () => {
    const registry = new ToolRegistry();
    const order: string[] = [];
    registry.register(
      makeEchoTool({
        name: "ordered",
        handler: async (args) => {
          order.push((args as { tag: string }).tag);
          return { llmResult: "ok" };
        },
      }),
    );

    const { client } = makeClient([
      scripted(
        // index 1 arrives before index 0.
        toolCall({ index: 1, id: "call_1", name: "ordered", argumentsDelta: '{"tag":"second"}' }),
        toolCall({ index: 0, id: "call_0", name: "ordered", argumentsDelta: '{"tag":"first"}' }),
        final({ fullText: "", finishReason: "tool_calls" }),
      ),
      scripted(content("done"), final({ fullText: "done", finishReason: "stop" })),
    ]);

    const result = await runToolLoop(baseParams({ llmClient: client, registry }));
    expectFinal(result);
    expect(order).toEqual(["first", "second"]);

    const assistantMsg = result.history[1];
    const toolCalls =
      assistantMsg && "tool_calls" in assistantMsg ? assistantMsg.tool_calls : undefined;
    expect(toolCalls?.map((c) => c.id)).toEqual(["call_0", "call_1"]);
  });

  test(`more than MAX_TOOL_CALLS_PER_TURN (${MAX_TOOL_CALLS_PER_TURN}) calls: overflow gets an error result without invoking the handler`, async () => {
    const registry = new ToolRegistry();
    const invoked: string[] = [];
    const total = MAX_TOOL_CALLS_PER_TURN + 2;
    for (let i = 0; i < total; i++) {
      registry.register(
        makeEchoTool({
          name: `tool_${i}`,
          handler: async () => {
            invoked.push(`tool_${i}`);
            return { llmResult: "ok" };
          },
        }),
      );
    }

    const deltas = Array.from({ length: total }, (_, i) =>
      toolCall({ index: i, id: `call_${i}`, name: `tool_${i}`, argumentsDelta: "{}" }),
    );
    const { client } = makeClient([
      scripted(...deltas, final({ fullText: "", finishReason: "tool_calls" })),
      scripted(content("done"), final({ fullText: "done", finishReason: "stop" })),
    ]);

    const result = await runToolLoop(baseParams({ llmClient: client, registry }));
    expectFinal(result);

    expect(invoked).toHaveLength(MAX_TOOL_CALLS_PER_TURN);
    expect(invoked).toEqual(Array.from({ length: MAX_TOOL_CALLS_PER_TURN }, (_, i) => `tool_${i}`));

    const toolMsgs = result.history.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(total);
    const overflowMsgs = toolMsgs.slice(MAX_TOOL_CALLS_PER_TURN);
    for (const msg of overflowMsgs) {
      expect("content" in msg && msg.content.toLowerCase()).toContain("too many tool calls");
    }
  });

  test(`accumulating more than MAX_DISTINCT_TOOL_CALLS_HARD_CAP (${MAX_DISTINCT_TOOL_CALLS_HARD_CAP}) distinct calls fails the turn`, async () => {
    const registry = new ToolRegistry();
    let handlerCalls = 0;
    registry.register(
      makeEchoTool({
        handler: async () => {
          handlerCalls++;
          return { llmResult: "ok" };
        },
      }),
    );

    const deltas = Array.from({ length: MAX_DISTINCT_TOOL_CALLS_HARD_CAP + 1 }, (_, i) =>
      toolCall({ index: i, id: `call_${i}`, name: "echo_tool", argumentsDelta: "{}" }),
    );
    const { client } = makeClient([
      scripted(...deltas, final({ fullText: "", finishReason: "tool_calls" })),
    ]);

    const updater = new RecordedUpdater();
    const result = await runToolLoop(baseParams({ llmClient: client, registry, updater }));

    expectError(result);
    expect(result.error).toBeInstanceOf(ToolProtocolError);
    expect(handlerCalls).toBe(0);
    expect(result.history).toEqual([{ role: "user", content: "hi" }]);
    expect(updater.abortCount).toBe(1);
    expect(updater.commitCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Loop-level tool_call index guard (defense in depth vs. a non-OpenRouterClient
// ILLMClient that skips wire-level index validation)
// ---------------------------------------------------------------------------

describe("runToolLoop: tool_call index guard", () => {
  const invalidIndices: [label: string, index: number][] = [
    ["負の index", -1],
    ["整数でない index", 0.5],
    ["safe integer を超える index", 2 ** 53],
    ["safe integer だが MAX_TOOL_CALL_INDEX を1超える index", MAX_TOOL_CALL_INDEX + 1],
  ];

  for (const [label, index] of invalidIndices) {
    test(`${label} (${index}) はハンドラを一切実行せずターンを失敗させる`, async () => {
      const registry = new ToolRegistry();
      let handlerCalls = 0;
      registry.register(
        makeEchoTool({
          handler: async () => {
            handlerCalls++;
            return { llmResult: "ok" };
          },
        }),
      );

      const { client, callCount } = makeClient([
        scripted(
          toolCall({ index, id: "call_1", name: "echo_tool", argumentsDelta: "{}" }),
          final({ fullText: "", finishReason: "tool_calls" }),
        ),
      ]);
      const updater = new RecordedUpdater();
      const result = await runToolLoop(baseParams({ llmClient: client, registry, updater }));

      expectError(result);
      expect(result.error).toBeInstanceOf(ToolProtocolError);
      expect(handlerCalls).toBe(0);
      // No follow-up request was attempted after the guard failed the turn.
      expect(callCount()).toBe(1);
      expect(updater.commitCount).toBe(0);
      expect(updater.abortCount).toBe(1);
    });
  }

  test(`index が MAX_TOOL_CALL_INDEX (${MAX_TOOL_CALL_INDEX}) ちょうどなら通常どおり受理・dispatch される`, async () => {
    const registry = new ToolRegistry();
    let handlerCalls = 0;
    registry.register(
      makeEchoTool({
        handler: async () => {
          handlerCalls++;
          return { llmResult: "ok" };
        },
      }),
    );

    const { client } = makeClient([
      scripted(
        toolCall({
          index: MAX_TOOL_CALL_INDEX,
          id: "call_1",
          name: "echo_tool",
          argumentsDelta: "{}",
        }),
        final({ fullText: "", finishReason: "tool_calls" }),
      ),
      scripted(content("done"), final({ fullText: "done", finishReason: "stop" })),
    ]);
    const result = await runToolLoop(baseParams({ llmClient: client, registry }));

    expectFinal(result);
    expect(result.text).toBe("done");
    expect(handlerCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Conflicting id/name fragments at the same index
// ---------------------------------------------------------------------------

describe("runToolLoop: conflicting id/name fragments at the same index", () => {
  test('index 0 に name:"a" の後、後続断片で異なる name:"b" が来るとターンが失敗する', async () => {
    const { client } = makeClient([
      scripted(
        toolCall({ index: 0, id: "call_1", name: "a" }),
        toolCall({ index: 0, name: "b" }),
        final({ fullText: "", finishReason: "tool_calls" }),
      ),
    ]);
    const updater = new RecordedUpdater();
    const result = await runToolLoop(baseParams({ llmClient: client, updater }));
    expectError(result);
    expect(result.error).toBeInstanceOf(ToolProtocolError);
    expect(updater.abortCount).toBe(1);
    expect(updater.commitCount).toBe(0);
  });

  test('index 0 に id:"call_1" の後、後続断片で異なる id:"call_2" が来るとターンが失敗する', async () => {
    const { client } = makeClient([
      scripted(
        toolCall({ index: 0, id: "call_1", name: "a" }),
        toolCall({ index: 0, id: "call_2" }),
        final({ fullText: "", finishReason: "tool_calls" }),
      ),
    ]);
    const updater = new RecordedUpdater();
    const result = await runToolLoop(baseParams({ llmClient: client, updater }));
    expectError(result);
    expect(result.error).toBeInstanceOf(ToolProtocolError);
    expect(updater.abortCount).toBe(1);
    expect(updater.commitCount).toBe(0);
  });

  test("同値の id/name の再送はターンを失敗させない（従来どおり無視される）", async () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool({ name: "a" }));
    const { client } = makeClient([
      scripted(
        toolCall({ index: 0, id: "call_1", name: "a" }),
        toolCall({ index: 0, id: "call_1", name: "a", argumentsDelta: "{}" }),
        final({ fullText: "", finishReason: "tool_calls" }),
      ),
      scripted(content("done"), final({ fullText: "done", finishReason: "stop" })),
    ]);
    const result = await runToolLoop(baseParams({ llmClient: client, registry }));
    expectFinal(result);
    expect(result.text).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Stream-termination matrix
// ---------------------------------------------------------------------------

describe("runToolLoop: stream termination matrix", () => {
  test('finish_reason "stop" with tool_call fragments -> ToolProtocolError, nothing pushed to history', async () => {
    const { client } = makeClient([
      scripted(
        toolCall({ index: 0, id: "x", name: "n", argumentsDelta: "{}" }),
        final({ fullText: "preamble", finishReason: "stop" }),
      ),
    ]);
    const updater = new RecordedUpdater();
    const result = await runToolLoop(baseParams({ llmClient: client, updater }));
    expectError(result);
    expect(result.error).toBeInstanceOf(ToolProtocolError);
    expect(result.history).toEqual([{ role: "user", content: "hi" }]);
    expect(updater.abortCount).toBe(1);
    expect(updater.commitCount).toBe(0);
  });

  test('finish_reason "length" with no fragments -> final result with finishReason "length"', async () => {
    const { client } = makeClient([
      scripted(content("cut off"), final({ fullText: "cut off", finishReason: "length" })),
    ]);
    const result = await runToolLoop(baseParams({ llmClient: client }));
    expectFinal(result);
    expect(result.finishReason).toBe("length");
    expect(result.text).toBe("cut off");
  });

  test('finish_reason "content_filter" with no fragments -> final result', async () => {
    const { client } = makeClient([
      scripted(
        content("moderated"),
        final({ fullText: "moderated", finishReason: "content_filter" }),
      ),
    ]);
    const result = await runToolLoop(baseParams({ llmClient: client }));
    expectFinal(result);
    expect(result.finishReason).toBe("content_filter");
  });

  test('finish_reason "length"/"content_filter" with tool_call fragments -> ToolProtocolError', async () => {
    const { client } = makeClient([
      scripted(
        toolCall({ index: 0, id: "x", name: "n", argumentsDelta: "{}" }),
        final({ fullText: "preamble", finishReason: "length" }),
      ),
    ]);
    const result = await runToolLoop(baseParams({ llmClient: client }));
    expectError(result);
    expect(result.error).toBeInstanceOf(ToolProtocolError);
  });

  test('finish_reason "error" -> status error', async () => {
    const { client } = makeClient([scripted(final({ fullText: "", finishReason: "error" }))]);
    const result = await runToolLoop(baseParams({ llmClient: client }));
    expectError(result);
    expect(result.error).toBeInstanceOf(ToolProtocolError);
  });

  test("stream ends without ever observing a terminal finish_reason (disconnect) -> error", async () => {
    const { client } = makeClient([
      scripted(content("partial"), final({ fullText: "partial", finishReason: undefined })),
    ]);
    const updater = new RecordedUpdater();
    const result = await runToolLoop(baseParams({ llmClient: client, updater }));
    expectError(result);
    expect(result.error).toBeInstanceOf(ToolProtocolError);
    expect(result.history).toEqual([{ role: "user", content: "hi" }]);
    expect(updater.abortCount).toBe(1);
  });

  test("empty response (no content, no tool calls) with finish_reason stop -> error", async () => {
    const { client } = makeClient([scripted(final({ fullText: "", finishReason: "stop" }))]);
    const result = await runToolLoop(baseParams({ llmClient: client }));
    expectError(result);
    expect(result.error).toBeInstanceOf(ToolProtocolError);
  });

  test("unknown finish_reason -> error, never treated as an implicit completion", async () => {
    const { client } = makeClient([
      scripted(content("hmm"), final({ fullText: "hmm", finishReason: "some_unknown_value" })),
    ]);
    const result = await runToolLoop(baseParams({ llmClient: client }));
    expectError(result);
    expect(result.error).toBeInstanceOf(ToolProtocolError);
  });

  test("turn accumulation exceeding MAX_TURN_ACCUM_BYTES fails the turn", async () => {
    const huge = "x".repeat(MAX_TURN_ACCUM_BYTES + 1);
    const { client } = makeClient([
      scripted(content(huge), final({ fullText: huge, finishReason: "stop" })),
    ]);
    const updater = new RecordedUpdater();
    const result = await runToolLoop(baseParams({ llmClient: client, updater }));
    expectError(result);
    expect(result.error).toBeInstanceOf(ToolProtocolError);
    expect(updater.abortCount).toBe(1);
    expect(updater.commitCount).toBe(0);
  });

  test("byte ガードは蓄積・staging の前に評価される: 個々には上限未満でも合計で上限を跨ぐ2フレーム目は " +
    "stageContent に渡らない", async () => {
    // 1フレーム目だけでは上限未満、2フレーム目を足すと上限を超える。
    const firstLen = MAX_TURN_ACCUM_BYTES - 10;
    const first = "x".repeat(firstLen);
    const second = "y".repeat(20);
    const { client } = makeClient([
      scripted(
        content(first),
        content(second),
        final({ fullText: first + second, finishReason: "stop" }),
      ),
    ]);
    const updater = new RecordedUpdater();
    const result = await runToolLoop(baseParams({ llmClient: client, updater }));
    expectError(result);
    expect(result.error).toBeInstanceOf(ToolProtocolError);
    expect(updater.abortCount).toBe(1);
    expect(updater.commitCount).toBe(0);

    const stagedTexts = updater.events
      .filter((e) => e.startsWith("stageContent:"))
      .map((e) => e.slice("stageContent:".length));
    // 1フレーム目までは staged されている。
    expect(stagedTexts).toContain(first);
    // 2フレーム目（"y" を含む、上限超過を引き起こした断片）を含むテキストは一度も staged されない。
    expect(stagedTexts.some((s) => s.includes("y"))).toBe(false);
  }, 10_000);

  test("empty argumentsDelta fragments still charge a fixed per-fragment overhead, so fragment count alone can trip MAX_TURN_ACCUM_BYTES", async () => {
    const overflowCount = Math.floor(MAX_TURN_ACCUM_BYTES / TOOL_CALL_FRAGMENT_OVERHEAD_BYTES) + 2;
    const manyEmptyFragments: TurnScript = async function* () {
      for (let i = 0; i < overflowCount; i++) {
        yield toolCall({ index: 0, argumentsDelta: "" });
      }
      yield final({ fullText: "", finishReason: "tool_calls" });
    };
    const { client } = makeClient([manyEmptyFragments]);
    const updater = new RecordedUpdater();
    const result = await runToolLoop(baseParams({ llmClient: client, updater }));
    expectError(result);
    expect(result.error).toBeInstanceOf(ToolProtocolError);
    expect(updater.abortCount).toBe(1);
    expect(updater.commitCount).toBe(0);
  }, 10_000);

  test("empty argumentsDelta fragments are not pushed into the joined arguments (no observable effect on dispatch)", async () => {
    const registry = new ToolRegistry();
    const receivedArgs: unknown[] = [];
    registry.register(
      makeEchoTool({
        name: "t",
        handler: async (args) => {
          receivedArgs.push(args);
          return { llmResult: "ok" };
        },
      }),
    );
    const { client } = makeClient([
      scripted(
        toolCall({ index: 0, id: "c1", name: "t" }),
        toolCall({ index: 0, argumentsDelta: "" }),
        toolCall({ index: 0, argumentsDelta: "{}" }),
        toolCall({ index: 0, argumentsDelta: "" }),
        final({ fullText: "", finishReason: "tool_calls" }),
      ),
      scripted(content("done"), final({ fullText: "done", finishReason: "stop" })),
    ]);
    const result = await runToolLoop(baseParams({ llmClient: client, registry }));
    expectFinal(result);
    expect(receivedArgs).toEqual([{}]);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("runToolLoop: cancellation", () => {
  test("already aborted before the first request: no request is made, updater is never called", async () => {
    const { client, callCount } = makeClient([
      scripted(
        content("should not run"),
        final({ fullText: "should not run", finishReason: "stop" }),
      ),
    ]);
    const controller = new AbortController();
    controller.abort();
    const updater = new RecordedUpdater();
    const initialMessages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const result = await runToolLoop(
      baseParams({
        llmClient: client,
        updater,
        signal: controller.signal,
        messages: initialMessages,
      }),
    );

    expectCancelled(result);
    expect(callCount()).toBe(0);
    expect(updater.events).toEqual([]);
    expect(result.history).toEqual(initialMessages);
  });

  test("aborted mid-streaming: transport aborts, turn is aborted (not committed), status cancelled", async () => {
    const controller = new AbortController();
    const hangingTurn: TurnScript = async function* (_request, signal) {
      yield content("partial");
      await hangUntilAborted(signal); // hang until the signal aborts the fetch
    };
    const { client, callCount } = makeClient([hangingTurn]);

    setTimeout(() => controller.abort(), 15);

    const updater = new RecordedUpdater();
    const result = await runToolLoop(
      baseParams({
        llmClient: client,
        updater,
        signal: controller.signal,
        timeouts: FAST_TIMEOUTS,
      }),
    );

    expectCancelled(result);
    expect(result.history).toEqual([{ role: "user", content: "hi" }]);
    expect(updater.beginCount).toBe(1);
    expect(updater.abortCount).toBe(1);
    expect(updater.commitCount).toBe(0);
    expect(callCount()).toBe(1);
  });

  test("cancel priority over a simultaneous stream rejection", async () => {
    const controller = new AbortController();
    const rejectingTurn: TurnScript = async function* () {
      yield content("partial");
      controller.abort();
      throw new Error("transport boom (should be classified as cancel, not error)");
    };
    const { client } = makeClient([rejectingTurn]);

    const result = await runToolLoop(
      baseParams({ llmClient: client, signal: controller.signal, timeouts: FAST_TIMEOUTS }),
    );

    expectCancelled(result);
  });

  test(
    "cancel during dispatch: the in-flight call is cancelled, the not-yet-started call is filled in " +
      "as cancelled without ever being invoked, and no further model request is made",
    async () => {
      const controller = new AbortController();
      let bCalled = false;
      const registry = new ToolRegistry();
      registry.register(
        makeEchoTool({
          name: "call_a",
          timeoutMs: 60_000,
          handler: (_args, _ctx, signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        }),
      );
      registry.register(
        makeEchoTool({
          name: "call_b",
          handler: async () => {
            bCalled = true;
            return { llmResult: "should not run" };
          },
        }),
      );

      const { client, callCount } = makeClient([
        scripted(
          toolCall({ index: 0, id: "id_a", name: "call_a", argumentsDelta: "{}" }),
          toolCall({ index: 1, id: "id_b", name: "call_b", argumentsDelta: "{}" }),
          final({ fullText: "", finishReason: "tool_calls" }),
        ),
      ]);

      setTimeout(() => controller.abort(), 15);

      const updater = new RecordedUpdater();
      const result = await runToolLoop(
        baseParams({
          llmClient: client,
          registry,
          updater,
          signal: controller.signal,
          timeouts: FAST_TIMEOUTS,
        }),
      );

      expectCancelled(result);
      expect(bCalled).toBe(false);
      expect(callCount()).toBe(1); // no turn-2 model request

      const toolMsgs = result.history.filter((m) => m.role === "tool");
      expect(toolMsgs).toHaveLength(2);
      expect(
        toolMsgs[0] && "tool_call_id" in toolMsgs[0] ? toolMsgs[0].tool_call_id : undefined,
      ).toBe("id_a");
      expect(
        toolMsgs[1] && "tool_call_id" in toolMsgs[1] ? toolMsgs[1].tool_call_id : undefined,
      ).toBe("id_b");

      // assistant tool_calls message was already committed before dispatch began.
      expect(updater.commits).toEqual(["tool_calls"]);
    },
  );

  test(
    "already aborted + a registered tool's isEnabled() throws: buildTools() is never allowed " +
      "to surface as a rejection, status is cancelled (abort wins over the throw)",
    async () => {
      const registry = new ToolRegistry();
      registry.register(
        makeEchoTool({
          isEnabled: () => {
            throw new Error("boom:isEnabled");
          },
        }),
      );
      const { client, callCount } = makeClient([
        scripted(content("should not run"), final({ fullText: "x", finishReason: "stop" })),
      ]);
      const controller = new AbortController();
      controller.abort();
      const updater = new RecordedUpdater();
      const initialMessages: ChatMessage[] = [{ role: "user", content: "hi" }];

      const result = await runToolLoop(
        baseParams({
          llmClient: client,
          registry,
          updater,
          signal: controller.signal,
          messages: initialMessages,
        }),
      );

      expectCancelled(result);
      expect(callCount()).toBe(0);
      expect(updater.events).toEqual([]);
      expect(result.history).toEqual(initialMessages);
    },
  );

  test(
    "not aborted, a registered tool's isEnabled() throws during buildTools(): reported as " +
      "status:error (no rejection, no updater call — no turn was ever opened)",
    async () => {
      const registry = new ToolRegistry();
      const thrown = new Error("boom:isEnabled");
      registry.register(
        makeEchoTool({
          isEnabled: () => {
            throw thrown;
          },
        }),
      );
      const { client, callCount } = makeClient([
        scripted(content("should not run"), final({ fullText: "x", finishReason: "stop" })),
      ]);
      const updater = new RecordedUpdater();
      const initialMessages: ChatMessage[] = [{ role: "user", content: "hi" }];

      const result = await runToolLoop(
        baseParams({ llmClient: client, registry, updater, messages: initialMessages }),
      );

      expectError(result);
      expect(result.error).toBe(thrown);
      expect(callCount()).toBe(0);
      expect(updater.events).toEqual([]);
      expect(result.history).toEqual(initialMessages);
    },
  );

  test(
    "frozen tools のクローンに失敗する（parameters に非 clonable な値を含む）場合も " +
      "buildTools() throw と同じ status:error 経路になる（no rejection, no updater call）",
    async () => {
      const registry = new ToolRegistry();
      registry.register(
        makeEchoTool({
          parameters: {
            type: "object",
            // Functions are not structured-cloneable.
            notClonable: () => undefined,
          } as unknown as Record<string, unknown>,
        }),
      );
      const { client, callCount } = makeClient([
        scripted(content("should not run"), final({ fullText: "x", finishReason: "stop" })),
      ]);
      const updater = new RecordedUpdater();
      const initialMessages: ChatMessage[] = [{ role: "user", content: "hi" }];

      const result = await runToolLoop(
        baseParams({ llmClient: client, registry, updater, messages: initialMessages }),
      );

      expectError(result);
      expect(callCount()).toBe(0);
      expect(updater.events).toEqual([]);
      expect(result.history).toEqual(initialMessages);
    },
  );
});

// ---------------------------------------------------------------------------
// Updater robustness
// ---------------------------------------------------------------------------

describe("runToolLoop: updater robustness", () => {
  test("a throwing updater does not break protocol progression or the returned history", async () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool({ name: "t" }));
    const { client } = makeClient([
      scripted(
        toolCall({ index: 0, id: "c1", name: "t", argumentsDelta: "{}" }),
        final({ fullText: "", finishReason: "tool_calls" }),
      ),
      scripted(content("done"), final({ fullText: "done", finishReason: "stop" })),
    ]);
    const updater = new RecordedUpdater(
      new Set(["beginTurn", "stageContent", "commitTurn", "beginToolBlock", "endToolBlock"]),
    );
    const result = await runToolLoop(baseParams({ llmClient: client, registry, updater }));

    expectFinal(result);
    expect(result.text).toBe("done");
    expect(result.history).toHaveLength(4);
    expect(updater.beginCount).toBe(2);
    expect(updater.commitCount).toBe(2);
    expect(updater.abortCount).toBe(0);
  });

  test("a throwing abortTurn still lets the loop return the error result", async () => {
    const { client } = makeClient([scripted(final({ fullText: "", finishReason: "error" }))]);
    const updater = new RecordedUpdater(new Set(["abortTurn"]));
    const result = await runToolLoop(baseParams({ llmClient: client, updater }));
    expectError(result);
    expect(updater.abortCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Updater call bounded wait (never-resolving updater must not hang the loop)
// ---------------------------------------------------------------------------

/** An updater every one of whose methods returns a promise that never settles. */
class HangingUpdater implements IToolLoopUpdater {
  calls: string[] = [];
  beginTurn(): Promise<void> {
    this.calls.push("beginTurn");
    return new Promise(() => {});
  }
  stageContent(text: string): Promise<void> {
    this.calls.push(`stageContent:${text}`);
    return new Promise(() => {});
  }
  commitTurn(kind: "tool_calls" | "final"): Promise<void> {
    this.calls.push(`commitTurn:${kind}`);
    return new Promise(() => {});
  }
  abortTurn(reason: string): Promise<void> {
    this.calls.push(`abortTurn:${reason}`);
    return new Promise(() => {});
  }
  beginToolBlock(name: string): Promise<void> {
    this.calls.push(`beginToolBlock:${name}`);
    return new Promise(() => {});
  }
  endToolBlock(name: string): Promise<void> {
    this.calls.push(`endToolBlock:${name}`);
    return new Promise(() => {});
  }
}

describe("runToolLoop: updater call bounded wait", () => {
  test("a never-resolving updater does not block request cancellation from settling the loop", async () => {
    const controller = new AbortController();
    const hangingTurn: TurnScript = async function* (_request, signal) {
      yield content("partial");
      await hangUntilAborted(signal);
    };
    const { client } = makeClient([hangingTurn]);
    const updater = new HangingUpdater();
    setTimeout(() => controller.abort(), 15);

    const result = await runToolLoop(
      baseParams({
        llmClient: client,
        updater,
        signal: controller.signal,
        // Deliberately much larger than the test's own patience: if the
        // fix regresses (updater calls awaited unconditionally), this test
        // times out instead of the assertions failing cleanly.
        timeouts: { ...FAST_TIMEOUTS, updaterCallMs: 60_000 },
      }),
    );

    expectCancelled(result);
    expect(updater.calls).toContain("beginTurn");
  }, 3_000);

  test("a never-resolving updater does not block the stream's own wall-clock timeout from settling the loop", async () => {
    // biome-ignore lint/correctness/useYield: intentionally never yields — the wall timer aborts it first
    const neverSends: TurnScript = async function* (_request, signal) {
      await hangUntilAborted(signal);
    };
    const { client } = makeClient([neverSends]);
    const updater = new HangingUpdater();

    // No cancel signal at all: without the bounded-wait fix, the loop's
    // `await updater.beginTurn()` before runTurn() even starts would hang
    // forever, so the wall timer inside runTurn() would never get a chance
    // to fire. updaterCallMs is set well below wallMs so beginTurn's bounded
    // wait resolves first, letting the turn actually start and hit wallMs.
    const result = await runToolLoop(
      baseParams({
        llmClient: client,
        updater,
        timeouts: { idleMs: 5_000, wallMs: 60, updaterCallMs: 20 },
      }),
    );

    expectError(result);
    expect(updater.calls).toContain("beginTurn");
  }, 3_000);

  test("a never-resolving stageContent does not block onContent from returning, letting the stream keep draining", async () => {
    const { client } = makeClient([
      scripted(content("a"), content("b"), final({ fullText: "ab", finishReason: "stop" })),
    ]);
    const updater = new HangingUpdater();

    const result = await runToolLoop(
      baseParams({
        llmClient: client,
        updater,
        timeouts: { ...FAST_TIMEOUTS, updaterCallMs: 20 },
      }),
    );

    expectFinal(result);
    expect(result.text).toBe("ab");
    expect(updater.calls.filter((c) => c.startsWith("stageContent"))).toHaveLength(2);
  }, 3_000);
});

// ---------------------------------------------------------------------------
// Idle timeout
// ---------------------------------------------------------------------------

describe("runToolLoop: idle timeout", () => {
  test("no chunk arrives within the idle window -> status error", async () => {
    // biome-ignore lint/correctness/useYield: intentionally never yields — it hangs until the idle timer aborts it
    const neverSends: TurnScript = async function* (_request, signal) {
      await hangUntilAborted(signal); // never yields; the idle timer aborts it first
    };
    const { client } = makeClient([neverSends]);
    const updater = new RecordedUpdater();
    const result = await runToolLoop(
      baseParams({ llmClient: client, updater, timeouts: { idleMs: 30, wallMs: 5_000 } }),
    );
    expectError(result);
    expect(updater.abortCount).toBe(1);
  }, 2_000);
});

// ---------------------------------------------------------------------------
// Heartbeat chunks (SSE comment-line keep-alives, e.g. OpenRouter's
// `: OPENROUTER PROCESSING`): must reset the idle timer and must never be
// mistaken for content/tool_call data.
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runToolLoop: heartbeat", () => {
  test("heartbeat のみが続くストリームは、合計時間が idleMs を超えても timeout しない（heartbeat 間隔 < idleMs < 総時間）", async () => {
    const heartbeatOnly: TurnScript = async function* () {
      // 各 heartbeat の間隔 (15ms) は idleMs (50ms) より短いが、6 回分の合計時間
      // (90ms) は idleMs を超える。heartbeat が idle タイマーをリセットしていな
      // ければ、この合計時間だけで idle timeout が発火してしまう。
      for (let i = 0; i < 6; i++) {
        await delay(15);
        yield heartbeat();
      }
      yield content("hi");
      yield final({ fullText: "hi", finishReason: "stop" });
    };
    const { client } = makeClient([heartbeatOnly]);
    const updater = new RecordedUpdater();
    const result = await runToolLoop(
      baseParams({ llmClient: client, updater, timeouts: { idleMs: 50, wallMs: 5_000 } }),
    );
    expectFinal(result);
    expect(result.text).toBe("hi");
  }, 2_000);

  test("heartbeat チャンクは content / tool_call の蓄積に一切影響しない", async () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool());
    const { client } = makeClient([
      scripted(
        heartbeat(),
        content("Hel"),
        heartbeat(),
        content("lo"),
        heartbeat(),
        toolCall({ index: 0, id: "call-1", name: "echo_tool", argumentsDelta: "{}" }),
        heartbeat(),
        final({ fullText: "Hello", finishReason: "tool_calls" }),
      ),
      scripted(content("done"), final({ fullText: "done", finishReason: "stop" })),
    ]);
    const updater = new RecordedUpdater();
    const result = await runToolLoop(
      baseParams({
        llmClient: client,
        updater,
        registry,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expectFinal(result);
    expect(result.text).toBe("done");
    // heartbeat が staged content に混入していないこと（1ターン目の累積は "Hel" →
    // "Hello" のみ。"done" は tool dispatch 後の2ターン目の内容）。
    expect(updater.events.filter((e) => e.startsWith("stageContent"))).toEqual([
      "stageContent:Hel",
      "stageContent:Hello",
      "stageContent:done",
    ]);
    // tool_call の結果も heartbeat に影響されず正常にディスパッチされている。
    const toolMessages = result.history.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]).toMatchObject({ tool_call_id: "call-1" });
  });
});

// ---------------------------------------------------------------------------
// Generator finalization: runTurn() must finalize the chatStream iterator on
// every exit path, so its own `finally` — which releases/cancels the
// underlying response body reader — actually runs.
// ---------------------------------------------------------------------------

/**
 * Wraps a `TurnScript` so a shared flag records whether the generator ever
 * ran its own `finally` block to completion — i.e. whether it was actually
 * finalized (via normal completion or an explicit `iterator.return()`), not
 * merely abandoned mid-suspension.
 */
function withFinalizeTracking(flag: { finalized: boolean }, script: TurnScript): TurnScript {
  return async function* (request, signal) {
    try {
      yield* script(request, signal);
    } finally {
      flag.finalized = true;
    }
  };
}

describe("runToolLoop: generator finalization", () => {
  test("completed (normal final result) finalizes the chatStream generator", async () => {
    const flag = { finalized: false };
    const { client } = makeClient([
      withFinalizeTracking(
        flag,
        scripted(content("hi"), final({ fullText: "hi", finishReason: "stop" })),
      ),
    ]);
    const result = await runToolLoop(baseParams({ llmClient: client }));
    expectFinal(result);
    expect(flag.finalized).toBe(true);
  });

  test("cancelled (request aborted mid-stream) finalizes the chatStream generator", async () => {
    const flag = { finalized: false };
    const controller = new AbortController();
    const hangingTurn: TurnScript = async function* (_request, signal) {
      yield content("partial");
      await hangUntilAborted(signal);
    };
    const { client } = makeClient([withFinalizeTracking(flag, hangingTurn)]);
    setTimeout(() => controller.abort(), 15);

    const result = await runToolLoop(
      baseParams({ llmClient: client, signal: controller.signal, timeouts: FAST_TIMEOUTS }),
    );
    expectCancelled(result);
    expect(flag.finalized).toBe(true);
  });

  test("timeout (idle) finalizes the chatStream generator", async () => {
    const flag = { finalized: false };
    // biome-ignore lint/correctness/useYield: intentionally never yields — it hangs until aborted
    const neverSends: TurnScript = async function* (_request, signal) {
      await hangUntilAborted(signal);
    };
    const { client } = makeClient([withFinalizeTracking(flag, neverSends)]);

    const result = await runToolLoop(
      baseParams({ llmClient: client, timeouts: { idleMs: 30, wallMs: 5_000 } }),
    );
    expectError(result);
    expect(flag.finalized).toBe(true);
  });

  test("transport-error (stream rejects) finalizes the chatStream generator", async () => {
    const flag = { finalized: false };
    const throwingTurn: TurnScript = async function* () {
      yield content("partial");
      throw new Error("transport boom");
    };
    const { client } = makeClient([withFinalizeTracking(flag, throwingTurn)]);

    const result = await runToolLoop(baseParams({ llmClient: client }));
    expectError(result);
    expect(flag.finalized).toBe(true);
  });

  test("guard-violation (hard cap exceeded) finalizes the chatStream generator", async () => {
    const flag = { finalized: false };
    const deltas = Array.from({ length: MAX_DISTINCT_TOOL_CALLS_HARD_CAP + 1 }, (_, i) =>
      toolCall({ index: i, id: `call_${i}`, name: "echo_tool", argumentsDelta: "{}" }),
    );
    const { client } = makeClient([
      withFinalizeTracking(
        flag,
        scripted(...deltas, final({ fullText: "", finishReason: "tool_calls" })),
      ),
    ]);

    const result = await runToolLoop(baseParams({ llmClient: client }));
    expectError(result);
    expect(flag.finalized).toBe(true);
  });

  test(
    "iterator.return() が settle しなくても ITERATOR_CLEANUP_TIMEOUT_MS で打ち切られ、ターン全体は settle する",
    async () => {
      const controller = new AbortController();
      // chatStream() の finally が壊れている/極端に遅いケース（reader.cancel() の
      // fire-and-forget 化が退行した場合など）を模す: 生成器自身の finally が
      // 永久に解決しない promise を await する。
      const hangingCleanupTurn: TurnScript = async function* (_request, signal) {
        try {
          yield content("partial");
          await hangUntilAborted(signal);
        } finally {
          await new Promise<never>(() => {});
        }
      };
      const { client } = makeClient([hangingCleanupTurn]);
      setTimeout(() => controller.abort(), 15);

      const start = Date.now();
      const result = await runToolLoop(
        baseParams({ llmClient: client, signal: controller.signal, timeouts: FAST_TIMEOUTS }),
      );
      const elapsedMs = Date.now() - start;

      expectCancelled(result);
      // ITERATOR_CLEANUP_TIMEOUT_MS で打ち切られる（iterator.return() の解決を無期限に待たない）。
      // 下限は「待たずに即座に返っていない」こと（打ち切りタイマーを実際に使っている）を確認し、
      // 上限は素の壁時計比較なので CI/ローカルの負荷変動を吸収できる余裕を大きめに取る。
      expect(elapsedMs).toBeGreaterThanOrEqual(ITERATOR_CLEANUP_TIMEOUT_MS - 1_000);
      expect(elapsedMs).toBeLessThan(ITERATOR_CLEANUP_TIMEOUT_MS + 10_000);
    },
    ITERATOR_CLEANUP_TIMEOUT_MS + 15_000,
  );
});

// ---------------------------------------------------------------------------
// A cancel landing during runTurn()'s post-terminal-yield cleanup (the
// `boundedIteratorReturn` await in its `finally`) must still end the turn as
// cancelled, even though the turn was already internally `kind:"completed"`
// by the time that cleanup started.
// ---------------------------------------------------------------------------

describe("runToolLoop: cancel during post-terminal cleanup", () => {
  test("terminal yield 後、runTurn() の cleanup 完了前に cancel されると status:cancelled になり、commitTurn は呼ばれない", async () => {
    const controller = new AbortController();
    const cleanupGate = deferred<void>();

    // finishReason:"stop" を yield した直後（runTurn() が既に kind:"completed" を internally
    // 確定させた後）、生成器自身の finally が cleanupGate の resolve まで解決しない状況を作る。
    // これにより runTurn() の boundedIteratorReturn がその finally の完了待ちで足止めされる。
    const terminalThenHangingCleanup: TurnScript = async function* () {
      try {
        yield content("hi");
        yield final({ fullText: "hi", finishReason: "stop", usage: usage1(1) });
      } finally {
        await cleanupGate.promise;
      }
    };
    const { client } = makeClient([terminalThenHangingCleanup]);
    const updater = new RecordedUpdater();

    const resultPromise = runToolLoop(
      baseParams({ llmClient: client, updater, signal: controller.signal }),
    );

    // cleanup が完了するより先に abort する（= terminal 決定後・cleanup 中の cancel を模す）。
    setTimeout(() => controller.abort(), 10);
    setTimeout(() => cleanupGate.resolve(), 30);

    const result = await resultPromise;

    expectCancelled(result);
    // "final" は一度も commit されない（stop ボタンが成功を返した以上、確定応答を返してはならない）。
    expect(updater.commits).not.toContain("final");
    expect(updater.abortCount).toBeGreaterThan(0);
    // terminal chunk（usage 付き）は cleanup 中の cancel より前に既に受領済みなので、
    // このターンの usage は cancelled の結果にも含まれなければならない（turn 1 なので
    // 集計 = このターン単独の usage と一致する）。
    expect(result.usage).toEqual(usage1(1));
  });
});

// ---------------------------------------------------------------------------
// Cancel arriving while an updater call's own bounded wait is still pending
// (as opposed to a cancel that arrives before the wait even starts, which
// the existing "no updater call is made" / pre-turn checks already cover).
// ---------------------------------------------------------------------------

describe("runToolLoop: cancel while beginTurn()'s bounded wait is pending", () => {
  test("beginTurn の待機中に abort されると chatStream は呼ばれず、abortTurn 経由で cancelled になる", async () => {
    const controller = new AbortController();
    const beginGate = deferred<void>();

    class DeferredBeginUpdater implements IToolLoopUpdater {
      beginCount = 0;
      abortCount = 0;
      beginTurn(): Promise<void> {
        this.beginCount++;
        return beginGate.promise; // never resolves within this test
      }
      stageContent(): void {}
      commitTurn(): void {}
      abortTurn(): void {
        this.abortCount++;
      }
      beginToolBlock(): void {}
      endToolBlock(): void {}
    }
    const updater = new DeferredBeginUpdater();

    const { client, callCount } = makeClient([
      scripted(
        content("should not run"),
        final({ fullText: "should not run", finishReason: "stop" }),
      ),
    ]);

    const resultPromise = runToolLoop(
      baseParams({
        llmClient: client,
        updater,
        signal: controller.signal,
        timeouts: FAST_TIMEOUTS,
      }),
    );

    setTimeout(() => controller.abort(), 10);

    const result = await resultPromise;

    expectCancelled(result);
    // beginTurn() was already called (so its turn must be closed via abortTurn), but
    // chatStream() itself is never reached: the turn is decided cancelled before that.
    expect(callCount()).toBe(0);
    expect(updater.beginCount).toBe(1);
    expect(updater.abortCount).toBe(1);
  });
});

describe('runToolLoop: cancel while commitTurn("final")\'s bounded wait is pending', () => {
  test('commitTurn("final") の待機中に abort されると、abortTurn を呼ばずに cancelled を返す', async () => {
    const controller = new AbortController();
    const commitGate = deferred<void>();

    class DeferredCommitUpdater implements IToolLoopUpdater {
      commitCount = 0;
      abortCount = 0;
      beginTurn(): void {}
      stageContent(): void {}
      commitTurn(kind: "tool_calls" | "final"): void | Promise<void> {
        this.commitCount++;
        if (kind === "final") {
          return commitGate.promise; // never resolves within this test
        }
      }
      abortTurn(): void {
        this.abortCount++;
      }
      beginToolBlock(): void {}
      endToolBlock(): void {}
    }
    const updater = new DeferredCommitUpdater();

    const { client, callCount } = makeClient([
      scripted(content("hi"), final({ fullText: "hi", finishReason: "stop" })),
    ]);

    const resultPromise = runToolLoop(
      baseParams({
        llmClient: client,
        updater,
        signal: controller.signal,
        timeouts: FAST_TIMEOUTS,
      }),
    );

    setTimeout(() => controller.abort(), 10);

    const result = await resultPromise;

    expectCancelled(result);
    // commitTurn("final") is the turn's terminal decision (already made exactly once);
    // abortTurn() must not additionally be called for the same turn.
    expect(updater.commitCount).toBe(1);
    expect(updater.abortCount).toBe(0);
    // No second model request was made after the (only) turn's stream completed.
    expect(callCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cancel arriving while an error/timeout/guard-violation/protocol-error
// branch's decideAbort() (i.e. abortTurn()'s bounded wait) is still pending.
// abortTurn() itself is always invoked exactly once (invokeUpdater()'s bound
// only cuts the `await`, never the call), so a cancel observed here must not
// additionally decide "error" on top of a stop that already succeeded.
// ---------------------------------------------------------------------------

describe("runToolLoop: cancel while an error-branch's abortTurn() is pending", () => {
  /** An updater whose abortTurn() hangs on `gate` and records how many times it was invoked. */
  class DeferredAbortUpdater implements IToolLoopUpdater {
    abortCount = 0;
    commitCount = 0;
    constructor(private readonly gate: { promise: Promise<void> }) {}
    beginTurn(): void {}
    stageContent(): void {}
    commitTurn(): void {
      this.commitCount++;
    }
    abortTurn(): Promise<void> {
      this.abortCount++;
      return this.gate.promise; // never resolves within this test
    }
    beginToolBlock(): void {}
    endToolBlock(): void {}
  }

  test("timeout 分岐: abortTurn 待機中に abort されると status:error ではなく cancelled になる", async () => {
    const controller = new AbortController();
    const gate = deferred<void>();
    const updater = new DeferredAbortUpdater(gate);

    // biome-ignore lint/correctness/useYield: intentionally never yields — the idle timer fires first
    const neverSends: TurnScript = async function* (_request, signal) {
      await hangUntilAborted(signal);
    };
    const { client } = makeClient([neverSends]);

    const resultPromise = runToolLoop(
      baseParams({
        llmClient: client,
        updater,
        signal: controller.signal,
        timeouts: { idleMs: 20, wallMs: 5_000 },
      }),
    );

    // Comfortably after the idle timeout (20ms) so `turnResult.kind` is
    // already decided as "timeout" (not "cancelled") by the time abort()
    // fires — this test targets the timeout branch's own decideAbort() recheck.
    setTimeout(() => controller.abort(), 150);

    const result = await resultPromise;

    expectCancelled(result);
    expect(updater.abortCount).toBe(1);
    expect(updater.commitCount).toBe(0);
  }, 3_000);

  test("guard-violation 分岐: abortTurn 待機中に abort されると cancelled になる", async () => {
    const controller = new AbortController();
    const gate = deferred<void>();
    const updater = new DeferredAbortUpdater(gate);

    const deltas = Array.from({ length: MAX_DISTINCT_TOOL_CALLS_HARD_CAP + 1 }, (_, i) =>
      toolCall({ index: i, id: `call_${i}`, name: "echo_tool", argumentsDelta: "{}" }),
    );
    const { client } = makeClient([
      scripted(...deltas, final({ fullText: "", finishReason: "tool_calls" })),
    ]);

    const resultPromise = runToolLoop(
      baseParams({
        llmClient: client,
        updater,
        signal: controller.signal,
        timeouts: FAST_TIMEOUTS,
      }),
    );

    setTimeout(() => controller.abort(), 10);

    const result = await resultPromise;

    expectCancelled(result);
    expect(updater.abortCount).toBe(1);
    expect(updater.commitCount).toBe(0);
  });

  test("protocol-error 分岐（unknown finish_reason）: abortTurn 待機中に abort されると cancelled になる", async () => {
    const controller = new AbortController();
    const gate = deferred<void>();
    const updater = new DeferredAbortUpdater(gate);

    const { client } = makeClient([
      scripted(content("hmm"), final({ fullText: "hmm", finishReason: "some_unknown_value" })),
    ]);

    const resultPromise = runToolLoop(
      baseParams({
        llmClient: client,
        updater,
        signal: controller.signal,
        timeouts: FAST_TIMEOUTS,
      }),
    );

    setTimeout(() => controller.abort(), 10);

    const result = await resultPromise;

    expectCancelled(result);
    expect(updater.abortCount).toBe(1);
    expect(updater.commitCount).toBe(0);
  });

  test('finish_reason "error" 分岐: abortTurn 待機中に abort されると cancelled になる', async () => {
    const controller = new AbortController();
    const gate = deferred<void>();
    const updater = new DeferredAbortUpdater(gate);

    const { client } = makeClient([scripted(final({ fullText: "", finishReason: "error" }))]);

    const resultPromise = runToolLoop(
      baseParams({
        llmClient: client,
        updater,
        signal: controller.signal,
        timeouts: FAST_TIMEOUTS,
      }),
    );

    setTimeout(() => controller.abort(), 10);

    const result = await resultPromise;

    expectCancelled(result);
    expect(updater.abortCount).toBe(1);
    expect(updater.commitCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// chatStream() throwing synchronously (e.g. an eager-validating client
// implementation, or a misbehaving mock) must not reject runToolLoop() —
// it must still be classified into a terminal ToolLoopResult, with the
// already-begun turn's commit/abort decision made exactly once.
// ---------------------------------------------------------------------------

describe("runToolLoop: chatStream() synchronous throw", () => {
  test("chatStream が同期 throw しても reject せず status:error を返し、abortTurn が1回呼ばれる", async () => {
    const updater = new RecordedUpdater();
    const throwingClient: ILLMClient = {
      chat: async () => {
        throw new Error("chat() is not used by the tool loop");
      },
      chatStream: () => {
        throw new Error("boom: synchronous chatStream() failure");
      },
      listModels: async () => [],
      listModelsWithPricing: async () => [],
      getCredits: async () => ({ remaining: 0 }),
      isRateLimited: () => false,
    };

    const result = await runToolLoop(baseParams({ llmClient: throwingClient, updater }));

    expectError(result);
    expect(updater.beginCount).toBe(1);
    expect(updater.abortCount).toBe(1);
    expect(updater.commitCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Usage aggregation
// ---------------------------------------------------------------------------

describe("runToolLoop: model/provider aggregation across turns", () => {
  test("turn1's model/provider survive to the result even though turn2 (the final turn) omits both", async () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool({ name: "t" }));
    const { client } = makeClient([
      scripted(
        toolCall({ index: 0, id: "c1", name: "t", argumentsDelta: "{}" }),
        final({ fullText: "", finishReason: "tool_calls", model: "m1", provider: "p1" }),
      ),
      scripted(
        // Turn 2 is the final turn and never reports model/provider (e.g. a
        // usage-only trailer or a provider that only sends it on some turns).
        content("done"),
        final({ fullText: "done", finishReason: "stop", model: undefined, provider: undefined }),
      ),
    ]);
    const result = await runToolLoop(baseParams({ llmClient: client, registry }));
    expectFinal(result);
    expect(result.model).toBe("m1");
    expect(result.provider).toBe("p1");
  });

  test("a later turn's model/provider overrides an earlier turn's when both are present", async () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool({ name: "t" }));
    const { client } = makeClient([
      scripted(
        toolCall({ index: 0, id: "c1", name: "t", argumentsDelta: "{}" }),
        final({ fullText: "", finishReason: "tool_calls", model: "m1", provider: "p1" }),
      ),
      scripted(
        content("done"),
        final({ fullText: "done", finishReason: "stop", model: "m2", provider: "p2" }),
      ),
    ]);
    const result = await runToolLoop(baseParams({ llmClient: client, registry }));
    expectFinal(result);
    expect(result.model).toBe("m2");
    expect(result.provider).toBe("p2");
  });
});

describe("runToolLoop: usage aggregation", () => {
  test("sums numeric fields and optional sub-fields across turns", async () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool({ name: "t" }));
    const { client } = makeClient([
      scripted(
        toolCall({ index: 0, id: "c1", name: "t", argumentsDelta: "{}" }),
        final({
          fullText: "",
          finishReason: "tool_calls",
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            cost: 0.01,
            prompt_tokens_details: { cached_tokens: 2 },
          },
        }),
      ),
      scripted(
        content("done"),
        final({
          fullText: "done",
          finishReason: "stop",
          usage: {
            prompt_tokens: 20,
            completion_tokens: 8,
            total_tokens: 28,
            cost: 0.02,
            completion_tokens_details: { reasoning_tokens: 3 },
          },
        }),
      ),
    ]);
    const result = await runToolLoop(baseParams({ llmClient: client, registry }));
    expectFinal(result);
    expect(result.usage).toEqual({
      prompt_tokens: 30,
      completion_tokens: 13,
      total_tokens: 43,
      cost: 0.03,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 3 },
    });
  });

  test("returns partial usage on cancellation", async () => {
    const controller = new AbortController();
    const registry = new ToolRegistry();
    registry.register(
      makeEchoTool({
        name: "t",
        handler: () => new Promise(() => {}),
      }),
    );
    const { client } = makeClient([
      scripted(
        toolCall({ index: 0, id: "c1", name: "t", argumentsDelta: "{}" }),
        final({ fullText: "", finishReason: "tool_calls", usage: usage1(5) }),
      ),
    ]);
    setTimeout(() => controller.abort(), 15);
    const result = await runToolLoop(
      baseParams({
        llmClient: client,
        registry,
        signal: controller.signal,
        timeouts: FAST_TIMEOUTS,
      }),
    );
    expectCancelled(result);
    expect(result.usage).toEqual({ prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 });
  });

  test("巨大な cost 値を2ターン集計しても非有限値にならない（オーバーフローは警告のうえ加算前の値を維持）", async () => {
    // cost は token 系フィールドと異なり Number.isSafeInteger を要求しない
    // （金額は端数を持ちうる）ので、ここでは Number.MAX_VALUE のような真の
    // オーバーフロー（合計が Infinity になる）ケースを引き続き cost 単独で検証する。
    // token 系フィールドは1ターン分の値としても Number.MAX_VALUE 自体が safe
    // integer ではなくなる（＝そもそも単一チャンクとしてあり得ない値になる）ため、
    // ここでは現実的な safe integer を使い、通常どおり加算されることだけを確認する
    // （token 側の unsafe-integer オーバーフローは別テストで検証する）。
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new ToolRegistry();
      registry.register(makeEchoTool({ name: "t" }));
      const huge = Number.MAX_VALUE;
      const { client } = makeClient([
        scripted(
          toolCall({ index: 0, id: "c1", name: "t", argumentsDelta: "{}" }),
          final({
            fullText: "",
            finishReason: "tool_calls",
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cost: huge },
          }),
        ),
        scripted(
          content("done"),
          final({
            fullText: "done",
            finishReason: "stop",
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cost: huge },
          }),
        ),
      ]);
      const result = await runToolLoop(baseParams({ llmClient: client, registry }));
      expectFinal(result);
      expect(result.usage).toBeDefined();
      expect(Number.isFinite(result.usage?.cost)).toBe(true);
      // 加算結果 (huge + huge) が非有限になる場合、加算前の値（1ターン目の huge）を維持する。
      expect(result.usage?.cost).toBe(huge);
      // token 系フィールドは cost のオーバーフローとは独立して通常どおり加算される。
      expect(result.usage?.prompt_tokens).toBe(20);
      expect(result.usage?.total_tokens).toBe(22);
      expect(result.usage?.completion_tokens).toBe(2);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("MAX_SAFE_INTEGER と 2 の2ターン集計は非有限ではないが unsafe integer になる: 加算前の値を維持し警告する", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new ToolRegistry();
      registry.register(makeEchoTool({ name: "t" }));
      const { client } = makeClient([
        scripted(
          toolCall({ index: 0, id: "c1", name: "t", argumentsDelta: "{}" }),
          final({
            fullText: "",
            finishReason: "tool_calls",
            usage: {
              prompt_tokens: Number.MAX_SAFE_INTEGER,
              completion_tokens: 1,
              total_tokens: Number.MAX_SAFE_INTEGER,
            },
          }),
        ),
        scripted(
          content("done"),
          final({
            fullText: "done",
            finishReason: "stop",
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 2 },
          }),
        ),
      ]);
      const result = await runToolLoop(baseParams({ llmClient: client, registry }));
      expectFinal(result);
      expect(result.usage).toBeDefined();
      // 合計 (MAX_SAFE_INTEGER + 2) は Number.isFinite では true になるが、
      // Number.isSafeInteger では false になる — その unsafe な合計を許してしまう
      // と正確な整数表現でなくなるので、加算前の値（1ターン目の MAX_SAFE_INTEGER）を維持する。
      expect(Number.isFinite(result.usage?.prompt_tokens)).toBe(true);
      expect(Number.isSafeInteger(result.usage?.prompt_tokens)).toBe(true);
      expect(result.usage?.prompt_tokens).toBe(Number.MAX_SAFE_INTEGER);
      expect(result.usage?.total_tokens).toBe(Number.MAX_SAFE_INTEGER);
      // completion_tokens は unsafe にならないので通常どおり加算される。
      expect(result.usage?.completion_tokens).toBe(2);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: real OpenRouterClient (raw SSE over a mocked fetch) driven by
// runToolLoop. Unlike every test above — which drives runToolLoop against a
// hand-scripted ILLMClient that already speaks the loop's internal chunk
// types — these exercise the actual wire-parsing generator in
// `openrouter.ts` too, which is the only way to catch a defect at the
// boundary between the two (e.g. a chatStream() frame that silently yields
// nothing, or a parser throw racing a cancel).
// ---------------------------------------------------------------------------

/** Builds a raw SSE `data:` event line (including the trailing blank-line terminator). */
function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Mocks `globalThis.fetch` to resolve with a single streaming response built
 * from `steps`, each chunk enqueued only after its paired `delayMs` (default
 * 0) elapses. Real wall-clock gaps between chunks are the only way to
 * exercise the tool loop's idle-timeout race against a genuine `chatStream()`
 * generator (as opposed to a hand-scripted one that yields synchronously).
 */
function mockDelayedSseFetch(steps: { data: string; delayMs?: number }[]): void {
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const step of steps) {
        if (step.delayMs) await delay(step.delayMs);
        controller.enqueue(encoder.encode(step.data));
      }
      controller.close();
    },
  });
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(readable, { status: 200 })),
  ) as unknown as typeof fetch;
}

describe("runToolLoop + real OpenRouterClient: heartbeat-less frames must not idle-timeout", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("reasoning-only 風フレームが idleMs より短い間隔で連続しても、合計時間が idleMs を超えて timeout しない", async () => {
    // 各フレームの間隔 (12ms) は idleMs (30ms) より短いが、5 回分の合計時間
    // (60ms) は idleMs を超える。reasoning-only delta が heartbeat として
    // yield されていなければ、この合計時間だけで idle timeout が発火する。
    mockDelayedSseFetch([
      ...Array.from({ length: 5 }, () => ({
        data: sseLine({ choices: [{ delta: { reasoning: "thinking..." } }] }),
        delayMs: 12,
      })),
      { data: sseLine({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }) },
      { data: "data: [DONE]\n\n" },
    ]);

    const client = new OpenRouterClient("test-api-key");
    const result = await runToolLoop(
      baseParams({ llmClient: client, timeouts: { idleMs: 30, wallMs: 5_000 } }),
    );
    expectFinal(result);
    expect(result.text).toBe("hi");
  }, 2_000);

  test("usage-only トレーラーの到着が遅れても、直前フレームからの単一ギャップが idleMs 未満なら timeout しない", async () => {
    // 1フレーム目 (content+finish_reason) の直後に十分な間隔をおいてから
    // usage トレーラーが届く。usage トレーラー自体が何も yield しなければ、
    // 「1フレーム目 → [DONE]」の合計ギャップだけで idle timeout が発火する
    // （usage トレーラー到着時点でタイマーがリセットされないため）。
    mockDelayedSseFetch([
      { data: sseLine({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }) },
      {
        data: sseLine({
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        delayMs: 15,
      },
      { data: "data: [DONE]\n\n", delayMs: 15 },
    ]);

    const client = new OpenRouterClient("test-api-key");
    const result = await runToolLoop(
      baseParams({ llmClient: client, timeouts: { idleMs: 20, wallMs: 5_000 } }),
    );
    expectFinal(result);
    expect(result.text).toBe("hi");
    expect(result.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  }, 2_000);

  test("finish_reason だけの terminal フレーム後、[DONE] の到着が遅れても timeout しない", async () => {
    // content フレームと finish_reason-only フレームを分離する: finish_reason
    // だけのフレームは自身では何も yield しなければ、その後の [DONE] 遅延と
    // 合算した時間だけで idle timeout が発火してしまう。
    mockDelayedSseFetch([
      { data: sseLine({ choices: [{ delta: { content: "hi" } }] }) },
      { data: sseLine({ choices: [{ delta: {}, finish_reason: "stop" }] }), delayMs: 10 },
      { data: "data: [DONE]\n\n", delayMs: 15 },
    ]);

    const client = new OpenRouterClient("test-api-key");
    const result = await runToolLoop(
      baseParams({ llmClient: client, timeouts: { idleMs: 20, wallMs: 5_000 } }),
    );
    expectFinal(result);
    expect(result.text).toBe("hi");
  }, 2_000);
});

describe("runToolLoop + real OpenRouterClient: malformed frame vs. cancel", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("malformed フレームに到達し、cancel されない場合は status:error（StreamProtocolError 由来）", async () => {
    mockDelayedSseFetch([
      { data: sseLine({ choices: [{ delta: { content: "partial" } }] }) },
      { data: "data: {not valid json\n\n", delayMs: 10 },
    ]);

    const client = new OpenRouterClient("test-api-key");
    const result = await runToolLoop(
      baseParams({ llmClient: client, timeouts: { idleMs: 2_000, wallMs: 5_000 } }),
    );
    expectError(result);
    expect(result.error).toBeInstanceOf(StreamProtocolError);
  }, 2_000);

  test("malformed フレームに到達する前に request signal が abort されると status:cancelled（cancel 優先）", async () => {
    // malformed フレームの到着 (30ms 後) より先に abort する (10ms 後)。cancel が
    // parser エラーより優先されることを実クライアント越しに確認する。
    mockDelayedSseFetch([
      { data: sseLine({ choices: [{ delta: { content: "partial" } }] }) },
      { data: "data: {not valid json\n\n", delayMs: 30 },
    ]);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const client = new OpenRouterClient("test-api-key");
    const result = await runToolLoop(
      baseParams({
        llmClient: client,
        signal: controller.signal,
        timeouts: { idleMs: 2_000, wallMs: 5_000 },
      }),
    );
    expectCancelled(result);
  }, 2_000);

  test("malformed バイトの enqueue と abort() が同一コールバック内で「enqueue → abort」の順に実行されても cancelled が優先される", async () => {
    // 30ms/10ms のように離れたタイミングではなく、同一コールバック内で両方を
    // 実行することで、parser のエラー化と cancel が同じマイクロタスクのまとまりで
    // 同時に settle するケース（コード上のコメントが言う "same microtask batch"）を
    // 直接再現する。
    const encoder = new TextEncoder();
    const controller = new AbortController();
    const readable = new ReadableStream<Uint8Array>({
      start(rc) {
        rc.enqueue(encoder.encode(sseLine({ choices: [{ delta: { content: "partial" } }] })));
        setTimeout(() => {
          rc.enqueue(encoder.encode("data: {not valid json\n\n"));
          controller.abort();
        }, 10);
      },
    });
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(readable, { status: 200 })),
    ) as unknown as typeof fetch;

    const client = new OpenRouterClient("test-api-key");
    const result = await runToolLoop(
      baseParams({
        llmClient: client,
        signal: controller.signal,
        timeouts: { idleMs: 2_000, wallMs: 5_000 },
      }),
    );
    expectCancelled(result);
  }, 2_000);

  test("malformed バイトの enqueue と abort() が同一コールバック内で「abort → enqueue」の順に実行されても cancelled が優先される", async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    const readable = new ReadableStream<Uint8Array>({
      start(rc) {
        rc.enqueue(encoder.encode(sseLine({ choices: [{ delta: { content: "partial" } }] })));
        setTimeout(() => {
          controller.abort();
          rc.enqueue(encoder.encode("data: {not valid json\n\n"));
        }, 10);
      },
    });
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(readable, { status: 200 })),
    ) as unknown as typeof fetch;

    const client = new OpenRouterClient("test-api-key");
    const result = await runToolLoop(
      baseParams({
        llmClient: client,
        signal: controller.signal,
        timeouts: { idleMs: 2_000, wallMs: 5_000 },
      }),
    );
    expectCancelled(result);
  }, 2_000);
});

describe("runToolLoop + real OpenRouterClient: usage survives a post-heartbeat, pre-[DONE] early exit", () => {
  // OpenRouter sends the turn's usage on an empty-`choices` trailer chunk
  // immediately before `[DONE]` (`openrouter.ts` yields it as a heartbeat
  // carrying `usage`). These tests exercise the real wire-parsing generator
  // end to end to confirm that usage is not silently dropped when the turn
  // never reaches its terminal `StreamFinalResult` — a cancel or a malformed
  // frame arriving after that trailer but before `[DONE]` — and that a
  // normal completion still reports the usage exactly once (no double count
  // from also folding the heartbeat's `usage` into the `completed` path).
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("usage トレーラー受領後・[DONE] 前に abort されると、status:cancelled の usage にそのトレーラーの usage が反映される", async () => {
    mockDelayedSseFetch([
      { data: sseLine({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }) },
      { data: sseLine({ choices: [], usage: usage1(5) }), delayMs: 10 },
      { data: "data: [DONE]\n\n", delayMs: 30 },
    ]);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const client = new OpenRouterClient("test-api-key");
    const result = await runToolLoop(
      baseParams({
        llmClient: client,
        signal: controller.signal,
        timeouts: { idleMs: 2_000, wallMs: 5_000 },
      }),
    );
    expectCancelled(result);
    expect(result.usage).toEqual(usage1(5));
  }, 2_000);

  test("usage トレーラー受領後・[DONE] 前に malformed フレームが到達すると、status:error の usage にそのトレーラーの usage が反映される", async () => {
    mockDelayedSseFetch([
      { data: sseLine({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }) },
      { data: sseLine({ choices: [], usage: usage1(5) }) },
      { data: "data: {not valid json\n\n" },
    ]);

    const client = new OpenRouterClient("test-api-key");
    const result = await runToolLoop(
      baseParams({ llmClient: client, timeouts: { idleMs: 2_000, wallMs: 5_000 } }),
    );
    expectError(result);
    expect(result.error).toBeInstanceOf(StreamProtocolError);
    expect(result.usage).toEqual(usage1(5));
  }, 2_000);

  test("正常完了時は usage トレーラーの heartbeat usage と最終チャンクの usage が二重加算されない", async () => {
    mockDelayedSseFetch([
      { data: sseLine({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }) },
      { data: sseLine({ choices: [], usage: usage1(5) }) },
      { data: "data: [DONE]\n\n" },
    ]);

    const client = new OpenRouterClient("test-api-key");
    const result = await runToolLoop(
      baseParams({ llmClient: client, timeouts: { idleMs: 2_000, wallMs: 5_000 } }),
    );
    expectFinal(result);
    // Doubled would be { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }.
    expect(result.usage).toEqual(usage1(5));
  }, 2_000);
});

describe("runToolLoop + real OpenRouterClient: usage on a content-carrying frame survives an early exit", () => {
  // Unlike the block above (usage on its own empty-`choices` trailer frame),
  // these frames pair `content`/`usage` on the *same* frame — the shape
  // OpenRouter actually sends for a single-chunk-completion turn. Before the
  // fix, `processSseLine()` only attached `usage` to a heartbeat chunk when
  // the frame yielded *no* content/tool_call payload; a frame that yielded
  // both left its usage reachable only via `state.lastUsage`, which
  // `toolLoop.ts`'s early-exit paths (cancel/malformed-frame-after) never
  // read — so a cancel or malformed frame landing between this frame and
  // `[DONE]` silently dropped the turn's usage.
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("content+usage 併載フレーム受領後・[DONE] 前に abort されると、status:cancelled の usage にそのフレームの usage が反映される", async () => {
    mockDelayedSseFetch([
      {
        data: sseLine({
          choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
          usage: usage1(5),
        }),
      },
      { data: "data: [DONE]\n\n", delayMs: 30 },
    ]);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const client = new OpenRouterClient("test-api-key");
    const result = await runToolLoop(
      baseParams({
        llmClient: client,
        signal: controller.signal,
        timeouts: { idleMs: 2_000, wallMs: 5_000 },
      }),
    );
    expectCancelled(result);
    expect(result.usage).toEqual(usage1(5));
  }, 2_000);

  test("content+usage 併載フレーム受領後・[DONE] 前に malformed フレームが到達すると、status:error の usage にそのフレームの usage が反映される", async () => {
    mockDelayedSseFetch([
      {
        data: sseLine({
          choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
          usage: usage1(5),
        }),
      },
      { data: "data: {not valid json\n\n" },
    ]);

    const client = new OpenRouterClient("test-api-key");
    const result = await runToolLoop(
      baseParams({ llmClient: client, timeouts: { idleMs: 2_000, wallMs: 5_000 } }),
    );
    expectError(result);
    expect(result.error).toBeInstanceOf(StreamProtocolError);
    expect(result.usage).toEqual(usage1(5));
  }, 2_000);

  test("正常完了時は content+usage 併載フレームの heartbeat usage と最終チャンクの usage が二重加算されない", async () => {
    mockDelayedSseFetch([
      {
        data: sseLine({
          choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
          usage: usage1(5),
        }),
      },
      { data: "data: [DONE]\n\n" },
    ]);

    const client = new OpenRouterClient("test-api-key");
    const result = await runToolLoop(
      baseParams({ llmClient: client, timeouts: { idleMs: 2_000, wallMs: 5_000 } }),
    );
    expectFinal(result);
    // Doubled would be { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }.
    expect(result.usage).toEqual(usage1(5));
  }, 2_000);
});
