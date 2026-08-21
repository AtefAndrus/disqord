import { describe, expect, test } from "bun:test";
import type {
  IClientTool,
  IToolContext,
  IToolHandlerResult,
} from "../../../src/llm/tools/registry";
import { ToolRegistry } from "../../../src/llm/tools/registry";
import type { INormalizedToolCall } from "../../../src/llm/tools/toolHandler";
import {
  clipToolResultBytes,
  MAX_TOOL_RESULT_BYTES,
  MIN_TOOL_TIMEOUT_MS,
  ToolDispatcher,
} from "../../../src/llm/tools/toolHandler";

const ctx: IToolContext = { guildId: "g1", channelId: "c1", userId: "u1" };
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function makeTool(overrides: Partial<IClientTool> = {}): IClientTool {
  return {
    name: "echo",
    description: "Echoes the input back.",
    parameters: { type: "object", properties: {} },
    isEnabled: () => true,
    validate: (args: unknown) => ({ ok: true, value: args }),
    handler: async (args: unknown) => ({ llmResult: JSON.stringify(args) }),
    ...overrides,
  };
}

function makeCall(overrides: Partial<INormalizedToolCall> = {}): INormalizedToolCall {
  return {
    index: 0,
    id: "call-1",
    name: "echo",
    rawArguments: "{}",
    ...overrides,
  };
}

function setup(tools: IClientTool[]): { registry: ToolRegistry; dispatcher: ToolDispatcher } {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return { registry, dispatcher: new ToolDispatcher(registry) };
}

