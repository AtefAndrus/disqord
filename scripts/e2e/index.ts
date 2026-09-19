/**
 * End-to-end check against real Discord and the real LLM API.
 *
 * A second bot account (the "tester") posts into a dedicated channel over
 * REST, mentioning the bot under test, and the replies are read back over
 * REST and asserted on. Nothing here automates a user account: Discord
 * forbids that, and a bot can do everything these scenarios need except
 * clicking a button (see `stop`, which waits for a human to click).
 *
 * Usage:
 *   bun run e2e                 run the default scenarios (chat, long, image, pdf)
 *   bun run e2e chat pdf        run the named scenarios
 *   bun run e2e stop            post a long request and wait for someone to press 停止
 *   bun run e2e --no-spawn ...  use a bot that is already running instead of starting one
 *
 * Not part of CI on purpose: it needs two bot tokens and an LLM key, costs
 * money per run, and its failures are as often the network or the model as
 * the code.
 */
import { loadConfig } from "../../src/config";
import { STREAMING_LABEL } from "../../src/utils/chatContainerBuilder";
import { PDF_DATA, PNG_DATA } from "./fixtures";

const API = "https://discord.com/api/v10";
const POLL_INTERVAL_MS = 2_000;
const REPLY_TIMEOUT_MS = 180_000;
const MANUAL_STOP_TIMEOUT_MS = 600_000;
const BOT_READY_TIMEOUT_MS = 30_000;

interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; username: string };
  components?: unknown[];
  attachments?: { filename: string }[];
}

interface Reply {
  messages: DiscordMessage[];
  /** Every text and button label found in the reply's components, in order. */
  text: string;
}

interface Scenario {
  name: string;
  /** Run only when named on the command line. */
  manual?: boolean;
  prompt: string;
  files?: { name: string; type: string; data: Uint8Array<ArrayBuffer> }[];
  timeoutMs?: number;
  /** Returns the reasons the reply is wrong; empty means it passed. */
  check: (reply: Reply) => string[];
}

const config = loadConfig();
const testerToken = process.env.E2E_TESTER_BOT_TOKEN;
const channelId = process.env.E2E_CHANNEL_ID;
const botId = config.applicationId;

function requireEnv(): void {
  const missing = [
    ["E2E_TESTER_BOT_TOKEN", testerToken],
    ["E2E_TESTER_BOT_ID", config.e2eTesterBotId],
    ["E2E_CHANNEL_ID", channelId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(", ")}. With NODE_ENV=production E2E_TESTER_BOT_ID is ignored.`,
    );
  }
}

async function discord(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bot ${testerToken}`, ...init.headers },
  });
  if (response.status === 429) {
    const body = (await response.json()) as { retry_after?: number };
    await Bun.sleep(Math.ceil((body.retry_after ?? 1) * 1000));
    return discord(path, init);
  }
  return response;
}

