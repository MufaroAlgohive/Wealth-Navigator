/**
 * Master switch for the IRESS price overlay (read by the web app / BFFs).
 *
 * During the UAT phase the IRESS endpoint returns TEST prices, not the live
 * market (e.g. EXX R145 vs the real R202). So `IRESS_PRICE_OVERLAY=0` tells the
 * app to ignore IRESS quotes everywhere and show the Yahoo price instead, which
 * is the accurate live source until production IRESS is contracted. At the prod
 * cutover, set it back to `1` (or unset) and IRESS becomes the live price source
 * automatically. Default ON so nothing changes unless explicitly disabled.
 *
 * This gates the READ side (the overlays in iress.ts, /api/equities,
 * live-queries, the analysis/quote-snapshot BFFs, and research-lab). On the
 * worker, `IRESS_RETAIL_DRY_RUN` stops the RETAIL writes (securities_c /
 * stock_intraday_c) but does NOT stop the institutional quote_snapshot_c write,
 * so the read gate above is the authoritative suppressor during UAT.
 */
export function iressPriceOverlayEnabled(): boolean {
  return process.env.IRESS_PRICE_OVERLAY !== "0";
}

/**
 * An IRESS quote_snapshot_c row (or worker tick) is trusted as "live" only
 * within this window; older rows are stale and must be dropped in favour of the
 * Yahoo reference. Shared by every read path (iress.ts, /api/equities,
 * live-queries) so the freshness window stays in lockstep. Override with
 * `IRESS_QUOTE_MAX_AGE_HOURS`; defaults to 48h.
 */
export function iressQuoteMaxAgeMs(): number {
  const h = Number(process.env.IRESS_QUOTE_MAX_AGE_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 48) * 3_600_000;
}

/**
 * A worker price (IRESS snapshot or intraday tick) more than this fraction off
 * the Yahoo reference (securities_c.last_price) is almost certainly CT/test/
 * stale data and is rejected. Shared so the board, ticker, and Analysis tab all
 * use the same threshold.
 */
export const IRESS_DIVERGENCE = 0.25;

/**
 * Tight fact-check tolerance: a PAID live feed (IRESS) should track the Yahoo
 * reference within this fraction intraday. Anything past it is worth a look.
 * Override with `IRESS_FACTCHECK_TOLERANCE`; defaults to 0.02 (2%).
 */
export function iressFactcheckTolerance(): number {
  const t = Number(process.env.IRESS_FACTCHECK_TOLERANCE);
  return Number.isFinite(t) && t > 0 ? t : 0.02;
}

/**
 * The hard reject line (clearly test/stale/mis-scaled data). Same default as
 * `IRESS_DIVERGENCE` (0.25) but overridable via `IRESS_DIVERGENCE_PCT`.
 */
export function iressDivergenceReject(): number {
  const r = Number(process.env.IRESS_DIVERGENCE_PCT);
  return Number.isFinite(r) && r > 0 ? r : IRESS_DIVERGENCE;
}

export type DivergenceSeverity = "ok" | "watch" | "breach";

export interface DivergenceResult {
  /** |iress - yahoo| / |yahoo|. */
  ratio: number;
  /** ratio as a percentage. */
  pct: number;
  severity: DivergenceSeverity;
  /** true when within the tight fact-check tolerance (or no reference). */
  withinTolerance: boolean;
}

/**
 * Compare an IRESS value against the Yahoo reference (SAME UNIT for both args,
 * e.g. both in cents). This is the single source of truth for "how far is IRESS
 * from Yahoo" used by the read-path overlays AND the fact-check layer. It is
 * SYMMETRIC: a breach may be Yahoo's fault (15-min delay, currency collisions),
 * so callers must label it "IRESS vs Yahoo mismatch", not "IRESS is wrong".
 * Returns `withinTolerance: true` when there is no usable reference.
 */
export function computeDivergence(iressVal: number, yahooVal: number): DivergenceResult {
  if (!Number.isFinite(yahooVal) || yahooVal <= 0 || !Number.isFinite(iressVal)) {
    return { ratio: 0, pct: 0, severity: "ok", withinTolerance: true };
  }
  const ratio = Math.abs(iressVal - yahooVal) / Math.abs(yahooVal);
  const tolerance = iressFactcheckTolerance();
  const reject = iressDivergenceReject();
  const severity: DivergenceSeverity =
    ratio >= reject ? "breach" : ratio >= tolerance ? "watch" : "ok";
  return { ratio, pct: ratio * 100, severity, withinTolerance: ratio < tolerance };
}
