import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { DecisionsNoulResult, IDecisionsClient } from "../../../src/llm/openrouter";
import {
  buildReplyGateQuestion,
  buildReplyGateState,
  REPLY_GATE_MODEL,
  REPLY_GATE_TIMEOUT_MS,
  ReplyGateService,
} from "../../../src/services/replyGateService";
import type { NormalizedMessage } from "../../../src/utils/discordMessageNormalizer";
import { logger } from "../../../src/utils/logger";
import { estimateTextTokens } from "../../../src/utils/tokenEstimate";

function message(id: number, text = `text ${id}`): NormalizedMessage {
  return {
    id: String(id),
    channelId: "channel",
    kind: "user",
    author: `author${id}`,
    time: "now",
    timestampMs: id,
    text,
    attachments: [],
    exchangeId: String(id),
  };
}

const current = { author: "new author", text: "new text", attachments: [] };

describe("buildReplyGateState", () => {
  test("keeps mandatory messages and untruncated filenames when they alone exceed the budget", () => {
    const filename = "名".repeat(3200);
    const state = buildReplyGateState({
      botName: "bot",
      botUserId: "100",
      current: { ...current, attachments: [{ kind: "other", filename }] },
      isReplyToBot: false,
      conversation: { messages: [message(1)], replyTarget: message(0) },
    });
    expect(state.recent_messages).toEqual([]);
    expect(state.reply_target).toBe("author0: text 0");
    expect(state.new_message).toBe(`new author: new text [ファイル ${filename}]`);
  });
  test("reactions on history messages are not part of the judged state", () => {
    const state = buildReplyGateState({
      botName: "bot",
      botUserId: "100",
      current,
      isReplyToBot: false,
      conversation: {
        messages: [{ ...message(1), reactions: "[リアクション 👍 2]" }],
        replyTarget: { ...message(0), reactions: "[リアクション 😢 1]" },
      },
    });
    expect(JSON.stringify(state)).not.toContain("リアクション");
  });

  test("marks the bot's replies the gate chose", () => {
    const reply = (id: number): NormalizedMessage => ({
      ...message(id, `answer ${id}`),
      kind: "assistant",
      author: "assistant",
    });
    const state = buildReplyGateState({
      botName: "bot",
      botUserId: "100",
      current,
      isReplyToBot: false,
      conversation: { messages: [reply(1), reply(2)], replyTarget: reply(3) },
      isAutoReply: (m) => m.exchangeId !== "1",
    });
    expect(state.recent_messages).toEqual(["bot: answer 1", "bot（自動応答）: answer 2"]);
    expect(state.reply_target).toBe("bot（自動応答）: answer 3");
  });

  test("history off includes only the current message and reply flag", () => {
    expect(
      buildReplyGateState({ botName: "bot", botUserId: "100", current, isReplyToBot: true }),
    ).toEqual({
      bot_name: "bot",
      new_message: "new author: new text",
      is_reply_to_bot: true,
    });
  });

  test("keeps the newest 20 in chronological order and a separate reply target", () => {
    const messages = Array.from({ length: 25 }, (_, i) => message(i));
    const state = buildReplyGateState({
      botName: "bot",
      botUserId: "100",
      current,
      isReplyToBot: false,
      conversation: { messages, replyTarget: message(0) },
    });
    expect(state.recent_messages).toEqual(
      messages.slice(5).map((item) => `${item.author}: ${item.text}`),
    );
    expect(state.reply_target).toBe("author0: text 0");
    expect(state).not.toHaveProperty("is_reply_to_bot");
  });

  test("truncates text and poll together at 400 code points without truncating labels", () => {
    const target = {
      ...message(0, "😀".repeat(398)),
      poll: "投票",
      attachments: [
        {
          index: 0,
          id: "file",
          kind: "pdf" as const,
          filename: "target.pdf",
          sizeBytes: 1,
          mimeType: "application/pdf",
          url: "unused",
        },
      ],
    };
    const state = buildReplyGateState({
      botName: "bot",
      botUserId: "100",
      current: {
        ...current,
        text: "😀".repeat(401),
        attachments: [
          { kind: "image", filename: "photo.png" },
          { kind: "pdf", filename: "doc.pdf" },
          { kind: "other", filename: "archive.zip" },
        ],
      },
      isReplyToBot: false,
      conversation: { messages: [], replyTarget: target },
    });
    expect(state.new_message).toBe(
      `new author: ${"😀".repeat(400)}… [画像 photo.png] [PDF doc.pdf] [ファイル archive.zip]`,
    );
    expect(state.reply_target).toBe(`author0: ${"😀".repeat(398)}\n投… [PDF target.pdf]`);
  });

  test("includes poll text after the message text", () => {
    const state = buildReplyGateState({
      botName: "bot",
      botUserId: "100",
      current,
      isReplyToBot: false,
      conversation: { messages: [{ ...message(0), poll: "poll choices" }] },
    });
    expect(state.recent_messages).toEqual(["author0: text 0\npoll choices"]);
  });

  test("names the bot in its own replies and in mentions of it", () => {
    const reply: NormalizedMessage = {
      ...message(1, "answer"),
      kind: "assistant",
      author: "assistant",
    };
    const state = buildReplyGateState({
      botName: "bot",
      botUserId: "100",
      current: { ...current, text: "<@!100> and <@200> in <@&300> <#400>" },
      isReplyToBot: false,
      conversation: { messages: [message(0, "<@100> question"), reply], replyTarget: reply },
    });
    expect(state.recent_messages).toEqual(["author0: @bot question"]);
    expect(state.reply_target).toBe("bot: answer");
    // Role and channel mentions are not people, so they stay as they are.
    expect(state.new_message).toBe("new author: @bot and @メンバー in <@&300> <#400>");
  });

  test("drops oldest messages first to fit the budget including target and new message", () => {
    const messages = Array.from({ length: 20 }, (_, i) => message(i, "あ".repeat(400)));
    const state = buildReplyGateState({
      botName: "bot",
      botUserId: "100",
      current: { ...current, text: "今".repeat(400) },
      isReplyToBot: false,
      conversation: { messages, replyTarget: message(99, "先".repeat(400)) },
    });
    const recent = state.recent_messages as string[];
    const fixed =
      estimateTextTokens(state.reply_target as string) +
      estimateTextTokens(state.new_message as string);
    const tokens = fixed + recent.reduce((sum, item) => sum + estimateTextTokens(item), 0);
    expect(tokens).toBeLessThanOrEqual(3000);
    expect(recent).toHaveLength(5);
    expect(recent[0]).toStartWith("author15:");
    expect(tokens + estimateTextTokens(`author14: ${messages[14].text}`)).toBeGreaterThan(3000);
    expect(state.reply_target).toBe(`author99: ${"先".repeat(400)}`);
    expect(state.new_message).toBe(`new author: ${"今".repeat(400)}`);
  });
});

