import { Database } from "bun:sqlite";
import { PermissionsBitField } from "discord.js";
import { canManageGuildSettings } from "../../src/services/settingsAuthorization";

type Request = (path: string, init?: RequestInit) => Promise<Response>;

/** What a scenario needs from the run besides Discord: the bot's database and the tester's id. */
export interface ScenarioEnv {
  databasePath: string;
  testerBotId: string;
  /** Bot under test's token, used to remove its own scheduled events. */
  botToken?: string;
  /** Aborted on SIGINT or SIGTERM, whose cleanup can run before the scenario writes its rows. */
  interrupted?: AbortSignal;
}

interface MessageLike {
  id: string;
  author?: { id?: string };
  message_reference?: { message_id?: string };
  components?: unknown[];
}

const APPROVE_ID = /^cron:proposal:approve:(\d+):[01]$/u;
const DELIVERY_POLL_MS = 5_000;

function customIds(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(customIds);
  if (typeof node !== "object" || node === null) return [];
  const record = node as Record<string, unknown>;
  return [
    ...(typeof record.custom_id === "string" ? [record.custom_id] : []),
    ...customIds(record.components),
    ...customIds(record.accessory),
  ];
}

export function isProposalCard(message: { components?: unknown[] }): boolean {
  return customIds(message.components).some((id) => APPROVE_ID.test(id));
}

async function guildOf(channelId: string, request: Request): Promise<string> {
  const response = await request(`/channels/${channelId}`);
  if (!response.ok) throw new Error(`cannot read the channel: HTTP ${response.status}`);
  const guildId = ((await response.json()) as { guild_id?: string }).guild_id;
  if (!guildId) throw new Error("E2E_CHANNEL_ID is not a guild channel");
  return guildId;
}

/**
 * A proposal needs `cron_enabled` in the guild under test and a tester bot
 * that passes `canManageGuildSettings`, judged from the bot's own database
 * and the tester's roles as Discord reports them.
 */
export async function cronPreconditions(
  channelId: string,
  request: Request,
  env: ScenarioEnv,
): Promise<string[]> {
  const guildId = await guildOf(channelId, request);
  const db = new Database(env.databasePath, { readonly: true });
  let settings: { cronEnabled: number; adminRoleId: string | null } | null;
  try {
    settings = db
      .query<{ cronEnabled: number; adminRoleId: string | null }, [string]>(
        "SELECT cron_enabled AS cronEnabled, admin_role_id AS adminRoleId FROM guild_settings WHERE guild_id=?",
      )
      .get(guildId);
  } finally {
    db.close();
  }
  const problems: string[] = [];
  if (!settings?.cronEnabled)
    problems.push(
      `定期実行 is off for guild ${guildId} in ${env.databasePath}: turn on 機能 → 定期実行 in /config, or set guild_settings.cron_enabled=1`,
    );
  const [memberResponse, rolesResponse] = await Promise.all([
    request(`/guilds/${guildId}/members/${env.testerBotId}`),
    request(`/guilds/${guildId}/roles`),
  ]);
  if (!memberResponse.ok || !rolesResponse.ok)
    return [
      ...problems,
      `cannot read the tester's member or the guild roles: HTTP ${memberResponse.status}/${rolesResponse.status}`,
    ];
  const member = (await memberResponse.json()) as { roles: string[] };
  const roles = (await rolesResponse.json()) as { id: string; permissions: string }[];
  const bits = roles
    .filter((role) => role.id === guildId || member.roles.includes(role.id))
    .reduce((sum, role) => sum | BigInt(role.permissions), 0n);
  const actor = { permissions: new PermissionsBitField(bits), roleIds: member.roles };
  if (!canManageGuildSettings(actor, { adminRoleId: settings?.adminRoleId ?? null }))
    problems.push(
      "the tester bot has neither ManageGuild nor the admin role set in /config, so it cannot propose a job",
    );
  return problems;
}

export async function cronSearchPreconditions(
  channelId: string,
  request: Request,
  env: ScenarioEnv,
): Promise<string[]> {
  const problems = await cronPreconditions(channelId, request, env);
  const guildId = await guildOf(channelId, request);
  const db = new Database(env.databasePath, { readonly: true });
  try {
    const enabled = db
      .query<{ webSearchEnabled: number }, [string]>(
        "SELECT web_search_enabled AS webSearchEnabled FROM guild_settings WHERE guild_id=?",
      )
      .get(guildId)?.webSearchEnabled;
    if (!enabled)
      problems.push(`Web 検索 is off for guild ${guildId}: turn on 機能 → Web 検索 in /config`);
  } finally {
    db.close();
  }
  return problems;
}

