import { describe, expect, test } from "bun:test";
import {
  adminHeaders,
  dateToSnowflake,
  describeHealth,
  formatMessage,
  lastStartLine,
  linesBetween,
  messageText,
  parseMessageLink,
  retryAfterSeconds,
  snowflakeToDate,
} from "../../../scripts/admin";
import { verifyAdminRequest } from "../../../src/http/adminAuth";

describe("parseMessageLink", () => {
  test("accepts stable, ptb, and canary links", () => {
    for (const host of ["discord.com", "ptb.discord.com", "canary.discord.com"]) {
      expect(parseMessageLink(`https://${host}/channels/1/22/333`)).toEqual({
        guildId: "1",
        channelId: "22",
        messageId: "333",
      });
    }
  });

  test("rejects a channel link without a message id", () => {
    expect(() => parseMessageLink("https://discord.com/channels/1/22")).toThrow();
  });
});

describe("snowflakeToDate", () => {
  test("decodes the creation time from the id", () => {
    expect(snowflakeToDate("1560145518129053767").toISOString()).toBe("2026-10-15T04:21:17.624Z");
  });
});

describe("adminHeaders", () => {
  test("produces headers the server accepts, with the query in any order", async () => {
    const secret = "test-secret";
    const query = new URLSearchParams({ since: "2026-10-15T04:16:00.000Z", lines: "2000" });
    const headers = await adminHeaders(secret, "/admin/logs", query);
    const request = new Request(`http://localhost/admin/logs?${query}`, { headers });

    expect(await verifyAdminRequest(request, secret)).toEqual({ ok: true });
  });

  test("is rejected under another secret", async () => {
    const headers = await adminHeaders("a", "/admin/metrics", new URLSearchParams());
    const request = new Request("http://localhost/admin/metrics", { headers });

    expect((await verifyAdminRequest(request, "b")).ok).toBe(false);
  });
});

describe("messageText", () => {
  test("collects TextDisplay content nested in a Components V2 container", () => {
    const components = [
      {
        type: 17,
        components: [
          { type: 10, content: "answer" },
          { type: 14 },
          { type: 10, content: "-# footer" },
        ],
      },
    ];

    expect(messageText({ content: "", components })).toBe("answer\n-# footer");
  });
});

describe("formatMessage", () => {
  test("marks the linked message and lists its reply target and links", () => {
    const text = formatMessage(
      {
        id: "1560145518129053767",
        content: "see\nthis",
        author: { username: "alice" },
        message_reference: { message_id: "9" },
        embeds: [{ url: "https://fixupx.com/a/status/1", description: "post text\nsecond line" }],
        attachments: [{ filename: "a.png" }],
      },
      "1560145518129053767",
    );

    expect(text).toBe(
      [
        ">> 1560145518129053767 2026-10-15T04:21:17.624Z alice (reply to 9)",
        "   see",
        "   this",
        "   embed: https://fixupx.com/a/status/1 | post text",
        "   attachment: a.png",
      ].join("\n"),
    );
  });
});

describe("linesBetween", () => {
  test("keeps timestamped lines inside the range and drops the rest", () => {
    const log = [
      "[2026-10-15T04:00:00.000Z] [INFO] before",
      "[2026-10-15T04:21:00.000Z] [INFO] inside",
      "DisQord logged in as disqord#0000",
      "[2026-10-15T05:00:00.000Z] [INFO] after",
    ].join("\n");

    expect(
      linesBetween(log, new Date("2026-10-15T04:16:00Z"), new Date("2026-10-15T04:31:00Z")),
    ).toEqual(["[2026-10-15T04:21:00.000Z] [INFO] inside"]);
  });
});

describe("dateToSnowflake", () => {
  test("encodes a time that snowflakeToDate decodes back", () => {
    const date = new Date("2026-10-22T13:00:00.000Z");

    expect(snowflakeToDate(dateToSnowflake(date)).toISOString()).toBe(date.toISOString());
  });
});

describe("lastStartLine", () => {
  const log = [
    '[2026-10-22T13:32:01.304Z] [INFO] Configuration loaded {"nodeEnv":"production"}',
    "[2026-10-23T17:21:28.043Z] [INFO] Web search {}",
    '[2026-10-28T04:44:19.243Z] [INFO] Configuration loaded {"nodeEnv":"production","version":"1.18.0"}',
    "[2026-10-28T05:00:00.000Z] [INFO] Reply gate {}",
  ].join("\n");

  test("returns the last start before the time, not a later one", () => {
    expect(lastStartLine(log, new Date("2026-10-25T00:00:00Z"))).toBe(
      '[2026-10-22T13:32:01.304Z] [INFO] Configuration loaded {"nodeEnv":"production"}',
    );
    expect(lastStartLine(log, new Date("2026-10-28T05:00:00Z"))).toContain('"version":"1.18.0"');
  });

  test("returns nothing when no start precedes the time", () => {
    expect(lastStartLine(log, new Date("2026-10-01T00:00:00Z"))).toBeUndefined();
  });

  test("ignores a later line that only quotes the phrase", () => {
    const quoted = `${log}\n[2026-10-28T05:10:00.000Z] [INFO] Web search {"searches":[{"query":"Configuration loaded"}]}`;

    expect(lastStartLine(quoted, new Date("2026-10-28T06:00:00Z"))).toContain('"version":"1.18.0"');
  });
});

describe("retryAfterSeconds", () => {
  test("prefers the body's retry_after, then the header, then one second", () => {
    expect(retryAfterSeconds({ retry_after: 0.5 }, "3")).toBe(0.5);
    expect(retryAfterSeconds(undefined, "3")).toBe(3);
    expect(retryAfterSeconds({}, null)).toBe(1);
  });
});

describe("describeHealth", () => {
  const health = { version: "1.18.0", startedAt: "2026-10-28T04:44:21.325Z" };

  test("says whether the running process had started by the time", () => {
    expect(describeHealth(health, new Date("2026-10-28T05:00:00Z"))).toBe(
      "health: version 1.18.0, started 2026-10-28T04:44:21.325Z (the message is after its start)",
    );
    expect(describeHealth(health, new Date("2026-10-25T00:00:00Z"))).toContain(
      "another process answered it",
    );
  });

  test("reports missing fields as unknown", () => {
    expect(describeHealth({}, new Date())).toBe(
      "health: version unknown, started unknown (start time unknown)",
    );
  });
});
