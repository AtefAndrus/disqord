import { describe, expect, test } from "bun:test";
import { formatSearchResultLinks, isSearchCountCapped } from "../../../src/llm/tools/webSearch";

describe("formatSearchResultLinks", () => {
  test("リンクを見出し付きの箇条書きにし、ラベルに実際のホスト名を添え、埋め込みを抑止する形で書く", () => {
    expect(
      formatSearchResultLinks([
        { url: "https://bun.com/blog/bun-v1.4", title: "Bun 1.4 | Bun Blog" },
      ]),
    ).toBe("-# 検索結果\n- [Bun 1.4 Bun Blog (bun.com)](<https://bun.com/blog/bun-v1.4>)");
  });

  test("何も表示できなければ undefined を返す", () => {
    expect(formatSearchResultLinks([])).toBeUndefined();
    expect(formatSearchResultLinks([{ url: "javascript:alert(1)", title: "x" }])).toBeUndefined();
    expect(formatSearchResultLinks([{ url: "not a url" }])).toBeUndefined();
  });

  test("タイトルからリンク構文とメンションを壊す文字を除き、無ければホスト名だけにする", () => {
    const text = formatSearchResultLinks([
      { url: "https://a.test/x", title: "[evil](https://phish.test) @everyone\n<#1>" },
      { url: "https://b.test/y" },
    ]);
    expect(text).toBe(
      "-# 検索結果\n- [evilhttps phish.test everyone 1 (a.test)](<https://a.test/x>)\n- [b.test](<https://b.test/y>)",
    );
  });

  test("文字を除いた結果として現れる :// も残さない", () => {
    const text =
      formatSearchResultLinks([
        { url: "https://evil.example/phish", title: "https:/\\/discord.com/login" },
      ]) ?? "";
    expect(text).not.toContain("://discord");
    expect(text).toContain("(evil.example)](<https://evil.example/phish>)");
  });

  test("300 文字を超える URL は表示しない", () => {
    const long = `https://a.test/${"x".repeat(300)}`;
    expect(formatSearchResultLinks([{ url: long, title: "long" }])).toBeUndefined();
  });

  test("同じ URL は 1 回だけ、先頭から 5 件まで並べる", () => {
    const results = Array.from({ length: 7 }, (_, i) => ({ url: `https://site${i}.test/` }));
    const text = formatSearchResultLinks([{ url: "https://site0.test/" }, ...results]) ?? "";
    const lines = text.split("\n").slice(1);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("- [site0.test](<https://site0.test/>)");
    expect(lines[1]).toBe("- [site1.test](<https://site1.test/>)");
  });
});

describe("isSearchCountCapped", () => {
  test("max_uses が native 検索の多くで無視されるエンジンでは上限なしとみなす", () => {
    expect(isSearchCountCapped("perplexity")).toBe(true);
    expect(isSearchCountCapped("exa")).toBe(true);
    expect(isSearchCountCapped("native")).toBe(false);
    expect(isSearchCountCapped("auto")).toBe(false);
  });
});
