import { describe, expect, test } from "bun:test";
import {
  findLeftoverReferences,
  githubUrlFromRemote,
  rewriteLinks,
} from "../../../scripts/prune-released-changes";

const ROOT = "/repo";
const BASE = "https://github.com/o/r/blob/abc123";
const PRUNED = ["/repo/docs/changes/old-feature"];
const FILE = "/repo/docs/changes/next-feature/design.md";

describe("rewriteLinks", () => {
  test("削除するフォルダへの相対リンクを permalink にし、アンカーを残す", () => {
    const text = "先行: [old](../old-feature/design.md) と [節](../old-feature/design.md#tasks)";

    expect(rewriteLinks(text, FILE, PRUNED, ROOT, BASE)).toBe(
      `先行: [old](${BASE}/docs/changes/old-feature/design.md) と [節](${BASE}/docs/changes/old-feature/design.md#tasks)`,
    );
  });

  test("残るフォルダ、同じ文書内のアンカー、外部 URL は変えない", () => {
    const text =
      "[kept](../kept/design.md) [here](#goals) [ext](https://example.com/old-feature/design.md)";

    expect(rewriteLinks(text, FILE, PRUNED, ROOT, BASE)).toBe(text);
  });

  test("名前の前方一致だけのフォルダ（old-feature-2）は削除対象と見なさない", () => {
    const text = "[similar](../old-feature-2/design.md)";

    expect(rewriteLinks(text, FILE, PRUNED, ROOT, BASE)).toBe(text);
  });

  test("title 付き、<...> のリンク先、前後の空白、参照定義も書き換える", () => {
    const url = `${BASE}/docs/changes/old-feature/design.md`;
    const text = [
      '[a](../old-feature/design.md "title")',
      "[b](<../old-feature/design.md>)",
      "[c]( ../old-feature/design.md )",
      "[old]: ../old-feature/design.md",
      '  [old2]: <../old-feature/design.md> "title"',
    ].join("\n");

    expect(rewriteLinks(text, FILE, PRUNED, ROOT, BASE)).toBe(
      [
        `[a](${url} "title")`,
        `[b](<${url}>)`,
        `[c]( ${url} )`,
        `[old]: ${url}`,
        `  [old2]: <${url}> "title"`,
      ].join("\n"),
    );
  });

  test("コードブロックとインラインコードの中は書き換えない", () => {
    const text = [
      "`[x](../old-feature/design.md)` と [y](../old-feature/design.md)",
      "```md",
      "[z](../old-feature/design.md)",
      "```",
    ].join("\n");

    expect(rewriteLinks(text, FILE, PRUNED, ROOT, BASE).split("\n")).toEqual([
      `\`[x](../old-feature/design.md)\` と [y](${BASE}/docs/changes/old-feature/design.md)`,
      "```md",
      "[z](../old-feature/design.md)",
      "```",
    ]);
  });

  test("長い fence の中の短い fence では閉じず、中身を書き換えない", () => {
    const text = [
      "````md",
      "```",
      "[x](../old-feature/design.md)",
      "```",
      "````",
      "[y](../old-feature/design.md)",
    ].join("\n");

    expect(rewriteLinks(text, FILE, PRUNED, ROOT, BASE).split("\n")).toEqual([
      "````md",
      "```",
      "[x](../old-feature/design.md)",
      "```",
      "````",
      `[y](${BASE}/docs/changes/old-feature/design.md)`,
    ]);
  });

  test("先頭が / のリポジトリ相対パス、パーセントエンコード、クエリと複数の # を扱う", () => {
    const text = [
      "[root](/docs/changes/old-feature/design.md)",
      "[enc](../%6Fld-feature/design.md#a#b)",
      "[query](../old-feature/design.md?plain=1#L3)",
      "[proto](//example.com/docs/changes/old-feature/design.md)",
    ].join("\n");

    expect(rewriteLinks(text, FILE, PRUNED, ROOT, BASE).split("\n")).toEqual([
      `[root](${BASE}/docs/changes/old-feature/design.md)`,
      `[enc](${BASE}/docs/changes/old-feature/design.md#a#b)`,
      `[query](${BASE}/docs/changes/old-feature/design.md?plain=1#L3)`,
      "[proto](//example.com/docs/changes/old-feature/design.md)",
    ]);
  });

  test("別の階層のファイルからのリンクもリポジトリ相対のパスで書き換える", () => {
    const text = "[d](changes/old-feature/design.md)";

    expect(rewriteLinks(text, "/repo/docs/progress.md", PRUNED, ROOT, BASE)).toBe(
      `[d](${BASE}/docs/changes/old-feature/design.md)`,
    );
  });
});

