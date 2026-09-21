/**
 * Warns about package versions a change to `bun.lock` adds that were
 * published less than `MIN_AGE_DAYS` ago.
 *
 * Renovate holds direct dependencies for the same three days
 * (`renovate.json5`), but the `bun install` that regenerates the lock can
 * resolve transitive dependencies to versions published minutes earlier, and
 * nothing else looks at them. This covers every npm version the lock gains,
 * direct or transitive.
 *
 * It warns rather than fails, and never fails on its own errors: a fresh
 * version is sometimes the security fix that has to go in now, which is the
 * same reason `bunfig.toml` carries no install-time age gate. A person reads
 * the warning and decides. Ages are measured when the check runs.
 *
 * Usage: bun scripts/check-lock-age.ts <base-ref>
 * Compares `git show <base-ref>:bun.lock` with the working tree's `bun.lock`.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

export const MIN_AGE_DAYS = 3;
const REGISTRY = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 30_000;
const CONCURRENCY = 6;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 30_000;
/** GitHub shows at most 10 warning annotations per step; one goes to the overall count. */
const MAX_ANNOTATIONS = 9;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
/** Full packuments of long-lived packages run to tens of MB; beyond this the age is reported unknown. */
const MAX_PACKUMENT_BYTES = 64 * 1024 * 1024;

/**
 * Every resolved `name@resolution` in the lock's `packages`, parsed as JSONC
 * so formatting and comments cannot hide an entry. Throws when the text is
 * not a Bun lockfile, so a malformed lock never reads as "nothing added".
 */
export function lockPackages(lock: string): Set<string> {
  const parsed = Bun.JSONC.parse(lock) as { packages?: unknown } | null;
  const packages = parsed?.packages;
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) {
    throw new Error("bun.lock has no `packages` object");
  }
  const resolved = new Set<string>();
  for (const [key, entry] of Object.entries(packages)) {
    const first = Array.isArray(entry) ? entry[0] : undefined;
    if (typeof first !== "string") throw new Error(`bun.lock entry "${key}" is malformed`);
    resolved.add(first);
  }
  return resolved;
}

/** The `name@resolution` entries of `head` that `base` does not have, sorted. */
export function addedPackages(base: Set<string>, head: Set<string>): string[] {
  return [...head].filter((pkg) => !base.has(pkg)).sort();
}

export type Resolution =
  | { kind: "npm"; name: string; version: string }
  | { kind: "local"; name: string; resolution: string }
  | { kind: "external"; name: string; resolution: string };

/**
 * Splits at the first `@` after a scope's leading one; a resolution such as
 * `git+ssh://git@host/...` can contain more. A registry version starts with a
 * digit; `workspace:` / `file:` / `link:` are local; anything else (git,
 * GitHub, tarball URLs) has no npm publish time.
 */
export function parseResolution(pkg: string): Resolution {
  const at = pkg.indexOf("@", 1);
  const name = pkg.slice(0, at);
  const resolution = pkg.slice(at + 1);
  if (/^\d+\.\d+\.\d+/.test(resolution)) return { kind: "npm", name, version: resolution };
  if (/^(?:workspace|file|link):/.test(resolution)) return { kind: "local", name, resolution };
  return { kind: "external", name, resolution };
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

/** Publish times of one package, fetched once however many of its versions were added. */
async function publishTimes(name: string): Promise<Record<string, string>> {
  // `@scope/name` must keep its `@` and encode the `/`.
  const path = name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${REGISTRY}/${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.ok) {
      const length = Number(response.headers.get("content-length"));
      if (length > MAX_PACKUMENT_BYTES)
        throw new Error(`metadata is ${length} bytes, over the limit`);
      const text = await response.text();
      if (text.length > MAX_PACKUMENT_BYTES) throw new Error("metadata is over the size limit");
      const body = JSON.parse(text) as { time?: Record<string, string> };
      return body.time ?? {};
    }
    const transient = response.status === 429 || response.status >= 500;
    if (!transient || attempt >= MAX_ATTEMPTS) throw new Error(`HTTP ${response.status}`);
    const waitMs = retryAfterMs(response.headers.get("retry-after"), Date.now()) ?? 2000 * attempt;
    // Retrying before the registry asked would only spend the remaining attempts while still throttled.
    if (waitMs > MAX_RETRY_WAIT_MS)
      throw new Error(`HTTP ${response.status}, retry after ${waitMs} ms`);
    await Bun.sleep(waitMs);
  }
}

/** Milliseconds a `Retry-After` header asks for, in either its seconds or HTTP-date form. */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

