import { describe, expect, mock, test } from "bun:test";
import { ToolRegistry } from "../../../src/llm/tools/registry";
import { PDF_PARSER_PLUGIN } from "../../../src/services/attachmentParser";
import { buildChatRequest, ChatService } from "../../../src/services/chatService";
import { ModelService } from "../../../src/services/modelService";
import type { ChatCompletionRequest } from "../../../src/types";
import {
  createMockLLMClient,
  createMockSettingsService,
  createMockTweetService,
} from "../../helpers/mockFactories";

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
    expect(request).toEqual(buildChatRequest("test-model:fixture", { text: "question" }));
  });
});
