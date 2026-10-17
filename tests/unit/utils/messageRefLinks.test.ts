import { describe, expect, test } from "bun:test";
import type { ConversationToolContext, MessageRefTarget } from "../../../src/llm/tools/registry";
import { createMessageRefResolver, linkMessageRefs } from "../../../src/utils/messageRefLinks";

const url = "https://discord.com/channels/guild/channel/message";
const linked = `[Alice の発言](${url})`;
const resolve = (ref: string): { label: string; url: string } | undefined =>
  ref === "m12" ? { label: "Alice の発言", url } : undefined;

describe("linkMessageRefs", () => {
  test("links known bracketed refs, leaving bare, unknown, and incomplete refs alone", () => {
    expect(linkMessageRefs("[m12] m12 m3.medium [m13] [m1", resolve)).toBe(
      `${linked} m12 m3.medium [m13] [m1`,
    );
    expect(linkMessageRefs("[m12] and [m12]", resolve)).toBe(`${linked} and ${linked}`);
    expect(linkMessageRefs("<[m12]>", resolve)).toBe(`<${linked}>`);
    expect(linkMessageRefs("[m12](Alice)", resolve)).toBe(`${linked}(Alice)`);
    expect(linkMessageRefs("[m12](note: 古い情報)", resolve)).toBe(`${linked}(note: 古い情報)`);
  });

  test.each([
    "```ts\n[m12]\n```",
    "~~~\n[m12]\n~~~",
    "   ````\n```\n[m12]\n````",
    "~~~\n```\n[m12]\n~~~",
    "```\n[m12]\n``` not a closer\n[m12]\n```",
    "~~~\r\n[m12]\r\n~~~",
    "`[m12]`",
    "`` `[m12]` ``",
    "`across\n[m12]`",
    "[m12](https://example.com)",
    "[supplement [m12]](https://example.com/a_(b))",
    "[supplement [m12]](<https://example.com>)",
    String.raw`[escaped \[bracket\] [m12]](https://example.com)`,
    String.raw`[escaped \] [m12]](https://example.com)`,
    "[link](https://example.com/[m12])",
    "https://example.com/[m12]",
    "<https://example.com/[m12]>",
  ])("leaves protected text unchanged: %s", (protectedText) => {
    expect(linkMessageRefs(`${protectedText}\n[m12]`, resolve)).toBe(`${protectedText}\n${linked}`);
  });

  test("leaves an unclosed fence unchanged through the end of the stream", () => {
    expect(linkMessageRefs("[m12]\n~~~\n[m12]", resolve)).toBe(`${linked}\n~~~\n[m12]`);
  });

  test("a mismatched inline delimiter or invalid backtick fence does not start code", () => {
    expect(linkMessageRefs("`unclosed [m12]", resolve)).toBe(`\`unclosed ${linked}`);
    expect(linkMessageRefs("```invalid` [m12]", resolve)).toBe(`\`\`\`invalid\` ${linked}`);
  });

  test.each([1, 2, 3, 4])("handles %s preceding backslashes", (count) => {
    const prefix = "\\".repeat(count);
    expect(linkMessageRefs(`${prefix}[m12]`, resolve)).toBe(
      prefix + (count % 2 === 1 ? "[m12]" : linked),
    );
  });

  test("reading an already linked bot reply does not replace refs inside its label again", () => {
    const withRefAuthor = (ref: string): { label: string; url: string } | undefined =>
      ref === "m12" ? { label: String.raw`Alice \[m12\] の発言`, url } : undefined;
    const reply = linkMessageRefs("[m12]", withRefAuthor);
    expect(linkMessageRefs(reply, withRefAuthor)).toBe(reply);
    expect(linkMessageRefs(linked, resolve)).toBe(linked);
  });
});

test("resolver reads current targets, uses each message's channel, and escapes author Markdown", () => {
  const targets = new Map<string, MessageRefTarget>();
  const context: ConversationToolContext = {
    describeMessageRef: (ref) => targets.get(ref),
    resolveMessageRef: (ref) => targets.get(ref)?.messageId,
    readEarlierMessages: async () => "",
    viewAttachment: async () => "",
  };
  const resolver = createMessageRefResolver("guild", context);
  expect(linkMessageRefs("[m12]", resolver)).toBe("[m12]");
  targets.set("m12", {
    messageId: "message",
    channelId: "older-channel",
    author: "A[]*_`~|\\",
    kind: "user",
  });
  expect(linkMessageRefs("[m12]", resolver)).toBe(
    String.raw`[A\[\]\*\_\`\~\|\\` +
      " の発言](https://discord.com/channels/guild/older-channel/message)",
  );
  targets.set("m12", {
    messageId: "bot-message",
    channelId: "channel",
    author: "assistant",
    kind: "assistant",
  });
  expect(linkMessageRefs("[m12]", resolver)).toBe(
    "[bot の発言](https://discord.com/channels/guild/channel/bot-message)",
  );
});
