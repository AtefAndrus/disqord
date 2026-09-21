/**
 * Release step: delete every `docs/changes/<name>/` whose design is
 * `status: implemented`, and rewrite the links other Markdown files make into
 * those folders to permalinks at the commit that still has them.
 *
 * Deleting the folders is the release convention (git history is the
 * archive), so a plain relative link would break on every release. Dropping
 * the link would lose the pointer to the design a later change builds on.
 *
 * Usage: bun scripts/prune-released-changes.ts
 * Run it on a commit whose `docs/changes/` is committed and unmodified: the
 * permalinks point at HEAD.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "./generate-readme";

const LINK = /(\]\()([^)\s]+)(\))/g;

/**
 * Rewrites the relative links in `text` (the content of `file`) that point
 * inside one of `prunedDirs` to `<blobBase>/<repo path>`, keeping any `#anchor`.
 * All paths are absolute; `blobBase` is `https://github.com/<owner>/<repo>/blob/<sha>`.
 */
export function rewriteLinks(
  text: string,
  file: string,
  prunedDirs: readonly string[],
  repoRoot: string,
  blobBase: string,
): string {
  return text.replace(LINK, (whole, open: string, href: string, close: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return whole;
    const [path = "", anchor] = href.split("#", 2);
    const target = resolve(dirname(file), path);
    const inPruned = prunedDirs.some((dir) => target === dir || target.startsWith(dir + sep));
    if (!inPruned) return whole;
    const repoPath = relative(repoRoot, target).split(sep).join("/");
    return `${open}${blobBase}/${repoPath}${anchor === undefined ? "" : `#${anchor}`}${close}`;
  });
}

/** `https://github.com/<owner>/<repo>` from an HTTPS or SSH (including host-alias) remote URL. */
export function githubUrlFromRemote(remote: string): string {
  const match = remote.trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error(`cannot read owner/repo from remote: ${remote}`);
  return `https://github.com/${match[1]}/${match[2]}`;
}

function markdownFiles(dir: string, skip: readonly string[]): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (skip.some((s) => path === s || path.startsWith(s + sep))) continue;
    if (entry.isDirectory()) files.push(...markdownFiles(path, skip));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function main(): void {
  const repoRoot = resolve(import.meta.dir, "..");
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

  const changesDir = resolve(repoRoot, "docs/changes");
  const pruned = readdirSync(changesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(changesDir, entry.name))
    .filter((dir) => {
      const design = resolve(dir, "design.md");
      return (
        existsSync(design) &&
        parseFrontmatter(readFileSync(design, "utf8")).status === "implemented"
      );
    });
  if (pruned.length === 0) {
    console.log("No implemented change docs to prune.");
    return;
  }

  const dirty = git("status", "--porcelain", "--", "docs/changes");
  if (dirty) throw new Error(`docs/changes has uncommitted changes:\n${dirty}`);
  const blobBase = `${githubUrlFromRemote(git("remote", "get-url", "origin"))}/blob/${git("rev-parse", "HEAD")}`;

  const skip = [
    resolve(repoRoot, "node_modules"),
    resolve(repoRoot, ".git"),
    resolve(repoRoot, "CHANGELOG.md"),
    ...pruned,
  ];
  for (const file of markdownFiles(repoRoot, skip)) {
    const before = readFileSync(file, "utf8");
    const after = rewriteLinks(before, file, pruned, repoRoot, blobBase);
    if (after !== before) {
      writeFileSync(file, after);
      console.log(`rewrote links in ${relative(repoRoot, file)}`);
    }
  }
  for (const dir of pruned) {
    rmSync(dir, { recursive: true });
    console.log(`deleted ${relative(repoRoot, dir)}`);
  }
}

if (import.meta.main) main();
