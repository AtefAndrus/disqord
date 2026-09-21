import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../../../src/config";

const KEYS = [
  "DISCORD_TOKEN",
  "DISCORD_APPLICATION_ID",
  "OPENROUTER_API_KEY",
  "NODE_ENV",
  "E2E_TESTER_BOT_ID",
  "WEB_SEARCH_ENGINE",
] as const;

describe("loadConfig: E2E_TESTER_BOT_ID", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    process.env.DISCORD_TOKEN = "token";
    process.env.DISCORD_APPLICATION_ID = "1";
    process.env.OPENROUTER_API_KEY = "key";
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("development では設定値をそのまま返す", () => {
    process.env.NODE_ENV = "development";
    process.env.E2E_TESTER_BOT_ID = "875079314163499040";

    expect(loadConfig().e2eTesterBotId).toBe("875079314163499040");
  });

  test("production では設定されていても無視する（本番 bot を他の bot から駆動させない）", () => {
    process.env.NODE_ENV = "production";
    process.env.E2E_TESTER_BOT_ID = "875079314163499040";

    expect(loadConfig().e2eTesterBotId).toBeUndefined();
  });

  test("production では不正な値でも起動を止めない（無視する設定の検証で本番を落とさない）", () => {
    process.env.NODE_ENV = "production";
    process.env.E2E_TESTER_BOT_ID = "not-a-snowflake";

    expect(loadConfig().e2eTesterBotId).toBeUndefined();
  });

  test("未設定と空文字は undefined になる", () => {
    process.env.NODE_ENV = "development";
    delete process.env.E2E_TESTER_BOT_ID;
    expect(loadConfig().e2eTesterBotId).toBeUndefined();

    process.env.E2E_TESTER_BOT_ID = "";
    expect(loadConfig().e2eTesterBotId).toBeUndefined();
  });

  test("数字以外を含む値は起動時に拒否する", () => {
    process.env.NODE_ENV = "development";
    process.env.E2E_TESTER_BOT_ID = "not-a-snowflake";

    expect(() => loadConfig()).toThrow();
  });
});

describe("loadConfig: WEB_SEARCH_ENGINE", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    process.env.DISCORD_TOKEN = "token";
    process.env.DISCORD_APPLICATION_ID = "1";
    process.env.OPENROUTER_API_KEY = "key";
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("未設定と空文字は perplexity になる", () => {
    delete process.env.WEB_SEARCH_ENGINE;
    expect(loadConfig().webSearchEngine).toBe("perplexity");

    process.env.WEB_SEARCH_ENGINE = "";
    expect(loadConfig().webSearchEngine).toBe("perplexity");
  });

  test("OpenRouter のエンジン名はそのまま使う", () => {
    process.env.WEB_SEARCH_ENGINE = "exa";
    expect(loadConfig().webSearchEngine).toBe("exa");
  });

  test("エンジン名の誤記は起動時に拒否する", () => {
    process.env.WEB_SEARCH_ENGINE = "perplexcity";
    expect(() => loadConfig()).toThrow();
  });
});
