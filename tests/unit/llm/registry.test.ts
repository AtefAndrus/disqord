import { describe, expect, test } from "bun:test";
import type { IClientTool, IToolContext } from "../../../src/llm/tools/registry";
import { ToolRegistry } from "../../../src/llm/tools/registry";

function makeTool(overrides: Partial<IClientTool> = {}): IClientTool {
  return {
    name: "echo",
    description: "Echoes the input back.",
    parameters: { type: "object", properties: {} },
    isEnabled: () => true,
    validate: (args: unknown) => ({ ok: true, value: args }),
    handler: async () => ({ llmResult: "ok" }),
    ...overrides,
  };
}

const ctx: IToolContext = { guildId: "g1", channelId: "c1", userId: "u1" };

describe("ToolRegistry", () => {
  test("registers and retrieves a tool by name", () => {
    const registry = new ToolRegistry();
    const tool = makeTool();
    registry.register(tool);
    expect(registry.get("echo")).toBe(tool);
  });

  test("get() returns undefined for an unregistered name", () => {
    const registry = new ToolRegistry();
    expect(registry.get("missing")).toBeUndefined();
  });

  test("rejects duplicate tool names", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool());
    expect(() => registry.register(makeTool())).toThrow();
  });

  test("rejects invalid tool names", () => {
    const registry = new ToolRegistry();
    const invalidNames = ["", "has space", "has/slash", "a".repeat(65), "emoji🙂"];
    for (const name of invalidNames) {
      expect(() => registry.register(makeTool({ name }))).toThrow();
    }
  });

  test("accepts boundary-valid tool names", () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(makeTool({ name: "a" }))).not.toThrow();
    expect(() => registry.register(makeTool({ name: "b".repeat(64) }))).not.toThrow();
    expect(() => registry.register(makeTool({ name: "under_score-dash" }))).not.toThrow();
  });

  test("rejects an empty or whitespace-only description", () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(makeTool({ description: "" }))).toThrow();
    expect(() => registry.register(makeTool({ name: "b", description: "   " }))).toThrow();
  });

  test("buildTools() includes only isEnabled tools for the given context", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: "always_on", isEnabled: () => true }));
    registry.register(
      makeTool({
        name: "guild_only",
        isEnabled: (c) => c.guildId !== null,
      }),
    );
    registry.register(makeTool({ name: "always_off", isEnabled: () => false }));

    const guildTools = registry.buildTools(ctx).map((t) => t.function.name);
    expect(guildTools.sort()).toEqual(["always_on", "guild_only"]);

    const dmTools = registry
      .buildTools({ guildId: null, channelId: "c1", userId: "u1" })
      .map((t) => t.function.name);
    expect(dmTools).toEqual(["always_on"]);
  });

  test("buildTools() returns [] when no tools are enabled", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ isEnabled: () => false }));
    expect(registry.buildTools(ctx)).toEqual([]);
  });

  test("buildTools() returns [] for an empty registry", () => {
    const registry = new ToolRegistry();
    expect(registry.buildTools(ctx)).toEqual([]);
  });

  test("buildTools() produces well-formed FunctionTool shapes", () => {
    const registry = new ToolRegistry();
    const parameters = { type: "object", properties: { x: { type: "number" } } };
    registry.register(makeTool({ name: "shaped", description: "A shaped tool.", parameters }));

    const [tool] = registry.buildTools(ctx);
    expect(tool).toEqual({
      type: "function",
      function: {
        name: "shaped",
        description: "A shaped tool.",
        parameters,
      },
    });
  });

  test("isEnabled is re-evaluated per call (not cached)", () => {
    const registry = new ToolRegistry();
    let enabled = false;
    registry.register(makeTool({ isEnabled: () => enabled }));
    expect(registry.buildTools(ctx)).toEqual([]);
    enabled = true;
    expect(registry.buildTools(ctx).map((t) => t.function.name)).toEqual(["echo"]);
  });
});
