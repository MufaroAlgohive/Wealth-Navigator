/**
 * Single source of truth for a stock_holdings_c row's cost basis.
 *
 * Prefers Expected_fill (the price the client was quoted/saw) over avg_fill
 * (the actual broker execution price) so that MINT's own execution spread
 * never shows up as phantom client P&L — same convention MINT's retail app
 * uses (src/lib/strategyValuation.js higherOfCostPerShareRands) and the one
 * this repo's settlement writers already document as canonical (see
 * src/lib/orderbook/reconcile-buffer-drawdowns.ts, "client is charged the
 * price they saw").
 *
 * Before this file existed, this exact formula was independently
 * reimplemented (with drifting cents/rands heuristics) in at least six
 * places: admin/investors/page.tsx, api/admin/clients/route.ts,
 * api/admin/studio/route.ts, api/admin/orderbook/route.ts,
 * api/rebalance/impact/route.ts and api/rebalance/client-target-impact/route.ts.
 * One more place (api/admin/orderbook/crm-investor-holdings/route.ts) didn't
 * compute a cost basis at all — it passed through stock_holdings_c's own
 * unrealized_pnl column, which is written by a DIFFERENT app (MINT retail's
 * refreshHeldSecurities worker) on its own cadence and its own convention.
 * That divergence is exactly the class of bug this file exists to prevent:
 * two admin screens showing the same holding up in one place and down in
 * another at the same instant, because they never agreed on what "cost"
 * means. Every reader of a holding's cost basis in this repo should import
 * from here instead of reimplementing the cents-vs-rands detection.
 */

export interface CostBasisInput {
  avg_fill?: number | null;
  Expected_fill?: number | null;
}

/** Cost basis per share, in CENTS. */
export function costCentsPerShare(h: CostBasisInput): number {
  const avgCents = Number(h?.avg_fill) || 0;
  const expectedRaw = Number(h?.Expected_fill) || 0;
  if (expectedRaw > 0) {
    const avgRands = avgCents > 0 ? avgCents / 100 : 0;
    // Expected_fill is normally RANDS, but some legacy rows stored it in
    // cents. If it's implausibly far above the known avg_fill (in rands),
    // assume it's cents and convert. Same heuristic as MINT's
    // higherOfCostPerShareRands, kept in sync deliberately.
    const expectedRands = avgRands > 0 && expectedRaw > avgRands * 5 ? expectedRaw / 100 : expectedRaw;
    return Math.round(expectedRands * 100);
  }
  return avgCents > 0 ? avgCents : 0;
}

/** Cost basis per share, in RANDS. */
export function costRandsPerShare(h: CostBasisInput): number {
  return costCentsPerShare(h) / 100;
}
