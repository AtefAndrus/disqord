import { describe, expect, test } from "bun:test";
import {
  addedPackages,
  annotations,
  classify,
  escapeData,
  lockPackages,
  parseResolution,
  retryAfterMs,
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
  test("ネストしたキーや scoped の名前も、解決された name@version で拾う", () => {
    expect([...lockPackages(BASE)].sort()).toEqual([
      "@discordjs/rest@2.6.1",
      "@sapphire/snowflake@3.5.5",
      "zod@4.4.3",
    ]);
  });

  test("書式の違い（1 行の JSON、配列の改行）でも同じ結果になる", () => {
    const compact = '{"lockfileVersion":1,"packages":{"zod":["zod@4.4.3","",{},"sha512-a"]}}';
    const multiline =
      '{\n  "packages": {\n    "zod": [\n      "zod@4.4.3",\n      "",\n      {},\n      "sha512-a"\n    ],\n  },\n}';

    expect([...lockPackages(compact)]).toEqual(["zod@4.4.3"]);
    expect([...lockPackages(multiline)]).toEqual(["zod@4.4.3"]);
  });

  test("コメントの中の記述は数えず、alias は解決先の名前で拾う", () => {
    const text =
      '{\n  "packages": {\n    /* "x": ["zod@9.9.9", "", {}, ""], */\n    "my-zod": ["zod@4.4.3", "", {}, "sha512-a"],\n  },\n}';

    expect([...lockPackages(text)]).toEqual(["zod@4.4.3"]);
  });

  test("lock として読めなければ、空ではなく例外にする", () => {
    expect(() => lockPackages("not json")).toThrow();
    expect(() => lockPackages('{"lockfileVersion": 1}')).toThrow("no `packages` object");
    expect(() => lockPackages('{"packages": {"zod": {}}}')).toThrow('entry "zod" is malformed');
  });
});

describe("addedPackages", () => {
  test("head にだけある版を返し、版の変わらない依存と消えた依存は返さない", () => {
    const head = lock([
      '"zod": ["zod@4.6.5", "", {}, "sha512-a"]',
      '"@discordjs/rest": ["@discordjs/rest@2.6.1", "", {}, "sha512-b"]',
      '"@discordjs/rest/@sapphire/snowflake": ["@sapphire/snowflake@3.5.6", "", {}, "sha512-c"]',
    ]);

    expect(addedPackages(lockPackages(BASE), lockPackages(head))).toEqual([
      "@sapphire/snowflake@3.5.6",
      "zod@4.6.5",
    ]);
  });
});

describe("parseResolution", () => {
  test("npm の版、ローカル、それ以外の外部を分け、名前を正しく切り出す", () => {
    expect(parseResolution("@sapphire/snowflake@3.5.6")).toEqual({
      kind: "npm",
      name: "@sapphire/snowflake",
      version: "3.5.6",
    });
    expect(parseResolution("zod@4.6.5-beta.1").kind).toBe("npm");
    expect(parseResolution("local@workspace:packages/local").kind).toBe("local");
    expect(parseResolution("real@git+ssh://git@github.com/org/repo#abc")).toEqual({
      kind: "external",
      name: "real",
      resolution: "git+ssh://git@github.com/org/repo#abc",
    });
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

describe("summarize と annotations", () => {
  const results = [
    { pkg: "a@1", status: "old", publishedAt: "2026-09-01T00:00:00Z" },
    { pkg: "c@1", status: "unknown", reason: "the registry lookup failed: HTTP 404" },
    { pkg: "b@1", status: "young", publishedAt: "2026-09-21T00:00:00Z", ageHours: 12.5 },
  ] as const;

  test("要確認のものを先に並べ、ローカルの解決は確認対象外として載せる", () => {
    const rows = summarize([...results], ["local@workspace:x"])
      .split("\n")
      .filter((l) => l.startsWith("| `"));

    expect(rows).toEqual([
      "| `b@1` | 2026-09-21T00:00:00Z | **12h old**, under 3 days |",
      "| `c@1` | ? | could not check: the registry lookup failed: HTTP 404 |",
      "| `a@1` | 2026-09-01T00:00:00Z | ok |",
      "| `local@workspace:x` | - | local, not checked |",
    ]);
  });

  test("注釈は件数の 1 行を先頭に、young を unknown より先に出す", () => {
    const lines = annotations([...results]);

    expect(lines[0]).toContain(
      "1 added version(s) are under the 3-day cooldown and 1 could not be checked",
    );
    expect(lines[1]).toContain("b@1 was published 12h ago");
    expect(lines[2]).toContain("could not check the age of c@1");
    expect(lines).toHaveLength(3);
  });

  test("注釈は GitHub の上限に収まるよう、件数の行を含めて 10 行までにする", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      pkg: `p${i}@1`,
      status: "young" as const,
      publishedAt: "2026-09-21T00:00:00Z",
      ageHours: 1,
    }));

    expect(annotations(many)).toHaveLength(10);
  });

  test("問題が無ければ注釈を出さない", () => {
    expect(annotations([results[0]])).toEqual([]);
    expect(summarize([])).toContain("None.");
  });
});

describe("retryAfterMs", () => {
  const now = Date.parse("2026-09-21T12:00:00Z");

  test("秒数と HTTP 日付の両方を読み、読めなければ undefined", () => {
    expect(retryAfterMs("120", now)).toBe(120_000);
    expect(retryAfterMs("Mon, 21 Sep 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(retryAfterMs(null, now)).toBeUndefined();
    expect(retryAfterMs("soon", now)).toBeUndefined();
  });
});

describe("escapeData", () => {
  test("改行と % をエスケープし、値が別のワークフローコマンドを始められないようにする", () => {
    expect(escapeData("a\n::stop-commands::x\r100%")).toBe("a%0A::stop-commands::x%0D100%25");
  });

  test("注釈に入る依存名もエスケープされる", () => {
    const [, line] = annotations([
      { pkg: "evil@1\n::error::forged", status: "unknown", reason: "r" },
    ]);

    expect(line).not.toContain("\n");
    expect(line).toContain("evil@1%0A::error::forged");
  });
});
