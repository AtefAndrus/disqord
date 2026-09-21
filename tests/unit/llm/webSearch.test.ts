import { describe, expect, test } from "bun:test";
import { formatSearchResultLinks, MAX_RESULT_LINKS } from "../../../src/llm/tools/webSearch";

describe("formatSearchResultLinks", () => {
  test("リンクを見出し付きの箇条書きにし、埋め込みを抑止する形で書く", () => {
    expect(
      formatSearchResultLinks([
        { url: "https://bun.com/blog/bun-v1.4", title: "Bun 1.4 | Bun Blog" },
      ]),
    ).toBe("-# 検索結果\n- [Bun 1.4 Bun Blog](<https://bun.com/blog/bun-v1.4>)");
  });

  test("何も表示できなければ undefined を返す", () => {
    expect(formatSearchResultLinks([])).toBeUndefined();
    expect(formatSearchResultLinks([{ url: "javascript:alert(1)", title: "x" }])).toBeUndefined();
    expect(formatSearchResultLinks([{ url: "not a url" }])).toBeUndefined();
  });

  test("タイトルからリンク構文とメンションを壊す文字を除き、無ければホスト名を使う", () => {
    const text = formatSearchResultLinks([
      { url: "https://a.test/x", title: "[evil](https://phish.test) @everyone\n<#1>" },
      { url: "https://b.test/y" },
    ]);
    expect(text).toBe(
      "-# 検索結果\n- [evilhttps phish.test everyone 1](<https://a.test/x>)\n- [b.test](<https://b.test/y>)",
    );
  });

  test("同じ URL は 1 回だけ、先頭から上限件数まで並べる", () => {
    const results = Array.from({ length: MAX_RESULT_LINKS + 2 }, (_, i) => ({
      url: `https://site${i}.test/`,
    }));
    const text = formatSearchResultLinks([{ url: "https://site0.test/" }, ...results]) ?? "";
    const lines = text.split("\n").slice(1);
    expect(lines).toHaveLength(MAX_RESULT_LINKS);
    expect(lines[0]).toBe("- [site0.test](<https://site0.test/>)");
    expect(lines[1]).toBe("- [site1.test](<https://site1.test/>)");
  });
});
