import type { DeletedBeforeSaveRecord } from "../../db/repositories/conversation";
import type { HistoryPurgeScope, IHistoryRecorder } from "../../services/historyRecorder";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(data: Record<string, unknown>, name: string): string | undefined {
  const value = data[name];
  return typeof value === "string" ? value : undefined;
}

function stringArrayField(data: Record<string, unknown>, name: string): string[] {
  const value = data[name];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function purgeScope(data: Record<string, unknown>): HistoryPurgeScope {
  const channelId = stringField(data, "channel_id");
  const guildId = stringField(data, "guild_id");
  return {
    ...(channelId && { channelId }),
    ...(guildId && { guildId }),
  };
}

export function createRawEventHandler(
  historyRecorder: IHistoryRecorder,
  deletedBeforeSave: DeletedBeforeSaveRecord,
): (packet: unknown) => Promise<void> {
  return async (packet: unknown): Promise<void> => {
    try {
      if (!isRecord(packet)) return;
      const eventName = packet.t;
      const data = packet.d;
      if (typeof eventName !== "string" || !isRecord(data)) return;

      switch (eventName) {
        case "MESSAGE_DELETE": {
          const messageId = stringField(data, "id");
          if (!messageId) return;
          deletedBeforeSave.recordMessage(messageId);
          await historyRecorder.purgeMessage(messageId, purgeScope(data));
          return;
        }
        case "MESSAGE_DELETE_BULK": {
          const messageIds = stringArrayField(data, "ids");
          for (const messageId of messageIds) deletedBeforeSave.recordMessage(messageId);
          await historyRecorder.purgeMessages(messageIds, purgeScope(data));
          return;
        }
        case "CHANNEL_DELETE": {
          const channelId = stringField(data, "id");
          if (!channelId) return;
          deletedBeforeSave.recordChannel(channelId);
          await historyRecorder.purgeChannel(channelId, purgeScope(data));
          return;
        }
        case "THREAD_DELETE": {
          const channelId = stringField(data, "id");
          if (!channelId) return;
          deletedBeforeSave.recordChannel(channelId);
          await historyRecorder.purgeThread(channelId, purgeScope(data));
          return;
        }
        case "GUILD_DELETE": {
          const guildId = stringField(data, "id");
          if (!guildId || data.unavailable === true) return;
          deletedBeforeSave.recordGuild(guildId);
          await historyRecorder.purgeGuild(guildId);
          return;
        }
        default:
          return;
      }
    } catch (error) {
      console.error(
        "Failed to handle raw Discord event",
        error instanceof Error ? error.name : typeof error,
      );
    }
  };
}
