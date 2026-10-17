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

export function linkMessageRefs(
  text: string,
  resolve: (ref: string) => { label: string; url: string } | undefined,
): string {
  return transformOutsideCodeFences(text, (outside) => {
    let result = "";
    let replacedEnd = -1;
    for (let cursor = 0; cursor < outside.length; ) {
      const link = readLinkAt(outside, cursor);
      if (link) {
        result += link;
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
          result += outside.slice(cursor, end);
          cursor = end;
          continue;
        }
        result += run;
        cursor += run.length;
        continue;
      }
      if (outside[cursor] === "[" && !isEscaped(outside, cursor)) {
        const ref = /^\[(m\d+)\]/u.exec(outside.slice(cursor));
        const target = ref?.[1] ? resolve(ref[1]) : undefined;
        if (ref && target) {
          // `[m12][m13]` would otherwise render as one run of link text.
          if (replacedEnd === cursor) result += "、";
          result += `[${target.label}](${target.url})`;
          cursor += ref[0].length;
          replacedEnd = cursor;
          continue;
        }
      }
      result += outside[cursor];
      cursor++;
    }
    return result;
  });
}

export function createMessageRefResolver(
  guildId: string,
  context: ConversationToolContext,
): (ref: string) => { label: string; url: string } | undefined {
  return (ref) => {
    const target = context.describeMessageRef(ref);
    if (!target) return undefined;
    const author =
      target.kind === "assistant" ? "bot" : target.author.replace(/[[\]*_`~|\\]/gu, "\\$&");
    return {
      label: `${author} の発言`,
      url: `https://discord.com/channels/${guildId}/${target.channelId}/${target.messageId}`,
    };
  };
}
