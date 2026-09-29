import type { IReplyRecordService } from "../../services/replyRecordService";

type ReplyRecordDeleter = Pick<
  IReplyRecordService,
  "deleteByGuild" | "deleteByChannel" | "deleteGuildsNotIn"
>;

export interface ReplyRecordCleanupHandlers {
  guildDelete(guild: { id: string }): Promise<void>;
  channelDelete(channel: { id: string }): Promise<void>;
  threadDelete(thread: { id: string }): Promise<void>;
  /** Run once the client is ready, with every guild it is in, to catch guilds left while stopped. */
  reconcileGuilds(guildIds: Iterable<string>): Promise<void>;
}

/**
 * Reply records are kept without a time limit and removed only when their
 * range can no longer be read. Deletions discord.js does not report are left
 * behind: a thread outside the cache, a thread under a deleted parent, and
 * anything deleted while the bot was stopped other than a whole guild. Those
 * channels are never read again, so the rows only take space.
 */
export function createReplyRecordCleanupHandlers(
  service: ReplyRecordDeleter,
  cron?: {
    deleteByGuild(guildId: string): number;
    deleteByChannel(channelId: string): number;
    deleteGuildsNotIn(guildIds: readonly string[]): number;
  },
): ReplyRecordCleanupHandlers {
  const log = (scope: string, id: string, removed: number): void => {
    if (removed > 0)
      console.info(
        `[replyRecord] removed ${removed} records ${id ? `for ${scope} ${id}` : `of ${scope}`}`,
      );
  };
  const clean = async (
    scope: string,
    id: string,
    replyDelete: () => Promise<number>,
    cronDelete: () => number | undefined,
  ): Promise<void> => {
    const [reply, cronResult] = await Promise.allSettled([
      Promise.resolve().then(replyDelete),
      Promise.resolve().then(cronDelete),
    ]);
    if (reply.status === "fulfilled") log(scope, id, reply.value);
    if (cronResult.status === "fulfilled" && cronResult.value !== undefined && cronResult.value > 0)
      console.info(
        `[cron] removed ${cronResult.value} records ${id ? `for ${scope} ${id}` : `of ${scope}`}`,
      );
    if (reply.status === "rejected") throw reply.reason;
    if (cronResult.status === "rejected") throw cronResult.reason;
  };
  return {
    guildDelete: async (guild) => {
      await clean(
        "guild",
        guild.id,
        () => service.deleteByGuild(guild.id),
        () => cron?.deleteByGuild(guild.id),
      );
    },
    channelDelete: async (channel) => {
      await clean(
        "channel",
        channel.id,
        () => service.deleteByChannel(channel.id),
        () => cron?.deleteByChannel(channel.id),
      );
    },
    threadDelete: async (thread) => {
      await clean(
        "thread",
        thread.id,
        () => service.deleteByChannel(thread.id),
        () => cron?.deleteByChannel(thread.id),
      );
    },
    reconcileGuilds: async (guildIds) => {
      const ids = [...guildIds];
      await clean(
        "guilds left",
        "",
        () => service.deleteGuildsNotIn(ids),
        () => cron?.deleteGuildsNotIn(ids),
      );
    },
  };
}
