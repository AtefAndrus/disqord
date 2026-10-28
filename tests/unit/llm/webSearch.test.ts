import { describe, expect, test } from "bun:test";
import { describeSearchBilling, formatSearchResultLinks } from "../../../src/llm/tools/webSearch";
import type { WebSearchTrace } from "../../../src/types";

function resultUrls(trace: WebSearchTrace): string[] {
  return Array.from(
    (formatSearchResultLinks(trace) ?? "").matchAll(/\]\(<([^>]+)>\)/g),
    (m) => m[1],
  );
}

describe("formatSearchResultLinks", () => {
  test("リンクを見出し付きの箇条書きにし、ラベルに実際のホスト名を添え、埋め込みを抑止する形で書く", () => {
    expect(
      formatSearchResultLinks({
        calls: [],
        results: [{ url: "https://bun.com/blog/bun-v1.4", title: "Bun 1.4 | Bun Blog" }],
      }),
    ).toBe("-# 検索結果\n- [Bun 1.4 Bun Blog (bun.com)](<https://bun.com/blog/bun-v1.4>)");
  });

  test("何も表示できなければ undefined を返す", () => {
    expect(formatSearchResultLinks({ calls: [], results: [] })).toBeUndefined();
    expect(
      formatSearchResultLinks({ calls: [], results: [{ url: "javascript:alert(1)", title: "x" }] }),
    ).toBeUndefined();
    expect(formatSearchResultLinks({ calls: [], results: [{ url: "not a url" }] })).toBeUndefined();
  });

  test("タイトルには文字・数字・空白と決めた記号だけを残し、無ければホスト名だけにする", () => {
    const text = formatSearchResultLinks({
      calls: [],
      results: [
        { url: "https://a.test/x", title: "[evil](https://phish.test) **b** `c` @everyone\n<#1>" },
        { url: "https://b.test/y", title: "【速報】Bun 1.4 リリース｜技術ブログ" },
        { url: "https://c.test/z" },
      ],
    });
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
      formatSearchResultLinks({
        calls: [],
        results: [
          { url: "https://evil.example/phish", title: "https:/\\/discord.com/login :/://x" },
        ],
      }) ?? "";
    expect(text).not.toContain("://discord");
    expect(text).not.toMatch(/\[[^\]]*:\/\//);
    expect(text).toContain("(evil.example)](<https://evil.example/phish>)");
  });

  test("表示の向きを変える文字やゼロ幅文字は残さない", () => {
    expect(
      formatSearchResultLinks({
        calls: [],
        results: [{ url: "https://moc.live/", title: "\u202e" }],
      }),
    ).toBe("-# 検索結果\n- [moc.live](<https://moc.live/>)");
    const text =
      formatSearchResultLinks({
        calls: [],
        results: [{ url: "https://d.test/", title: "a\u200bb\u2066c\u0336" }],
      }) ?? "";
    for (const char of ["\u200b", "\u2066", "\u202e", "\u0336"]) {
      expect(text).not.toContain(char);
    }
    expect(text).toContain("[a b c (d.test)]");
  });

  test("Markdown を作りうる文字が残るホスト名のリンクは表示しない", () => {
    expect(
      formatSearchResultLinks({
        calls: [],
        results: [{ url: "https://%60trusted%60.test/", title: "x" }],
      }),
    ).toBeUndefined();
  });

  test("300 文字を超える URL は表示しない", () => {
    const long = `https://a.test/${"x".repeat(300)}`;
    expect(
      formatSearchResultLinks({ calls: [], results: [{ url: long, title: "long" }] }),
    ).toBeUndefined();
  });

  test("同じ URL は 1 回だけ、先頭から 5 件まで並べる", () => {
    const results = Array.from({ length: 7 }, (_, i) => ({ url: `https://site${i}.test/` }));
    const text =
      formatSearchResultLinks({
        calls: [],
        results: [{ url: "https://site0.test/" }, ...results],
      }) ?? "";
    const lines = text.split("\n").slice(1);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("- [site0.test](<https://site0.test/>)");
    expect(lines[1]).toBe("- [site1.test](<https://site1.test/>)");
  });

  test.each([
    { searches: 2, paths: ["a1", "b1", "a2", "b2", "a3"] },
    { searches: 4, paths: ["a1", "b1", "c1", "d1", "a2"] },
    { searches: 6, paths: ["a1", "b1", "c1", "d1", "e1"] },
  ])("検索 $searches 回の結果を検索順に交互に選び、5 件に収める", ({ searches, paths }) => {
    const calls = Array.from({ length: searches }, (_, index) => ({
      query: String.fromCharCode(97 + index),
      sources: Array.from(
        { length: 5 },
        (_, result) => `https://example.test/${String.fromCharCode(97 + index)}${result + 1}`,
      ),
    }));
    expect(
      resultUrls({
        calls,
        results: [...calls].reverse().flatMap((call) => call.sources.map((url) => ({ url }))),
      }),
    ).toEqual(paths.map((path) => `https://example.test/${path}`));
  });

  test("空の検索と途中で尽きた検索を飛ばして残りの枠を埋める", () => {
    const a = "https://example.test/a";
    const b = "https://example.test/b";
    const c = Array.from({ length: 4 }, (_, index) => `https://example.test/c${index + 1}`);
    expect(
      resultUrls({
        calls: [
          { query: "empty", sources: [] },
          { query: "a", sources: [a] },
          { query: "b", sources: [b] },
          { query: "c", sources: c },
        ],
        results: [a, b, ...c].map((url) => ({ url })),
      }),
    ).toEqual([a, b, ...c.slice(0, 3)]);
  });

  test("一致しない結果は一致した検索を交互に選んだ後の枠に元の順で入れる", () => {
    const a = "https://example.test/a";
    const b = "https://example.test/b";
    const unmatched = Array.from({ length: 4 }, (_, index) => `https://example.test/u${index + 1}`);
    expect(
      resultUrls({
        calls: [
          { query: "a", sources: [a] },
          { query: "b", sources: [b] },
        ],
        results: [unmatched[0], b, unmatched[1], a, ...unmatched.slice(2)].map((url) => ({ url })),
      }),
    ).toEqual([a, b, ...unmatched.slice(0, 3)]);
  });

  test("2 つの検索に含まれる URL は最初の検索だけに属し、1 回だけ表示する", () => {
    const shared = "https://example.test/shared";
    const a = ["https://example.test/a1", "https://example.test/a2"];
    const b = ["https://example.test/b1", "https://example.test/b2"];
    expect(
      resultUrls({
        calls: [
          { query: "a", sources: [shared, ...a] },
          { query: "b", sources: [shared, ...b] },
        ],
        results: [shared, ...a, shared, ...b].map((url) => ({ url })),
      }),
    ).toEqual([shared, b[0], a[0], b[1], a[1]]);
  });

  test("URL を正規化して検索との対応付けと重複の除去を行う", () => {
    const shared = "https://example.test/shared";
    const a = "https://example.test/a";
    const b = "https://example.test/b";
    expect(
      resultUrls({
        calls: [
          { query: "a", sources: ["https://EXAMPLE.test:443/dir/../shared", a] },
          { query: "b", sources: [shared, "https://EXAMPLE.test:443/b"] },
        ],
        results: [shared, a, "https://EXAMPLE.test:443/shared", b].map((url) => ({ url })),
      }),
    ).toEqual([shared, b, a]);
  });

  test("sources の解析できない文字列を無視し、有効な検索結果を交互に選ぶ", () => {
    const a = ["https://example.test/a1", "https://example.test/a2"];
    const b = "https://example.test/b";
    expect(
      resultUrls({
        calls: [
          { query: "a", sources: ["not a url", "", ...a] },
          { query: "b", sources: ["https://[", b] },
        ],
        results: [...a, b].map((url) => ({ url })),
      }),
    ).toEqual([a[0], b, a[1]]);
  });

  test("全件が検索に一致しなければ元の順に先頭 5 件を表示する", () => {
    const urls = Array.from({ length: 7 }, (_, index) => `https://example.test/u${index}`);
    expect(
      resultUrls({
        calls: [
          { query: "a", sources: ["https://other.test/a"] },
          { query: "b", sources: ["https://other.test/b"] },
        ],
        results: urls.map((url) => ({ url })),
      }),
    ).toEqual(urls.slice(0, 5));
  });

  test("検索 1 回に一致しない結果が混ざっても元の順に先頭 5 件を表示する", () => {
    const urls = Array.from({ length: 7 }, (_, index) => `https://example.test/u${index}`);
    expect(
      resultUrls({
        calls: [{ query: "a", sources: urls.slice(1, 5) }],
        results: urls.map((url) => ({ url })),
      }),
    ).toEqual(urls.slice(0, 5));
  });

  test.each([
    {
      caseName: "無害化",
      otherSources: [
        "javascript:alert(1)",
        "not a url",
        "https://%60trusted%60.test/",
        `https://long.test/${"x".repeat(300)}`,
        "https://bad_host.test/",
      ],
    },
    { caseName: "重複", otherSources: ["https://example.test/a1", "https://example.test/a2"] },
  ])(
    "$caseName で検索のグループが 1 つになれば一致しない先頭の結果を動かさない",
    ({ otherSources }) => {
      const urls = Array.from({ length: 6 }, (_, index) => `https://example.test/a${index + 1}`);
      const unmatched = "https://example.test/unmatched";
      expect(
        resultUrls({
          calls: [
            { query: "a", sources: urls },
            { query: "b", sources: [...otherSources] },
          ],
          results: [unmatched, ...urls, ...otherSources].map((url) => ({ url })),
        }),
      ).toEqual([unmatched, ...urls.slice(0, 4)]);
    },
  );
});

describe("describeSearchBilling", () => {
  test("上限が効かない native 検索と、課金先の違う Firecrawl をそれぞれ伝える", () => {
    expect(describeSearchBilling("perplexity")).toContain("1応答あたり最大4回");
    expect(describeSearchBilling("perplexity")).not.toContain("効きません");
    expect(describeSearchBilling("native")).toContain(
      "Anthropic 以外のモデルの native 検索にはこの上限が効きません",
    );
    expect(describeSearchBilling("auto")).toContain("native 検索を使う場合");
    expect(describeSearchBilling("firecrawl")).toContain("Firecrawl のキーに課金");
  });
});
