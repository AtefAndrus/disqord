import type { Database } from "bun:sqlite";
import type { ChatMessageContent, GuildId } from "../../types";

export const SESSION_GAP_MS = 60 * 60 * 1000;
export const DELETED_RECORD_TTL_MS = 15 * 60 * 1000;
export const TURN_SAVE_MAX_AGE_MS = 10 * 60 * 1000;
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PDF_FETCH_TIMEOUT_MS = 30_000;

export type PersistedContentPart =
  | { type: "text"; text: string }
  | { type: "image-ref"; url: string; mime: string }
  | { type: "file-ref"; url: string; filename: string; mime: string };

export type ConversationTurnStatus = "pending" | "completed" | "stopped" | "failed";

export interface PersistedTurn {
  id: number;
  sessionId: number;
  role: "user" | "assistant";
  authorId: string | null;
  authorLabel: string | null;
  status: "completed" | "abandoned" | ConversationTurnStatus;
  active: boolean;
  discordCreatedAt: number;
  finalizedAt: number | null;
  discordMessageId: string;
  content: PersistedContentPart[];
}

export interface ConversationExchange {
  user: PersistedTurn;
  assistant?: PersistedTurn;
}

export interface ConversationContext {
  current: PersistedTurn;
  exchanges: ConversationExchange[];
  openrouterSessionId: string;
}

export interface PersistedAttachmentRef {
  type: "image-ref" | "file-ref";
  url: string;
  mime: string;
  filename?: string;
}

export interface CreateConversationTurnInput {
  guildId: GuildId;
  channelId: string;
  parentChannelId: string | null;
  discordMessageId: string;
  authorId: string;
  authorLabel: string;
  content: PersistedContentPart[];
  replyToDiscordMessageId: string | null;
  discordCreatedAt: number;
  handlingStartedAt: number;
}

export interface CreateConversationTurnResult {
  historyEnabled: boolean;
  created: boolean;
  duplicate: boolean;
  skippedReason?: "disabled" | "deleted" | "too-old";
  skipResponse?: boolean;
  sessionId?: number;
  openrouterSessionId?: string;
  userTurnId?: number;
  assistantTurnId?: number;
}

export interface HistoricalUserContent {
  id: number;
  content: PersistedContentPart[];
}

export interface IConversationRepository {
  createUserAndAssistantTurn(
    input: CreateConversationTurnInput,
  ): Promise<CreateConversationTurnResult>;
  getContext(userTurnId: number): Promise<ConversationContext | null>;
  createAssistantTurn(
    sessionId: number,
    parentUserTurnId: number,
    discordCreatedAt?: number,
  ): Promise<number | null>;
  onBotMessageSent(
    assistantTurnId: number,
    discordMessageId: string,
    discordCreatedAt: number,
  ): Promise<boolean>;
  deleteMessageMapping(discordMessageId: string): Promise<boolean>;
  finalizeAssistantTurn(
    assistantTurnId: number,
    status: Exclude<ConversationTurnStatus, "pending">,
    text: string,
    finalizedAt?: number,
  ): Promise<boolean>;
  failPendingTurns(): Promise<number>;
  purgeMessage(discordMessageId: string): Promise<boolean>;
  purgeMessages(discordMessageIds: readonly string[]): Promise<boolean>;
  purgeChannel(channelId: string): Promise<boolean>;
  purgeThread(channelId: string): Promise<boolean>;
  purgeGuild(guildId: string): Promise<boolean>;
  sweepExpired(now?: number): Promise<number>;
}

export class DeletedBeforeSaveRecord {
  private readonly messageIds = new Map<string, number>();
  private readonly channelIds = new Map<string, number>();
  private readonly guildIds = new Map<string, number>();

