import { WINDOW_RAW_MESSAGE_LIMIT } from "../../src/services/conversationWindow";
import { EmbedColors } from "../../src/types/embed";
import {
  extractComponentsV2Footer,
  type RawDiscordMessage,
} from "../../src/utils/discordMessageNormalizer";
import { buildDigitsPng, buildPdfData, PDF_DATA, PNG_DATA } from "./fixtures";

export interface DiscordMessage {
  id: string;
  content: string;
  edited_timestamp?: string | null;
  author: { id: string; username: string };
  components?: unknown[];
  attachments?: { id: string; filename: string }[];
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
  setup?: {
    prompt: string;
    mention?: boolean;
    files?: Scenario["files"];
    fillerCount?: number;
  };
  mention?: boolean;
  files?: { name: string; type: string; data: Uint8Array<ArrayBuffer> }[];
  toolName?: "read_earlier_messages" | "view_attachment";
  timeoutMs?: number;
  /** Returns the reasons the reply is wrong; empty means it passed. */
  check: (reply: Reply) => string[];
}

// Discord component types.
const TEXT_DISPLAY = 10;
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
  const raw: RawDiscordMessage = {
    id: message.id,
    channel_id: "",
    content: message.content,
    timestamp: "",
    author: message.author,
    components: message.components,
  };
  return extractComponentsV2Footer(raw);
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

