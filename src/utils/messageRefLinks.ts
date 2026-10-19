import type { ConversationToolContext } from "../llm/tools/registry";

/** Share CommonMark fence handling with thematic breaks; keep original line endings. */
export function transformOutsideCodeFences(
  text: string,
  transform: (text: string) => string,
): string {
  let fence: { char: string; length: number } | undefined;
  let pending = "";
  let result = "";
  for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line.replace(/\r?\n$/u, ""));
    if (marker) {
      const [, run = "", rest = ""] = marker;
      if (!fence && !(run[0] === "`" && rest.includes("`"))) {
        result += transform(pending);
        pending = "";
        fence = { char: run[0] ?? "", length: run.length };
        result += line;
        continue;
      }
      if (fence && run[0] === fence.char && run.length >= fence.length && rest.trim() === "") {
        fence = undefined;
        result += line;
        continue;
      }
    }
    if (fence) result += line;
    else pending += line;
  }
  return result + transform(pending);
}

function isEscaped(text: string, cursor: number): boolean {
  let backslashes = 0;
  while (cursor > 0 && text[--cursor] === "\\") backslashes++;
  return backslashes % 2 === 1;
}

/** A complete masked link (nested/escaped brackets allowed), URL, or autolink. */
export function readLinkAt(text: string, cursor: number): string | undefined {
  if (text[cursor] === "[" && !isEscaped(text, cursor)) {
    let depth = 1;
    let end = cursor + 1;
    for (; end < text.length && depth > 0; end++) {
      if (text[end] === "\\") end++;
      else if (text[end] === "[") depth++;
      else if (text[end] === "]") depth--;
    }
    // Discord renders `[x](y)` as a link only when y is an http(s) URL, bare or
    // in `<>` as search results write it, and a URL holds no whitespace: a
    // missing `)` must not swallow a following code fence.
    if (depth === 0 && text[end] === "(" && /^<?https?:\/\//iu.test(text.slice(end + 1))) {
      depth = 1;
      for (end++; end < text.length && !/\s/u.test(text[end] ?? ""); end++) {
        if (text[end] === "\\") end++;
        else if (text[end] === "(") depth++;
        else if (text[end] === ")" && --depth === 0) return text.slice(cursor, end + 1);
      }
    }
  }
  if (text[cursor] === "<") {
    const end = text.indexOf(">", cursor + 1);
    const target = text.slice(cursor + 1, end);
    if (
      end !== -1 &&
      (/^[a-z][a-z\d+.-]*:[^\s<>]*$/iu.test(target) || /^[^\s<>@]+@[^\s<>@]+$/u.test(target))
    ) {
      return text.slice(cursor, end + 1);
    }
  }
  if (cursor === 0 || !/[\w]/u.test(text[cursor - 1] ?? "")) {
    const url = /[a-z][a-z\d+.-]*:\/\/[^\s<>]+/iy;
    url.lastIndex = cursor;
    return url.exec(text)?.[0];
  }
  return undefined;
}

export interface MessageRefLink {
  /** The author as written in prose, to find it beside the ref. */
  name: string;
  /** `<author> の発言`, Markdown-escaped. */
  label: string;
  url: string;
}

/** The label of a link whose sentence already names the message's author. */
export const UNNAMED_REF_LABEL = "発言";

interface Segment {
  kind: "link" | "code" | "text";
  text: string;
}