async function send(scenario: Scenario): Promise<string> {
  const payload = {
    content: `<@${botId}> ${scenario.prompt}`,
    allowed_mentions: { users: [botId] },
    attachments: (scenario.files ?? []).map((file, id) => ({ id, filename: file.name })),
  };
  const form = new FormData();
  form.set("payload_json", JSON.stringify(payload));
  for (const [index, file] of (scenario.files ?? []).entries()) {
    form.set(`files[${index}]`, new Blob([file.data], { type: file.type }), file.name);
  }
  const response = await discord(`/channels/${channelId}/messages`, { method: "POST", body: form });
  if (!response.ok) {
    throw new Error(`send failed: HTTP ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as DiscordMessage).id;
}

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

async function repliesAfter(messageId: string): Promise<Reply> {
  const response = await discord(`/channels/${channelId}/messages?after=${messageId}&limit=50`);
  if (!response.ok) throw new Error(`read failed: HTTP ${response.status}`);
  const messages = ((await response.json()) as DiscordMessage[])
    .filter((message) => message.author.id === botId)
    .reverse();
  const parts: string[] = [];
  for (const message of messages) {
    if (message.content) parts.push(message.content);
    collectText(message.components, parts);
  }
  return { messages, text: parts.join("\n") };
}

/** Waits until the bot has replied and no reply still shows the streaming state. */
async function waitForReply(messageId: string, timeoutMs: number): Promise<Reply> {
  const deadline = Date.now() + timeoutMs;
  let last: Reply = { messages: [], text: "" };
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
    last = await repliesAfter(messageId);
    if (last.messages.length > 0 && !last.text.includes(STREAMING_LABEL)) return last;
  }
  throw new Error(
    last.messages.length === 0
      ? "the bot never replied"
      : `the reply was still streaming after ${timeoutMs / 1000}s`,
  );
}

const hasFooter = (reply: Reply): string[] =>
  /Tokens: \d+\+\d+=\d+/.test(reply.text) && /Provider: \S/.test(reply.text)
    ? []
    : ["no usage footer with Tokens and Provider (is llm-details on for this guild?)"];

const SCENARIOS: Scenario[] = [
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
    check: (reply) => [
      ...(reply.messages.length >= 2
        ? []
        : [`expected the reply to be split, got ${reply.messages.length} message`]),
      ...(/ページ \d+\/\d+/.test(reply.text) ? [] : ["no page footer (ページ n/m)"]),
      ...hasFooter(reply),
    ],
  },
  {
    name: "image",
    prompt: "[e2e] この画像を塗りつぶしている色を、英語の小文字1語で答えて。",
    files: [{ name: "square.png", type: "image/png", data: PNG_DATA }],
    check: (reply) => (/red/i.test(reply.text) ? [] : ["the reply does not name the color red"]),
  },
  {
    name: "pdf",
    prompt: "[e2e] このPDFに書かれている secret word を1語で答えて。",
    files: [{ name: "secret.pdf", type: "application/pdf", data: PDF_DATA }],
    check: (reply) =>
      /PINEAPPLE/i.test(reply.text) ? [] : ["the reply does not contain the word in the PDF"],
  },
  {
    name: "stop",
    manual: true,
    prompt:
      "[e2e: 手動確認] 世界の主要な河川20本をそれぞれ500字以上で解説して。（この返信の「停止」ボタンを押してください）",
    timeoutMs: MANUAL_STOP_TIMEOUT_MS,
    check: (reply) =>
      reply.text.includes("Stopped")
        ? []
        : ["the reply finished without being stopped (nobody pressed 停止 in time)"],
  },
];

async function startBot(): Promise<{ stop: () => void }> {
  const child = Bun.spawn(["bun", "run", "src/index.ts"], { stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + BOT_READY_TIMEOUT_MS;
  let output = "";
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    if (output.includes("logged in")) {
      reader.releaseLock();
      return { stop: () => child.kill() };
    }
  }
  child.kill();
  throw new Error(`the bot did not log in within ${BOT_READY_TIMEOUT_MS / 1000}s:\n${output}`);
}

async function main(): Promise<number> {
  requireEnv();
  const args = process.argv.slice(2);
  const spawn = !args.includes("--no-spawn");
  const names = args.filter((arg) => !arg.startsWith("--"));
  const unknown = names.filter((name) => !SCENARIOS.some((scenario) => scenario.name === name));
  if (unknown.length > 0) throw new Error(`unknown scenario: ${unknown.join(", ")}`);
  const selected = SCENARIOS.filter((scenario) =>
    names.length > 0 ? names.includes(scenario.name) : !scenario.manual,
  );

  const bot = spawn ? await startBot() : undefined;
  let failures = 0;
  try {
    for (const scenario of selected) {
      const startedAt = Date.now();
      try {
        const messageId = await send(scenario);
        if (scenario.manual) console.log(`  ${scenario.name}: waiting for a manual action…`);
        const reply = await waitForReply(messageId, scenario.timeoutMs ?? REPLY_TIMEOUT_MS);
        const problems = scenario.check(reply);
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        if (problems.length === 0) {
          console.log(`PASS ${scenario.name} (${seconds}s, ${reply.messages.length} message(s))`);
        } else {
          failures++;
          console.log(`FAIL ${scenario.name} (${seconds}s)`);
          for (const problem of problems) console.log(`     - ${problem}`);
          console.log(`     reply: ${reply.text.replace(/\s+/g, " ").slice(0, 300)}`);
        }
      } catch (error) {
        failures++;
        console.log(`FAIL ${scenario.name}: ${error instanceof Error ? error.message : error}`);
      }
    }
  } finally {
    bot?.stop();
  }
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
