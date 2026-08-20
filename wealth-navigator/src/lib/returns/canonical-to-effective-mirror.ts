/**
 * Canonical ledger -> `strategy_returns_effective_c` mirror contract.
 *
 * Background: `strategy_returns_effective_c` used to be populated by a
 * completely independent calculation (`publishEodReturns()` -> the
 * `publish_guarded_strategy_return` RPC, plus a byte-identical writer inside
 * the separate MINT app server). That guarded chain and the certified
 * `strategy_canonical_daily_ledger_c` ledger (fixed for the YTD chain-linking
 * bug — see canonical-ledger-ytd-chain-link.test.ts) could and did disagree,
 * confirmed live for both "Yield Basket" (guarded chain climbing to 17.23%
 * while the certified ledger oscillated 4-7%) and "MyGrowthFund" (guarded
 * chain carrying `LEGACY_PRODUCTION` rows dated years before the strategy's
 * own inception).
 *
 * Fix: `certify_strategy_canonical_daily_ledger_c` (see
 * supabase/migrations/20260821000001_mirror_effective_returns_from_canonical_ledger.sql)
 * now mirror-writes the just-certified row into `strategy_returns_effective_c`
 * in the same transaction as certification, so a CERTIFIED row's numbers in
 * `strategy_returns_effective_c` are always byte-identical to
 * `strategy_canonical_daily_ledger_c.period_metrics`. The guarded chain still
 * owns any date that has not yet been certified (mirroring the "certified
 * overlay" pattern already used app-side in
 * src/app/api/admin/factsheets/route.ts), but a certified date can never
 * disagree with itself again.
 *
 * This module is the single, tested definition of that mapping. The SQL
 * migration's expressions are written to match this function field-for-field
 * — keep them in sync if either changes.
 */

export type CanonicalPeriodMetrics = Record<string, { return_pct?: number | null } | undefined>;

export interface CanonicalLedgerRowForMirror {
  strategy_id: string;
  as_of_date: string;
  securities_value_cents: number;
  continuity_cash_cents: number;
  complete_value_cents: number;
  period_metrics: CanonicalPeriodMetrics;
  leg_snapshot: unknown;
  /** Nearest certified row's complete_value_cents on/before (as_of_date - 1 year), or the earliest certified row if none. Null when no certified history exists at all. */
  oneYearReferenceCompleteValueCents: number | null;
  /** Same idea, 5 years back. */
  fiveYearReferenceCompleteValueCents: number | null;
  /** Active composition's effective_from as of as_of_date, from strategy_composition_log_c. */
  compositionEffectiveFrom: string | null;
}

export interface EffectiveReturnsRow {
  strategy_id: string;
  as_of_date: string;
  securities_value_cents: number;
  continuity_cash_cents: number;
  complete_value_cents: number;
  basket_value_cents: number;
  basket_value: number;
  ytd_pct: number | null;
  "1d_pct": number | null;
  "5d_pct": number | null;
  "1m_pct": number | null;
  mtd_pct: number | null;
  "6m_pct": number | null;
  "1y_pct": number | null;
  "5y_pct": number | null;
  all_pct: number | null;
  composition_effective_from: string | null;
  holdings_snapshot: unknown;
  source_kind: string;
  repair_run_id: null;
}

export const CERTIFIED_MIRROR_SOURCE_KIND = "CERTIFIED_CANONICAL_LEDGER";

function pct(metrics: CanonicalPeriodMetrics, period: string): number | null {
  const v = metrics[period]?.return_pct;
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

function ratioPct(currentCents: number, referenceCents: number | null): number | null {
  if (referenceCents == null || !(referenceCents > 0)) return null;
  return ((currentCents - referenceCents) / referenceCents) * 100;
}

/**
 * Maps one CERTIFIED `strategy_canonical_daily_ledger_c` row to the exact
 * row shape `strategy_returns_effective_c` consumers (MINT, CRM, and this
 * repo's own routes) read today. `period_metrics` only carries 1D, 1W, WTD,
 * MTD, 1M, 3M, 6M, YTD and SI — there is no canonical 1Y/5Y period, so those
 * two columns are derived here (and in SQL) from the same complete_value_cents
 * ratio directMetric() uses for every other period, referenced against the
 * nearest certified row on/before the target lookback date.
 *
 * "5d_pct" is approximated from the canonical "1W" (7 calendar days) period —
 * the closest canonical equivalent to a 5-trading-day window. This is a
 * documented, deliberate approximation, not an oversight.
 */
export function mapCertifiedRowToEffectiveRow(row: CanonicalLedgerRowForMirror): EffectiveReturnsRow {
  return {
    strategy_id: row.strategy_id,
    as_of_date: row.as_of_date,
    securities_value_cents: row.securities_value_cents,
    continuity_cash_cents: row.continuity_cash_cents,
    complete_value_cents: row.complete_value_cents,
    basket_value_cents: row.complete_value_cents,
    basket_value: row.complete_value_cents,
    ytd_pct: pct(row.period_metrics, "YTD"),
    "1d_pct": pct(row.period_metrics, "1D"),
    "5d_pct": pct(row.period_metrics, "1W"),
    "1m_pct": pct(row.period_metrics, "1M"),
    mtd_pct: pct(row.period_metrics, "MTD"),
    "6m_pct": pct(row.period_metrics, "6M"),
    "1y_pct": ratioPct(row.complete_value_cents, row.oneYearReferenceCompleteValueCents),
    "5y_pct": ratioPct(row.complete_value_cents, row.fiveYearReferenceCompleteValueCents),
    all_pct: pct(row.period_metrics, "SI"),
    composition_effective_from: row.compositionEffectiveFrom,
    holdings_snapshot: row.leg_snapshot,
    source_kind: CERTIFIED_MIRROR_SOURCE_KIND,
    repair_run_id: null,
  };
}
