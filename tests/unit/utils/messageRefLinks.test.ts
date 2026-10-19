import { describe, expect, test } from "bun:test";
import type { ConversationToolContext, MessageRefTarget } from "../../../src/llm/tools/registry";
import {
  createMessageRefResolver,
  linkMessageRefs,
  type MessageRefLink,
} from "../../../src/utils/messageRefLinks";

const url = "https://discord.com/channels/guild/channel/message";
const linked = `[Alice の発言](${url})`;
const unnamed = `[発言](${url})`;
const resolve = (ref: string): MessageRefLink | undefined =>
  ref === "m12" ? { name: "Alice", label: "Alice の発言", url } : undefined;

describe("linkMessageRefs", () => {
  test("links known bracketed refs, leaving bare, unknown, and incomplete refs alone", () => {
    expect(linkMessageRefs("[m12] m12 m3.medium [m13] [m1", resolve)).toBe(
      `${linked} m12 m3.medium [m13] [m1`,
    );
    expect(linkMessageRefs("[m12] and [m12]", resolve)).toBe(`${linked} and ${linked}`);
    const both = (ref: string): MessageRefLink | undefined =>
      ref === "m12" || ref === "m13"
        ? { name: `author-${ref}`, label: `${ref} の発言`, url: `${url}/${ref}` }
        : undefined;
    // Adjacent masked links would read as one run of blue text.
    expect(linkMessageRefs("[m12][m13] と [m12] [m13]", both)).toBe(
      `[m12 の発言](${url}/m12)、[m13 の発言](${url}/m13) と [m12 の発言](${url}/m12) [m13 の発言](${url}/m13)`,
    );
    expect(linkMessageRefs("<[m12]>", resolve)).toBe(`<${linked}>`);
    expect(linkMessageRefs("[m12](Bob)", resolve)).toBe(`${linked}(Bob)`);
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

  test.each([
    [
      "after the ref",
      "一番古いのは [m12] で、Alice さんの発言です。",
      `一番古いのは ${unnamed} で、Alice さんの発言です。`,
    ],
    [
      "before the ref",
      "提案したのは Alice さんです [m12]",
      `提案したのは Alice さんです ${unnamed}`,
    ],
    ["beside another ref", "Alice の案 [m12][m13] です", `Alice の案 ${unnamed}[m13] です`],
  ])("drops the author from the label when the sentence names them %s", (_, text, expected) => {
    expect(linkMessageRefs(text, resolve)).toBe(expected);
  });

  test.each([
    [
      "。",
      "Alice が提案した。一番古いのは [m12] です。",
      `Alice が提案した。一番古いのは ${linked} です。`,
    ],
    ["！", "Alice です！根拠は [m12]", `Alice です！根拠は ${linked}`],
    ["a line break", "- Alice\n- [m12]", `- Alice\n- ${linked}`],
    ["a period and a space", "Alice did. See [m12].", `Alice did. See ${linked}.`],
    [
      "a period before emphasis",
      "**Alice has answered.** See [m12].",
      `**Alice has answered.** See ${linked}.`,
    ],
    [
      "a period before a quote",
      'Alice said "hello." See [m12].',
      `Alice said "hello." See ${linked}.`,
    ],
    [
      "a period before a corner bracket",
      "Alice said 「hello.」 See [m12].",
      `Alice said 「hello.」 See ${linked}.`,
    ],
    [
      "a later sentence",
      "[m12] です。Alice さんにも聞いた",
      `${linked} です。Alice さんにも聞いた`,
    ],
  ])("keeps the author in the label when %s separates the name", (_, text, expected) => {
    expect(linkMessageRefs(text, resolve)).toBe(expected);
  });

  test.each([
    [
      "a code span",
      "Alice の案 `status?` は [m12] です",
      `Alice の案 \`status?\` は ${unnamed} です`,
    ],
    [
      "a link destination",
      "Alice の案 [資料](https://example.com/?id=1) は [m12] です",
      `Alice の案 [資料](https://example.com/?id=1) は ${unnamed} です`,
    ],
    [
      "a bare URL",
      "Alice の案 https://example.com/?id=1 は [m12]",
      `Alice の案 https://example.com/?id=1 は ${unnamed}`,
    ],
  ])("punctuation inside %s does not end the sentence", (_, text, expected) => {
    expect(linkMessageRefs(text, resolve)).toBe(expected);
  });

  test.each([
    ["a link destination", "[資料](https://example.com/Alice) と [m12] を参照"],
    ["a bare URL", "https://example.com/Alice と [m12] を参照"],
    ["an autolink", "<https://example.com/Alice> と [m12] を参照"],
    [
      "a link destination with parentheses",
      "[資料](https://example.com/a_(b)/Alice) と [m12] を参照",
    ],
    ["a double-backtick code span", "`` Alice `x` `` と [m12] を参照"],
  ])("a name only inside %s is not taken as written", (_, text) => {
    expect(linkMessageRefs(text, resolve)).toBe(text.replace("[m12]", linked));
  });

  test("a period inside a word does not end the sentence", () => {
    expect(linkMessageRefs("Alice uses m3.medium [m12]", resolve)).toBe(
      `Alice uses m3.medium ${unnamed}`,
    );
  });

  test.each([
    ["full-width parentheses as the model reads them", "A(B)", "A（B） の案 [m12]"],
    ["escaped backticks, which are not code", "A`B`C", "A\\`B\\`C の案 [m12]"],
  ])("finds a name written with %s", (_, name, text) => {
    const named = (ref: string): MessageRefLink | undefined =>
      ref === "m12" ? { name, label: "x の発言", url } : undefined;
    expect(linkMessageRefs(text, named)).toBe(text.replace("[m12]", unnamed));
  });

  test("an empty name never drops the label", () => {
    const blank = (ref: string): MessageRefLink | undefined =>
      ref === "m12" ? { name: "", label: "Alice の発言", url } : undefined;
    expect(linkMessageRefs("[m12] です", blank)).toBe(`${linked} です`);
  });

  test("reading an already linked bot reply does not replace refs inside its label again", () => {
    const withRefAuthor = (ref: string): MessageRefLink | undefined =>
      ref === "m12"
        ? { name: "Alice [m12]", label: String.raw`Alice \[m12\] の発言`, url }
        : undefined;
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
  const resolver = createMessageRefResolver("guild", context, "Dis*Qord");
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
    "[Dis\\*Qord の発言](https://discord.com/channels/guild/channel/bot-message)",
  );
  // The bot is found by its own name, unescaped, as prose writes it.
  expect(linkMessageRefs("Dis*Qord の回答は [m12]", resolver)).toBe(
    "Dis*Qord の回答は [発言](https://discord.com/channels/guild/channel/bot-message)",
  );
  expect(linkMessageRefs("Dis\\*Qord の回答は [m12]", resolver)).toBe(
    "Dis\\*Qord の回答は [発言](https://discord.com/channels/guild/channel/bot-message)",
  );
});