/**
 * The error the bot saved for the inserted job once its run failed. Without it a failed run
 * only shows as the scenario deadline passing, which hides why the post never came.
 */
function runFailure(env: ScenarioEnv, jobId: number | bigint): string | undefined {
  const db = new Database(env.databasePath, { readonly: true });
  try {
    return (
      db
        .query<{ lastError: string | null }, [number | bigint]>(
          "SELECT last_error AS lastError FROM cron_jobs WHERE id=?",
        )
        .get(jobId)?.lastError ?? undefined
    );
  } finally {
    db.close();
  }
}

export async function verifyCronSearch(
  triggerId: string,
  channelId: string,
  request: Request,
  botId: string,
  env: ScenarioEnv,
): Promise<string[]> {
  const guildId = await guildOf(channelId, request);
  if (env.interrupted?.aborted) return ["interrupted before the job was inserted"];
  const name = `e2e-search-${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const runAt = now + 60_000;
  const db = new Database(env.databasePath);
  let jobId: number | bigint;
  try {
    const inserted = db
      .query(`INSERT INTO cron_jobs (guild_id,channel_id,user_id,name,prompt,kind,expr,silent,web_search,status,next_run_at,created_at,updated_at)
      VALUES (?,?,?,?,?, 'once',?,0,1,'active',?,?,?)`)
      .run(
        guildId,
        channelId,
        env.testerBotId,
        name,
        "Web 検索で oven-sh/bun の GitHub Release のタグ bun-v1.4.0 の公開日を UTC で調べ、日付と出典を答えて。",
        new Date(runAt).toISOString(),
        runAt,
        now,
        now,
      );
    if (env.interrupted?.aborted) {
      db.query("DELETE FROM cron_jobs WHERE id=?").run(inserted.lastInsertRowid);
      return ["interrupted after the job was inserted; the job was deleted"];
    }
    jobId = inserted.lastInsertRowid;
  } finally {
    db.close();
  }
  const heading = `定期実行「${name}」`;
  let headingSeenAt: number | undefined;
  let headingMessageId: string | undefined;
  let pageCount = 1;
  while (true) {
    const response = await request(`/channels/${channelId}/messages?after=${triggerId}&limit=50`);
    if (!response.ok) return [`cannot read messages: HTTP ${response.status}`];
    const posts = ((await response.json()) as MessageLike[]).filter(
      (message) => message.author?.id === botId,
    );
    const scheduledPost = posts.find((message) =>
      JSON.stringify(message.components ?? []).includes(heading),
    );
    if (scheduledPost) {
      headingMessageId = scheduledPost.id;
      headingSeenAt ??= Date.now();
      const pageInfo = /ページ 1\/(\d+)/u.exec(JSON.stringify(scheduledPost.components ?? []));
      pageCount = pageInfo ? Number(pageInfo[1]) : 1;
    }
    const scheduledPostId = headingMessageId;
    const scheduledPages =
      scheduledPostId === undefined
        ? []
        : posts.filter((message) => {
            if (message.id === scheduledPostId) return true;
            if (BigInt(message.id) <= BigInt(scheduledPostId)) return false;
            const page = /ページ (\d+)\/(\d+)/u.exec(JSON.stringify(message.components ?? []));
            return page?.[2] === String(pageCount) && Number(page[1]) >= 2;
          });
    if (
      scheduledPages.some((message) =>
        JSON.stringify(message.components ?? []).includes("-# 検索結果"),
      )
    )
      return [];
    if (headingSeenAt !== undefined && Date.now() - headingSeenAt > 30_000)
      return ["scheduled post has no search result links"];
    const failure = runFailure(env, jobId);
    if (failure && headingSeenAt === undefined) return [`the scheduled run failed: ${failure}`];
    await Bun.sleep(DELIVERY_POLL_MS);
  }
}

/**
 * Finds the confirmation card, then inserts a one-off job due in a minute
 * and waits for its post. Approval is left out: a bot cannot press a button.
 */
export async function verifyCron(
  triggerId: string,
  channelId: string,
  request: Request,
  botId: string,
  env: ScenarioEnv,
): Promise<string[]> {
  const recent = await request(`/channels/${channelId}/messages?after=${triggerId}&limit=50`);
  if (!recent.ok) return [`cannot read messages: HTTP ${recent.status}`];
  const card = ((await recent.json()) as MessageLike[]).find(
    (message) =>
      message.author?.id === botId &&
      message.message_reference?.message_id === triggerId &&
      isProposalCard(message),
  );
  const problems: string[] = [];
  if (!card) problems.push("no confirmation card with a 登録する button replied to the request");

  const guildId = await guildOf(channelId, request);
  // An interrupt's cleanup may already have run while the channel was read,
  // and nothing would delete a job inserted after it.
  if (env.interrupted?.aborted) return [...problems, "interrupted before the job was inserted"];
  const name = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const runAt = now + 60_000;
  const db = new Database(env.databasePath);
  let jobId: number | bigint;
  try {
    const inserted = db
      .query(`INSERT INTO cron_jobs
        (guild_id,channel_id,user_id,name,prompt,kind,expr,silent,status,next_run_at,created_at,updated_at)
        VALUES (?,?,?,?,?, 'once',?,0,'active',?,?,?)`)
      .run(
        guildId,
        channelId,
        env.testerBotId,
        name,
        "「定期実行OK」とだけ答えてください。",
        new Date(runAt).toISOString(),
        runAt,
        now,
        now,
      );
    if (env.interrupted?.aborted) {
      db.query("DELETE FROM cron_jobs WHERE id=?").run(inserted.lastInsertRowid);
      return [...problems, "interrupted after the job was inserted; the job was deleted"];
    }
    jobId = inserted.lastInsertRowid;
  } finally {
    db.close();
  }
  const heading = `定期実行「${name}」`;
  // The request deadline ends the wait: the ticker runs once a minute, so the
  // post arrives within about two minutes of the insert.
  while (true) {
    const response = await request(`/channels/${channelId}/messages?after=${triggerId}&limit=50`);
    if (!response.ok) return [...problems, `cannot read messages: HTTP ${response.status}`];
    const delivered = ((await response.json()) as MessageLike[]).some(
      (message) =>
        message.author?.id === botId && JSON.stringify(message.components ?? []).includes(heading),
    );
    if (delivered) return problems;
    const failure = runFailure(env, jobId);
    if (failure) return [...problems, `the scheduled run failed: ${failure}`];
    await Bun.sleep(DELIVERY_POLL_MS);
  }
}

/**
 * Deletes what the scenario created, found in the database rather than
 * remembered, so that it also works when the reply never finished or the run
 * was interrupted: rows of the tester in this channel created since the
 * scenario started. Only this script creates jobs for the tester (a bot
 * cannot press 登録する), and the channel is reserved for the run.
 */
export async function cleanupCron(
  channelId: string,
  env: ScenarioEnv,
  startedAt: number,
): Promise<string[]> {
  startedRuns.push({ channelId, startedAt });
  // Cleanup also runs when the preconditions failed, possibly on a wrong path; never create a file there.
  const db = new Database(env.databasePath, { readwrite: true, create: false });
  try {
    for (const table of ["cron_jobs", "cron_proposals"]) {
      db.query(`DELETE FROM ${table} WHERE user_id=? AND channel_id=? AND created_at>=?`).run(
        env.testerBotId,
        channelId,
        startedAt,
      );
    }
  } finally {
    db.close();
  }
  return [];
}

const startedRuns: { channelId: string; startedAt: number }[] = [];

/**
 * Deletes the proposals again at the end of the run, for every cron scenario
 * that reached its cleanup. When only the HTTP response of the request post
 * fails, the scenario's cleanup runs while the bot is still waiting on the
 * LLM, and the proposal the bot saves afterwards would stay. The run calls
 * this after stopping the bot it started, so nothing is saved after it.
 * Under `--no-spawn` the bot keeps running, and a proposal it saves after
 * this pass is not deleted by anything in this script.
 */
export function cleanupLateCronProposals(env: ScenarioEnv): string[] {
  if (startedRuns.length === 0) return [];
  try {
    const db = new Database(env.databasePath, { readwrite: true, create: false });
    try {
      for (const { channelId, startedAt } of startedRuns) {
        db.query(
          "DELETE FROM cron_proposals WHERE user_id=? AND channel_id=? AND created_at>=?",
        ).run(env.testerBotId, channelId, startedAt);
      }
    } finally {
      db.close();
    }
    return [];
  } catch (error) {
    return [`late proposal cleanup failed: ${error instanceof Error ? error.message : error}`];
  }
}
