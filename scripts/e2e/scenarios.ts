import { EmbedColors } from "../../src/types/embed";
import { PDF_DATA, PNG_DATA } from "./fixtures";

export interface DiscordMessage {
  id: string;
  content: string;
  edited_timestamp?: string | null;
  author: { id: string; username: string };
  components?: unknown[];
}

/**
 * A reply as the scenarios see it. `body` and `footers` are told apart by
 * where the renderer puts them, never by what they say: the answer is model
 * output and may quote any footer, label, or error heading verbatim.
 */
export interface Reply {
  messages: DiscordMessage[];
  /** Every text of every page except the footers (so: model badge and answer). */
  body: string;
  /** The footer of each page that has one, in page order. */
  footers: string[];
  /** True when the reply ends in an error container (alone, or after the partial pages a failed stream leaves behind). */
  isError: boolean;
}

export interface Scenario {
  name: string;
  /** Run only when named on the command line. */
  manual?: boolean;
  /** What the person running the script has to do in Discord, printed once the prompt is sent. */
  userAction?: string;
  prompt: string;
  files?: { name: string; type: string; data: Uint8Array<ArrayBuffer> }[];
  timeoutMs?: number;
  /** Returns the reasons the reply is wrong; empty means it passed. */
  check: (reply: Reply) => string[];
}

// Discord component types.
const TEXT_DISPLAY = 10;
const SEPARATOR = 14;
const CONTAINER = 17;
const STOP_BUTTON_ID_PREFIX = "stop_response_";

type Component = Record<string, unknown>;

function isComponent(node: unknown): node is Component {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

function containerOf(message: DiscordMessage): Component | undefined {
  return (message.components ?? []).filter(isComponent).find((c) => c.type === CONTAINER);
}

function childrenOf(container: Component | undefined): Component[] {
  return Array.isArray(container?.components) ? container.components.filter(isComponent) : [];
}

/**
 * `buildFinalContainer` and `buildStoppedContainer` end a page with a
 * Separator followed by one TextDisplay; nothing in the answer body can
 * produce a Separator, so that position identifies the footer.
 */
function footerOf(message: DiscordMessage): string | undefined {
  const children = childrenOf(containerOf(message));
  const last = children.at(-1);
  const beforeLast = children.at(-2);
  if (last?.type === TEXT_DISPLAY && beforeLast?.type === SEPARATOR) {
    return typeof last.content === "string" ? last.content : undefined;
  }
  return undefined;
}

function collectText(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return;
  }
  if (!isComponent(node)) return;
  if (typeof node.content === "string") out.push(node.content);
  collectText(node.components, out);
  collectText(node.accessory, out);
}

/** `buildErrorContainer`: a red container holding exactly one TextDisplay that opens with the warning heading. */
function isErrorContainer(message: DiscordMessage): boolean {
  const container = containerOf(message);
  const children = childrenOf(container);
  const only = children[0];
  return (
    container?.accent_color === EmbedColors.RED &&
    children.length === 1 &&
    only?.type === TEXT_DISPLAY &&
    typeof only.content === "string" &&
    only.content.startsWith("## ⚠️ ")
  );
}

export function toReply(messages: DiscordMessage[]): Reply {
  const body: string[] = [];
  const footers: string[] = [];
  const lastMessage = messages.at(-1);
  for (const message of messages) {
    const footer = footerOf(message);
    const texts: string[] = [];
    if (message.content) texts.push(message.content);
    collectText(message.components, texts);
    if (footer !== undefined) {
      footers.push(footer);
      texts.pop(); // the footer is the last text collected
    }
    body.push(...texts);
  }
  return {
    messages,
    body: body.join("\n"),
    footers,
    isError: lastMessage !== undefined && isErrorContainer(lastMessage),
  };
}

function hasStopButton(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasStopButton);
  if (!isComponent(node)) return false;
  if (typeof node.custom_id === "string" && node.custom_id.startsWith(STOP_BUTTON_ID_PREFIX)) {
    return true;
  }
  return hasStopButton(node.components) || hasStopButton(node.accessory);
}

export function isStreaming(reply: Reply): boolean {
  return reply.messages.some((message) => hasStopButton(message.components));
}

/** Changes whenever a message is added, removed, or edited. */
export function snapshotKey(reply: Reply): string {
  return reply.messages.map((m) => `${m.id}@${m.edited_timestamp ?? ""}`).join(",");
}

const USAGE_FOOTER = /Tokens: \d+\+\d+=\d+/;
const STOPPED_FOOTER = /^🛑 Stopped \| \d+(\.\d+)?s/u;

function lastPageFooter(reply: Reply): string | undefined {
  const lastMessage = reply.messages.at(-1);
  return lastMessage ? footerOf(lastMessage) : undefined;
}

/**
 * A reply is finished only when it shows a terminal state: the usage footer
 * of a final reply, the stopped footer, or an error container. "No stop
 * button" alone is not enough. The updater drops the streaming section from
 * one page before it sends the next, and that send can take longer than any
 * fixed quiet period, so an unfinished first page looks exactly like that.
 *
 * The usage footer exists only when `llm-details` is on for the guild, which
 * is why the scenarios require it.
 */