/** Splits text outside code fences into links, code spans, and the text between them. */
function segmentsOf(outside: string): Segment[] {
  const segments: Segment[] = [];
  let text = "";
  const push = (kind: Segment["kind"], value: string): void => {
    if (text) segments.push({ kind: "text", text });
    text = "";
    segments.push({ kind, text: value });
  };
  for (let cursor = 0; cursor < outside.length; ) {
    const link = readLinkAt(outside, cursor);
    if (link) {
      push("link", link);
      cursor += link.length;
      continue;
    }
    if (outside[cursor] === "`" && !isEscaped(outside, cursor)) {
      const run = /^`+/u.exec(outside.slice(cursor))?.[0] ?? "`";
      const runs = /`+/gu;
      runs.lastIndex = cursor + run.length;
      let closing = runs.exec(outside);
      while (closing && closing[0].length !== run.length) closing = runs.exec(outside);
      if (closing) {
        const end = closing.index + run.length;
        push("code", outside.slice(cursor, end));
        cursor = end;
        continue;
      }
      text += run;
      cursor += run.length;
      continue;
    }
    text += outside[cursor];
    cursor++;
  }
  if (text) segments.push({ kind: "text", text });
  return segments;
}

function sentenceAround(text: string, start: number, end: number): string {
  let from = 0;
  // A period may be followed by closing quotes or emphasis before the space.
  for (const match of text.slice(0, start).matchAll(/[。！？!?\n]|\.(?=["'”’)*_~]*\s)/gu)) {
    from = match.index + match[0].length;
  }
  const next = /[。！？!?\n]|\.(?=["'”’)*_~]*(?:\s|$))/u.exec(text.slice(end));
  return text.slice(from, next ? end + next.index : text.length);
}

/**
 * Models often name the author beside the ref (`[m2] で、田中さんの発言です`),
 * which with the author's label renders the name twice; instructions alone
 * did not stop it. The label is dropped rather than the prose, since telling
 * the model's naming apart from content would risk deleting the answer.
 * `prose` has links and code spans blanked out, so their punctuation ends no
 * sentence and a name inside them is not taken as written. A missed name (an
 * abbreviation's period, or punctuation in the name itself, ending the
 * sentence early) only keeps the label as it was.
 */
function namesAuthor(prose: string, start: number, end: number, name: string): boolean {
  // The model reads names with full-width parentheses (`authorNames`).
  const plain = (value: string): string => value.replace(/（/gu, "(").replace(/）/gu, ")");
  return (
    name.length > 0 &&
    plain(
      sentenceAround(prose, start, end)
        .replace(/\[m\d+\]/gu, "")
        .replace(/\\(.)/gu, "$1"),
    ).includes(plain(name))
  );
}

export function linkMessageRefs(
  text: string,
  resolve: (ref: string) => MessageRefLink | undefined,
): string {
  return transformOutsideCodeFences(text, (outside) => {
    const segments = segmentsOf(outside);
    const prose = segments
      .map((segment) =>
        segment.kind === "text" ? segment.text : "\u0000".repeat(segment.text.length),
      )
      .join("");
    let result = "";
    let replacedEnd = -1;
    let offset = 0;
    for (const segment of segments) {
      if (segment.kind !== "text") {
        result += segment.text;
        offset += segment.text.length;
        continue;
      }
      for (let index = 0; index < segment.text.length; ) {
        const cursor = offset + index;
        if (outside[cursor] === "[" && !isEscaped(outside, cursor)) {
          const ref = /^\[(m\d+)\]/u.exec(segment.text.slice(index));
          const target = ref?.[1] ? resolve(ref[1]) : undefined;
          if (ref && target) {
            // `[m12][m13]` would otherwise render as one run of link text.
            if (replacedEnd === cursor) result += "、";
            const end = cursor + ref[0].length;
            const label = namesAuthor(prose, cursor, end, target.name)
              ? UNNAMED_REF_LABEL
              : target.label;
            result += `[${label}](${target.url})`;
            index += ref[0].length;
            replacedEnd = end;
            continue;
          }
        }
        result += segment.text[index];
        index++;
      }
      offset += segment.text.length;
    }
    return result;
  });
}

/** `botName` labels the bot's own messages, which the window names `assistant`. */
export function createMessageRefResolver(
  guildId: string,
  context: ConversationToolContext,
  botName: string,
): (ref: string) => MessageRefLink | undefined {
  return (ref) => {
    const target = context.describeMessageRef(ref);
    if (!target) return undefined;
    const name = target.kind === "assistant" ? botName : target.author;
    return {
      name,
      label: `${name.replace(/[[\]*_`~|\\]/gu, "\\$&")} の発言`,
      url: `https://discord.com/channels/${guildId}/${target.channelId}/${target.messageId}`,
    };
  };
}