describe("ToolDispatcher.dispatch", () => {
  test("executes normally: status ok, llmResult, render, and meta are passed through", async () => {
    const receivedMeta: { requestId: string; toolCallId: string; invocationId: string }[] = [];
    const { dispatcher } = setup([
      makeTool({
        handler: async (args, _ctx, _signal, meta) => {
          receivedMeta.push(meta);
          return { llmResult: `got:${JSON.stringify(args)}`, render: { kind: "widget" } };
        },
      }),
    ]);

    const outcome = await dispatcher.dispatch(makeCall({ rawArguments: '{"x":1}' }), {
      ctx,
      frozenToolNames: new Set(["echo"]),
      requestId: "req-1",
    });

    expect(outcome.status).toBe("ok");
    expect(outcome.toolMessage).toEqual({
      role: "tool",
      tool_call_id: "call-1",
      content: 'got:{"x":1}',
    });
    expect(outcome.render).toEqual({ kind: "widget" });

    expect(receivedMeta).toHaveLength(1);
    expect(receivedMeta[0]?.requestId).toBe("req-1");
    expect(receivedMeta[0]?.toolCallId).toBe("call-1");
    expect(receivedMeta[0]?.invocationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test("invocationId is unique across separate dispatches of the same call id", async () => {
    const seen: string[] = [];
    const { dispatcher } = setup([
      makeTool({
        handler: async (_args, _ctx, _signal, meta) => {
          seen.push(meta.invocationId);
          return { llmResult: "ok" };
        },
      }),
    ]);
    const options = { ctx, frozenToolNames: new Set(["echo"]), requestId: "req-1" };
    await dispatcher.dispatch(makeCall(), options);
    await dispatcher.dispatch(makeCall(), options);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  test("precomputedError short-circuits to an error result without invoking the handler", async () => {
    let called = false;
    const { dispatcher } = setup([
      makeTool({
        handler: async () => {
          called = true;
          return { llmResult: "should not run" };
        },
      }),
    ]);

    const outcome = await dispatcher.dispatch(
      makeCall({ precomputedError: "too many tool calls" }),
      { ctx, frozenToolNames: new Set(["echo"]), requestId: "req-1" },
    );

    expect(called).toBe(false);
    expect(outcome.status).toBe("error");
    expect(outcome.toolMessage.tool_call_id).toBe("call-1");
    expect(outcome.toolMessage.content).toBe("too many tool calls");
  });

  test("rejects a tool that is not in the frozen snapshot (not offered this request)", async () => {
    let called = false;
    const { dispatcher } = setup([
      makeTool({
        handler: async () => {
          called = true;
          return { llmResult: "should not run" };
        },
      }),
    ]);

    const outcome = await dispatcher.dispatch(makeCall(), {
      ctx,
      frozenToolNames: new Set(), // "echo" not offered
      requestId: "req-1",
    });

    expect(called).toBe(false);
    expect(outcome.status).toBe("error");
    expect(outcome.toolMessage.tool_call_id).toBe("call-1");
  });

  test("rejects an unknown tool name", async () => {
    const { dispatcher } = setup([]);
    const outcome = await dispatcher.dispatch(makeCall({ name: "does_not_exist" }), {
      ctx,
      frozenToolNames: new Set(["does_not_exist"]),
      requestId: "req-1",
    });
    expect(outcome.status).toBe("error");
    expect(outcome.toolMessage.tool_call_id).toBe("call-1");
  });

  test("rejects when isEnabled(ctx) is false at dispatch time, even after buildTools included it earlier", async () => {
    let enabled = true;
    let called = false;
    const registry = new ToolRegistry();
    registry.register(
      makeTool({
        name: "toggle",
        isEnabled: () => enabled,
        handler: async () => {
          called = true;
          return { llmResult: "should not run" };
        },
      }),
    );
    // Simulate the loop freezing a snapshot while the tool was still enabled.
    const frozen = new Set(registry.buildTools(ctx).map((t) => t.function.name));
    expect(frozen.has("toggle")).toBe(true);

    enabled = false; // disabled between snapshot freeze and dispatch
    const dispatcher = new ToolDispatcher(registry);
    const outcome = await dispatcher.dispatch(makeCall({ name: "toggle" }), {
      ctx,
      frozenToolNames: frozen,
      requestId: "req-1",
    });

    expect(called).toBe(false);
    expect(outcome.status).toBe("error");
  });

  test("invalid JSON arguments produce an error result", async () => {
    const { dispatcher } = setup([makeTool()]);
    const outcome = await dispatcher.dispatch(makeCall({ rawArguments: "{not json" }), {
      ctx,
      frozenToolNames: new Set(["echo"]),
      requestId: "req-1",
    });
    expect(outcome.status).toBe("error");
    expect(outcome.toolMessage.content.toLowerCase()).toContain("json");
  });

  test("validate() rejection produces an error result including the validator's message", async () => {
    const { dispatcher } = setup([
      makeTool({ validate: () => ({ ok: false, error: "field 'x' is required" }) }),
    ]);
    const outcome = await dispatcher.dispatch(makeCall({ rawArguments: "{}" }), {
      ctx,
      frozenToolNames: new Set(["echo"]),
      requestId: "req-1",
    });
    expect(outcome.status).toBe("error");
    expect(outcome.toolMessage.content).toContain("field 'x' is required");
  });

  test("empty rawArguments is treated as {}", async () => {
    let receivedArgs: unknown;
    const { dispatcher } = setup([
      makeTool({
        validate: (args) => ({ ok: true, value: args }),
        handler: async (args) => {
          receivedArgs = args;
          return { llmResult: "ok" };
        },
      }),
    ]);
    const outcome = await dispatcher.dispatch(makeCall({ rawArguments: "" }), {
      ctx,
      frozenToolNames: new Set(["echo"]),
      requestId: "req-1",
    });
    expect(outcome.status).toBe("ok");
    expect(receivedArgs).toEqual({});
  });

  test.each([
    ["undefined", undefined],
    ["a number", 42],
  ])(
    "a handler resolving with a non-string llmResult (%s) produces a bounded error result, not a false ok",
    async (_label, badLlmResult) => {
      const { dispatcher } = setup([
        makeTool({
          handler: async () => ({ llmResult: badLlmResult }) as unknown as IToolHandlerResult,
        }),
      ]);
      const outcome = await dispatcher.dispatch(makeCall(), {
        ctx,
        frozenToolNames: new Set(["echo"]),
        requestId: "req-1",
      });
      expect(outcome.status).toBe("error");
      expect(typeof outcome.toolMessage.content).toBe("string");
      expect(outcome.toolMessage.content).toContain("non-string result");
      expect(outcome.toolMessage.tool_call_id).toBe("call-1");
      expect(outcome.render).toBeUndefined();
    },
  );

  test("a handler that throws produces a bounded error result", async () => {
    const { dispatcher } = setup([
      makeTool({
        handler: async () => {
          throw new Error("boom");
        },
      }),
    ]);
    const outcome = await dispatcher.dispatch(makeCall(), {
      ctx,
      frozenToolNames: new Set(["echo"]),
      requestId: "req-1",
    });
    expect(outcome.status).toBe("error");
    expect(outcome.toolMessage.content).toContain("boom");
    expect(outcome.toolMessage.tool_call_id).toBe("call-1");
  });

  test("dispatch never invokes the handler when the request signal is already aborted", async () => {
    let called = false;
    const { dispatcher } = setup([
      makeTool({
        handler: async () => {
          called = true;
          return { llmResult: "should not run" };
        },
      }),
    ]);
    const controller = new AbortController();
    controller.abort();

    const outcome = await dispatcher.dispatch(makeCall(), {
      ctx,
      requestSignal: controller.signal,
      frozenToolNames: new Set(["echo"]),
      requestId: "req-1",
    });

    expect(called).toBe(false);
    expect(outcome.status).toBe("cancelled");
    expect(outcome.toolMessage.tool_call_id).toBe("call-1");
  });

  test("an already-aborted signal short-circuits to cancelled even when the call also carries a precomputedError", async () => {
    let called = false;
    const { dispatcher } = setup([
      makeTool({
        handler: async () => {
          called = true;
          return { llmResult: "should not run" };
        },
      }),
    ]);
    const controller = new AbortController();
    controller.abort();

    const outcome = await dispatcher.dispatch(
      makeCall({ precomputedError: "too many tool calls" }),
      {
        ctx,
        requestSignal: controller.signal,
        frozenToolNames: new Set(["echo"]),
        requestId: "req-1",
      },
    );

    expect(called).toBe(false);
    expect(outcome.status).toBe("cancelled");
    expect(outcome.toolMessage.tool_call_id).toBe("call-1");
  });

  test("an already-aborted signal short-circuits to cancelled instead of surfacing a validate() rejection as an error", async () => {
    const { dispatcher } = setup([
      makeTool({ validate: () => ({ ok: false, error: "field 'x' is required" }) }),
    ]);
    const controller = new AbortController();
    controller.abort();

    const outcome = await dispatcher.dispatch(makeCall({ rawArguments: "{}" }), {
      ctx,
      requestSignal: controller.signal,
      frozenToolNames: new Set(["echo"]),
      requestId: "req-1",
    });

    expect(outcome.status).toBe("cancelled");
    expect(outcome.toolMessage.tool_call_id).toBe("call-1");
  });

  test("a request cancel that arrives before the per-tool timeout is classified as cancelled, not timeout", async () => {
    const { dispatcher } = setup([
      makeTool({
        name: "hangs",
        timeoutMs: MIN_TOOL_TIMEOUT_MS, // clamped floor; deliberately much larger than the cancel delay below
        handler: () => new Promise(() => {}), // never settles; ignores signal
      }),
    ]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);

    const outcome = await dispatcher.dispatch(makeCall({ name: "hangs" }), {
      ctx,
      requestSignal: controller.signal,
      frozenToolNames: new Set(["hangs"]),
      requestId: "req-1",
    });

    expect(outcome.status).toBe("cancelled");
    expect(outcome.toolMessage.tool_call_id).toBe("call-1");
  });

  test(
    "timeout: the handler observes signal.aborted, dispatch resolves with status timeout, and a " +
      "late handler rejection after that does not produce an unhandled rejection",
    async () => {
      let observedAbort = false;
      let rejectLate: ((err: unknown) => void) | undefined;
      const { dispatcher } = setup([
        makeTool({
          name: "slow",
          timeoutMs: MIN_TOOL_TIMEOUT_MS,
          handler: (_args, _ctx, signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                observedAbort = true;
              });
              rejectLate = reject;
            }),
        }),
      ]);

      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);

      try {
        const start = Date.now();
        const outcome = await dispatcher.dispatch(makeCall({ name: "slow" }), {
          ctx,
          frozenToolNames: new Set(["slow"]),
          requestId: "req-1",
        });
        const elapsed = Date.now() - start;

        expect(outcome.status).toBe("timeout");
        expect(outcome.toolMessage.tool_call_id).toBe("call-1");
        expect(elapsed).toBeGreaterThanOrEqual(MIN_TOOL_TIMEOUT_MS - 5);
        expect(observedAbort).toBe(true);

        // Now let the abandoned handler promise settle (reject) late.
        rejectLate?.(new Error("late failure after timeout"));
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }
    },
  );

  test("all dispatch outcomes (across every branch) use tool_call_id === call.id", async () => {
    const { dispatcher } = setup([makeTool({ validate: () => ({ ok: false, error: "nope" }) })]);
    const call = makeCall({ id: "distinctive-id-42" });
    const outcome = await dispatcher.dispatch(call, {
      ctx,
      frozenToolNames: new Set(["echo"]),
      requestId: "req-1",
    });
    expect(outcome.toolMessage.tool_call_id).toBe("distinctive-id-42");
  });

  test("the final fallback constant is returned when even error-message formatting throws", async () => {
    // `call.name` throws on access; every code path that formats an error
    // message interpolates `call.name`, so this exercises the outer
    // catch -> errorOutcome -> (throws again) -> fixed ASCII fallback chain.
    const call = {
      index: 0,
      id: "call-x",
      rawArguments: "{}",
      get name(): string {
        throw new Error("name getter boom");
      },
    } as unknown as INormalizedToolCall;

    const { dispatcher } = setup([]);
    const outcome = await dispatcher.dispatch(call, {
      ctx,
      frozenToolNames: new Set(),
      requestId: "req-1",
    });

    expect(outcome.status).toBe("error");
    expect(outcome.toolMessage.tool_call_id).toBe("call-x");
    expect(outcome.toolMessage.content).toBe(
      "Tool execution failed and the error detail could not be serialized.",
    );
  });
});

describe("ToolDispatcher.buildCancelledOutcome", () => {
  test("produces a bounded cancellation result for a call that was never dispatched", () => {
    const { dispatcher } = setup([]);
    const outcome = dispatcher.buildCancelledOutcome(makeCall({ id: "never-started" }));
    expect(outcome.status).toBe("cancelled");
    expect(outcome.toolMessage.tool_call_id).toBe("never-started");
    expect(outcome.render).toBeUndefined();
  });
});

describe("clipToolResultBytes", () => {
  test("leaves text at or under the byte limit unchanged", () => {
    const text = "hello world";
    expect(clipToolResultBytes(text, 100)).toBe(text);

    const exact = "a".repeat(50);
    expect(utf8Encoder.encode(exact).length).toBe(50);
    expect(clipToolResultBytes(exact, 50)).toBe(exact);
  });

  test("clips text exceeding the byte limit, staying within budget and keeping head/tail", () => {
    const text = `${"A".repeat(100)}MIDDLE${"B".repeat(100)}`;
    const clipped = clipToolResultBytes(text, 60);
    expect(utf8Encoder.encode(clipped).length).toBeLessThanOrEqual(60);
    expect(clipped.startsWith("A")).toBe(true);
    expect(clipped.endsWith("B")).toBe(true);
    expect(clipped).toContain("...[truncated");
    expect(clipped).toContain("bytes]...");
  });

  test("never splits a multi-byte UTF-8 character at the clip boundary", () => {
    // 3-byte-per-character text (Japanese), well over the byte cap.
    const text = "あ".repeat(2000);
    const clipped = clipToolResultBytes(text, 101); // cap not a multiple of 3
    const bytes = utf8Encoder.encode(clipped);
    expect(bytes.length).toBeLessThanOrEqual(101);
    // Must decode cleanly as UTF-8 (throws on split multi-byte sequences).
    expect(() => utf8Decoder.decode(bytes)).not.toThrow();
  });

  test("uses the default MAX_TOOL_RESULT_BYTES cap when none is given", () => {
    const text = "x".repeat(MAX_TOOL_RESULT_BYTES + 500);
    const clipped = clipToolResultBytes(text);
    expect(utf8Encoder.encode(clipped).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
  });

  test("degrades gracefully when the cap is smaller than the marker itself", () => {
    const text = "x".repeat(1000);
    const clipped = clipToolResultBytes(text, 5);
    const bytes = utf8Encoder.encode(clipped);
    expect(bytes.length).toBeLessThanOrEqual(5);
    expect(() => utf8Decoder.decode(bytes)).not.toThrow();
  });

  test("a full tool run whose llmResult exceeds the cap is clipped through the same path", async () => {
    const huge = "z".repeat(MAX_TOOL_RESULT_BYTES + 1000);
    const { dispatcher } = setup([makeTool({ handler: async () => ({ llmResult: huge }) })]);
    const outcome = await dispatcher.dispatch(makeCall(), {
      ctx,
      frozenToolNames: new Set(["echo"]),
      requestId: "req-1",
    });
    expect(outcome.status).toBe("ok");
    expect(utf8Encoder.encode(outcome.toolMessage.content).length).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_BYTES,
    );
  });
});
