/**
 * Reads the running bot's admin API (docs/admin-api.md) and the Discord
 * messages an incident report links to, so an investigation needs neither a
 * hand-built HMAC nor a hand-decoded snowflake.
 *
 * Usage:
 *   bun scripts/admin.ts metrics
 *   bun scripts/admin.ts logs [--level warn] [--lines 200] [--since <ISO 8601>]
 *   bun scripts/admin.ts message <discord message link> [--around 10]
 *   bun scripts/admin.ts channel <channel id> --since <ISO 8601>
 *
 * Reads ADMIN_API_BASE_URL and ADMIN_API_SECRET from the environment (Bun
 * loads `.env`). `message` and `channel` read the channel with the first of
 * DISCORD_TOKEN and E2E_TESTER_BOT_TOKEN that Discord lets in, because the bot
 * that answered is usually the production bot, whose token is not on a
 * development machine.
 */
import { canonicalizeQuery } from "../src/http/adminAuth";
import { hmacSha256Hex } from "../src/http/hmac";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_EPOCH_MS = 1_420_070_400_000n;
/** Log lines before the linked message that still belong to the request it answered or triggered. */
const LOG_LEAD_MS = 5 * 60_000;
/** A reply streams for minutes at most; later lines belong to other requests. */
const LOG_TRAIL_MS = 10 * 60_000;
const LOG_LINES = 2000;
/** The admin API's ceiling; a start line older than this many lines is out of reach. */
const MAX_LOG_LINES = 10_000;
/** Discord's page size for channel history. */
const HISTORY_PAGE = 100;
const LOG_TIMESTAMP = /^\[([^\]]+)\]/;
const START_LINE = "Configuration loaded";
/** Enough to tell whether a link preview carried the post's text, without dumping it. */
const EMBED_PREVIEW_CHARS = 120;

export interface MessageLink {
  guildId: string;
  channelId: string;
  messageId: string;
}

export function parseMessageLink(link: string): MessageLink {
  const match = link.match(
    /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/,
  );
  if (!match) throw new Error(`not a Discord message link: ${link}`);
  return { guildId: match[1], channelId: match[2], messageId: match[3] };
}

export function snowflakeToDate(id: string): Date {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS));
}

/** The smallest snowflake created at `date`, for Discord's `after` cursor. */
export function dateToSnowflake(date: Date): string {
  return String((BigInt(date.getTime()) - DISCORD_EPOCH_MS) << 22n);
}

/**
 * The last process start before `before`, which names the version that
 * probably wrote the lines after it. A start line written before the field
 * existed carries no `version`, and the caller reports that as unknown rather
 * than reaching past it to an older start.
 */
export function lastStartLine(log: string, before: Date): string | undefined {
  return linesBetween(log, new Date(0), before)
    .filter((line) => line.includes(START_LINE))
    .at(-1);
}

export interface HealthSnapshot {
  version?: string;
  startedAt?: string;
}

/** Whether the running process, as `/health` reports it, already ran at `at`. */
export function describeHealth(health: HealthSnapshot, at: Date): string {
  const started = health.startedAt ? Date.parse(health.startedAt) : Number.NaN;
  const coverage = Number.isNaN(started)
    ? "start time unknown"
    : started <= at.getTime()
      ? "the message is after its start"
      : "the message is before its start, so another process answered it";
  return `health: version ${health.version ?? "unknown"}, started ${health.startedAt ?? "unknown"} (${coverage})`;
}

export async function adminHeaders(
  secret: string,
  path: string,
  query: URLSearchParams,
  now: number = Date.now(),
): Promise<Record<string, string>> {
  const timestamp = String(now);
  const signature = await hmacSha256Hex(
    secret,
    `GET\n${path}\n${canonicalizeQuery(query)}\n${timestamp}`,
  );
  return { "X-Admin-Timestamp": timestamp, "X-Admin-Signature": `sha256=${signature}` };
}