export function isFinished(reply: Reply): boolean {
  if (reply.messages.length === 0 || isStreaming(reply)) return false;
  if (reply.isError) return true;
  const footer = lastPageFooter(reply);
  return footer !== undefined && (USAGE_FOOTER.test(footer) || STOPPED_FOOTER.test(footer));
}

/** The model id the bot reports in its usage footer, for the run log. */
export function modelOf(reply: Reply): string | undefined {
  return lastPageFooter(reply)?.match(/Model: (\S+)/)?.[1];
}

/** The cost in USD the bot reports in its usage footer (summed over every turn of the request), for the run log. */
export function costOf(reply: Reply): number | undefined {
  const match = lastPageFooter(reply)?.match(/Cost: \$(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : undefined;
}

function hasUsageFooter(reply: Reply): string[] {
  const footer = lastPageFooter(reply) ?? "";
  return USAGE_FOOTER.test(footer) && /Provider: \S/.test(footer)
    ? []
    : ["the last page has no usage footer with Tokens and Provider"];
}

function checkPages(reply: Reply): string[] {
  const last = (lastPageFooter(reply) ?? "").match(/ページ (\d+)\/(\d+)/);
  if (!last) return ["the last page has no page footer (ページ n/m)"];
  const [, page, total] = last;
  if (page !== total) {
    return [`the last page footer is ${page}/${total}, so the reply is incomplete`];
  }
  if (Number(total) < 2) return [`expected the reply to be split, got ${total} page`];
  if (reply.messages.length !== Number(total)) {
    return [`the footer says ${total} pages but ${reply.messages.length} messages arrived`];
  }
  return [];
}

export const SCENARIOS: Scenario[] = [
  {
    name: "chat",
    prompt: "[e2e] 「接続確認OK」という語を含めて、1文で返事をして。",
    check: (reply) => [
      ...(reply.body.includes("接続確認OK") ? [] : ["the reply does not contain 接続確認OK"]),
      ...hasUsageFooter(reply),
    ],
  },
  {
    name: "long",
    prompt:
      "[e2e] 日本の四季それぞれについて各1500字以上、合計6000字以上の随筆を書いて。途中にPythonのコードブロックを1つ入れて。",
    timeoutMs: 300_000,
    check: (reply) => [...checkPages(reply), ...hasUsageFooter(reply)],
  },
  {
    name: "image",
    // Made-up tokens the model can only choose between by seeing the color
    // (a bare /red/ also matches "An image is required"). The prompt names
    // every token, so a reply that names more than one proves nothing.
    prompt:
      "[e2e] この画像を塗りつぶしている色が赤なら COLOR-RED、青なら COLOR-BLUE、画像が見えなければ NO-IMAGE とだけ答えて。",
    files: [{ name: "square.png", type: "image/png", data: PNG_DATA }],
    check: (reply) => [
      ...(reply.body.includes("COLOR-RED") ? [] : ["the reply is not COLOR-RED"]),
      ...(/NO-IMAGE|COLOR-BLUE/.test(reply.body) ? ["the reply also names another answer"] : []),
      ...hasUsageFooter(reply),
    ],
  },
  {
    name: "pdf",
    prompt: "[e2e] このPDFに書かれている secret word を1語で答えて。",
    files: [{ name: "secret.pdf", type: "application/pdf", data: PDF_DATA }],
    check: (reply) => [
      ...(/\bPINEAPPLE\b/i.test(reply.body)
        ? []
        : ["the reply does not contain the word in the PDF"]),
      ...hasUsageFooter(reply),
    ],
  },
  {
    // Manual because it passes only after `/config web-search on` in the
    // guild under test, and every search is billed. The GitHub release
    // bun-v1.4.0 was published 2026-08-20T14:07:21Z: a fixed answer, unlike
    // a "latest version" that moves with every release. Naming the tag and
    // UTC keeps the model from answering a patch release or an announcement
    // date. A model that already knows the date still passes, so this proves
    // that a search ran and the answer is right, not that the answer came
    // from the search.
    name: "search",
    manual: true,
    prompt:
      "[e2e] Web 検索で、oven-sh/bun の GitHub Release のうちタグ bun-v1.4.0 の公開日を UTC で調べて、「公開日: YYYY-MM-DD」の形の1行で答えて。",
    check: (reply) => [
      ...(/(?:^|\|)\s*Searches:\s*[1-9]\d*(?:\s*\([^)|]*\))?\s*(?=\||$)/.test(
        lastPageFooter(reply) ?? "",
      )
        ? []
        : ["the usage footer reports no web search (is /config web-search on?)"]),
      ...(/^公開日:\s*2026-08-20\s*$/m.test(reply.body.normalize("NFKC").replace(/[*`]/g, ""))
        ? []
        : ["the reply has no 公開日: 2026-08-20 line"]),
      ...hasUsageFooter(reply),
    ],
  },
  {
    name: "stop",
    manual: true,
    userAction: "press 停止 on the reply",
    prompt:
      "[e2e: 手動確認] 世界の主要な河川20本をそれぞれ500字以上で解説して。（この返信の「停止」ボタンを押してください）",
    timeoutMs: 600_000,
    check: (reply) =>
      STOPPED_FOOTER.test(lastPageFooter(reply) ?? "")
        ? []
        : ["the reply did not end with the stopped footer (nobody pressed 停止 in time)"],
  },
];