  constructor(
    private readonly ttlMs = DELETED_RECORD_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  recordMessage(messageId: string): void {
    this.prune();
    this.messageIds.set(messageId, this.now());
  }

  recordChannel(channelId: string): void {
    this.prune();
    this.channelIds.set(channelId, this.now());
  }

  recordGuild(guildId: string): void {
    this.prune();
    this.guildIds.set(guildId, this.now());
  }

  hasMessage(messageId: string): boolean {
    this.prune();
    return this.messageIds.has(messageId);
  }

  hasScope(channelId: string, parentChannelId: string | null, guildId: string): boolean {
    this.prune();
    return (
      this.channelIds.has(channelId) ||
      (parentChannelId !== null && this.channelIds.has(parentChannelId)) ||
      this.guildIds.has(guildId)
    );
  }

  hasTurnBeenDeleted(
    messageId: string,
    channelId: string,
    parentChannelId: string | null,
    guildId: string,
  ): boolean {
    return this.hasMessage(messageId) || this.hasScope(channelId, parentChannelId, guildId);
  }

  prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const entries of [this.messageIds, this.channelIds, this.guildIds]) {
      for (const [id, recordedAt] of entries) {
        if (recordedAt <= cutoff) entries.delete(id);
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedContentPart(value: unknown): value is PersistedContentPart {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "image-ref") {
    return typeof value.url === "string" && typeof value.mime === "string";
  }
  return (
    value.type === "file-ref" &&
    typeof value.url === "string" &&
    typeof value.filename === "string" &&
    typeof value.mime === "string"
  );
}

function parsePersistedContent(raw: string, turnId: number): PersistedContentPart[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[conversation] ignoring turn with invalid content JSON", { turnId });
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every(isPersistedContentPart)) {
    console.warn("[conversation] ignoring turn with invalid content shape", { turnId });
    return null;
  }
  return parsed;
}

export function normalizeAuthorLabel(rawLabel: string, authorId: string): string {
  const withoutLineBreaks = rawLabel.replace(/[\r\n\t]/g, " ");
  const withoutControls = withoutLineBreaks.replace(/[\p{Cc}\p{Cf}]/gu, "");
  const trimmed = withoutControls.replace(/[[\]]/g, "").trim();
  if (trimmed.length === 0) return authorId;
  return Array.from(trimmed).slice(0, 32).join("");
}

export function buildPersistedContent(
  text: string,
  attachmentRefs: readonly PersistedAttachmentRef[],
): PersistedContentPart[] {
  const parts: PersistedContentPart[] = [];
  if (text.length > 0) parts.push({ type: "text", text });
  for (const ref of attachmentRefs) {
    if (ref.type === "image-ref") {
      parts.push({ type: "image-ref", url: ref.url, mime: ref.mime });
    } else {
      parts.push({
        type: "file-ref",
        url: ref.url,
        filename: ref.filename ?? "file.pdf",
        mime: ref.mime,
      });
    }
  }
  return parts;
}

function containsMedia(content: readonly PersistedContentPart[]): boolean {
  return content.some((part) => part.type === "image-ref" || part.type === "file-ref");
}

export function stripHistoricalMedia(
  turns: readonly HistoricalUserContent[],
): HistoricalUserContent[];
export function stripHistoricalMedia(
  turns: readonly PersistedContentPart[][],
): PersistedContentPart[][];
export function stripHistoricalMedia(
  turns: readonly HistoricalUserContent[] | readonly PersistedContentPart[][],
): HistoricalUserContent[] | PersistedContentPart[][] {
  const isPlainContent = turns.every((turn) => Array.isArray(turn));
  const normalized: HistoricalUserContent[] = isPlainContent
    ? (turns as readonly PersistedContentPart[][]).map((content, id) => ({ id, content }))
    : (turns as readonly HistoricalUserContent[]).map((turn) => ({
        id: turn.id,
        content: [...turn.content],
      }));
  let latestMediaIndex = -1;
  for (let index = normalized.length - 1; index >= 0; index--) {
    if (containsMedia(normalized[index]?.content ?? [])) {
      latestMediaIndex = index;
      break;
    }
  }

  const stripped = normalized.map((turn, index) => ({
    ...turn,
    content:
      index < latestMediaIndex
        ? turn.content.flatMap((part) => {
            if (part.type === "image-ref") {
              return [{ type: "text" as const, text: "[earlier image omitted]" }];
            }
            if (part.type === "file-ref") {
              return [{ type: "text" as const, text: "[earlier file omitted]" }];
            }
            return [part];
          })
        : [...turn.content],
  }));
  return isPlainContent ? stripped.map((turn) => turn.content) : stripped;
}

export function estimatePersistedContentTokens(content: readonly PersistedContentPart[]): number {
  let tokens = 0;
  for (const part of content) {
    if (part.type === "image-ref") {
      tokens += 1_000;
      continue;
    }
    if (part.type === "file-ref") {
      tokens += 2_000;
      continue;
    }
    let ascii = 0;
    let nonAscii = 0;
    for (const character of Array.from(part.text)) {
      const codePoint = character.codePointAt(0);
      if (codePoint !== undefined && codePoint <= 0x7f) ascii++;
      else nonAscii++;
    }
    tokens += Math.ceil(ascii / 4) + nonAscii;
  }
  return tokens;
}

export async function hydratePersistedContent(
  content: readonly PersistedContentPart[],
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ChatMessageContent[]> {
  const hydrated: ChatMessageContent[] = [];
  for (const part of content) {
    if (part.type === "text") {
      hydrated.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image-ref") {
      hydrated.push({ type: "image_url", image_url: { url: part.url } });
      continue;
    }
    try {
      const timeoutSignal = AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS);
      const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const response = await fetcher(part.url, { signal: fetchSignal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const base64 = Buffer.from(await response.arrayBuffer()).toString("base64");
      hydrated.push({
        type: "file",
        file: { filename: part.filename, file_data: `data:${part.mime};base64,${base64}` },
      });
    } catch (error) {
      console.warn("[conversation] historical file hydration failed", {
        filename: part.filename,
        error: error instanceof Error ? error.message : String(error),
      });
      hydrated.push({ type: "text", text: `[file unavailable: ${part.filename}]` });
    }
  }
  return hydrated;
}

interface RawSession {
  id: number;
  openrouterSessionId: string;
  guildId: string;
  channelId: string;
  parentChannelId: string | null;
  startedAt: number;
  lastActivityAt: number;
}

interface RawTurn {
  id: number;
  sessionId: number;
  role: "user" | "assistant";
  authorId: string | null;
  authorLabel: string | null;
  parentUserTurnId: number | null;
  status: PersistedTurn["status"];
  active: number;
  discordCreatedAt: number;
  finalizedAt: number | null;
  contentSchemaVersion: number;
  contentJson: string;
}

function compareDiscordMessageIds(left: string, right: string): number {
  try {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  } catch {
    return left.localeCompare(right);
  }
}

function deleteEmptySessions(db: Database): void {
  db.run(
    "DELETE FROM sessions WHERE NOT EXISTS (SELECT 1 FROM turns WHERE turns.session_id = sessions.id)",
  );
}

export class ConversationRepository implements IConversationRepository {
  private readonly createTurnInTransaction: {
    immediate: (input: CreateConversationTurnInput) => CreateConversationTurnResult;
  };

  constructor(
    private readonly db: Database,
    readonly deletedBeforeSave = new DeletedBeforeSaveRecord(),
  ) {
    this.createTurnInTransaction = this.db.transaction((input: CreateConversationTurnInput) =>
      this.createTurn(input),
    );
  }

  async createUserAndAssistantTurn(
    input: CreateConversationTurnInput,
  ): Promise<CreateConversationTurnResult> {
    const historyEnabled =
      (this.db
        .query<{ historyEnabled: number }, [string]>(
          "SELECT history_enabled as historyEnabled FROM guild_settings WHERE guild_id = ?",
        )
        .get(input.guildId)?.historyEnabled ?? 0) === 1;
    if (!historyEnabled) {
      return {
        historyEnabled: false,
        created: false,
        duplicate: false,
        skippedReason: "disabled",
      };
    }
    return this.createTurnInTransaction.immediate(input);
  }

  async getContext(userTurnId: number): Promise<ConversationContext | null> {
    const currentRow = this.db
      .query<RawTurn, [number]>(
        `SELECT id, session_id as sessionId, role, author_id as authorId, author_label as authorLabel,
                parent_user_turn_id as parentUserTurnId, status, active, discord_created_at as discordCreatedAt,
                finalized_at as finalizedAt, content_schema_version as contentSchemaVersion, content_json as contentJson
         FROM turns WHERE id = ? AND role = 'user' AND active = 1`,
      )
      .get(userTurnId);
    if (!currentRow) return null;
    const current = this.toPersistedTurn(currentRow);
    if (!current) return null;
    const messageId = this.getPrimaryMessageId(userTurnId);
    if (!messageId) return null;

    const session = this.db
      .query<RawSession, [number]>(
        `SELECT id, openrouter_session_id as openrouterSessionId, guild_id as guildId,
                channel_id as channelId, parent_channel_id as parentChannelId,
                started_at as startedAt, last_activity_at as lastActivityAt
         FROM sessions WHERE id = ?`,
      )
      .get(currentRow.sessionId);
    if (!session) return null;
    if (this.isTurnDeleted(userTurnId, session)) return null;

    const userRows = this.db
      .query<RawTurn, [number]>(
        `SELECT id, session_id as sessionId, role, author_id as authorId, author_label as authorLabel,
                parent_user_turn_id as parentUserTurnId, status, active, discord_created_at as discordCreatedAt,
                finalized_at as finalizedAt, content_schema_version as contentSchemaVersion, content_json as contentJson
         FROM turns WHERE session_id = ? AND role = 'user' AND active = 1`,
      )
      .all(currentRow.sessionId)
      .filter((row) => row.id !== userTurnId)
      .filter((row) => !this.isTurnDeleted(row.id, session))
      .filter((row) => {
        if (row.discordCreatedAt < currentRow.discordCreatedAt) return true;
        if (row.discordCreatedAt > currentRow.discordCreatedAt) return false;
        const rowMessageId = this.getPrimaryMessageId(row.id);
        return rowMessageId !== null && compareDiscordMessageIds(rowMessageId, messageId) < 0;
      })
      .sort((left, right) => {
        if (left.discordCreatedAt !== right.discordCreatedAt) {
          return left.discordCreatedAt - right.discordCreatedAt;
        }
        const leftId = this.getPrimaryMessageId(left.id) ?? "";
        const rightId = this.getPrimaryMessageId(right.id) ?? "";
        return compareDiscordMessageIds(leftId, rightId);
      });

    const exchanges: ConversationExchange[] = [];
    for (const userRow of userRows) {
      const user = this.toPersistedTurn(userRow);
      if (!user) continue;
      const assistantRow = this.db
        .query<RawTurn, [number]>(
          `SELECT id, session_id as sessionId, role, author_id as authorId, author_label as authorLabel,
                  parent_user_turn_id as parentUserTurnId, status, active, discord_created_at as discordCreatedAt,
                  finalized_at as finalizedAt, content_schema_version as contentSchemaVersion, content_json as contentJson
           FROM turns
           WHERE parent_user_turn_id = ? AND role = 'assistant' AND active = 1
           ORDER BY id DESC LIMIT 1`,
        )
        .get(userRow.id);
      if (assistantRow && this.isTurnDeleted(assistantRow.id, session)) continue;
      const assistant =
        assistantRow &&
        (assistantRow.status === "completed" || assistantRow.status === "stopped") &&
        assistantRow.finalizedAt !== null &&
        assistantRow.finalizedAt <= currentRow.discordCreatedAt
          ? this.toPersistedTurn(assistantRow)
          : undefined;
      exchanges.push({ user, ...(assistant && { assistant }) });
    }

    return { current, exchanges, openrouterSessionId: session.openrouterSessionId };
  }

  async createAssistantTurn(
    sessionId: number,
    parentUserTurnId: number,
    discordCreatedAt = Date.now(),
  ): Promise<number | null> {
    return this.db
      .transaction((nextSessionId: number, parentId: number, createdAt: number) => {
        const result = this.db
          .query(
            `INSERT INTO turns (
               session_id, role, parent_user_turn_id, status, content_schema_version, content_json,
               active, discord_created_at
             )
             SELECT ?, 'assistant', id, 'pending', 1, ?, 1, ?
             FROM turns parent
             WHERE parent.id = ? AND parent.role = 'user' AND parent.session_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM turns existing
                 WHERE existing.parent_user_turn_id = parent.id
                   AND existing.role = 'assistant' AND existing.status != 'failed'
               )`,
          )
          .run(nextSessionId, JSON.stringify([]), createdAt, parentId, nextSessionId);
        return result.changes === 1 ? Number(result.lastInsertRowid) : null;
      })
      .immediate(sessionId, parentUserTurnId, discordCreatedAt);
  }

  async onBotMessageSent(
    assistantTurnId: number,
    discordMessageId: string,
    discordCreatedAt: number,
  ): Promise<boolean> {
    return this.db
      .transaction((turnId: number, messageId: string, createdAt: number): boolean => {
        const assistant = this.db
          .query<{ parentUserTurnId: number; status: string }, [number]>(
            `SELECT parent_user_turn_id as parentUserTurnId, status FROM turns
             WHERE id = ? AND role = 'assistant'`,
          )
          .get(turnId);
        if (assistant?.status !== "pending") return false;
        if (this.deletedBeforeSave.hasMessage(messageId)) {
          this.db.query("DELETE FROM turns WHERE id = ?").run(assistant.parentUserTurnId);
          deleteEmptySessions(this.db);
          return false;
        }

        const count =
          this.db
            .query<{ count: number }, [number]>(
              "SELECT COUNT(*) as count FROM turn_messages WHERE turn_id = ?",
            )
            .get(turnId)?.count ?? 0;
        const result = this.db
          .query(
            `INSERT OR IGNORE INTO turn_messages (turn_id, discord_msg_id, seq)
             SELECT ?, ?, COALESCE(MAX(seq) + 1, 0)
             FROM turn_messages WHERE turn_id = ?
             AND EXISTS (SELECT 1 FROM turns WHERE id = ? AND status = 'pending')`,
          )
          .run(turnId, messageId, turnId, turnId);
        if (result.changes > 0 && count === 0) {
          this.db
            .query("UPDATE turns SET discord_created_at = ? WHERE id = ? AND status = 'pending'")
            .run(createdAt, turnId);
        }
        return result.changes > 0;
      })
      .immediate(assistantTurnId, discordMessageId, discordCreatedAt);
  }

  async deleteMessageMapping(discordMessageId: string): Promise<boolean> {
    return this.db
      .transaction((messageId: string) => {
        const result = this.db
          .query("DELETE FROM turn_messages WHERE discord_msg_id = ?")
          .run(messageId);
        return result.changes > 0;
      })
      .immediate(discordMessageId);
  }

  async finalizeAssistantTurn(
    assistantTurnId: number,
    status: Exclude<ConversationTurnStatus, "pending">,
    text: string,
    finalizedAt = Date.now(),
  ): Promise<boolean> {
    return this.db
      .transaction(
        (
          turnId: number,
          nextStatus: Exclude<ConversationTurnStatus, "pending">,
          content: string,
          at: number,
        ) => {
          const result = this.db
            .query(
              `UPDATE turns SET status = ?, active = CASE WHEN ? = 'failed' THEN 0 ELSE active END,
                      content_json = ?, finalized_at = ?
               WHERE id = ? AND role = 'assistant' AND status = 'pending'`,
            )
            .run(
              nextStatus,
              nextStatus,
              JSON.stringify([{ type: "text", text: content }]),
              at,
              turnId,
            );
          return result.changes > 0;
        },
      )
      .immediate(assistantTurnId, status, text, finalizedAt);
  }

  async failPendingTurns(): Promise<number> {
    return this.db
      .transaction(() => {
        const result = this.db
          .query("UPDATE turns SET status = 'failed', active = 0 WHERE status = 'pending'")
          .run();
        return result.changes;
      })
      .immediate();
  }

  async purgeMessage(discordMessageId: string): Promise<boolean> {
    return this.purgeMessages([discordMessageId]);
  }

  async purgeMessages(discordMessageIds: readonly string[]): Promise<boolean> {
    if (discordMessageIds.length === 0) return false;
    return this.db
      .transaction((messageIds: readonly string[]) => {
        const placeholders = messageIds.map(() => "?").join(", ");
        const result = this.db
          .query(
            `DELETE FROM turns WHERE id IN (
               SELECT CASE WHEN turns.parent_user_turn_id IS NULL THEN turns.id ELSE turns.parent_user_turn_id END
               FROM turns JOIN turn_messages ON turn_messages.turn_id = turns.id
               WHERE turn_messages.discord_msg_id IN (${placeholders})
             )`,
          )
          .run(...messageIds);
        deleteEmptySessions(this.db);
        return result.changes > 0;
      })
      .immediate(discordMessageIds);
  }

  async purgeChannel(channelId: string): Promise<boolean> {
    return this.db
      .transaction((id: string) => {
        const result = this.db
          .query("DELETE FROM sessions WHERE channel_id = ? OR parent_channel_id = ?")
          .run(id, id);
        deleteEmptySessions(this.db);
        return result.changes > 0;
      })
      .immediate(channelId);
  }

  async purgeThread(channelId: string): Promise<boolean> {
    return this.db
      .transaction((id: string) => {
        const result = this.db.query("DELETE FROM sessions WHERE channel_id = ?").run(id);
        deleteEmptySessions(this.db);
        return result.changes > 0;
      })
      .immediate(channelId);
  }

  async purgeGuild(guildId: string): Promise<boolean> {
    return this.db
      .transaction((id: string) => {
        const result = this.db.query("DELETE FROM sessions WHERE guild_id = ?").run(id);
        deleteEmptySessions(this.db);
        return result.changes > 0;
      })
      .immediate(guildId);
  }

  async sweepExpired(now = Date.now()): Promise<number> {
    const cutoff = now - HISTORY_RETENTION_MS;
    return this.db
      .transaction((expiration: number) => {
        const result = this.db
          .query(
            `DELETE FROM turns WHERE id IN (
               SELECT users.id FROM turns users
               WHERE users.role = 'user'
               AND NOT EXISTS (
                 SELECT 1 FROM turns exchange
                 WHERE (exchange.id = users.id OR exchange.parent_user_turn_id = users.id)
                   AND exchange.discord_created_at >= ?
               )
             )`,
          )
          .run(expiration);
        deleteEmptySessions(this.db);
        return result.changes;
      })
      .immediate(cutoff);
  }

  private createTurn(input: CreateConversationTurnInput): CreateConversationTurnResult {
    const historyEnabled =
      (this.db
        .query<{ historyEnabled: number }, [string]>(
          "SELECT history_enabled as historyEnabled FROM guild_settings WHERE guild_id = ?",
        )
        .get(input.guildId)?.historyEnabled ?? 0) === 1;
    if (!historyEnabled) {
      return {
        historyEnabled: false,
        created: false,
        duplicate: false,
        skippedReason: "disabled",
      };
    }

    const existing = this.db
      .query<{ turnId: number }, [string]>(
        "SELECT turn_id as turnId FROM turn_messages WHERE discord_msg_id = ? LIMIT 1",
      )
      .get(input.discordMessageId);
    if (existing) {
      return { historyEnabled: true, created: false, duplicate: true, userTurnId: existing.turnId };
    }

    if (Date.now() - input.handlingStartedAt > TURN_SAVE_MAX_AGE_MS) {
      return {
        historyEnabled: true,
        created: false,
        duplicate: false,
        skippedReason: "too-old",
      };
    }
    const messageDeleted = this.deletedBeforeSave.hasMessage(input.discordMessageId);
    const scopeDeleted = this.deletedBeforeSave.hasScope(
      input.channelId,
      input.parentChannelId,
      input.guildId,
    );
    if (messageDeleted || scopeDeleted) {
      return {
        historyEnabled: true,
        created: false,
        duplicate: false,
        skippedReason: "deleted",
        skipResponse: messageDeleted,
      };
    }

    const session = this.db
      .query<RawSession, [string, string]>(
        `SELECT id, openrouter_session_id as openrouterSessionId, guild_id as guildId,
                channel_id as channelId, parent_channel_id as parentChannelId,
                started_at as startedAt, last_activity_at as lastActivityAt
         FROM sessions WHERE guild_id = ? AND channel_id = ?
         ORDER BY last_activity_at DESC, id DESC LIMIT 1`,
      )
      .get(input.guildId, input.channelId);

    let sessionId: number;
    let openrouterSessionId: string;
    if (session && input.discordCreatedAt - session.lastActivityAt <= SESSION_GAP_MS) {
      sessionId = session.id;
      openrouterSessionId = session.openrouterSessionId;
      this.db
        .query("UPDATE sessions SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?")
        .run(input.discordCreatedAt, sessionId);
    } else {
      openrouterSessionId = crypto.randomUUID();
      const result = this.db
        .query(
          `INSERT INTO sessions (openrouter_session_id, guild_id, channel_id, parent_channel_id, started_at, last_activity_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          openrouterSessionId,
          input.guildId,
          input.channelId,
          input.parentChannelId,
          input.discordCreatedAt,
          input.discordCreatedAt,
        );
      sessionId = Number(result.lastInsertRowid);
    }

    const replyToTurnId = input.replyToDiscordMessageId
      ? (this.db
          .query<{ turnId: number }, [string]>(
            "SELECT turn_id as turnId FROM turn_messages WHERE discord_msg_id = ? LIMIT 1",
          )
          .get(input.replyToDiscordMessageId)?.turnId ?? null)
      : null;
    const userResult = this.db
      .query(
        `INSERT INTO turns (
           session_id, role, author_id, author_label, reply_to_turn_id, reply_to_discord_msg_id,
           status, content_schema_version, content_json, active, discord_created_at
         ) VALUES (?, 'user', ?, ?, ?, ?, 'completed', 1, ?, 1, ?)`,
      )
      .run(
        sessionId,
        input.authorId,
        normalizeAuthorLabel(input.authorLabel, input.authorId),
        replyToTurnId,
        input.replyToDiscordMessageId,
        JSON.stringify(input.content),
        input.discordCreatedAt,
      );
    const userTurnId = Number(userResult.lastInsertRowid);
    this.db
      .query("INSERT INTO turn_messages (turn_id, discord_msg_id, seq) VALUES (?, ?, 0)")
      .run(userTurnId, input.discordMessageId);

    const assistantResult = this.db
      .query(
        `INSERT INTO turns (
           session_id, role, parent_user_turn_id, status, content_schema_version, content_json,
           active, discord_created_at
         )
         SELECT ?, 'assistant', id, 'pending', 1, ?, 1, ?
         FROM turns WHERE id = ? AND role = 'user' AND session_id = ?`,
      )
      .run(sessionId, JSON.stringify([]), Date.now(), userTurnId, sessionId);
    if (assistantResult.changes !== 1) {
      throw new Error("Unable to create assistant turn for user turn");
    }
    return {
      historyEnabled: true,
      created: true,
      duplicate: false,
      sessionId,
      openrouterSessionId,
      userTurnId,
      assistantTurnId: Number(assistantResult.lastInsertRowid),
    };
  }

  private getPrimaryMessageId(turnId: number): string | null {
    return (
      this.db
        .query<{ discordMessageId: string }, [number]>(
          `SELECT discord_msg_id as discordMessageId FROM turn_messages WHERE turn_id = ? ORDER BY seq LIMIT 1`,
        )
        .get(turnId)?.discordMessageId ?? null
    );
  }

  private isTurnDeleted(turnId: number, session: RawSession): boolean {
    if (
      this.deletedBeforeSave.hasScope(session.channelId, session.parentChannelId, session.guildId)
    ) {
      return true;
    }
    return this.db
      .query<{ discordMessageId: string }, [number]>(
        "SELECT discord_msg_id as discordMessageId FROM turn_messages WHERE turn_id = ?",
      )
      .all(turnId)
      .some(({ discordMessageId }) => this.deletedBeforeSave.hasMessage(discordMessageId));
  }

  private toPersistedTurn(row: RawTurn): PersistedTurn | null {
    if (row.contentSchemaVersion < 1) {
      console.warn("[conversation] ignoring turn with unsupported content schema", {
        turnId: row.id,
        contentSchemaVersion: row.contentSchemaVersion,
      });
      return null;
    }
    const content = parsePersistedContent(row.contentJson, row.id);
    if (!content) return null;
    const discordMessageId = this.getPrimaryMessageId(row.id);
    if (!discordMessageId) return null;
    return {
      id: row.id,
      sessionId: row.sessionId,
      role: row.role,
      authorId: row.authorId,
      authorLabel: row.authorLabel,
      status: row.status,
      active: row.active === 1,
      discordCreatedAt: row.discordCreatedAt,
      finalizedAt: row.finalizedAt,
      discordMessageId,
      content,
    };
  }
}
