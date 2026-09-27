import type { Database } from "bun:sqlite";

export type ReplyRecordStatus = "pending" | "completed" | "stopped" | "failed";

export interface ReplyRecord {
  triggerMsgId: string;
  channelId: string;
  guildId: string;
  status: ReplyRecordStatus;
  pageCount: number | null;
  finalizedAt: number | null;
  createdAt: number;
}

export interface ReplyPage {
  pageMsgId: string;
  triggerMsgId: string;
  seq: number;
}

export interface CreateReplyRecordInput {
  triggerMsgId: string;
  channelId: string;
  guildId: string;
  createdAt?: number;
}

export interface IReplyRecordRepository {
  createPending(input: CreateReplyRecordInput): boolean;
  appendPage(triggerMsgId: string, pageMsgId: string): boolean;
  removePage(pageMsgId: string): boolean;
  finalize(
    triggerMsgId: string,
    status: Exclude<ReplyRecordStatus, "pending">,
    pageCount: number,
    at?: number,
  ): boolean;
  findByTrigger(triggerMsgId: string): ReplyRecord | null;
  findByPage(pageMsgId: string): ReplyRecord | null;
  listPages(triggerMsgId: string): ReplyPage[];
  markPendingFailed(): number;
  deleteByGuild(guildId: string): number;
  deleteByChannel(channelId: string): number;
  deleteGuildsNotIn(guildIds: readonly string[]): number;
}

interface RawReplyRecord {
  triggerMsgId: string;
  channelId: string;
  guildId: string;
  status: ReplyRecordStatus;
  pageCount: number | null;
  finalizedAt: number | null;
  createdAt: number;
}

interface RawReplyPage {
  pageMsgId: string;
  triggerMsgId: string;
  seq: number;
}

const SELECT_RECORD = `
  SELECT reply_records.trigger_msg_id as triggerMsgId,
         reply_records.channel_id as channelId,
         reply_records.guild_id as guildId,
         reply_records.status,
         reply_records.page_count as pageCount,
         reply_records.finalized_at as finalizedAt,
         reply_records.created_at as createdAt
  FROM reply_records
`;

function toReplyRecord(row: RawReplyRecord): ReplyRecord {
  return row;
}

export class ReplyRecordRepository implements IReplyRecordRepository {
  private readonly createPendingInTransaction: {
    immediate: (input: CreateReplyRecordInput) => boolean;
  };

  constructor(private readonly db: Database) {
    this.createPendingInTransaction = this.db.transaction((input: CreateReplyRecordInput) => {
      const createdAt = input.createdAt ?? Date.now();
      const result = this.db
        .query(
          `INSERT OR IGNORE INTO reply_records
             (trigger_msg_id, channel_id, guild_id, status, page_count, finalized_at, created_at)
           VALUES (?, ?, ?, 'pending', NULL, NULL, ?)`,
        )
        .run(input.triggerMsgId, input.channelId, input.guildId, createdAt);
      return result.changes > 0;
    });
  }

  createPending(input: CreateReplyRecordInput): boolean {
    return this.createPendingInTransaction.immediate(input);
  }

  appendPage(triggerMsgId: string, pageMsgId: string): boolean {
    return this.db
      .transaction((triggerId: string, pageId: string): boolean => {
        const result = this.db
          .query(
            `INSERT INTO reply_pages (page_msg_id, trigger_msg_id, seq)
             SELECT ?, ?, COALESCE(
               (SELECT MAX(seq) + 1 FROM reply_pages WHERE trigger_msg_id = ?),
               0
             )
             WHERE EXISTS (
               SELECT 1 FROM reply_records
               WHERE trigger_msg_id = ? AND status = 'pending'
             )`,
          )
          .run(pageId, triggerId, triggerId, triggerId);
        return result.changes > 0;
      })
      .immediate(triggerMsgId, pageMsgId);
  }

