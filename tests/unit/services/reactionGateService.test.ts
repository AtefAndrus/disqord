import { describe, expect, mock, spyOn, test } from "bun:test";
import type { DecisionsResult } from "../../../src/llm/openrouter";
import { REACTION_EMOJI } from "../../../src/services/reactionEmoji";
import {
  ACCEPTS_THRESHOLD,
  buildReactionGateQuestions,
  keepsLastBotMessage,
  MAX_EMOJI_CHOICES,
  MAX_REACTION_GATE_CHARS,
  NEEDS_TEXT_THRESHOLD,
  REACTION_GATE_TIMEOUT_MS,
  ReactionGateService,
  withBotMessageEnd,
} from "../../../src/services/reactionGateService";
import { REPLY_GATE_MODEL } from "../../../src/services/replyGateService";
import type { NormalizedMessage } from "../../../src/utils/discordMessageNormalizer";

const input = {
  guildId: "guild",
  channelId: "channel",
  messageId: "message",
  botName: "Bot",
  state: { current_message: "ありがとう" },
  customEmoji: [],
};

function answers(needsText: unknown, accepts: unknown, choice: unknown): DecisionsResult {
  return {
    answers: {
      needs_text: { type: "noul", noul: needsText },
      accepts: { type: "noul", noul: accepts },
      emoji: { type: "choice", choice },
    },
    cost: 0.0001,
  };
}

async function judged(result: DecisionsResult | Error): Promise<string | null> {
  const info = spyOn(console, "info").mockImplementation(() => {});
  try {
    return await new ReactionGateService().judge(
      input,
      {
        decide: mock(async () => {
          if (result instanceof Error) throw result;
          return result;
        }),
      },
      "default",
    );
  } finally {
    info.mockRestore();
  }
}

describe("ReactionGateService.judge", () => {
  test("returns the emoji only below both thresholds", async () => {
    expect(await judged(answers(0.05, 0.1, "🙏"))).toBe("🙏");
    expect(await judged(answers(NEEDS_TEXT_THRESHOLD, 0.1, "🙏"))).toBeNull();
    expect(await judged(answers(0.05, ACCEPTS_THRESHOLD, "🙏"))).toBeNull();
    expect(await judged(answers(NEEDS_TEXT_THRESHOLD - 0.01, ACCEPTS_THRESHOLD - 0.01, "🙏"))).toBe(
      "🙏",
    );
  });

  test("anything it cannot read means text", async () => {
    expect(await judged(answers(0.05, 0.1, "📎 not offered"))).toBeNull();
    expect(await judged(answers(0.05, 0.1, 3))).toBeNull();
    expect(await judged(answers("0.05", 0.1, "🙏"))).toBeNull();
    expect(await judged(answers(0.05, undefined, "🙏"))).toBeNull();
    expect(await judged({ answers: { needs_text: { type: "refusal" } } })).toBeNull();
    expect(await judged({ answers: {} })).toBeNull();
    expect(await judged(new Error("HTTP 500"))).toBeNull();
    expect(await judged(Object.assign(new Error("x"), { status: 401 }))).toBeNull();
  });

  test("asks the judgment model under a short timeout, and logs the judgment and who paid", async () => {
    const info = spyOn(console, "info").mockImplementation(() => {});
    const timeout = spyOn(AbortSignal, "timeout");
    const decide = mock(async () => answers(0.05, 0.1, "🙏"));
    await new ReactionGateService().judge(input, { decide }, "user");
    const [request] = decide.mock.calls[0] as unknown as [{ model: string; state: unknown }];
    expect(request.model).toBe(REPLY_GATE_MODEL);
    expect(request.state).toEqual(input.state);
    expect(timeout).toHaveBeenCalledWith(REACTION_GATE_TIMEOUT_MS);
    const line = String(info.mock.calls.at(-1)?.[0]);
    expect(line).toContain("Reaction gate");
    expect(line).toContain('"decision":"reaction"');
    expect(line).toContain('"keySource":"user"');
    expect(line).toContain('"needsText":0.05');
    timeout.mockRestore();
    info.mockRestore();
  });
});

const bot = (text: string, id = "2"): NormalizedMessage => ({
  id,
  channelId: "c",
  kind: "assistant",
  author: "assistant",
  time: "",
  timestampMs: 0,
  text,
  attachments: [],
  exchangeId: "1",
});
const user: NormalizedMessage = { ...bot("ユーザー"), id: "3", kind: "user", author: "佐藤" };

