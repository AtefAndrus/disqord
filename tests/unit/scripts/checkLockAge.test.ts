import { describe, expect, test } from "bun:test";
import {
  addedPackages,
  classify,
  lockPackages,
  splitPackage,
  summarize,
} from "../../../scripts/check-lock-age";

const lock = (entries: string[]): string =>
  `{\n  "lockfileVersion": 1,\n  "packages": {\n${entries.map((e) => `    ${e},`).join("\n\n")}\n  }\n}\n`;

const BASE = lock([
  '"zod": ["zod@4.4.3", "https://npm.flatt.tech/zod/-/zod-4.4.3.tgz", {}, "sha512-a"]',
  '"@discordjs/rest": ["@discordjs/rest@2.6.1", "", { "dependencies": {} }, "sha512-b"]',
  '"@discordjs/rest/@sapphire/snowflake": ["@sapphire/snowflake@3.5.5", "", {}, "sha512-c"]',
]);

describe("lockPackages", () => {
  test("ネストしたキーや scoped の名前も name@version で拾う", () => {
    expect([...lockPackages(BASE)].sort()).toEqual([
      "@discordjs/rest@2.6.1",
      "@sapphire/snowflake@3.5.5",
      "zod@4.4.3",
    ]);
  });
});

describe("addedPackages", () => {
  test("head にだけある版を返し、版の変わらない依存と消えた依存は返さない", () => {
    const head = lock([
      '"zod": ["zod@4.6.5", "", {}, "sha512-a"]',
      '"@discordjs/rest": ["@discordjs/rest@2.6.1", "", {}, "sha512-b"]',
      '"@discordjs/rest/@sapphire/snowflake": ["@sapphire/snowflake@3.5.6", "", {}, "sha512-c"]',
    ]);

    expect(addedPackages(BASE, head)).toEqual(["@sapphire/snowflake@3.5.6", "zod@4.6.5"]);
  });

  test("lock が同じなら何も返さない", () => {
    expect(addedPackages(BASE, BASE)).toEqual([]);
  });
});

describe("splitPackage", () => {
  test("最後の @ で分け、scoped の名前の先頭の @ を残す", () => {
    expect(splitPackage("@sapphire/snowflake@3.5.6")).toEqual({
      name: "@sapphire/snowflake",
      version: "3.5.6",
    });
    expect(splitPackage("zod@4.6.5-beta.1")).toEqual({ name: "zod", version: "4.6.5-beta.1" });
  });
});

describe("classify", () => {
  const now = Date.parse("2026-09-21T12:00:00Z");

  test("公開から 3 日未満は young、3 日以上は old", () => {
    expect(classify("a@1", "2026-09-19T12:00:00Z", now)).toMatchObject({
      status: "young",
      ageHours: 48,
    });
    expect(classify("a@1", "2026-09-18T12:00:00Z", now).status).toBe("old");
  });

  test("公開日時が無いか読めなければ unknown", () => {
    expect(classify("a@1", undefined, now).status).toBe("unknown");
    expect(classify("a@1", "not a date", now).status).toBe("unknown");
  });
});

describe("summarize", () => {
  test("young と unknown を結果の列で区別する", () => {
    const text = summarize([
      { pkg: "a@1", status: "old", publishedAt: "2026-09-01T00:00:00Z" },
      { pkg: "b@1", status: "young", publishedAt: "2026-09-21T00:00:00Z", ageHours: 12.5 },
      { pkg: "c@1", status: "unknown", reason: "the registry lookup failed: HTTP 404" },
    ]);

    expect(text).toContain("| `a@1` | 2026-09-01T00:00:00Z | ok |");
    expect(text).toContain("**12h old**, under 3 days");
    expect(text).toContain("could not check: the registry lookup failed: HTTP 404");
  });

  test("追加が無ければ None と書く", () => {
    expect(summarize([])).toContain("None.");
  });
});