  // 返り値は「このページが記録に残っていないこと」であり、消した件数ではない。
  // 呼び出し側は Discord の削除を進めてよいかを判断するので、もともと登録が無いページも成功とする。
  // 書き込みに失敗したときだけ false になり、その場合は Discord から消さずに残す。
  removePage(pageMsgId: string): boolean {
    this.db.query("DELETE FROM reply_pages WHERE page_msg_id = ?").run(pageMsgId);
    return true;
  }

  finalize(
    triggerMsgId: string,
    status: Exclude<ReplyRecordStatus, "pending">,
    pageCount: number,
    at = Date.now(),
  ): boolean {
    return this.db
      .transaction(
        (
          triggerId: string,
          nextStatus: Exclude<ReplyRecordStatus, "pending">,
          expectedPageCount: number,
          time: number,
        ) => {
          const result = this.db
            .query(
              `UPDATE reply_records
             SET status = ?, page_count = ?, finalized_at = ?
             WHERE trigger_msg_id = ? AND status = 'pending'`,
            )
            .run(nextStatus, expectedPageCount, time, triggerId);
          return result.changes > 0;
        },
      )
      .immediate(triggerMsgId, status, pageCount, at);
  }

  findByTrigger(triggerMsgId: string): ReplyRecord | null {
    const row = this.db
      .query<RawReplyRecord, [string]>(`${SELECT_RECORD} WHERE reply_records.trigger_msg_id = ?`)
      .get(triggerMsgId);
    return row ? toReplyRecord(row) : null;
  }

  findByPage(pageMsgId: string): ReplyRecord | null {
    const row = this.db
      .query<RawReplyRecord, [string]>(
        `${SELECT_RECORD} JOIN reply_pages ON reply_pages.trigger_msg_id = reply_records.trigger_msg_id
         WHERE reply_pages.page_msg_id = ?`,
      )
      .get(pageMsgId);
    return row ? toReplyRecord(row) : null;
  }

  listPages(triggerMsgId: string): ReplyPage[] {
    return this.db
      .query<RawReplyPage, [string]>(
        `SELECT page_msg_id as pageMsgId, trigger_msg_id as triggerMsgId, seq
         FROM reply_pages WHERE trigger_msg_id = ? ORDER BY seq ASC`,
      )
      .all(triggerMsgId);
  }

  markPendingFailed(): number {
    return this.db
      .query("UPDATE reply_records SET status = 'failed' WHERE status = 'pending'")
      .run().changes;
  }

  // 記録は期限では消さない。返答のページやトリガーが消えたと分かったときにも消さない。
  // 消すと、そのトリガーが記録の無い人の発言として次の応答で再び読めるようになるからである。
  // 消すのは、その範囲がもう読まれないと分かったとき（guild からの退出、チャンネルの削除）だけである。
  deleteByGuild(guildId: string): number {
    return this.deleteWhere("guild_id = ?", [guildId]);
  }

  deleteByChannel(channelId: string): number {
    return this.deleteWhere("channel_id = ?", [channelId]);
  }

  // 呼び出し側は ClientReady 時点の参加中の guild をすべて渡すので、空の一覧は「どの guild にも居ない」を意味する。
  deleteGuildsNotIn(guildIds: readonly string[]): number {
    if (guildIds.length === 0) return this.deleteWhere("1 = 1", []);
    const placeholders = guildIds.map(() => "?").join(", ");
    return this.deleteWhere(`guild_id NOT IN (${placeholders})`, guildIds);
  }

  private deleteWhere(condition: string, params: readonly string[]): number {
    return this.db
      .transaction((): number => {
        // foreign_keys が無効な接続でもページの行を残さないよう、ON DELETE CASCADE に頼らず先に消す。
        this.db
          .query(
            `DELETE FROM reply_pages WHERE trigger_msg_id IN
               (SELECT trigger_msg_id FROM reply_records WHERE ${condition})`,
          )
          .run(...params);
        return this.db.query(`DELETE FROM reply_records WHERE ${condition}`).run(...params).changes;
      })
      .immediate();
  }
}
