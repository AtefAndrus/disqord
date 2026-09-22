import { afterEach, describe, expect, mock, test } from "bun:test";
import type { IReplyRecordRepository } from "../../../src/db/repositories/replyRecord";
import { ConversationWindowService } from "../../../src/services/conversationWindow";
import type {
  DiscordMessageFetchResult,
  DiscordMessageListResult,
  IDiscordMessageReader,
} from "../../../src/services/discordMessageReader";
import type { RawDiscordMessage } from "../../../src/utils/discordMessageNormalizer";

const originalFetch = globalThis.fetch;
const now = Date.parse("2026-09-22T12:00:00.000Z");

function humanWithAttachments(): RawDiscordMessage {
  return {
    id: "100",
    channel_id: "channel",
    guild_id: "guild",
    content: "two images",
    timestamp: new Date(now).toISOString(),
    author: { id: "user", username: "user", bot: false },
    components: [],
    attachments: [
      {
        id: "attachment-one",
        filename: "one.png",
        url: "https://cdn.discordapp.com/attachments/1/one.png",
        content_type: "image/png",
        size: 3,
      },
      {
        id: "attachment-two",
        filename: "two.png",
        url: "https://cdn.discordapp.com/attachments/1/two.png",
        content_type: "image/png",
        size: 3,
      },
    ],
  };
}

function records(): IReplyRecordRepository {
  return {
    createPending: () => true,
    appendPage: () => true,
    removePage: () => true,
    finalize: () => true,
    findByTrigger: () => null,
    findByPage: () => null,
    listPages: () => [],
    markPendingFailed: () => 0,
    deleteExpired: () => 0,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("view_attachment", () => {
  test("pins the attachment ID when a fresh message reorders attachments", async () => {
    const original = humanWithAttachments();
    const reordered = {
      ...original,
      attachments: [...(original.attachments ?? [])].reverse(),
    };
    const reader: IDiscordMessageReader = {
      list: mock(
        async (): Promise<DiscordMessageListResult> => ({ status: "ok", messages: [original] }),
      ),
      fetch: mock(
        async (): Promise<DiscordMessageFetchResult> => ({ status: "found", message: reordered }),
      ),
    };
    const service = new ConversationWindowService(
      reader,
      records(),
      () => now,
      async () => true,
    );
    const context = await service.build({
      current: {
        ...original,
        id: "101",
        content: "question",
        timestamp: new Date(now + 1_000).toISOString(),
      },
      guildId: "guild",
      userId: "user",
      botUserId: "bot",
      botUser: {},
      channel: {},
      historyEnabled: true,
      authorize: async () => true,
    });
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://cdn.discordapp.com/attachments/1/one.png");
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as unknown as typeof fetch;

    const result = await context?.toolContext.viewAttachment(
      "m1",
      1,
      "model",
      new AbortController().signal,
    );

    expect(result).toEqual([
      {
        type: "input_image",
        detail: "auto",
        image_url: "data:image/png;base64,AQID",
      },
    ]);
    expect(reader.fetch).toHaveBeenCalledTimes(1);
  });
});
