import { describe, expect, test } from "bun:test";
import { REASONING_COMPONENT_ID } from "../../../src/utils/chatContainerBuilder";
import type { RawDiscordMessage } from "../../../src/utils/discordMessageNormalizer";
import {
  extractComponentsV2Footer,
  formatMessageForModel,
  formatMessageForTool,
  normalizeBotReply,
  normalizeHumanMessage,
} from "../../../src/utils/discordMessageNormalizer";

function botPage(id: string, body: string, footer: string): RawDiscordMessage {
  return {
    id,
    channel_id: "channel",
    content: "",
    timestamp: `2026-09-22T12:00:0${id}Z`,
    author: { id: "bot", username: "bot", bot: true },
    components: [
      {
        type: 17,
        components: [
          { type: 10, content: "**Model:** test-model" },
          { type: 10, content: body },
          { type: 14, divider: false },
          { type: 10, content: footer },
        ],
      },
    ],
  };
}

describe("Discord message normalization", () => {
  test("reassembles bot pages, strips the page-0 badge and footer, and preserves page order", () => {
    const first = botPage("1", "first", "Tokens: 1+1=2 | ページ 1/2");
    const second = botPage("2", "second", "Tokens: 2+2=4 | ページ 2/2");

    expect(extractComponentsV2Footer(first)).toBe("Tokens: 1+1=2 | ページ 1/2");
    expect(
      normalizeBotReply("trigger", [
        { ...second, page: { pageMsgId: "2", triggerMsgId: "trigger", seq: 1 } },
        { ...first, page: { pageMsgId: "1", triggerMsgId: "trigger", seq: 0 } },
      ]),
    ).toMatchObject({
      id: "1",
      kind: "assistant",
      text: "first\n**Model:** test-model\nsecond",
      pageIds: ["1", "2"],
    });
  });

  test("推論の component id を持つ TextDisplay は本文に入らない", () => {
    const page = botPage("1", "answer", "Tokens: 1+1=2");
    const [container] = page.components as { components: unknown[] }[];
    const withReasoning: RawDiscordMessage = {
      ...page,
      components: [
        {
          ...(container as object),
          components: [
            container?.components[0],
            { type: 10, id: REASONING_COMPONENT_ID, content: "-# 推論\n||secret||" },
            ...(container?.components.slice(1) ?? []),
          ],
        },
      ],
    };

    expect(extractComponentsV2Footer(withReasoning)).toBe("Tokens: 1+1=2");
    expect(
      normalizeBotReply("trigger", [
        { ...withReasoning, page: { pageMsgId: "1", triggerMsgId: "trigger", seq: 0 } },
      ]).text,
    ).toBe("answer");
  });

  test("本文の区切り線は --- として読み戻し、末尾にあっても footer と取り違えない", () => {
    const page: RawDiscordMessage = {
      id: "1",
      channel_id: "channel",
      content: "",
      timestamp: "2026-09-22T12:00:01Z",
      author: { id: "bot", username: "bot", bot: true },
      components: [
        {
          type: 17,
          components: [
            { type: 10, content: "**Model:** test-model" },
            { type: 10, content: "上" },
            { type: 14, divider: true },
            { type: 10, content: "下" },
          ],
        },
      ],
    };

    expect(extractComponentsV2Footer(page)).toBeUndefined();
    expect(
      normalizeBotReply("trigger", [
        { ...page, page: { pageMsgId: "1", triggerMsgId: "trigger", seq: 0 } },
      ]).text,
    ).toBe("上\n---\n下");
  });

  test("normalizes human labels and exposes attachment metadata without CDN URLs", () => {
    const message: RawDiscordMessage = {
      id: "message",
      channel_id: "channel",
      content: "body",
      timestamp: "2026-09-22T12:00:00.000Z",
      author: { id: "user", username: "username", global_name: "fallback", bot: false },
      member: { nick: "name\nwith\u0000controls" },
      attachments: [
        {
          id: "attachment",
          filename: "file.pdf",
          url: "https://cdn.discordapp.com/private/file.pdf",
          content_type: "application/pdf",
          size: 123,
        },
      ],
    };
    const normalized = normalizeHumanMessage(message);

    expect(formatMessageForModel({ ...normalized, ref: "m7" })).toContain(
      '[添付 m7/1: PDF "file.pdf" 123 bytes]',
    );
    expect(formatMessageForModel({ ...normalized, ref: "m7" })).not.toContain("cdn.discordapp");
    expect(formatMessageForTool({ ...normalized, ref: "m7" })).toEqual({
      ref: "m7",
      author: "name withcontrols",
      kind: "user",
      time: "2026-09-22T12:00:00.000Z",
      text: "body",
      attachments: [{ index: 1, kind: "pdf", filename: "file.pdf", size_bytes: 123 }],
      truncated: false,
    });
  });

  test("falls back to the display name when REST history carries no member", () => {
    const message: RawDiscordMessage = {
      id: "message",
      channel_id: "channel",
      content: "body",
      timestamp: "2026-09-22T12:00:00.000Z",
      author: { id: "user", username: "account123", global_name: "田中", bot: false },
      attachments: [],
    };

    expect(normalizeHumanMessage(message).author).toBe("田中");
    expect(
      normalizeHumanMessage({
        ...message,
        author: { id: "user", username: "account123", bot: false },
      }).author,
    ).toBe("account123");
  });
});
