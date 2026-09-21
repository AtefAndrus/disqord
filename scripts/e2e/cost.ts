/**
 * What a run cost. Two figures are printed, because neither alone is enough:
 *
 * - Each reply's footer shows the response's `usage.cost`, which OpenRouter
 *   documents as the total amount charged for the request (tokens, server
 *   tools, the PDF parser). It is only there for replies that finished.
 * - The change in the key's `usage` (OpenRouter credits consumed by the key)
 *   across the run also catches requests whose reply was never collected,
 *   but it includes anything else that used the key meanwhile and excludes
 *   BYOK spending billed by the provider directly (`byok_usage`).
 *
 * OpenRouter gives no signal that a key's usage has caught up, so the delta
 * is what was observed when polling stopped, not a settled figure.
 */

const KEY_URL = "https://openrouter.ai/api/v1/key";
const KEY_TIMEOUT_MS = 10_000;

/** Reads of the key's usage after the run before giving up. */
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
 * - `stable`: reached what the replies reported and read the same value twice in a row.
 * - `changing`: reached it but was still moving when polling stopped.
 * - `below-reported`: never reached what the replies reported.
 */
export type UsageState = "stable" | "changing" | "below-reported";

/**
 * OpenRouter bills the key after the response has been returned, so a read
 * right after the last reply can still miss it. Polls until the usage has
 * reached `floor` (the key must have been billed at least what the replies
 * reported) and reads the same value twice in a row, or until `maxReads`.
 * This is a heuristic: a charge can still land after two equal reads.
 */
export async function observeUsage(
  deps: SettleDeps,
  floor: number,
  replies: number,
  maxReads = USAGE_MAX_READS,
): Promise<{ usage: number; state: UsageState }> {
  const target = floor - FOOTER_ROUNDING * replies;
  let last: number | undefined;
  for (let reads = 0; reads < maxReads; reads++) {
    if (reads > 0) await deps.pause();
    const usage = await deps.read();
    if (usage === last && usage >= target) return { usage, state: "stable" };
    last = usage;
  }
  const usage = last ?? floor;
  return { usage, state: usage >= target ? "changing" : "below-reported" };
}

export interface ScenarioCost {
  name: string;
  /** `undefined` when the scenario produced no reply with a usage footer. */
  cost: number | undefined;
}

function usd(amount: number): string {
  return `$${amount.toFixed(6)}`;
}

const STATE_NOTE: Record<UsageState, string> = {
  stable: "",
  changing: " (still changing when polling stopped; the final figure may be higher)",
  "below-reported":
    " (the key had not yet been billed what the replies reported when polling stopped)",
};

/** The lines printed at the end of a run. `usageDelta` is `undefined` when the key could not be read. */
export function formatCostSummary(
  costs: ScenarioCost[],
  usageDelta: { amount: number; state: UsageState } | undefined,
): string[] {
  const reported = costs.reduce((sum, { cost }) => sum + (cost ?? 0), 0);
  const perScenario = costs
    .map(({ name, cost }) => `${name} ${cost === undefined ? "unknown" : usd(cost)}`)
    .join(", ");
  const lines: string[] = [];
  if (usageDelta === undefined) {
    lines.push("COST unknown: the OpenRouter key's usage could not be read");
  } else {
    lines.push(
      `COST ${usd(usageDelta.amount)} of OpenRouter credits observed on the key during this run${STATE_NOTE[usageDelta.state]}`,
    );
  }
  lines.push(`     replies reported ${usd(reported)}: ${perScenario || "none"}`);
  if (costs.some(({ cost }) => cost === undefined)) {
    lines.push(
      "     scenarios marked unknown may still be billed after this run, so the figures above can be low",
    );
  }
  if (usageDelta !== undefined) {
    const other = usageDelta.amount - reported;
    if (other >= FOOTER_ROUNDING * Math.max(costs.length, 1) * 2) {
      lines.push(
        `     ${usd(other)} of the key's change is in no collected footer (a reply that was not collected, or other use of this key)`,
      );
    }
  }
  return lines;
}
