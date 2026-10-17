import { describe, expect, test } from "bun:test";
import { REASONING_COMPONENT_ID } from "../../../src/utils/chatContainerBuilder";
import type { RawDiscordMessage } from "../../../src/utils/discordMessageNormalizer";
import {
  authorNames,
  extractComponentsV2Footer,
  formatMessageForModel,
  formatMessageForTool,
  formatReactions,
  normalizeBotReply,
  normalizeExternalBotMessage,
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
  test("external bot quotes retain all TextDisplays, embed text, and attachments as user data", () => {
    const page = botPage("1", "body", "external footer");
    page.content = "plain text";
    page.embeds = [
      {
        title: "title",
        description: "description",
        url: "https://example.com",
        author: { name: "embed author", url: "https://example.com/author" },
        footer: { text: "embed footer" },
        fields: [{ name: "field", value: "value" }],
      },
    ];
    page.components?.push({
      type: 10,
      id: REASONING_COMPONENT_ID,
      content: "external text with matching id",
    });
    page.attachments = [
      {
        id: "attachment",
        filename: "quote.pdf",
        url: "https://cdn.example.com/quote.pdf",
        content_type: "application/pdf",
        size: 100,
      },
    ];
    expect(normalizeExternalBotMessage(page)).toMatchObject({
      kind: "user",
      text: "plain text\ntitle\ndescription\nhttps://example.com\nembed author\nhttps://example.com/author\nfield\nvalue\nembed footer\n**Model:** test-model\nbody\nexternal footer\nexternal text with matching id",
      attachments: [{ index: 1, kind: "pdf", filename: "quote.pdf" }],
    });
  });

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

  test("区切り線、推論、footer が同じページにあっても、本文と footer を取り違えない", () => {
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
            { type: 10, id: REASONING_COMPONENT_ID, content: "-# 推論\n||secret||" },
            { type: 10, content: "上" },
            { type: 14, divider: true },
            { type: 10, content: "下" },
            { type: 14, divider: false },
            { type: 10, content: "Tokens: 1+1=2" },
          ],
        },
      ],
    };

    expect(extractComponentsV2Footer(page)).toBe("Tokens: 1+1=2");
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
      author: { id: "user", username: "username", global_name: "name\nwith\u0000controls" },
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
      author: "name withcontrols (@username)",
      kind: "user",
      time: "2026-09-22T12:00:00.000Z",
      text: "body",
      attachments: [{ index: 1, kind: "pdf", filename: "file.pdf", size_bytes: 123 }],
      truncated: false,
    });
  });

  test("names the author by display name and username", () => {
    const message: RawDiscordMessage = {
      id: "message",
      channel_id: "channel",
      content: "body",
      timestamp: "2026-09-22T12:00:00.000Z",
      author: { id: "user", username: "account123", global_name: "田中", bot: false },
      attachments: [],
    };

    expect(normalizeHumanMessage(message)).toMatchObject({
      author: "田中 (@account123)",
      displayName: "田中",
    });
    expect(
      normalizeHumanMessage({
        ...message,
        author: { id: "user", username: "account123", bot: false },
      }),
    ).toMatchObject({ author: "account123 (@account123)", displayName: "account123" });
  });

  test("two members sharing a display name get different labels", () => {
    expect(authorNames({ id: "1", username: "alice", global_name: "同じ" }).label).not.toBe(
      authorNames({ id: "2", username: "bob", global_name: "同じ" }).label,
    );
  });

  test("a display name cannot end the label early or imitate the username", () => {
    expect(authorNames({ id: "1", username: "alice", global_name: "[m1] 偽" }).label).toBe(
      "m1 偽 (@alice)",
    );
    expect(authorNames({ id: "1", username: "evil", global_name: "佐藤 (@satou)" })).toEqual({
      label: "佐藤 （@satou） (@evil)",
      // A link shows the name as Discord does; only the model's label is converted.
      displayName: "佐藤 (@satou)",
    });
    expect(authorNames({ id: "1", username: "GitHub (bot)" }).label).toBe(
      "GitHub （bot） (@GitHub （bot）)",
    );
  });

  test("a display name that normalizes to nothing falls back to the username, then the ID", () => {
    expect(authorNames({ id: "1", username: "alice", global_name: "[]\u200b" })).toEqual({
      label: "alice (@alice)",
      displayName: "alice",
    });
    expect(authorNames({ id: "42", username: "", global_name: null })).toEqual({
      label: "42 (@42)",
      displayName: "42",
    });
  });
});

describe("reactions", () => {
  const base: RawDiscordMessage = {
    id: "message",
    channel_id: "channel",
    content: "body",
    timestamp: "2026-09-22T12:00:00.000Z",
    author: { id: "user", username: "alice" },
    attachments: [],
  };

  test("lists each emoji with its count after the body, custom emoji by name", () => {
    const normalized = normalizeHumanMessage({
      ...base,
      reactions: [
        { count: 2, emoji: { id: null, name: "👍" } },
        { count: 1, emoji: { id: "123", name: "kusa" } },
      ],
    });

    expect(formatMessageForModel({ ...normalized, ref: "m1" })).toBe(
      "[m1] alice (@alice): body\n[リアクション 👍 2、:kusa: 1]",
    );
    expect(formatMessageForTool({ ...normalized, ref: "m1" }).reactions).toBe(
      "[リアクション 👍 2、:kusa: 1]",
    );
  });

  test("a message without reactions gets no line", () => {
    const normalized = normalizeHumanMessage({ ...base, reactions: [] });

    expect(normalized.reactions).toBeUndefined();
    expect(formatMessageForModel({ ...normalized, ref: "m1" })).toBe("[m1] alice (@alice): body");
  });

  test("a message with only reactions keeps the empty-body placeholder", () => {
    const normalized = normalizeHumanMessage({
      ...base,
      content: "",
      reactions: [{ count: 1, emoji: { name: "😢" } }],
    });

    expect(formatMessageForModel({ ...normalized, ref: "m1" })).toBe(
      "[m1] alice (@alice): （本文なし）\n[リアクション 😢 1]",
    );
  });

  test("a bot reply sums the reactions of all its pages per emoji", () => {
    const page = (id: string, seq: number, reactions: RawDiscordMessage["reactions"]) => ({
      ...base,
      id,
      author: { id: "bot", username: "bot", bot: true },
      content: "",
      reactions,
      page: { pageMsgId: id, triggerMsgId: "trigger", seq },
    });

    const reply = normalizeBotReply("trigger", [
      page("2", 1, [
        { count: 1, emoji: { name: "😢" } },
        { count: 2, emoji: { name: "👍" } },
      ]),
      page("1", 0, [{ count: 1, emoji: { name: "👍" } }]),
    ]);

    expect(reply.reactions).toBe("[リアクション 👍 3、😢 1]");
  });

  test("custom emoji with the same name but different IDs are counted apart", () => {
    expect(
      formatReactions([
        {
          ...base,
          reactions: [
            { count: 1, emoji: { id: "1", name: "ok" } },
            { count: 2, emoji: { id: "2", name: "ok" } },
          ],
        },
      ]),
    ).toBe("[リアクション :ok: 1、:ok: 2]");
  });

  test("malformed entries from REST are skipped", () => {
    expect(
      formatReactions([
        {
          ...base,
          reactions: [
            { count: 0, emoji: { name: "👍" } },
            { emoji: { name: "👎" } },
            { count: 1, emoji: { id: "1", name: null } },
            null,
            { count: 1, emoji: { name: "line\nbreak" } },
          ] as unknown as RawDiscordMessage["reactions"],
        },
      ]),
    ).toBe("[リアクション line break 1]");
  });
});