interface DiscordMessage {
  id: string;
  content: string;
  author: { username: string; bot?: boolean };
  message_reference?: { message_id?: string };
  components?: unknown[];
  embeds?: { url?: string; description?: string }[];
  attachments?: { filename: string }[];
}

/** Components V2 replies carry their text in nested TextDisplay `content` fields, not in `content`. */
export function messageText(message: Pick<DiscordMessage, "content" | "components">): string {
  const texts: string[] = message.content ? [message.content] : [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
    } else if (typeof node === "object" && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        if (key === "content" && typeof value === "string") texts.push(value);
        else visit(value);
      }
    }
  };
  visit(message.components ?? []);
  return texts.join("\n");
}

export function formatMessage(message: DiscordMessage, target: string): string {
  const marker = message.id === target ? ">>" : "  ";
  const bot = message.author.bot ? " [bot]" : "";
  const reply = message.message_reference?.message_id
    ? ` (reply to ${message.message_reference.message_id})`
    : "";
  const extras = [
    ...(message.embeds ?? []).map((embed) => {
      const description = embed.description?.split("\n")[0]?.slice(0, EMBED_PREVIEW_CHARS);
      return `embed: ${embed.url ?? "(no url)"}${description ? ` | ${description}` : ""}`;
    }),
    ...(message.attachments ?? []).map((attachment) => `attachment: ${attachment.filename}`),
  ];
  const header = `${marker} ${message.id} ${snowflakeToDate(message.id).toISOString()} ${message.author.username}${bot}${reply}`;
  return [header, messageText(message), ...extras].join("\n").replace(/\n/g, "\n   ");
}

export function linesBetween(log: string, from: Date, to: Date): string[] {
  return log.split("\n").filter((line) => {
    const stamp = line.match(LOG_TIMESTAMP)?.[1];
    if (!stamp) return false;
    const time = Date.parse(stamp);
    return time >= from.getTime() && time <= to.getTime();
  });
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; add it to .env`);
  return value;
}

async function fetchAdmin(path: string, query = new URLSearchParams()): Promise<string> {
  const base = env("ADMIN_API_BASE_URL").replace(/\/$/, "");
  const search = query.size > 0 ? `?${query}` : "";
  const response = await fetch(`${base}${path}${search}`, {
    headers: await adminHeaders(env("ADMIN_API_SECRET"), path, query),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${body}`);
  return body;
}

