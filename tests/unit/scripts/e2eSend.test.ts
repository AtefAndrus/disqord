import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botContextMarker } from "../../../scripts/e2e/input";
import {
  type DiscordMessage,
  inputPreconditions,
  SCENARIOS,
  type Scenario,
  type ScenarioPost,
} from "../../../scripts/e2e/scenarios";
import { messagePayload, sendScenario } from "../../../scripts/e2e/send";
import { applyMigrations } from "../../../src/db/schema";

function scenario(name: string): Scenario {
  const found = SCENARIOS.find((item) => item.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

describe("actual Bot reply fixtures", () => {
  for (const name of ["bot-reply-embed", "bot-reply-v2", "bot-reply-tweet"]) {
    test(`${name} posts nonmention Bot fixtures and replies to the selected id after decoys`, async () => {
      const selected = scenario(name);
      const posts: { message: ScenarioPost; replyTo?: string }[] = [];
      const post = mock(
        async (message: ScenarioPost, replyTo?: string): Promise<DiscordMessage> => {
          posts.push({ message, replyTo });
          return {
            id: String(posts.length),
            content: message.prompt,
            author: { id: "tester", username: "tester", bot: true },
          };
        },
      );
      const sent = await sendScenario(selected, post, async () => {});
      expect(selected.manual).toBe(true);
      expect(posts).toHaveLength(4);
      expect(posts.slice(0, -1).every((item) => item.message.mention === false)).toBe(true);
      expect(posts.slice(0, -1).every((item) => item.replyTo === undefined)).toBe(true);
      const trigger = posts.at(-1);
      expect(trigger?.replyTo).toBe("1");
      expect(sent.triggerId).toBe("4");
      expect(botContextMarker(trigger?.message.prompt ?? "")).toBe(sent.marker);
      for (const token of [
        ...(selected.input?.quote?.tokens ?? []),
        ...(selected.input?.quote?.excludedTokens ?? []),
      ])
        expect(trigger?.message.prompt).not.toContain(token);
      expect(
        messagePayload(trigger?.message ?? { prompt: "" }, "bot", trigger?.replyTo),
      ).toMatchObject({
        allowed_mentions: { users: ["bot"], replied_user: false },
        message_reference: { message_id: "1", fail_if_not_exists: true },
      });
      if (name === "bot-reply-embed")
        expect(messagePayload(posts[0]?.message ?? { prompt: "" }, "bot").embeds).toEqual(
          selected.setup?.embeds,
        );
      if (name === "bot-reply-v2") {
        const payload = messagePayload(posts[0]?.message ?? { prompt: "" }, "bot");
        expect(payload).toMatchObject({ flags: 32768, components: selected.setup?.components });
        expect(payload.content).toBeUndefined();
      }
      if (name === "bot-reply-tweet") {
        expect(posts[0]?.message.prompt).toContain("https://fixupx.com/jack/status/20");
        expect(trigger?.message.prompt).not.toMatch(/https?:\/\//u);
        expect(trigger?.message.prompt).not.toContain("twttr");
      }
    });
  }

  test("rejects fixtures falsely represented as human instead of real Bot messages", async () => {
    const post = mock(
      async (message: ScenarioPost): Promise<DiscordMessage> => ({
        id: "1",
        content: message.prompt,
        author: { id: "tester", username: "tester", bot: false },
      }),
    );
    await expect(sendScenario(scenario("bot-reply-embed"), post, async () => {})).rejects.toThrow(
      "not a real Bot message",
    );
    expect(post).toHaveBeenCalledTimes(1);
  });

  test("rejects a decoy falsely represented as a human", async () => {
    let count = 0;
    const post = mock(
      async (message: ScenarioPost): Promise<DiscordMessage> => ({
        id: String(++count),
        content: message.prompt,
        author: { id: "tester", username: "tester", bot: count === 1 },
      }),
    );
    await expect(sendScenario(scenario("bot-reply-embed"), post, async () => {})).rejects.toThrow(
      "unrelated history fixture is not a real Bot message",
    );
    expect(post).toHaveBeenCalledTimes(2);
  });

  test("each send has a fresh marker even for the same scenario", async () => {
    const post = async (message: ScenarioPost): Promise<DiscordMessage> => ({
      id: "1",
      content: message.prompt,
      author: { id: "tester", username: "tester", bot: true },
    });
    const first = await sendScenario(scenario("tweet"), post, async () => {});
    const second = await sendScenario(scenario("tweet"), post, async () => {});
    expect(first.marker).not.toBe(second.marker);
    expect(botContextMarker(first.marker)).toBeUndefined();
  });

  test("existing history scenarios keep their prompts and exemption", async () => {
    const selected = scenario("history-window");
    if (!selected.setup) throw new Error("history-window requires a setup fixture");
    const posts: ScenarioPost[] = [];
    const post = async (message: ScenarioPost): Promise<DiscordMessage> => {
      posts.push(message);
      return {
        id: String(posts.length),
        content: message.prompt,
        author: { id: "tester", username: "tester", bot: true },
      };
    };
    const result = await sendScenario(selected, post, async () => {});
    expect(posts).toHaveLength(2);
    expect(posts[0]?.prompt).toBe(selected.setup.prompt);
    expect(posts[1]?.prompt).toBe(selected.prompt);
    expect(result.marker).toBe("");
    expect(botContextMarker(posts[1]?.prompt ?? "")).toBeUndefined();
  });

  test("default scenario set remains the same five", () => {
    expect(SCENARIOS.filter((item) => !item.manual).map((item) => item.name)).toEqual([
      "chat",
      "tweet",
      "long",
      "image",
      "pdf",
    ]);
  });
});

test("input preconditions identify disabled history, tweet expansion, and reply footer without changing settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "disqord-e2e-input-"));
  const databasePath = join(dir, "bot.db");
  const db = new Database(databasePath);
  try {
    db.run("PRAGMA synchronous = OFF");
    applyMigrations(db);
    db.run(
      "INSERT INTO guild_settings (guild_id, default_model, history_enabled, twitter_expand_enabled, show_llm_details) VALUES ('guild', 'm', 0, 0, 0)",
    );
    const request = mock(async (): Promise<Response> => Response.json({ guild_id: "guild" }));
    const env = { databasePath, testerBotId: "tester" };
    const blockers = await inputPreconditions("channel", request, env, {
      history: true,
      tweet: true,
    });
    expect(blockers).toHaveLength(3);
    expect(blockers.join("\n")).toContain("会話履歴 is off");
    expect(blockers.join("\n")).toContain("ツイート展開 is off");
    expect(blockers.join("\n")).toContain("LLM 詳細表示 is off");
    db.run(
      "UPDATE guild_settings SET history_enabled=1, twitter_expand_enabled=1, show_llm_details=1",
    );
    expect(
      await inputPreconditions("channel", request, env, { history: true, tweet: true }),
    ).toEqual([]);
    // Missing guild settings have the production defaults: history off, tweet expansion and details on.
    db.run("DELETE FROM guild_settings");
    expect(
      await inputPreconditions("channel", request, env, { history: true, tweet: true }),
    ).toHaveLength(1);
    expect(await inputPreconditions("channel", request, env, { tweet: true })).toEqual([]);
    expect(
      await inputPreconditions("channel", async () => new Response(null, { status: 403 }), env, {}),
    ).toEqual(["cannot read the channel for input preconditions: HTTP 403"]);
    expect(await inputPreconditions("channel", async () => Response.json({}), env, {})).toEqual([
      "E2E_CHANNEL_ID is not a guild channel",
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});
