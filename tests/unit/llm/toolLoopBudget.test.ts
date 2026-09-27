import { describe, expect, mock, test } from "bun:test";
import { BadRequestError, ContextLengthExceededError } from "../../../src/errors";
import { estimateToolResultTokens, MESSAGE_OVERHEAD_TOKENS } from "../../../src/llm/contextBudget";
import type { ILLMClient } from "../../../src/llm/openrouter";
import type { IToolLoopParams, IToolLoopUpdater } from "../../../src/llm/toolLoop";
import { FINISHING_RESERVE_TOKENS, runToolLoop } from "../../../src/llm/toolLoop";
import type { IClientTool, IToolContext } from "../../../src/llm/tools/registry";
import { ToolRegistry } from "../../../src/llm/tools/registry";
import type {
  ChatCompletionRequest,
  StreamChunk,
  StreamFinalResult,
  StreamToolCallChunk,
  ToolChatMessage,
} from "../../../src/types";

type StreamYield = StreamChunk | StreamToolCallChunk | StreamFinalResult;
type TurnScript = () => AsyncGenerator<StreamYield, void, void>;

const ctx: IToolContext = { guildId: "g1", channelId: "c1", userId: "u1" };

function scripted(...chunks: StreamYield[]): TurnScript {
  return async function* () {
    for (const chunk of chunks) yield chunk;
  };
}

function failing(error: Error): TurnScript {
  return async function* () {
    yield* [];
    throw error;
  };
}

function callTurn(...names: string[]): TurnScript {
  return scripted(
    ...names.map(
      (name, index): StreamToolCallChunk => ({
        toolCall: { index, id: `call-${index}-${name}`, name, argumentsDelta: "{}" },
        done: false,
      }),
    ),
    { done: true, fullText: "", finishReason: "tool_calls" },
  );
}

function answer(text: string): TurnScript {
  return scripted(
    { content: text, done: false },
    { done: true, fullText: text, finishReason: "stop" },
  );
}

/** A turn sent with tool_choice "none" whose model still calls a tool after writing text. */
function disobey(text: string, name: string): TurnScript {
  return scripted(
    { content: text, done: false },
    { toolCall: { index: 0, id: "ignored", name, argumentsDelta: "{}" }, done: false },
    { done: true, fullText: text, finishReason: "tool_calls" },
  );
}

function makeClient(scripts: TurnScript[]): {
  client: ILLMClient;
  requests: ChatCompletionRequest[];
} {
  const requests: ChatCompletionRequest[] = [];
  let index = 0;
  const client: ILLMClient = {
    chat: async () => {
      throw new Error("unused");
    },
    chatStream: (request) => {
      requests.push(structuredClone(request));
      const script = scripts[index++];
      if (!script) throw new Error(`no scripted turn #${index}`);
      return script();
    },
    listModels: async () => [],
    listModelsWithPricing: async () => [],
    getCredits: async () => ({ remaining: 0 }),
    isRateLimited: () => false,
  };
  return { client, requests };
}

function updater(): IToolLoopUpdater & { aborts: string[] } {
  const aborts: string[] = [];
  return {
    aborts,
    beginTurn: () => {},
    stageContent: () => {},
    commitTurn: () => {},
    abortTurn: (reason) => {
      aborts.push(reason);
    },
    beginToolBlock: () => {},
    endToolBlock: () => {},
  };
}

function tool(name: string, handler: IClientTool["handler"]): IClientTool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    isEnabled: () => true,
    validate: (args) => ({ ok: true, value: args }),
    handler,
  };
}

function params(
  client: ILLMClient,
  tools: IClientTool[],
  overrides: Partial<IToolLoopParams> = {},
): IToolLoopParams {
  const registry = new ToolRegistry();
  for (const entry of tools) registry.register(entry);
  return {
    llmClient: client,
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
    registry,
    ctx,
    updater: updater(),
    requestId: "req-1",
    timeouts: { idleMs: 2_000, wallMs: 5_000 },
    ...overrides,
  };
}

/** Text whose tool message is estimated at exactly `tokens`. */
function textOfTokens(tokens: number): string {
  return "x".repeat(Math.max(0, tokens - MESSAGE_OVERHEAD_TOKENS) * 4);
}

const toolMessages = (history: readonly { role: string }[]): ToolChatMessage[] =>
  history.filter((message): message is ToolChatMessage => message.role === "tool");

