import { describe, expect, it } from "vitest";

/**
 * admin/investors/page.tsx's investor cards previously showed a "return"
 * figure that was ALWAYS self-computed from live intraday prices
 * (pnlCents / investedStableCents) — never the canonical published return
 * (latestNav.inception_pct), even though the same object also carries
 * ytdPct read straight from that canonical field. Two investigated
 * consequences, both confirmed against live data for a real client
 * (Siliziwe Mafika, MyGrowthFund):
 *
 *   1. The two figures shown side-by-side on one card could legitimately
 *      disagree (self-computed -2.67% vs canonical/YTD -4.09%), because
 *      they were never the same metric — self-computed excludes the
 *      realized loss's contribution to invested/cost-basis the way the
 *      canonical chain-linked figure accounts for it.
 *   2. The self-computed figure ticks on every live-price poll, so a card
 *      appears to "keep changing" between reloads while YTD (fixed,
 *      published once daily) stays put.
 *
 * Mirrors MyMintAdmin's investors.html precedent: prefer the canonical
 * figure (there: repairRow.gross_strategy_twr_pct) whenever it exists;
 * self-compute only as a fallback when no canonical figure is available yet
 * (e.g. a strategy that has never published, or a brand-new investor).
 *
 * This test exercises the selection rule in isolation (extracted verbatim
 * from the fix in page.tsx) rather than mounting the full component, since
 * the page has no existing test harness and the logic is a pure function of
 * (canonicalRetPct, pnlCents, investedStableCents).
 */
function resolveRetPct(canonicalRetPct: number | null | undefined, pnlCents: number, investedStableCents: number): number {
  return canonicalRetPct != null
    ? Number(canonicalRetPct)
    : investedStableCents > 0
      ? (pnlCents / investedStableCents) * 100
      : 0;
}

describe("investor card retPct — canonical-first, self-computed fallback", () => {
  it("prefers the canonical published return when one exists, even though it disagrees with the self-computed figure", () => {
    // Siliziwe's real numbers: canonical -4.087%, self-computed would be ~-2.76%.
    const canonical = -4.087044946082763;
    const selfComputed = resolveRetPct(null, -4291, 155564); // what it would be without the fix
    expect(selfComputed).toBeCloseTo(-2.759, 1);
    expect(resolveRetPct(canonical, -4291, 155564)).toBe(canonical);
  });

  it("falls back to the self-computed figure when no canonical return has published yet", () => {
    expect(resolveRetPct(null, 500, 10000)).toBe(5);
    expect(resolveRetPct(undefined, -300, 12000)).toBe(-2.5);
  });

  it("falls back to 0 (not NaN) when there is no canonical figure and no invested base", () => {
    expect(resolveRetPct(null, 0, 0)).toBe(0);
  });

  it("a canonical figure of exactly 0 is honoured, not treated as missing", () => {
    expect(resolveRetPct(0, 999, 100)).toBe(0);
  });
});
