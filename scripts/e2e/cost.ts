/**
 * What a run cost, measured as the change in the OpenRouter key's billed
 * `usage` across the run. The key is billed for everything a request costs
 * (tokens, server tools, the PDF parser), whereas the `Cost:` in a reply's
 * footer is only what that response's usage reported, so the key delta is
 * the figure to trust and the footers show where it went.
 */

const KEY_URL = "https://openrouter.ai/api/v1/key";
const KEY_TIMEOUT_MS = 10_000;

/** Reads of the key's usage after the run before giving up on it settling. */
export const USAGE_MAX_READS = 10;
/**
 * The footer rounds each cost to 6 decimals (`toFixed(6)`), so the key can be
 * billed up to half a unit less than a reply reports.
 */
const FOOTER_ROUNDING = 0.0000005;

export async function readKeyUsage(apiKey: string): Promise<number> {
  const response = await fetch(KEY_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(KEY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET /key failed: HTTP ${response.status}`);
  const body = (await response.json()) as { data?: { usage?: unknown } };
  const usage = body.data?.usage;
  if (typeof usage !== "number" || !Number.isFinite(usage)) {
    throw new Error("GET /key returned no numeric usage");
  }
  return usage;
}

export interface SettleDeps {
  read: () => Promise<number>;
  pause: () => Promise<void>;
}

/**
 * OpenRouter bills the key after the response has been returned, so a read
 * right after the last reply can still miss it. Polls until the usage has
 * reached `floor` (the key was billed at least what the replies reported)
 * and then reads the same value twice in a row, or until `maxReads`.
 * Reaching the floor alone is not enough: a server-tool charge the footers
 * never showed can land after the token charges.
 */
export async function settledUsage(
  deps: SettleDeps,
  floor: number,
  replies: number,
  maxReads = USAGE_MAX_READS,
): Promise<{ usage: number; settled: boolean }> {
  const target = floor - FOOTER_ROUNDING * replies;
  let last: number | undefined;
  for (let reads = 0; reads < maxReads; reads++) {
    if (reads > 0) await deps.pause();
    const usage = await deps.read();
    if (usage === last && usage >= target) return { usage, settled: true };
    last = usage;
  }
  return { usage: last ?? floor, settled: false };
}

export interface ScenarioCost {
  name: string;
  /** `undefined` when the scenario produced no reply with a usage footer. */
  cost: number | undefined;
}

function usd(amount: number): string {
  return `$${amount.toFixed(6)}`;
}

/** The lines printed at the end of a run. `usageDelta` is `undefined` when the key could not be read. */
export function formatCostSummary(
  costs: ScenarioCost[],
  usageDelta: { amount: number; settled: boolean } | undefined,
): string[] {
  const reported = costs.reduce((sum, { cost }) => sum + (cost ?? 0), 0);
  const perScenario = costs
    .map(({ name, cost }) => `${name} ${cost === undefined ? "unknown" : usd(cost)}`)
    .join(", ");
  const lines: string[] = [];
  if (usageDelta === undefined) {
    lines.push(`COST unknown: the OpenRouter key's usage could not be read`);
  } else {
    const pending = usageDelta.settled
      ? ""
      : " (still changing when the run gave up waiting; the final figure may be higher)";
    lines.push(
      `COST ${usd(usageDelta.amount)} billed to the OpenRouter key during this run (tokens, server tools, PDF parsing)${pending}`,
    );
  }
  lines.push(`     replies reported ${usd(reported)}: ${perScenario || "none"}`);
  if (usageDelta !== undefined) {
    const other = usageDelta.amount - reported;
    if (other >= FOOTER_ROUNDING * Math.max(costs.length, 1) * 2) {
      lines.push(
        `     the other ${usd(other)} is in no reply's footer: charges billed apart from the response usage, or other use of this key during the run`,
      );
    }
  }
  return lines;
}