describe("runToolLoop context budget", () => {
  test("does not offer client tools when the context leaves no room for the finishing reserve", async () => {
    const { client, requests } = makeClient([answer("done")]);
    const handler = mock(async () => ({ llmResult: "unused" }));

    const result = await runToolLoop(
      params(client, [tool("probe", handler)], {
        contextLength: 8_000,
        requestFields: { max_output_tokens: 2_000 },
      }),
    );

    expect(result.status).toBe("final");
    expect(requests[0]?.tools).toBeUndefined();
    expect(requests[0]?.tool_choice).toBeUndefined();
  });

  test("hands each call the budget left above the reserve, accepts a terminal result once it is gone, and then answers without tools", async () => {
    const budgets: number[] = [];
    const probe = tool("probe", async (_args, toolCtx) => {
      const budget = toolCtx.resultBudgetTokens ?? Number.NaN;
      budgets.push(budget);
      return budget > 0
        ? { llmResult: textOfTokens(budget) }
        : { llmResult: '{"messages":[],"has_more":true}', terminal: true };
    });
    const { client, requests } = makeClient([
      callTurn("probe"),
      callTurn("probe"),
      disobey("final text", "probe"),
    ]);

    const result = await runToolLoop(
      params(client, [probe], {
        contextLength: 30_000,
        requestFields: { max_output_tokens: 1_000 },
      }),
    );

    expect(result.status).toBe("final");
    if (result.status === "final") expect(result.text).toBe("final text");
    expect(budgets).toHaveLength(2);
    expect(budgets[0]).toBeGreaterThan(1_000);
    expect(budgets[1]).toBe(0);
    const results = toolMessages(result.history);
    expect(estimateToolResultTokens(results[0]?.content ?? "")).toBe(budgets[0] as number);
    expect(results[1]?.content).toBe('{"messages":[],"has_more":true}');
    expect(requests.map((request) => request.tool_choice)).toEqual(["auto", "auto", "none"]);
  });

  test("result_too_large stops the other calls of the turn and the next turn has no tools", async () => {
    const later = mock(async () => ({ llmResult: "later" }));
    const big = tool("big", async (_args, toolCtx) => ({
      llmResult: textOfTokens((toolCtx.resultBudgetTokens ?? 0) + 50),
    }));
    const { client, requests } = makeClient([
      callTurn("big", "later"),
      disobey("answer anyway", "later"),
    ]);

    const result = await runToolLoop(
      params(client, [big, tool("later", later)], {
        contextLength: 30_000,
        requestFields: { max_output_tokens: 1_000 },
      }),
    );

    expect(result.status).toBe("final");
    const [first, second] = toolMessages(result.history);
    expect(JSON.parse(first?.content as string)).toMatchObject({ error: "result_too_large" });
    expect(second?.content).toBe('{"error":"client_tools_stopped","reason":"result_too_large"}');
    expect(later).not.toHaveBeenCalled();
    expect(requests[1]?.tool_choice).toBe("none");
  });

  test("passes a result longer than 16 KiB to the next request whole", async () => {
    const json = JSON.stringify({ messages: [{ text: "y".repeat(20_000) }] });
    const { client, requests } = makeClient([callTurn("big"), answer("ok")]);

    const result = await runToolLoop(
      params(client, [tool("big", async () => ({ llmResult: json }))], {
        contextLength: 200_000,
      }),
    );

    expect(result.status).toBe("final");
    const sent = requests[1]?.messages.find((message) => message.role === "tool");
    expect(sent?.content).toBe(json);
  });

  test("reserves the finishing reserve out of every tool's budget", async () => {
    const budgets: number[] = [];
    const { client } = makeClient([callTurn("probe"), answer("ok")]);
    await runToolLoop(
      params(
        client,
        [
          tool("probe", async (_args, toolCtx) => {
            budgets.push(toolCtx.resultBudgetTokens ?? Number.NaN);
            return { llmResult: "small" };
          }),
        ],
        { contextLength: 100_000, requestFields: { max_output_tokens: 4_000 } },
      ),
    );
    const upperBound = Math.floor((100_000 - 4_000) * 0.75) - FINISHING_RESERVE_TOKENS;
    expect(budgets[0]).toBeLessThan(upperBound);
    expect(budgets[0]).toBeGreaterThan(upperBound - 200);
  });
});

describe("runToolLoop context overflow recovery", () => {
  const probe = (): IClientTool => tool("probe", async () => ({ llmResult: "large result" }));

  test("replaces the last tool results and answers once without tools", async () => {
    const loopUpdater = updater();
    const { client, requests } = makeClient([
      callTurn("probe"),
      failing(new ContextLengthExceededError("too long")),
      answer("recovered"),
    ]);

    const result = await runToolLoop(params(client, [probe()], { updater: loopUpdater }));

    expect(result.status).toBe("final");
    if (result.status === "final") expect(result.text).toBe("recovered");
    expect(requests).toHaveLength(3);
    expect(requests[2]?.tool_choice).toBe("none");
    const sent = requests[2]?.messages.filter((message) => message.role === "tool");
    expect(sent?.map((message) => message.content)).toEqual([
      '{"error":"result_dropped","reason":"context_overflow"}',
    ]);
    expect(loopUpdater.aborts).toEqual(["context length exceeded"]);
  });

  test("recovers at most once", async () => {
    const { client, requests } = makeClient([
      callTurn("probe"),
      failing(new ContextLengthExceededError("too long")),
      failing(new ContextLengthExceededError("still too long")),
    ]);

    const result = await runToolLoop(params(client, [probe()]));

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toBeInstanceOf(ContextLengthExceededError);
    expect(requests).toHaveLength(3);
  });

  test("does not recover when the first request is rejected", async () => {
    const { client, requests } = makeClient([failing(new ContextLengthExceededError("too long"))]);

    const result = await runToolLoop(params(client, [probe()]));

    expect(result.status).toBe("error");
    expect(requests).toHaveLength(1);
  });

  test("does not recover from a 400 that carries no error_type", async () => {
    const { client, requests } = makeClient([
      callTurn("probe"),
      failing(new BadRequestError("bad request")),
    ]);

    const result = await runToolLoop(params(client, [probe()]));

    expect(result.status).toBe("error");
    expect(requests).toHaveLength(2);
  });
});