describe("githubUrlFromRemote", () => {
  test("HTTPS、SSH、ホスト別名つき SSH の remote から owner/repo を読む", () => {
    expect(githubUrlFromRemote("https://github.com/o/r.git")).toBe("https://github.com/o/r");
    expect(githubUrlFromRemote("git@github.com:o/r.git")).toBe("https://github.com/o/r");
    expect(githubUrlFromRemote("git@github-AtefAndrus:o/r.git\n")).toBe("https://github.com/o/r");
  });
});

describe("rewriteLinks の出力", () => {
  test("パス中の括弧をエンコードし、Markdown のリンクを途中で閉じさせない", () => {
    expect(rewriteLinks("[x](../old-feature/spec%29.md)", FILE, PRUNED, ROOT, BASE)).toBe(
      `[x](${BASE}/docs/changes/old-feature/spec%29.md)`,
    );
  });
});

describe("findLeftoverReferences", () => {
  test("書き換えられなかった書式の参照を行番号で返し、permalink は数えない", () => {
    const text = [
      `[ok](${BASE}/docs/changes/old-feature/design.md)`,
      "[paren](../old-feature/design.md (title))",
      "see docs/changes/old-feature/design.md",
      "`../old-feature/design.md`",
      "[other](../old-feature-2/design.md)",
    ].join("\n");

    expect(findLeftoverReferences(text, ["old-feature"])).toEqual([2, 3, 4]);
  });

  test("括弧、エスケープ、文字参照を含むリンク先は書き換えず、検出で止める", () => {
    const text = [
      "[a](../old-feature/spec(v2).md)",
      "[b](../old-feature/spec\\!.md)",
      "[c](../old&#45;feature/design.md)",
      "[d](../%6Fld-feature/design.md (title))",
    ].join("\n");

    const rewritten = rewriteLinks(text, FILE, PRUNED, ROOT, BASE);

    expect(rewritten).toBe(text);
    expect(findLeftoverReferences(rewritten, ["old-feature"])).toEqual([1, 2, 3, 4]);
  });

  test("同じ階層からの直下のパスも検出する", () => {
    expect(
      findLeftoverReferences("[x](old-feature/design.md (title))\n[y]: ./old-feature/", [
        "old-feature",
      ]),
    ).toEqual([1, 2]);
  });

  test("複数行にまたがるリンク先とドット区切りのパスを検出し、地の文の括弧では止まらない", () => {
    const text = [
      "[cron]: ",
      "  old-feature/design.md",
      "[a](.././old-feature/design.md (Design))",
      "定期実行 (old-feature) は別途設定する。",
    ].join("\n");

    expect(findLeftoverReferences(text, ["old-feature"])).toEqual([2, 3]);
  });

  test("エスケープした記号と changes/ の後のドット区切りも検出する", () => {
    const text = [
      "[a](../old\\-feature/design.md)",
      "[b](/docs/changes/./old-feature/design.md (Design))",
    ].join("\n");

    expect(findLeftoverReferences(text, ["old-feature"])).toEqual([1, 2]);
  });

  test("rewriteLinks が書き換えた結果には残りが無い", () => {
    const text = "[a](../old-feature/design.md#x)\n[b]: ../old-feature/design.md";

    expect(
      findLeftoverReferences(rewriteLinks(text, FILE, PRUNED, ROOT, BASE), ["old-feature"]),
    ).toEqual([]);
  });
});
