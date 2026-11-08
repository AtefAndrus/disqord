import { afterEach, describe, expect, mock, test } from "bun:test";
import { ApiKeyRequiredError } from "../../../src/errors";
import { type IDecisionsClient, OpenRouterClient } from "../../../src/llm/openrouter";
import { ToolRegistry } from "../../../src/llm/tools/registry";
import { ChatService } from "../../../src/services/chatService";
import { ModelService } from "../../../src/services/modelService";
import { ReplyGateService } from "../../../src/services/replyGateService";
import {
  createMockApiKeyService,
  createMockGuildSettings,
  createMockLLMClient,
  createMockSettingsService,
  createMockTweetService,
} from "../../helpers/mockFactories";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
describe("BYOK payment", () => {
  test.each([401, 402, 403, 404, 408, 429, 500, 503, "timeout"])(
    "reply gate connected-key status %s",
    async (status) => {
      const client: IDecisionsClient = {
        decideNoul: mock(async () => {
          throw status === "timeout"
            ? new DOMException("timeout", "TimeoutError")
            : Object.assign(new Error("fixture"), { status });
        }),
      };
      const defaultClient: IDecisionsClient = { decideNoul: mock(async () => ({ noul: 1 })) };
      const gate = new ReplyGateService(defaultClient, 0.3, () => 1_000_000);
      for (const source of ["user", "guild", "default"] as const) {
        const input = {
          guildId: "g",
          channelId: "c",
          messageId: source,
          state: {},
          botName: "bot",
        };
        const silent =
          source !== "default" &&
          typeof status === "number" &&
          status < 500 &&
          status !== 408 &&
          status !== 429;
        expect(await gate.judge(input, client, source)).toBe(silent ? "silent" : "reply");
        expect(gate.wasSilenced(source)).toBe(silent);
        expect(gate.wasAnswered(source)).toBe(!silent);
      }
      expect(defaultClient.decideNoul).not.toHaveBeenCalled();
    },
  );
  test.each([401, 402, 403])(
    "HTTP and stream errors have source-specific messages for %s",
    async (status) => {
      for (const source of ["user", "guild", "default"] as const) {
        const client = new OpenRouterClient("fixture", source);
        globalThis.fetch = mock(async () =>
          Response.json({ error: { message: "rejected" } }, { status }),
        ) as unknown as typeof globalThis.fetch;
        let httpMessage = "";
        try {
          await client.chat({ model: "fixture", messages: [] });
        } catch (error) {
          httpMessage = (error as { userMessage: string }).userMessage;
        }
        expect(httpMessage).toContain(
          source === "default"
            ? status === 403
              ? "入力内容"
              : "管理者"
            : source === "guild"
              ? "このサーバー"
              : "接続した OpenRouter",
        );
        globalThis.fetch = mock(
          async () =>
            new Response(
              `data: ${JSON.stringify({ type: "response.failed", response: { error: { code: status, message: "rejected" } } })}\n\n`,
            ),
        ) as unknown as typeof globalThis.fetch;
        let streamMessage = "";
        try {
          for await (const _chunk of client.chatStream({ model: "fixture", messages: [] })) {
          }
        } catch (error) {
          streamMessage = (error as { userMessage: string }).userMessage;
        }
        expect(streamMessage).toBe(httpMessage);
      }
    },
  );
  test("schedule interpretation and scheduled generation resolve the guild payer and never default on null", async () => {
    const defaultClient = createMockLLMClient();
    const guildClient = createMockLLMClient();
    guildClient.chat = mock(async () => ({
      choices: [{ message: { role: "assistant" as const, content: '{"schedule":"30m"}' } }],
    }));
    const settings = createMockSettingsService();
    settings.getGuildSettings = mock(async () =>
      createMockGuildSettings({ freeModelsOnly: false }),
    );
    const keys = createMockApiKeyService(guildClient);
    keys.resolveForGuild = mock(() => ({ key: "guild-fixture", source: "guild" as const }));
    const chat = new ChatService(
      defaultClient,
      settings,
      new ToolRegistry(),
      "perplexity",
      createMockTweetService(),
      new ModelService(defaultClient),
      keys,
    );
    expect(await chat.interpretCronSchedule("g", "every half hour")).toBe("30m");
    const job = {
      guildId: "g",
      prompt: "fixture",
      silent: false,
      webSearch: false,
    } as import("../../../src/db/repositories/cronRepository").CronJob;
    await chat.generateScheduledResponse(job, new AbortController().signal);
    expect(keys.resolveForGuild).toHaveBeenCalledTimes(2);
    expect(defaultClient.chat).not.toHaveBeenCalled();
    expect(guildClient.chat).toHaveBeenCalledTimes(2);
    keys.resolveForGuild = mock(() => null);
    await expect(chat.interpretCronSchedule("g", "fixture")).rejects.toBeInstanceOf(
      ApiKeyRequiredError,
    );
    await expect(
      chat.generateScheduledResponse(job, new AbortController().signal),
    ).rejects.toBeInstanceOf(ApiKeyRequiredError);
    expect(guildClient.chat).toHaveBeenCalledTimes(2);
  });

  test("streaming generation uses the selected client and records user key source", async () => {
    const defaultClient = createMockLLMClient();
    const payerClient = createMockLLMClient();
    const settings = createMockSettingsService();
    settings.getGuildSettings = mock(async () =>
      createMockGuildSettings({ freeModelsOnly: false }),
    );
    payerClient.chatStream = mock(async function* (_request, _signal, onGenerationId) {
      onGenerationId?.("generation-fixture");
      yield { content: "fixture", done: false as const };
      yield { done: true as const, fullText: "fixture", finishReason: "stop" };
    });
    const keys = createMockApiKeyService(payerClient);
    const chat = new ChatService(
      defaultClient,
      settings,
      new ToolRegistry(),
      "perplexity",
      createMockTweetService(),
      new ModelService(defaultClient),
      keys,
    );
    const payer = { key: "user-fixture", source: "user" as const };
    const result = await chat.generateChatResponse(
      "guild",
      { text: "fixture" },
      "trigger",
      {
        beginTurn: mock(() => {}),
        stageContent: mock(async () => {}),
        commitTurn: mock(async () => {}),
        abortTurn: mock(async () => {}),
        beginToolBlock: mock(() => {}),
        endToolBlock: mock(() => {}),
      },
      { channelId: "channel", userId: "actor", payer },
    );
    expect(keys.clientFor).toHaveBeenCalledWith(payer);
    expect(defaultClient.chatStream).not.toHaveBeenCalled();
    expect(payerClient.chatStream).toHaveBeenCalledTimes(1);
    expect(result.generations).toEqual([
      { id: "generation-fixture", serverTools: false, keySource: "user" },
    ]);
  });
});