describe("ReplyGateService", () => {
  const input = {
    guildId: "guild",
    channelId: "channel",
    messageId: "message",
    botName: "private bot",
    state: { new_message: "private message text" },
  };
  let log: ReturnType<typeof spyOn<typeof logger, "info">>;
  beforeEach(() => {
    log = spyOn(logger, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
  });

  test.each([0.3, 0.299])("compares probability %s to the threshold", async (noul) => {
    const decideNoul = mock(async () => ({ noul, cost: 0.001, model: "resolved model" }));
    const gate = new ReplyGateService({ decideNoul }, 0.3);
    expect(await gate.judge(input)).toBe(noul === 0.3 ? "reply" : "silent");
    expect(gate.wasSilenced(input.messageId)).toBe(noul < 0.3);
    expect(decideNoul).toHaveBeenCalledWith(
      {
        model: REPLY_GATE_MODEL,
        state: input.state,
        questions: { should_reply: buildReplyGateQuestion(input.botName) },
      },
      "should_reply",
      expect.any(AbortSignal),
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual([
      "Reply gate",
      expect.objectContaining({
        guildId: "guild",
        channelId: "channel",
        messageId: "message",
        threshold: 0.3,
        noul,
        cost: 0.001,
        model: "resolved model",
        elapsed: expect.any(Number),
      }),
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });

  test("remembers answered IDs, including fail-open ones, for one hour", async () => {
    let now = 100;
    let fail = false;
    const gate = new ReplyGateService(
      {
        decideNoul: mock(async () => {
          if (fail) throw new Error("down");
          return { noul: 0.9 };
        }),
      },
      0.3,
      () => now,
    );
    await gate.judge(input);
    fail = true;
    await gate.judge({ ...input, messageId: "failed" });
    expect(gate.wasAnswered(input.messageId)).toBe(true);
    expect(gate.wasAnswered("failed")).toBe(true);
    expect(gate.wasSilenced(input.messageId)).toBe(false);
    now += 3_600_000;
    expect(gate.wasAnswered(input.messageId)).toBe(false);
  });

  test("expires silent IDs after exactly one hour", async () => {
    let now = 100;
    const gate = new ReplyGateService(
      { decideNoul: mock(async () => ({ noul: 0 })) },
      0.3,
      () => now,
    );
    await gate.judge(input);
    now += 3_599_999;
    expect(gate.wasSilenced(input.messageId)).toBe(true);
    now++;
    expect(gate.wasSilenced(input.messageId)).toBe(false);
  });

  test("fails open and logs only the error name or status", async () => {
    const gate = new ReplyGateService(
      {
        decideNoul: mock(async () => {
          throw Object.assign(new Error("private text"), { status: 429 });
        }),
      },
      0.3,
    );
    expect(await gate.judge(input)).toBe("reply");
    expect(gate.wasSilenced(input.messageId)).toBe(false);
    expect(log.mock.calls[0]).toEqual([
      "Reply gate",
      expect.objectContaining({ decision: "error", error: 429 }),
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });

  test("fails open when the request is aborted after three seconds", async () => {
    const client: IDecisionsClient = {
      decideNoul: mock<IDecisionsClient["decideNoul"]>(
        (_request, _key, signal) =>
          new Promise<DecisionsNoulResult>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    };
    const gate = new ReplyGateService(client, 0.3);
    const start = Date.now();
    expect(await gate.judge(input)).toBe("reply");
    expect(Date.now() - start).toBeGreaterThanOrEqual(REPLY_GATE_TIMEOUT_MS - 20);
    expect(log.mock.calls[0]).toEqual([
      "Reply gate",
      expect.objectContaining({ decision: "error", error: "TimeoutError" }),
    ]);
  });
});
