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
 * in HEAD; an edit not yet committed (a ticked manual check) is fine, the
 * link then shows the committed version.
 *
 * The rewriter is not a CommonMark parser: it handles inline links (with a
 * quoted title, `<...>` destinations, and surrounding spaces), reference
 * definitions, and repository-root paths, and skips fenced code and code
 * spans. Rather than chasing every other link form, the script searches the
 * rewritten text for any path still naming a folder to delete and stops,
 * writing and deleting nothing, so a missed form surfaces as a line to fix
 * by hand instead of a broken link. `CHANGELOG.md` is skipped because
 * git-cliff regenerates it from commit messages.
 *
 * Known gap, deliberately not handled: a link whose destination wraps onto
 * a blockquote continuation line (`> `) passes both the rewriter and the
 * check. Nothing in the repository's design docs is written that way.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "./generate-readme";

const INLINE_LINK = /(\]\(\s*)(<[^>\n]*>|[^\s)]+)((?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\))/g;
const REFERENCE_DEFINITION = /^(\s{0,3}\[[^\]\n]+\]:\s*)(<[^>\n]*>|\S+)(.*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

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
  // Parentheses, backslash escapes, and character references change what the
  // destination means in ways this rewriter does not parse; leave them for
  // `findLeftoverReferences` to stop on.
  if (/[()\\&]/.test(href)) return destination;
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
  // Parentheses too: `encodeURIComponent` keeps them, and a bare `)` would end the Markdown link.
  const repoPath = relative(repoRoot, target)
    .split(sep)
    .map((segment) => encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29"))
    .join("/");
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
      const [, marker, rest = ""] = line.match(FENCE) ?? [];
      if (marker !== undefined) {
        if (fence === undefined) {
          fence = marker;
          return line;
        }
        // Only a run of the same character, at least as long, with nothing after it closes the block.
        if (marker[0] === fence[0] && marker.length >= fence.length && rest.trim() === "") {
          fence = undefined;
          return line;
        }
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

/** Undoes backslash escapes, percent-encoding, and numeric character references, where they decode cleanly. */
function decodeLoosely(line: string): string {
  const references = line
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
  return references.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
}

/**
 * Line numbers (1-based) of `text` that may still point into one of the
 * folders to delete: a folder name right after `../` or `changes/`, or at the
 * start of a link destination (after `](` or a reference definition's `]:`,
 * across line breaks), with any run of `./` and `../` in front, followed by
 * `/` or the end of the path. URLs are ignored, so the permalinks
 * `rewriteLinks` wrote do not count. It errs towards stopping: a false stop
 * costs a manual look, a miss costs a broken link.
 */
export function findLeftoverReferences(text: string, prunedNames: readonly string[]): number[] {
  const escaped = prunedNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const dots = "(?:\\.{1,2}/)*";
  const reference = new RegExp(
    `(?:(?:^|[^\\w-])${dots}(?:\\.\\./|changes/)${dots}|\\]\\(\\s*<?${dots}|\\]:\\s*<?${dots})(?:${escaped.join("|")})(?=[/)#?\\s>"']|$)`,
    "gm",
  );
  // Per line, so a replacement never moves text onto another line.
  const cleaned = text
    .split("\n")
    .map((line) => decodeLoosely(line.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)>\]]+/gi, "")))
    .join("\n");
  const lines = new Set<number>();
  for (const match of cleaned.matchAll(reference)) {
    const end = match.index + match[0].length;
    lines.add(cleaned.slice(0, end).split("\n").length);
  }
  return [...lines].sort((a, b) => a - b);
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

  // A file HEAD does not have (untracked, ignored, or only staged) would get a
  // permalink that 404s, and deleting it would lose it for good.
  const prunedPaths = pruned.map((dir) => relative(repoRoot, dir));
  const inHead = new Set(
    git("ls-tree", "-r", "--name-only", "HEAD", "--", ...prunedPaths).split("\n"),
  );
  const notInHead = git("ls-files", "--cached", "--others", "--", ...prunedPaths)
    .split("\n")
    .filter((path) => path && !inHead.has(path));
  if (notInHead.length > 0) {
    throw new Error(`files in the folders to delete are not in HEAD:\n${notInHead.join("\n")}`);
  }
  const blobBase = `${githubUrlFromRemote(git("remote", "get-url", "origin"))}/blob/${git("rev-parse", "HEAD")}`;

  const skip = [
    resolve(repoRoot, "node_modules"),
    resolve(repoRoot, ".git"),
    resolve(repoRoot, "CHANGELOG.md"),
    ...pruned,
  ];
  const prunedNames = pruned.map((dir) => relative(changesDir, dir));
  const rewrites: { file: string; before: string; after: string }[] = [];
  const leftovers: string[] = [];
  for (const file of markdownFiles(repoRoot, skip)) {
    const before = readFileSync(file, "utf8");
    const after = rewriteLinks(before, file, pruned, repoRoot, blobBase);
    rewrites.push({ file, before, after });
    for (const line of findLeftoverReferences(after, prunedNames)) {
      leftovers.push(`${relative(repoRoot, file)}:${line}`);
    }
  }
  if (leftovers.length > 0) {
    throw new Error(
      `these lines still name a folder to delete in a form this script does not rewrite; fix them by hand (a permalink at ${blobBase}) and rerun. Nothing was changed.\n${leftovers.join("\n")}`,
    );
  }
  for (const { file, before, after } of rewrites) {
    if (after === before) continue;
    writeFileSync(file, after);
    console.log(`rewrote links in ${relative(repoRoot, file)}`);
  }
  for (const dir of pruned) {
    rmSync(dir, { recursive: true });
    console.log(`deleted ${relative(repoRoot, dir)}`);
  }
}

if (import.meta.main) main();