async function fetchDiscordMessages(path: string): Promise<DiscordMessage[]> {
  const failures: string[] = [];
  for (const name of ["DISCORD_TOKEN", "E2E_TESTER_BOT_TOKEN"]) {
    const token = process.env[name];
    if (!token) continue;
    const response = await fetch(`${DISCORD_API}${path}`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (response.ok) return (await response.json()) as DiscordMessage[];
    failures.push(`${name}: ${response.status} ${await response.text()}`);
  }
  throw new Error(`no bot token could read the channel\n${failures.join("\n")}`);
}

async function fetchChannelMessages(link: MessageLink, around: number): Promise<DiscordMessage[]> {
  const page = await fetchDiscordMessages(
    `/channels/${link.channelId}/messages?around=${link.messageId}&limit=${around}`,
  );
  return page.reverse();
}

/** Every message after `since`, oldest first. Discord returns a page newest first. */
async function fetchChannelSince(channelId: string, since: Date): Promise<DiscordMessage[]> {
  const messages: DiscordMessage[] = [];
  let after = dateToSnowflake(since);
  for (;;) {
    const page = await fetchDiscordMessages(
      `/channels/${channelId}/messages?after=${after}&limit=${HISTORY_PAGE}`,
    );
    page.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    messages.push(...page);
    const last = page.at(-1);
    if (!last || page.length < HISTORY_PAGE) return messages;
    after = last.id;
  }
}

/** `/health` needs no signature; it is the only source for the running process's version. */
async function fetchHealth(): Promise<HealthSnapshot | undefined> {
  const base = env("ADMIN_API_BASE_URL").replace(/\/$/, "");
  try {
    const response = await fetch(`${base}/health`);
    return (await response.json()) as HealthSnapshot;
  } catch {
    return undefined;
  }
}

async function printHealth(at: Date): Promise<void> {
  const health = await fetchHealth();
  console.log(health ? describeHealth(health, at) : "health: unreadable");
}

async function printLastStart(at: Date): Promise<void> {
  const log = await fetchAdmin(
    "/admin/logs",
    new URLSearchParams({ level: "info", lines: String(MAX_LOG_LINES) }),
  );
  const start = lastStartLine(log, at);
  console.log(
    start
      ? `last start before it: ${start}`
      : `last start before it: none in the newest ${MAX_LOG_LINES} info lines`,
  );
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  // stderr, so `logs` output stays pipeable; the host tells which deployment answered.
  if (process.env.ADMIN_API_BASE_URL) {
    console.error(`admin API: ${new URL(process.env.ADMIN_API_BASE_URL).host}`);
  }
  if (command === "metrics") {
    console.log(JSON.stringify(JSON.parse(await fetchAdmin("/admin/metrics")), null, 2));
  } else if (command === "logs") {
    const query = new URLSearchParams();
    for (const name of ["level", "lines", "since"]) {
      const value = option(rest, name);
      if (value) query.set(name, value);
    }
    const log = await fetchAdmin("/admin/logs", query);
    if (log.length === 0)
      console.error("logs: no matching lines (logBytes 0 in metrics means none are stored)");
    process.stdout.write(log);
  } else if (command === "message" && rest[0]) {
    const link = parseMessageLink(rest[0]);
    const postedAt = snowflakeToDate(link.messageId);
    console.log(`message ${link.messageId} posted at ${postedAt.toISOString()}\n`);
    const messages = await fetchChannelMessages(link, Number(option(rest, "around") ?? 10));
    for (const message of messages) console.log(`${formatMessage(message, link.messageId)}\n`);

    const from = new Date(postedAt.getTime() - LOG_LEAD_MS);
    const to = new Date(postedAt.getTime() + LOG_TRAIL_MS);
    await printHealth(postedAt);
    const metrics = JSON.parse(await fetchAdmin("/admin/metrics")) as { logBytes?: number };
    if (metrics.logBytes === 0) {
      console.log("logs: none stored (logBytes is 0, so LOG_DIR is unset or unwritable)");
      return;
    }
    await printLastStart(postedAt);
    const log = await fetchAdmin(
      "/admin/logs",
      new URLSearchParams({ lines: String(LOG_LINES), since: from.toISOString() }),
    );
    const lines = linesBetween(log, from, to);
    console.log(`logs ${from.toISOString()} .. ${to.toISOString()}: ${lines.length} lines`);
    for (const line of lines) console.log(line);
  } else if (command === "channel" && rest[0] && option(rest, "since")) {
    const since = new Date(option(rest, "since") ?? "");
    if (Number.isNaN(since.getTime())) throw new Error("--since must be an ISO 8601 time");
    const messages = await fetchChannelSince(rest[0], since);
    console.log(`channel ${rest[0]}: ${messages.length} messages since ${since.toISOString()}\n`);
    for (const message of messages) console.log(`${formatMessage(message, "")}\n`);

    const log = await fetchAdmin(
      "/admin/logs",
      new URLSearchParams({ lines: String(MAX_LOG_LINES), since: since.toISOString() }),
    );
    // The log is shared by every guild; lines without this channel are kept
    // because restarts, release announcements, and Web search lines name none.
    const lines = log.split("\n").filter((line) => line.length > 0);
    console.log(`logs since ${since.toISOString()}: ${lines.length} lines (all channels)`);
    for (const line of lines) console.log(line);
  } else {
    console.error(
      "usage: bun scripts/admin.ts metrics | logs [--level L] [--lines N] [--since ISO] | message <link> [--around N] | channel <id> --since ISO",
    );
    process.exit(2);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
