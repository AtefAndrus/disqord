import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../../../src/config";

const KEYS = [
  "DISCORD_TOKEN",
  "DISCORD_APPLICATION_ID",
  "OPENROUTER_API_KEY",
  "NODE_ENV",
  "E2E_TESTER_BOT_ID",
  "WEB_SEARCH_ENGINE",
  "REPLY_GATE_THRESHOLD",
  "FXTWITTER_API_BASE",
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
    process.env.E2E_TESTER_BOT_ID = "500000000000000000";

    expect(loadConfig().e2eTesterBotId).toBe("500000000000000000");
  });

  test("production では設定されていても無視する（本番 bot を他の bot から駆動させない）", () => {
    process.env.NODE_ENV = "production";
    process.env.E2E_TESTER_BOT_ID = "500000000000000000";

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
    // bun test sets NODE_ENV=test, which the config schema rejects.
    process.env.NODE_ENV = "development";
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

  test("reply gate threshold defaults to 0.4 and accepts both boundaries", () => {
    delete process.env.REPLY_GATE_THRESHOLD;
    expect(loadConfig().replyGateThreshold).toBe(0.4);
    process.env.REPLY_GATE_THRESHOLD = "";
    expect(loadConfig().replyGateThreshold).toBe(0.4);
    for (const value of ["0", "0.7", "1"]) {
      process.env.REPLY_GATE_THRESHOLD = value;
      expect(loadConfig().replyGateThreshold).toBe(Number(value));
    }
  });

  test.each(["-0.1", "1.1", "invalid", "Infinity"])(
    "rejects invalid reply gate threshold %s",
    (value) => {
      process.env.REPLY_GATE_THRESHOLD = value;
      expect(() => loadConfig()).toThrow();
    },
  );
});

describe("loadConfig: FXTWITTER_API_BASE", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    process.env.DISCORD_TOKEN = "token";
    process.env.DISCORD_APPLICATION_ID = "1";
    process.env.OPENROUTER_API_KEY = "key";
    process.env.NODE_ENV = "development";
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("未設定なら既定値を使う", () => {
    delete process.env.FXTWITTER_API_BASE;
    expect(loadConfig().fxtwitterApiBase).toBe("https://api.fxtwitter.com");
  });

  test("サブパスと末尾スラッシュを正規化する", () => {
    process.env.FXTWITTER_API_BASE = "https://tweets.example.test/fxtwitter///";
    expect(loadConfig().fxtwitterApiBase).toBe("https://tweets.example.test/fxtwitter");
  });

  test.each([
    "https://tweets.example.test/api?tenant=one",
    "https://tweets.example.test/api#status",
    "https://user:password@tweets.example.test/api",
    "ftp://tweets.example.test/api",
  ])("クエリ、フラグメント、userinfo、非http(s)を拒否する: %s", (value) => {
    process.env.FXTWITTER_API_BASE = value;
    expect(() => loadConfig()).toThrow();
  });
});

describe("loadConfig: OAuth BYOK", () => {
  const names = [
    "DISCORD_TOKEN",
    "DISCORD_APPLICATION_ID",
    "OPENROUTER_API_KEY",
    "NODE_ENV",
    "ENCRYPTION_KEY",
    "ALLOW_UNAUTHENTICATED",
    "OAUTH_CALLBACK_URL",
  ] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.DISCORD_TOKEN = "fixture";
    process.env.DISCORD_APPLICATION_ID = "1";
    process.env.OPENROUTER_API_KEY = "fixture";
    process.env.NODE_ENV = "development";
    delete process.env.ENCRYPTION_KEY;
    delete process.env.ALLOW_UNAUTHENTICATED;
    delete process.env.OAUTH_CALLBACK_URL;
  });
  afterEach(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  test("defaults to the existing default-key behavior", () => {
    expect(loadConfig()).toMatchObject({
      allowUnauthenticated: true,
      encryptionKey: undefined,
      oauthCallbackUrl: undefined,
    });
  });
  test("strict boolean and encryption-key validation", () => {
    for (const value of ["", "yes", "0"]) {
      process.env.ALLOW_UNAUTHENTICATED = value;
      expect(() => loadConfig()).toThrow();
    }
    process.env.ALLOW_UNAUTHENTICATED = "false";
    expect(() => loadConfig()).toThrow("ENCRYPTION_KEY");
    process.env.ENCRYPTION_KEY = "12".repeat(32);
    expect(loadConfig().allowUnauthenticated).toBe(false);
    process.env.ENCRYPTION_KEY = "wrong";
    expect(() => loadConfig()).toThrow();
  });
  test.each([
    "https://callback.example/other-path",
    "http://localhost:3000/auth/callback",
    "http://127.0.0.1:3000/auth/callback",
  ])("accepts callback %s with encryption", (url) => {
    process.env.OAUTH_CALLBACK_URL = url;
    expect(() => loadConfig()).toThrow("ENCRYPTION_KEY");
    process.env.ENCRYPTION_KEY = "12".repeat(32);
    expect(loadConfig().oauthCallbackUrl).toBe(url);
  });
  test.each([
    "http://callback.example/auth/callback",
    "https://callback.example/?a=b",
    "https://callback.example/#hash",
    "https://actor@callback.example/",
    "https://callback.example/?",
    "https://callback.example/#",
    "file:///callback",
  ])("rejects callback %s", (url) => {
    process.env.OAUTH_CALLBACK_URL = url;
    process.env.ENCRYPTION_KEY = "12".repeat(32);
    expect(() => loadConfig()).toThrow();
  });
});
