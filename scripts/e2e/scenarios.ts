import { STREAMING_LABEL } from "../../src/utils/chatContainerBuilder";
import { PDF_DATA, PNG_DATA } from "./fixtures";

export interface DiscordMessage {
  id: string;
  content: string;
  edited_timestamp?: string | null;
  author: { id: string; username: string };
  components?: unknown[];
}

export interface Reply {
  messages: DiscordMessage[];
  /** Every text and button label found in the reply's components, in order. */
  text: string;
}

export interface Scenario {
  name: string;
  /** Run only when named on the command line. */
  manual?: boolean;
  prompt: string;
  files?: { name: string; type: string; data: Uint8Array<ArrayBuffer> }[];
  timeoutMs?: number;
  /** Returns the reasons the reply is wrong; empty means it passed. */
  check: (reply: Reply) => string[];
}

const STOP_BUTTON = "[button:停止]";

function collectText(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  if (typeof record.content === "string") out.push(record.content);
  if (typeof record.label === "string") out.push(`[button:${record.label}]`);
  collectText(record.components, out);
  collectText(record.accessory, out);
}

export function toReply(messages: DiscordMessage[]): Reply {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.content) parts.push(message.content);
    collectText(message.components, parts);
  }
  return { messages, text: parts.join("\n") };
}

export function isStreaming(reply: Reply): boolean {
  return reply.text.includes(STREAMING_LABEL) || reply.text.includes(STOP_BUTTON);
}

/** Changes whenever a message is added, removed, or edited. */
export function snapshotKey(reply: Reply): string {
  return reply.messages.map((m) => `${m.id}@${m.edited_timestamp ?? ""}`).join(",");
}

const hasFooter = (reply: Reply): string[] =>
  /Tokens: \d+\+\d+=\d+/.test(reply.text) && /Provider: \S/.test(reply.text)
    ? []
    : ["no usage footer with Tokens and Provider (is llm-details on for this guild?)"];

function checkPages(reply: Reply): string[] {
  const pages = [...reply.text.matchAll(/ページ (\d+)\/(\d+)/g)];
  const last = pages.at(-1);
  if (!last) return ["no page footer (ページ n/m)"];
  const [, page, total] = last;
  if (page !== total)
    return [`the last page footer is ${page}/${total}, so the reply is incomplete`];
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
      ...(reply.text.includes("接続確認OK") ? [] : ["the reply does not contain 接続確認OK"]),
      ...hasFooter(reply),
    ],
  },
  {
    name: "long",
    prompt:
      "[e2e] 日本の四季それぞれについて各1500字以上、合計6000字以上の随筆を書いて。途中にPythonのコードブロックを1つ入れて。",
    timeoutMs: 300_000,
    check: (reply) => [...checkPages(reply), ...hasFooter(reply)],
  },
  {
    name: "image",
    // A made-up token the model can only produce by seeing the color: a bare
    // /red/ also matches "An image is required".
    prompt:
      "[e2e] この画像を塗りつぶしている色が赤なら COLOR-RED、青なら COLOR-BLUE、画像が見えなければ NO-IMAGE とだけ答えて。",
    files: [{ name: "square.png", type: "image/png", data: PNG_DATA }],
    check: (reply) => [
      ...(reply.text.includes("COLOR-RED") ? [] : ["the reply is not COLOR-RED"]),
      ...hasFooter(reply),
    ],
  },
  {
    name: "pdf",
    prompt: "[e2e] このPDFに書かれている secret word を1語で答えて。",
    files: [{ name: "secret.pdf", type: "application/pdf", data: PDF_DATA }],
    check: (reply) => [
      ...(/\bPINEAPPLE\b/i.test(reply.text)
        ? []
        : ["the reply does not contain the word in the PDF"]),
      ...hasFooter(reply),
    ],
  },
  {
    name: "stop",
    manual: true,
    prompt:
      "[e2e: 手動確認] 世界の主要な河川20本をそれぞれ500字以上で解説して。（この返信の「停止」ボタンを押してください）",
    timeoutMs: 600_000,
    // The stopped footer, not the word: a finished answer about rivers may
    // well contain "Stopped" in its body.
    check: (reply) =>
      /🛑 Stopped \| \d+(\.\d+)?s/u.test(reply.text)
        ? []
        : ["the reply did not end with the stopped footer (nobody pressed 停止 in time)"],
  },
];
