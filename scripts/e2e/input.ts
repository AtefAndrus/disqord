/** Only message roles and text cross the child-process observation boundary. */
export interface InputText {
  role: "system" | "developer" | "user" | "assistant";
  text: string;
}

export type InputObservation = InputText[];
export const INPUT_PREFIX = "[e2e-input] ";
export const BOT_CONTEXT_PREFIX = "[e2e-bot-context] ";

export interface InputExpectation {
  /** Hidden fixture tokens, never copied into the trigger. */
  quote?: { tokens: string[]; excludedTokens: string[] };
  tweet?: { id: string; text: string };
}

export interface InputEvidence {
  marker: string;
  observations?: InputObservation[];
  botContextMarkers?: ReadonlySet<string>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeText(text: string): string {
  return text.replace(/data:[^\s;]+;base64,[A-Za-z0-9+/=]+/g, "[redacted data URL]");
}

/** Parses the wire body, discarding tools, reasoning, files, images, and all request metadata. */
export function observeResponsesBody(body: unknown): InputObservation | undefined {
  if (!record(body) || !Array.isArray(body.input)) return undefined;
  const messages: InputObservation = [];
  for (const item of body.input) {
    if (!record(item)) continue;
    const role = item.role;
    if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant")
      continue;
    const text =
      typeof item.content === "string"
        ? item.content
        : Array.isArray(item.content)
          ? item.content
              .flatMap((part: unknown) =>
                record(part) &&
                (part.type === "input_text" || part.type === "output_text") &&
                typeof part.text === "string"
                  ? [part.text]
                  : [],
              )
              .join("\n")
          : "";
    messages.push({ role, text: safeText(text) });
  }
  return messages;
}

export function parseInputLine(line: string): InputObservation | undefined {
  if (!line.startsWith(INPUT_PREFIX)) return undefined;
  try {
    const parsed: unknown = JSON.parse(line.slice(INPUT_PREFIX.length));
    if (!Array.isArray(parsed)) return undefined;
    if (
      !parsed.every(
        (item: unknown) =>
          record(item) &&
          typeof item.text === "string" &&
          ["system", "developer", "user", "assistant"].includes(String(item.role)),
      )
    )
      return undefined;
    return parsed.map((item: InputText) => ({ role: item.role, text: safeText(item.text) }));
  } catch {
    return undefined;
  }
}

export function botContextMarker(content: string): string | undefined {
  return content.match(/\[e2e-bot-context:[0-9a-f-]{36}\]/)?.[0];
}

function currentMessage(observation: InputObservation, marker: string): InputText | undefined {
  // A marker seen only inside a historical quote cannot select that request.
  return observation.find(
    (message) => message.text.includes(marker) && !/^\[m\d+\] /u.test(message.text),
  );
}

export function selectInput(evidence: InputEvidence): InputObservation | undefined {
  // Inspect the initial request: a later tool result must not repair missing input.
  return evidence.observations?.find((observation) => currentMessage(observation, evidence.marker));
}

function occurrences(text: string, token: string): number {
  return text.split(token).length - 1;
}

/** Independent of the model's answer; no observation is always a failed assertion. */
export function checkInput(expectation: InputExpectation, evidence: InputEvidence): string[] {
  if (!evidence.observations)
    return ["cannot verify LLM input under --no-spawn: child preload is unavailable"];
  const input = selectInput(evidence);
  if (!input) return ["no observed POST /responses matches this trigger's marker"];
  const current = currentMessage(input, evidence.marker);
  const problems: string[] = [];
  if (current?.role !== "user") problems.push("the current trigger is not a user message");
  if (expectation.quote) {
    if (!evidence.botContextMarkers?.has(evidence.marker))
      problems.push(
        "preload did not disable the tester's human-history exemption for this trigger",
      );
    const { tokens, excludedTokens } = expectation.quote;
    const quotes = input.filter((message) => tokens.some((token) => message.text.includes(token)));
    const quote = quotes[0];
    if (
      quotes.length !== 1 ||
      !quote ||
      !tokens.every(
        (token) =>
          input.reduce((count, message) => count + occurrences(message.text, token), 0) === 1 &&
          quote.text.includes(token),
      )
    )
      problems.push("the selected Bot fixture's text/Embed/V2 tokens are missing or duplicated");
    if (quote?.role !== "user") problems.push("the selected Bot quote is not a user message");
    const ref = quote?.text.match(/^\[(m\d+)\] [^\n]+: /u)?.[1];
    if (
      !ref ||
      !current?.text.startsWith("[current] ") ||
      !current.text.split("\n", 1)[0]?.includes(` (reply to [${ref}]): `)
    )
      problems.push("the current message does not point to the selected Bot quote's ref");
    for (const token of excludedTokens) {
      if (input.some((message) => message.text.includes(token)))
        problems.push("an unrelated Bot message leaked into the normal history window");
    }
  }
  if (expectation.tweet) {
    const { id, text } = expectation.tweet;
    const blocks =
      current?.text.match(/<untrusted-tweet url="[^"]+">[\s\S]*?<\/untrusted-tweet>/gu) ?? [];
    const block = blocks.find((candidate) =>
      candidate.startsWith(`<untrusted-tweet url="https://x.com/i/status/${id}">`),
    );
    if (!block?.includes(`本文:\n${text}\n`))
      problems.push(
        "the current user input lacks the fetched untrusted-tweet block and post body (a URL or model answer is insufficient)",
      );
  }
  return problems;
}