async function checkNpm(
  packages: { pkg: string; name: string; version: string }[],
  now: number,
): Promise<AgeResult[]> {
  const byName = Map.groupBy(packages, (p) => p.name);
  const names = [...byName.keys()];
  const results: AgeResult[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < names.length) {
      const name = names[next++] as string;
      const versions = byName.get(name) ?? [];
      try {
        const times = await publishTimes(name);
        for (const { pkg, version } of versions) results.push(classify(pkg, times[version], now));
      } catch (error) {
        const reason = `the registry lookup failed: ${error instanceof Error ? error.message : error}`;
        for (const { pkg } of versions) results.push({ pkg, status: "unknown", reason });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

/** Young first, then unknown, then old, so what needs a look leads the summary and the annotations. */
const ORDER = { young: 0, unknown: 1, old: 2 } as const;
export function sortResults(results: AgeResult[]): AgeResult[] {
  return [...results].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.pkg.localeCompare(b.pkg),
  );
}

/** Markdown for the job summary. `skipped` lists local resolutions, which have no publish time to check. */
export function summarize(results: AgeResult[], skipped: string[] = []): string {
  const lines = [`## Packages bun.lock adds (${results.length + skipped.length})`, ""];
  if (results.length === 0 && skipped.length === 0) return [...lines, "None."].join("\n");
  lines.push("| Package | Published | Result |", "| ------- | --------- | ------ |");
  for (const result of sortResults(results)) {
    const published = result.status === "unknown" ? "?" : result.publishedAt;
    const verdict =
      result.status === "old"
        ? "ok"
        : result.status === "young"
          ? `**${Math.floor(result.ageHours)}h old**, under ${MIN_AGE_DAYS} days`
          : `could not check: ${result.reason}`;
    lines.push(`| \`${result.pkg}\` | ${published} | ${verdict} |`);
  }
  for (const pkg of skipped) lines.push(`| \`${pkg}\` | - | local, not checked |`);
  return lines.join("\n");
}

/** Escapes a workflow command's message the way @actions/core does, so a value cannot end the command or start another. */
export function escapeData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Workflow commands for the step: one overall count, then the most important results up to the limit. */
export function annotations(results: AgeResult[]): string[] {
  const flagged = sortResults(results).filter((r) => r.status !== "old");
  if (flagged.length === 0) return [];
  const young = flagged.filter((r) => r.status === "young").length;
  const lines = [
    `::warning file=bun.lock::${young} added version(s) are under the ${MIN_AGE_DAYS}-day cooldown and ${flagged.length - young} could not be checked; see the job summary for the full list`,
  ];
  for (const result of flagged.slice(0, MAX_ANNOTATIONS)) {
    lines.push(
      result.status === "young"
        ? `::warning file=bun.lock::${escapeData(`${result.pkg} was published ${Math.floor(result.ageHours)}h ago (${result.publishedAt})`)}`
        : `::warning file=bun.lock::${escapeData(`could not check the age of ${result.pkg}: ${result.reason}`)}`,
    );
  }
  return lines;
}

/**
 * In Actions the summary goes only to the summary file: printed to the log,
 * a package name could be read as a workflow command. Locally it is printed.
 */
function report(lines: string[], summary: string): void {
  for (const line of lines) console.log(line);
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    console.log(summary);
    return;
  }
  try {
    appendFileSync(file, `${summary}\n`);
  } catch (error) {
    console.log(
      `::warning::${escapeData(`could not write the lock age summary: ${error instanceof Error ? error.message : error}`)}`,
    );
  }
}

function readLocks(baseRef: string): { base: Set<string>; head: Set<string> } {
  let baseText: string | undefined;
  try {
    baseText = execFileSync("git", ["show", `${baseRef}:bun.lock`], {
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // A base without bun.lock means everything in the head lock is new.
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (!/does not exist|exists on disk, but not in/.test(stderr)) throw error;
  }
  return {
    base: baseText === undefined ? new Set() : lockPackages(baseText),
    head: lockPackages(readFileSync("bun.lock", "utf8")),
  };
}

async function main(): Promise<void> {
  const baseRef = process.argv[2];
  if (!baseRef) throw new Error("usage: bun scripts/check-lock-age.ts <base-ref>");
  let locks: { base: Set<string>; head: Set<string> };
  try {
    locks = readLocks(baseRef);
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    report(
      [`::warning file=bun.lock::${escapeData(`the lock age check did not run: ${message}`)}`],
      `## Packages bun.lock adds\n\nNot checked: ${message}`,
    );
    return;
  }

  const npm: { pkg: string; name: string; version: string }[] = [];
  const skipped: string[] = [];
  const results: AgeResult[] = [];
  for (const pkg of addedPackages(locks.base, locks.head)) {
    const resolution = parseResolution(pkg);
    if (resolution.kind === "npm") npm.push({ pkg, ...resolution });
    else if (resolution.kind === "local") skipped.push(pkg);
    else
      results.push({
        pkg,
        status: "unknown",
        reason: "not from the npm registry, no publish time",
      });
  }
  results.push(...(await checkNpm(npm, Date.now())));
  report(annotations(results), summarize(results, skipped));
}

if (import.meta.main) {
  // Advisory only: an error in the checker itself is a warning, never a failed step.
  await main().catch((error: unknown) => {
    console.log(
      `::warning::${escapeData(`the lock age check stopped: ${error instanceof Error ? error.message : error}`)}`,
    );
  });
}
