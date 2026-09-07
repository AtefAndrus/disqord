import { describe, expect, test } from "bun:test";
import { ActivityType } from "discord.js";
import packageJson from "../../../package.json";
import { createBotClient } from "../../../src/bot/client";

describe("createBotClient", () => {
  test("再 IDENTIFY でも復元されるようにバージョン表示を ClientOptions に持たせる", async () => {
    const client = await createBotClient();

    expect(client.options.presence?.activities).toEqual([
      { name: `v${packageJson.version}`, type: ActivityType.Playing },
    ]);
  });
});
