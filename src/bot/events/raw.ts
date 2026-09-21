import type {
  DeletedBeforeSaveRecord,
  IConversationRepository,
} from "../../db/repositories/conversation";

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

export function createRawEventHandler(
  conversationRepository: IConversationRepository,
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
          await conversationRepository.purgeMessage(messageId);
          return;
        }
        case "MESSAGE_DELETE_BULK": {
          const messageIds = stringArrayField(data, "ids");
          for (const messageId of messageIds) deletedBeforeSave.recordMessage(messageId);
          await conversationRepository.purgeMessages(messageIds);
          return;
        }
        case "CHANNEL_DELETE": {
          const channelId = stringField(data, "id");
          if (!channelId) return;
          deletedBeforeSave.recordChannel(channelId);
          await conversationRepository.purgeChannel(channelId);
          return;
        }
        case "THREAD_DELETE": {
          const channelId = stringField(data, "id");
          if (!channelId) return;
          deletedBeforeSave.recordChannel(channelId);
          await conversationRepository.purgeThread(channelId);
          return;
        }
        case "GUILD_DELETE": {
          const guildId = stringField(data, "id");
          if (!guildId || data.unavailable === true) return;
          deletedBeforeSave.recordGuild(guildId);
          await conversationRepository.purgeGuild(guildId);
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
