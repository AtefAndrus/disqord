import { Database } from "bun:sqlite";
import { PermissionsBitField } from "discord.js";
import { canManageGuildSettings } from "../../src/services/settingsAuthorization";

type Request = (path: string, init?: RequestInit) => Promise<Response>;

/** What a scenario needs from the run besides Discord: the bot's database and the tester's id. */
export interface ScenarioEnv {
  databasePath: string;
  testerBotId: string;
}

interface MessageLike {
  id: string;
  author?: { id?: string };
  message_reference?: { message_id?: string };
  components?: unknown[];
}

const APPROVE_ID = /^cron:proposal:approve:(\d+)$/u;
const DELIVERY_POLL_MS = 5_000;

/** Rows this run created, so that cleanup removes exactly them. */
const created: { jobId?: number; proposalIds: number[] } = { proposalIds: [] };

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
  const proposalId = card
    ? customIds(card.components)
        .map((id) => APPROVE_ID.exec(id)?.[1])
        .find((id) => id !== undefined)
    : undefined;
  if (proposalId) created.proposalIds.push(Number(proposalId));
  else problems.push("no confirmation card with a 登録する button replied to the request");

  const guildId = await guildOf(channelId, request);
  const name = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const runAt = now + 60_000;
  const db = new Database(env.databasePath);
  try {
    const result = db
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
    created.jobId = Number(result.lastInsertRowid);
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
    await Bun.sleep(DELIVERY_POLL_MS);
  }
}

export async function cleanupCron(env: ScenarioEnv): Promise<string[]> {
  const db = new Database(env.databasePath);
  try {
    if (created.jobId !== undefined)
      db.query("DELETE FROM cron_jobs WHERE id=?").run(created.jobId);
    for (const id of created.proposalIds) db.query("DELETE FROM cron_proposals WHERE id=?").run(id);
  } finally {
    db.close();
    created.jobId = undefined;
    created.proposalIds = [];
  }
  return [];
}