/** Fresh per run so that history-recall can only pass through stored history. */
const HISTORY_PASSPHRASE = `sorama-${crypto.randomUUID().slice(0, 8)}`;
const READ_EARLIER_TOKEN = `earlier-${crypto.randomUUID().slice(0, 8)}`;
// 実行ごとに変える: 固定値だと、窓に残った前回の回答から答えても通ってしまう。
const WINDOW_TOKEN = `window-${crypto.randomUUID().slice(0, 8)}`;
const VIEW_ATTACHMENT_TOKEN = `ATTACH-${crypto.randomUUID().replaceAll("-", "")}`;
// 数字だけにする: 画像から読ませるので、見間違えやすい英字を入れない。
// 先頭を 0 にしない: 数として答えると先頭の 0 が落ち、正しく読めていても落ちる。
const VIEW_IMAGE_TOKEN = String(
  100_000 + ((crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 900_000),
);

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
    name: "tweet",
    prompt: "[e2e] https://x.com/jack/status/20 の本文を答えて。",
    check: (reply) => [
      ...(reply.isError ? ["the tweet reply ended in an error"] : []),
      ...(reply.body.includes("twttr") ? [] : ["the reply does not contain twttr"]),
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
    // date. `Searches: N` in the footer counts search calls the model made,
    // including ones refused past `max_uses`, so it alone does not show that
    // a search returned anything, and the result-link check is a text match
    // on the body, which a model writing the same heading and list itself
    // would also pass. Together they catch the common failures (search off,
    // links not appended) without proving where the links came from; the
    // unit tests of openrouter.ts and messageCreate.ts pin that. A model
    // that already knows the date still passes, so this does not show that
    // the answer came from the search.
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
      ...(/^-# 検索結果\n- \[.+\]\(<https?:\/\/[^>\s]+>\)$/m.test(reply.body)
        ? []
        : ["the reply lists no search results (the search returned nothing)"]),
      ...(/^公開日:\s*2026-08-20\s*$/m.test(reply.body.normalize("NFKC").replace(/[*`]/g, ""))
        ? []
        : ["the reply has no 公開日: 2026-08-20 line"]),
      ...hasUsageFooter(reply),
    ],
  },
  {
    // Requires `/config reasoning-display on`, `/config history on`, and a
    // model/provider that returns displayable reasoning. The tool call makes
    // the loop send the first turn's reasoning items back to OpenRouter, so
    // a rejected resend shows up as an error reply here.
    name: "reasoning",
    manual: true,
    toolName: "read_earlier_messages",
    prompt:
      "[e2e] 必ず read_earlier_messages を 1 回呼んでから、5 人を円卓に並べる並べ方が何通りあるか（回転は同じとみなす）を考え、数だけを短く答えて。",
    check: (reply) => [
      ...(reply.isError ? ["the reasoning reply ended in an error"] : []),
      ...(reply.messages
        .at(-1)
        ?.attachments?.some((attachment) => attachment.filename === "reasoning.md")
        ? []
        : [
            "the final message has no reasoning.md attachment (is reasoning display enabled and supported?)",
          ]),
      ...hasUsageFooter(reply),
    ],
  },
  {
    // Paired with history-recall, which must run right after it. The
    // passphrase is new on every run, so only the stored history can supply
    // it: a model cannot know it, and an earlier run's value does not match.
    // Needs `/config history on` in the guild under test.
    name: "history-set",
    manual: true,
    prompt: `[e2e] 合言葉は「${HISTORY_PASSPHRASE}」です。覚えておいて、「了解」とだけ返事をして。`,
    check: (reply) => hasUsageFooter(reply),
  },
  {
    name: "history-recall",
    manual: true,
    prompt: "[e2e] さっき伝えた合言葉を、「合言葉: 」に続けて1行で答えて。",
    check: (reply) => [
      ...(reply.body.includes(HISTORY_PASSPHRASE)
        ? []
        : [
            `the reply does not contain the passphrase ${HISTORY_PASSPHRASE} (is /config history on?)`,
          ]),
      ...hasUsageFooter(reply),
    ],
  },
  {
    name: "history-window",
    manual: true,
    setup: {
      prompt: `[e2e] 窓の確認用の合言葉は ${WINDOW_TOKEN} です。`,
      mention: false,
    },
    prompt: "[e2e] メンションなしで直前に投稿された合言葉を答えて。",
    check: (reply) => [
      ...(reply.body.includes(WINDOW_TOKEN)
        ? []
        : ["the reply does not include the unmentioned message"]),
      ...hasUsageFooter(reply),
    ],
  },
  {
    name: "read-earlier",
    manual: true,
    toolName: "read_earlier_messages",
    setup: {
      prompt: `[e2e] 過去の発言に含める確認用トークンは ${READ_EARLIER_TOKEN} です。`,
      mention: false,
      fillerCount: WINDOW_RAW_MESSAGE_LIMIT,
    },
    prompt:
      "[e2e] 必ず read_earlier_messages を呼び出してから、取得した発言に含まれていた確認用トークンをそのまま答えて。",
    check: (reply) => [
      ...(reply.body.includes(READ_EARLIER_TOKEN)
        ? []
        : [`the reply does not contain the earlier-history token ${READ_EARLIER_TOKEN}`]),
      ...hasUsageFooter(reply),
    ],
  },
  {
    name: "view-attachment",
    manual: true,
    toolName: "view_attachment",
    setup: {
      prompt: "[e2e] この添付ファイルを後で参照できるようにしておいて。",
      mention: false,
      files: [
        {
          name: "attachment.pdf",
          type: "application/pdf",
          data: buildPdfData(VIEW_ATTACHMENT_TOKEN, undefined, 12),
        },
      ],
    },
    // The token is generated per run and is absent from the prompt, so only a successful PDF tool read can reveal it.
    prompt:
      "[e2e] 必ず view_attachment で直前の添付ファイルを開き、添付ファイル内のトークンをそのまま答えて。",
    check: (reply) => [
      ...(reply.body.includes(VIEW_ATTACHMENT_TOKEN)
        ? []
        : ["the reply did not report the token from the attachment"]),
      ...hasUsageFooter(reply),
    ],
  },
  {
    // The image path of view_attachment returns the picture as an
    // input_image part, which some models behind OpenRouter drop silently,
    // so a failure here can be the model rather than the code: the FAIL
    // line names the model that answered.
    name: "view-image",
    manual: true,
    toolName: "view_attachment",
    setup: {
      prompt: "[e2e] この画像を後で参照できるようにしておいて。",
      mention: false,
      files: [{ name: "digits.png", type: "image/png", data: buildDigitsPng(VIEW_IMAGE_TOKEN) }],
    },
    prompt:
      "[e2e] 必ず view_attachment で直前の画像を開き、画像に書かれた 6 桁の数字を「数字: 」に続けて1行で答えて。",
    check: (reply) => [
      ...(reply.body.includes(VIEW_IMAGE_TOKEN)
        ? []
        : [`the reply does not contain the number ${VIEW_IMAGE_TOKEN} drawn in the image`]),
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
