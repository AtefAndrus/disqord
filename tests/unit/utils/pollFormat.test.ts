import { describe, expect, test } from "bun:test";
import {
  formatMessageForModel,
  formatPoll,
  formatPollResultNotice,
  normalizeHumanMessage,
  type RawDiscordMessage,
  type RawDiscordPoll,
} from "../../../src/utils/discordMessageNormalizer";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");

function poll(overrides: Partial<RawDiscordPoll> = {}): RawDiscordPoll {
  return {
    question: { text: "賛成ですか？" },
    answers: [
      { answer_id: 1, poll_media: { text: "はい" } },
      { answer_id: 2, poll_media: { text: "いいえ" } },
    ],
    expiry: "2026-09-28T12:47:00.000Z",
    allow_multiselect: false,
    results: { is_finalized: false, answer_counts: [{ id: 2, count: 1 }] },
    ...overrides,
  };
}

function notice(fields: Array<{ name: string; value: string }>): RawDiscordMessage {
  return {
    id: "46",
    channel_id: "channel",
    content: "",
    timestamp: new Date(NOW).toISOString(),
    author: { id: "user", username: "user" },
    type: 46,
    embeds: [{ type: "poll_result", fields }],
  };
}

describe("formatPoll", () => {
  test("counts an answer missing from answer_counts as zero and marks open counts", () => {
    expect(formatPoll(poll(), NOW)).toBe(
      [
        '[投票 "賛成ですか？" 締め切り 2026-09-28 21:47 JST・集計中]',
        "- はい: 0 票",
        "- いいえ: 1 票",
        "（延べ票数 1）",
      ].join("\n"),
    );
  });

  test("reports counts as unknown rather than zero when results are absent", () => {
    const text = formatPoll(poll({ results: undefined }), NOW);
    expect(text).toBe(
      [
        '[投票 "賛成ですか？" 締め切り 2026-09-28 21:47 JST]',
        "- はい: 不明",
        "- いいえ: 不明",
      ].join("\n"),
    );
  });

  test("marks an expired poll with finalized counts", () => {
    const text = formatPoll(
      poll({ results: { is_finalized: true, answer_counts: [{ id: 1, count: 3 }] } }),
      Date.parse("2026-09-29T00:00:00.000Z"),
    );
    expect(text.split("\n")[0]).toBe(
      '[投票 "賛成ですか？" 締め切り済み（2026-09-28 21:47 JST）・確定]',
    );
  });

  test("names the total of a multi-select poll so it is not read as voters", () => {
    const text = formatPoll(
      poll({
        allow_multiselect: true,
        results: {
          is_finalized: false,
          answer_counts: [
            { id: 1, count: 2 },
            { id: 2, count: 2 },
          ],
        },
      }),
      NOW,
    );
    expect(text.split("\n").at(-1)).toBe("（延べ票数 4、複数選択）");
  });

  test("omits counts and their state for the poll in the message that called the bot", () => {
    expect(formatPoll(poll(), NOW, false)).toBe(
      ['[投票 "賛成ですか？" 締め切り 2026-09-28 21:47 JST]', "- はい", "- いいえ"].join("\n"),
    );
  });

  test("writes a Unicode emoji as is and a custom emoji by name", () => {
    const text = formatPoll(
      poll({
        answers: [
          { answer_id: 1, poll_media: { text: "はい", emoji: { id: null, name: "👍" } } },
          { answer_id: 2, poll_media: { text: "いいえ", emoji: { id: "123", name: "nope" } } },
        ],
      }),
      NOW,
    );
    expect(text).toContain("- 👍 はい: 0 票");
    expect(text).toContain("- :nope: いいえ: 1 票");
  });
});

describe("formatPollResultNotice", () => {
  test("names the winning answer, its votes, and the total", () => {
    expect(
      formatPollResultNotice(
        notice([
          { name: "poll_question_text", value: "賛成ですか？" },
          { name: "victor_answer_votes", value: "1" },
          { name: "total_votes", value: "1" },
          { name: "victor_answer_id", value: "2" },
          { name: "victor_answer_text", value: "いいえ" },
        ]),
      ),
    ).toBe('[投票の締め切り "賛成ですか？": 「いいえ」が 1 票で最多（総票数 1）]');
  });

  test("writes only the total when Discord names no winner", () => {
    expect(
      formatPollResultNotice(
        notice([
          { name: "poll_question_text", value: "賛成ですか？" },
          { name: "total_votes", value: "0" },
        ]),
      ),
    ).toBe('[投票の締め切り "賛成ですか？": 総票数 0]');
  });

  test("returns undefined for a message that is not a notice", () => {
    expect(formatPollResultNotice({ ...notice([]), type: 0 })).toBeUndefined();
  });

  test("returns undefined when the embed lacks the question or the total", () => {
    expect(formatPollResultNotice(notice([{ name: "total_votes", value: "1" }]))).toBeUndefined();
    expect(
      formatPollResultNotice(notice([{ name: "poll_question_text", value: "賛成ですか？" }])),
    ).toBeUndefined();
  });
});

test("places a poll after the text, and a poll-only message has no placeholder", () => {
  const base: RawDiscordMessage = {
    id: "1",
    channel_id: "channel",
    content: "",
    timestamp: new Date(NOW).toISOString(),
    author: { id: "user", username: "alice" },
    poll: poll(),
  };
  expect(formatMessageForModel(normalizeHumanMessage(base, NOW))).toBe(
    `[m1] alice: ${formatPoll(poll(), NOW)}`,
  );
  expect(formatMessageForModel(normalizeHumanMessage({ ...base, content: "どう？" }, NOW))).toBe(
    `[m1] alice: どう？\n${formatPoll(poll(), NOW)}`,
  );
});
