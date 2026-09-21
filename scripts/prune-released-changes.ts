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
 * The permalinks point at HEAD, so every file in a folder to delete must be
 * tracked; an edit not yet committed (a ticked manual check) is fine, the
 * link then shows the committed version.
 *
 * This is not a full CommonMark parser. It handles inline links (with an
 * optional title, `<...>` destinations, and surrounding spaces), reference
 * definitions, and repository-root paths, and it leaves fenced code blocks
 * and code spans alone. `CHANGELOG.md` is skipped because git-cliff
 * regenerates it from commit messages.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "./generate-readme";

const INLINE_LINK = /(\]\(\s*)(<[^>\n]*>|[^\s)]+)((?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\))/g;
const REFERENCE_DEFINITION = /^(\s{0,3}\[[^\]\n]+\]:\s*)(<[^>\n]*>|\S+)(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)/;

/** Rewrites one link destination, or returns it unchanged when it is not a relative link into a pruned folder. */
function rewriteDestination(
  destination: string,
  file: string,
  prunedDirs: readonly string[],
  repoRoot: string,
  blobBase: string,
): string {
  const angled = destination.startsWith("<") && destination.endsWith(">");
  const href = angled ? destination.slice(1, -1) : destination;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) {
    return destination;
  }
  const suffixAt = href.search(/[?#]/);
  const rawPath = suffixAt === -1 ? href : href.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? "" : href.slice(suffixAt);
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return destination;
  }
  const target = path.startsWith("/")
    ? resolve(repoRoot, `.${path}`)
    : resolve(dirname(file), path);
  if (!prunedDirs.some((dir) => target === dir || target.startsWith(dir + sep))) {
    return destination;
  }
  const repoPath = relative(repoRoot, target).split(sep).map(encodeURIComponent).join("/");
  const rewritten = `${blobBase}/${repoPath}${suffix}`;
  return angled ? `<${rewritten}>` : rewritten;
}

/** Applies `rewrite` to the parts of `line` outside code spans. */
function outsideCodeSpans(line: string, rewrite: (text: string) => string): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, index) => (index % 2 === 1 ? part : rewrite(part)))
    .join("");
}

/**
 * Rewrites the links in `text` (the content of `file`) that point inside one
 * of `prunedDirs` to `<blobBase>/<repo path>`, keeping any query and fragment.
 * All paths are absolute; `blobBase` is `https://github.com/<owner>/<repo>/blob/<sha>`.
 */
export function rewriteLinks(
  text: string,
  file: string,
  prunedDirs: readonly string[],
  repoRoot: string,
  blobBase: string,
): string {
  const to = (destination: string): string =>
    rewriteDestination(destination, file, prunedDirs, repoRoot, blobBase);
  let fence: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      const marker = line.match(FENCE)?.[1];
      if (marker !== undefined && (fence === undefined || fence === marker)) {
        fence = fence === undefined ? marker : undefined;
        return line;
      }
      if (fence !== undefined) return line;
      const definition = line.match(REFERENCE_DEFINITION);
      if (definition) {
        const [, head = "", destination = "", tail = ""] = definition;
        return `${head}${to(destination)}${tail}`;
      }
      return outsideCodeSpans(line, (part) =>
        part.replace(
          INLINE_LINK,
          (_whole, open: string, destination: string, close: string) =>
            `${open}${to(destination)}${close}`,
        ),
      );
    })
    .join("\n");
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
    else if (entry.name.toLowerCase().endsWith(".md")) files.push(path);
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

  // A file HEAD does not have would get a permalink that 404s, and deleting
  // it would lose it for good.
  const prunedPaths = pruned.map((dir) => relative(repoRoot, dir));
  const untracked = git("ls-files", "--others", "--", ...prunedPaths);
  if (untracked) {
    throw new Error(`files in the folders to delete are not committed:\n${untracked}`);
  }
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
