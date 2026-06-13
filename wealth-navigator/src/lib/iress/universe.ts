/**
 * Single source of truth for the symbols the production OEMS quotes,
 * tracks, and watches — shared by the Railway `iress-ingest` worker
 * (env-default watchlist) and the Next.js UI (cockpit movers, ticker
 * bar, security page watchlist, Equities Top-10, etc.).
 *
 * Why a shared module? Before the audit the worker watchlist had
 * 22 names and the UI watchlist had 13 — only 9 of those 13 were in
 * the worker set, so a click on SOL, AGL, MTN, SHP, CPI, BHG in the
 * UI returned "no tick" even though the worker was happily polling
 * them. Conversely the worker polled REM/BID/ABG/SLM/AMS/WHL/TBS/GRT/
 * CLS/MNP that the UI never displayed, so those writes were wasted
 * bandwidth.
 *
 * The 10-name baseline below is the intersection of the worker default
 * (22) and the UI default (13) plus SOL (worker added it but UI missed
 * it for the movers row). Once the worker covers more symbols, append
 * them here and the UI auto-subscribes on mount.
 *
 * This module is consumed via a relative path from the worker
 * (`workers/iress-ingest/src/env.ts`) and an absolute `@/` path from
 * the Next.js UI (`src/lib/iress/universe.ts`). Both paths resolve to
 * the same on-disk file — keep it framework-agnostic.
 */

export type UniverseKind = "equity" | "fx" | "mm" | "index" | "bond" | "sector";

export interface UniverseEntry {
  /** Canonical IRESS symbol (e.g. "NPN", "USDZAR", "JIBAR_3M"). */
  symbol: string;
  /** Bloomberg/Reuters-style RIC for IRESS `PricingQuoteGet`. Optional for derived rows. */
  ric?: string;
  /** ISIN when available. */
  isin?: string;
  /** Human-readable name for empty-state copy. */
  name: string;
  /** Sector for the heatmap + Equities screener. */
  sector: string;
  /** Semantic kind — drives the UI column (equity tile vs FX rate vs MM rate). */
  kind: UniverseKind;
}

/**
 * The 10-name JSE + rate-codes production baseline.
 *
 * 9 names that overlap between the old worker (22) and UI (13)
 * watchlists: NPN, PRX, FSR, SBK, AGL, BHG, MTN, SHP, CPI.
 * Plus SOL (worker had it, UI movers missed it) → 10.
 *
 * Adding more names here is enough for the worker to start polling
 * them (no separate env knob required) and for the UI to start
 * rendering them. The `IRESS_WATCHLIST_SYMBOLS` env override still
 * wins when the operator needs to focus the worker on a smaller set.
 */
export const JSE_TRACKED_UNIVERSE: ReadonlyArray<UniverseEntry> = [
  { symbol: "NPN", ric: "NPNJ.J", isin: "ZAE000015889", name: "Naspers",       sector: "Technology", kind: "equity" },
  { symbol: "PRX", ric: "PRX.J",  isin: "NL0013654783", name: "Prosus",        sector: "Technology", kind: "equity" },
  { symbol: "FSR", ric: "FSRJ.J", isin: "ZAE000066304", name: "FirstRand",     sector: "Banks",      kind: "equity" },
  { symbol: "SBK", ric: "SBKJ.J", isin: "ZAE000109815", name: "Standard Bank", sector: "Banks",      kind: "equity" },
  { symbol: "AGL", ric: "AGLJ.J", isin: "GB00B1XZS820", name: "Anglo American", sector: "Mining",     kind: "equity" },
  { symbol: "BHG", ric: "BHGJ.J", isin: "GB00BH0P3Z91", name: "BHP Group",     sector: "Mining",     kind: "equity" },
  { symbol: "MTN", ric: "MTNJ.J", isin: "ZAE000042164", name: "MTN Group",     sector: "Telco",      kind: "equity" },
  { symbol: "SOL", ric: "SOLJ.J", isin: "ZAE000006896", name: "Sasol",         sector: "Energy",     kind: "equity" },
  { symbol: "SHP", ric: "SHPJ.J", isin: "ZAE000012084", name: "Shoprite",      sector: "Retail",     kind: "equity" },
  { symbol: "CPI", ric: "CPIJ.J", isin: "ZAE000064676", name: "Capitec",       sector: "Banks",      kind: "equity" },
];

/**
 * The 2 rate codes the worker polls alongside the equity baseline.
 * `USDZAR` rides the `FX` exchange; `JIBAR_3M` rides the `MM` exchange.
 * These are real IRESS rate codes — `PricingQuoteGet` returns a real
 * fix, no `TimeSeriesGet2` entitlement required.
 *
 * Kept separate from the equity baseline so the cockpit movers can
 * render the JSE Top-10 with a JIBAR/USDZAR strip below without
 * conflating the two lists. `JSE_TRACKED_UNIVERSE.length + RATE_CODES.length`
 * is the full 12-symbol worker default after this audit.
 */
export const JSE_RATE_CODES: ReadonlyArray<UniverseEntry> = [
  { symbol: "USDZAR",   name: "USDZAR",  sector: "FX", kind: "fx" },
  { symbol: "JIBAR_3M", name: "JIBAR 3M", sector: "MM", kind: "mm" },
];

/** All symbols the worker should be polling (equity baseline + rate codes). */
export const WORKER_TRACKED_SYMBOLS: ReadonlyArray<string> = [
  ...JSE_TRACKED_UNIVERSE.map((e) => e.symbol),
  ...JSE_RATE_CODES.map((e) => e.symbol),
];

/** Stable Set for O(1) membership tests. Re-derived on module load. */
export const WORKER_TRACKED_SYMBOL_SET: ReadonlySet<string> = new Set(WORKER_TRACKED_SYMBOLS);