describe("withBotMessageEnd", () => {
  const state = { new_message: "了解" };
  const long = `${"あ".repeat(MAX_REACTION_GATE_CHARS)}書きましょうか？`;

  test("adds the end of a bot message longer than the state keeps", () => {
    const result = withBotMessageEnd(state, { messages: [bot(long), user] });
    expect(result.new_message).toBe("了解");
    expect(String(result.last_bot_message_end).endsWith("書きましょうか？")).toBe(true);
    expect(Array.from(String(result.last_bot_message_end))).toHaveLength(MAX_REACTION_GATE_CHARS);
  });

  test("adds nothing when the state already holds the whole message, or there is no bot message", () => {
    expect(withBotMessageEnd(state, { messages: [bot("短い回答")] })).toEqual(state);
    expect(withBotMessageEnd(state, { messages: [user] })).toEqual(state);
    expect(withBotMessageEnd(state, undefined)).toEqual(state);
  });

  test("prefers the bot message being replied to, then the most recent one", () => {
    const older = bot(`${"あ".repeat(500)}古い提案`, "1");
    const newer = bot(`${"あ".repeat(500)}新しい回答`, "2");
    expect(
      String(withBotMessageEnd(state, { messages: [older, newer] }).last_bot_message_end),
    ).toContain("新しい回答");
    expect(
      String(
        withBotMessageEnd(state, { messages: [older, newer], replyTarget: older })
          .last_bot_message_end,
      ),
    ).toContain("古い提案");
    expect(
      String(
        withBotMessageEnd(state, { messages: [older, newer], replyTarget: user })
          .last_bot_message_end,
      ),
    ).toContain("新しい回答");
  });
});

describe("keepsLastBotMessage", () => {
  const answer = bot("回答です。", "1");
  const kept = (count: number): Record<string, unknown> => ({
    recent_messages: Array.from({ length: count }, () => "line"),
  });

  test("counts from the newest message, as the state gives up the oldest", () => {
    const messages = [answer, user];
    expect(keepsLastBotMessage(kept(2), { messages })).toBe(true);
    expect(keepsLastBotMessage(kept(1), { messages })).toBe(false);
  });

  test("the reply target has its own field in the state", () => {
    const target = bot("書きましょうか？", "5");
    expect(keepsLastBotMessage(kept(0), { messages: [answer, target], replyTarget: target })).toBe(
      true,
    );
  });

  test("a person's reply target takes no place among the kept messages", () => {
    expect(keepsLastBotMessage(kept(1), { messages: [answer, user], replyTarget: user })).toBe(
      true,
    );
  });

  test("with no bot message in the conversation, nothing was lost", () => {
    expect(keepsLastBotMessage(kept(1), { messages: [user] })).toBe(true);
  });
});

describe("buildReactionGateQuestions", () => {
  test("fills the API's limit with the built-in list", () => {
    const { emoji } = buildReactionGateQuestions("Bot", []);
    expect(Object.keys(emoji.criteria)).toHaveLength(MAX_EMOJI_CHOICES);
    expect(REACTION_EMOJI).toHaveLength(MAX_EMOJI_CHOICES);
    expect(new Set(REACTION_EMOJI).size).toBe(MAX_EMOJI_CHOICES);
    expect(emoji.instructions).not.toContain("カスタム絵文字");
  });

  test("custom emoji take room from the end of the list, and the most common reactions stay", () => {
    const custom = Array.from({ length: 300 }, (_, index) => `custom_${index}`);
    const keys = Object.keys(buildReactionGateQuestions("Bot", custom).emoji.criteria);
    expect(keys).toHaveLength(MAX_EMOJI_CHOICES);
    expect(keys.filter((key) => key.startsWith("custom_"))).toHaveLength(100);
    for (const common of ["👍", "🙏", "😂", "🎉"]) expect(keys).toContain(common);
    expect(buildReactionGateQuestions("Bot", ["kusa"]).emoji.instructions).toContain(
      "カスタム絵文字",
    );
  });

  test("names the bot in both judgments", () => {
    const { needs_text, accepts } = buildReactionGateQuestions("でぃす", []);
    expect(needs_text.instructions).toContain("でぃす");
    expect(accepts.instructions).toContain("でぃす");
  });
});
