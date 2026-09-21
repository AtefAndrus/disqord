import { describe, expect, test } from "bun:test";
import { describeSearchBilling, formatSearchResultLinks } from "../../../src/llm/tools/webSearch";

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

  test("タイトルには文字・数字・空白と決めた記号だけを残し、無ければホスト名だけにする", () => {
    const text = formatSearchResultLinks([
      { url: "https://a.test/x", title: "[evil](https://phish.test) **b** `c` @everyone\n<#1>" },
      { url: "https://b.test/y", title: "【速報】Bun 1.4 リリース｜技術ブログ" },
      { url: "https://c.test/z" },
    ]);
    expect(text).toBe(
      [
        "-# 検索結果",
        "- [evil https phish.test b c everyone 1 (a.test)](<https://a.test/x>)",
        "- [【速報】Bun 1.4 リリース 技術ブログ (b.test)](<https://b.test/y>)",
        "- [c.test](<https://c.test/z>)",
      ].join("\n"),
    );
  });

  test("文字を除いた結果として :// を作らない", () => {
    const text =
      formatSearchResultLinks([
        { url: "https://evil.example/phish", title: "https:/\\/discord.com/login :/://x" },
      ]) ?? "";
    expect(text).not.toContain("://discord");
    expect(text).not.toMatch(/\[[^\]]*:\/\//);
    expect(text).toContain("(evil.example)](<https://evil.example/phish>)");
  });

  test("表示の向きを変える文字やゼロ幅文字は残さない", () => {
    expect(formatSearchResultLinks([{ url: "https://moc.live/", title: "\u202e" }])).toBe(
      "-# 検索結果\n- [moc.live](<https://moc.live/>)",
    );
    const text =
      formatSearchResultLinks([{ url: "https://d.test/", title: "a\u200bb\u2066c\u0336" }]) ?? "";
    for (const char of ["\u200b", "\u2066", "\u202e", "\u0336"]) {
      expect(text).not.toContain(char);
    }
    expect(text).toContain("[a b c (d.test)]");
  });

  test("Markdown を作りうる文字が残るホスト名のリンクは表示しない", () => {
    expect(
      formatSearchResultLinks([{ url: "https://%60trusted%60.test/", title: "x" }]),
    ).toBeUndefined();
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

describe("describeSearchBilling", () => {
  test("上限が効かない native 検索と、課金先の違う Firecrawl をそれぞれ伝える", () => {
    expect(describeSearchBilling("perplexity")).toContain("1応答あたり最大2回");
    expect(describeSearchBilling("perplexity")).not.toContain("効きません");
    expect(describeSearchBilling("native")).toContain(
      "Anthropic 以外のモデルの native 検索にはこの上限が効きません",
    );
    expect(describeSearchBilling("auto")).toContain("native 検索を使う場合");
    expect(describeSearchBilling("firecrawl")).toContain("Firecrawl のキーに課金");
  });
});
