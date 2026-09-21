import { describe, expect, test } from "bun:test";
import { githubUrlFromRemote, rewriteLinks } from "../../../scripts/prune-released-changes";

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
