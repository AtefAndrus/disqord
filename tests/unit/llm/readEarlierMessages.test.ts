import { expect, mock, test } from "bun:test";
import { ReadEarlierMessagesTool } from "../../../src/llm/tools/readEarlierMessages";

test("passes the dispatcher signal to the conversation context", async () => {
  const signal = new AbortController().signal;
  const readEarlierMessages = mock(async (count: number, receivedSignal: AbortSignal) => {
    expect(count).toBe(5);
    expect(receivedSignal).toBe(signal);
    return "{}";
  });
  const tool = new ReadEarlierMessagesTool();

  const result = await tool.handler(
    {},
    {
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      conversation: {
        readEarlierMessages,
        viewAttachment: async () => "{}",
      },
    },
    signal,
    { requestId: "request", toolCallId: "call", invocationId: "invocation" },
  );

  expect(result.llmResult).toBe("{}");
});
