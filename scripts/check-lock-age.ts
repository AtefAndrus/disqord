/**
 * Warns about package versions a change to `bun.lock` adds that were
 * published less than `MIN_AGE_DAYS` ago.
 *
 * Renovate holds direct dependencies for the same three days
 * (`renovate.json5`), but the `bun install` that regenerates the lock can
 * resolve transitive dependencies to versions published minutes earlier, and
 * nothing else looks at them. This covers every version the lock gains,
 * direct or transitive.
 *
 * It warns rather than fails: a fresh version is sometimes the security fix
 * that has to go in now, which is the same reason `bunfig.toml` carries no
 * install-time age gate. A person reads the warning and decides.
 *
 * Usage: bun scripts/check-lock-age.ts <base-ref>
 * Compares `git show <base-ref>:bun.lock` with the working tree's `bun.lock`.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

export const MIN_AGE_DAYS = 3;
const REGISTRY = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;

/** A package entry's first element is `"<name>@<version>"`; the name may be scoped. */
const ENTRY = /^\s*"[^"]+": \["((?:@[^/"]+\/)?[^@"]+)@([^"]+)"/gm;

/** Every `name@version` the lock resolves, one per resolved copy. */
export function lockPackages(lock: string): Set<string> {
  const packages = new Set<string>();
  for (const [, name, version] of lock.matchAll(ENTRY)) {
    packages.add(`${name}@${version}`);
  }
  return packages;
}

/** The `name@version` entries of `head` that `base` does not have, sorted. */
export function addedPackages(base: string, head: string): string[] {
  const before = lockPackages(base);
  return [...lockPackages(head)].filter((pkg) => !before.has(pkg)).sort();
}

/** Splits `name@version` at the last `@`, so a scoped name keeps its leading one. */
export function splitPackage(pkg: string): { name: string; version: string } {
  const at = pkg.lastIndexOf("@");
  return { name: pkg.slice(0, at), version: pkg.slice(at + 1) };
}

export type AgeResult =
  | { pkg: string; status: "old"; publishedAt: string }
  | { pkg: string; status: "young"; publishedAt: string; ageHours: number }
  | { pkg: string; status: "unknown"; reason: string };

export function classify(
  pkg: string,
  publishedAt: string | undefined,
  now: number,
  minAgeDays = MIN_AGE_DAYS,
): AgeResult {
  const time = publishedAt === undefined ? Number.NaN : Date.parse(publishedAt);
  if (!publishedAt || Number.isNaN(time)) {
    return { pkg, status: "unknown", reason: "the registry reports no publish time" };
  }
  const ageHours = (now - time) / 3_600_000;
  return ageHours < minAgeDays * 24
    ? { pkg, status: "young", publishedAt, ageHours }
    : { pkg, status: "old", publishedAt };
}

async function publishTime(name: string, version: string): Promise<string | undefined> {
  // `@scope/name` must keep its `@` and encode the `/`.
  const path = name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
  const response = await fetch(`${REGISTRY}/${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { time?: Record<string, string> };
  return body.time?.[version];
}

async function checkAll(packages: string[], now: number): Promise<AgeResult[]> {
  const results: AgeResult[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < packages.length) {
      const pkg = packages[next++] as string;
      const { name, version } = splitPackage(pkg);
      try {
        results.push(classify(pkg, await publishTime(name, version), now));
      } catch (error) {
        results.push({
          pkg,
          status: "unknown",
          reason: `the registry lookup failed: ${error instanceof Error ? error.message : error}`,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results.sort((a, b) => a.pkg.localeCompare(b.pkg));
}

/** Markdown for the job summary. */
export function summarize(results: AgeResult[]): string {
  const lines = [`## Packages bun.lock adds (${results.length})`, ""];
  if (results.length === 0) return [...lines, "None."].join("\n");
  lines.push("| Package | Published | Result |", "| ------- | --------- | ------ |");
  for (const result of results) {
    const published = result.status === "unknown" ? "?" : result.publishedAt;
    const verdict =
      result.status === "old"
        ? "ok"
        : result.status === "young"
          ? `**${Math.floor(result.ageHours)}h old**, under ${MIN_AGE_DAYS} days`
          : `could not check: ${result.reason}`;
    lines.push(`| \`${result.pkg}\` | ${published} | ${verdict} |`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const baseRef = process.argv[2];
  if (!baseRef) throw new Error("usage: bun scripts/check-lock-age.ts <base-ref>");
  const base = execFileSync("git", ["show", `${baseRef}:bun.lock`], { encoding: "utf8" });
  const head = readFileSync("bun.lock", "utf8");
  const results = await checkAll(addedPackages(base, head), Date.now());

  for (const result of results) {
    if (result.status === "young") {
      console.log(
        `::warning file=bun.lock::${result.pkg} was published ${Math.floor(result.ageHours)}h ago (${result.publishedAt}), under the ${MIN_AGE_DAYS}-day cooldown`,
      );
    } else if (result.status === "unknown") {
      console.log(
        `::warning file=bun.lock::could not check the age of ${result.pkg}: ${result.reason}`,
      );
    }
  }
  const summary = summarize(results);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

if (import.meta.main) await main();
