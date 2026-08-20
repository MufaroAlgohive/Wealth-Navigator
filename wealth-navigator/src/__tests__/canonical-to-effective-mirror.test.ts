import { describe, expect, it } from "vitest";

import {
  CERTIFIED_MIRROR_SOURCE_KIND,
  type CanonicalLedgerRowForMirror,
  mapCertifiedRowToEffectiveRow,
} from "@/lib/returns/canonical-to-effective-mirror";

/**
 * Regression coverage for the strategy_returns_effective_c divergence bug.
 *
 * Confirmed live this session: for "Yield Basket", the independently-computed
 * strategy_returns_effective_c guarded chain showed YTD climbing from 13.96%
 * (2026-07-01) to 17.23% (2026-08-20) — an almost-monotonic 3-week rise
 * inconsistent with real market volatility — while the corrected certified
 * canonical ledger (strategy_canonical_daily_ledger_c, fixed for the
 * rebalance-leg double-counting bug in PR #142) oscillated realistically
 * between 4-7% over the same window, e.g. 6.07% on a date in that range.
 *
 * These tests prove mapCertifiedRowToEffectiveRow() — the mirror this repo
 * now writes into strategy_returns_effective_c at certification time — always
 * reproduces the certified ledger's own numbers exactly, so this divergence
 * (two different YTD figures for the same strategy_id/as_of_date) becomes
 * structurally impossible: there is only one number, read from period_metrics,
 * ever written into effective_c for a CERTIFIED date.
 */
describe("mapCertifiedRowToEffectiveRow", () => {
  const baseRow: CanonicalLedgerRowForMirror = {
    strategy_id: "yield-basket",
    as_of_date: "2026-08-20",
    securities_value_cents: 182_015,
    continuity_cash_cents: 49_194,
    complete_value_cents: 231_209,
    period_metrics: {
      "1D": { return_pct: 0.42 },
      "1W": { return_pct: 1.1 },
      "1M": { return_pct: 2.3 },
      MTD: { return_pct: 2.1 },
      "6M": { return_pct: 5.9 },
      YTD: { return_pct: 6.07 },
      SI: { return_pct: 10.85 },
    },
    leg_snapshot: [{ ticker: "NED", units: 2 }],
    oneYearReferenceCompleteValueCents: 210_000,
    fiveYearReferenceCompleteValueCents: null,
    compositionEffectiveFrom: "2026-07-14",
  };

  it("mirrors the certified ledger's YTD exactly — the real 6.07% vs 17.23% divergence can't happen", () => {
    const mirrored = mapCertifiedRowToEffectiveRow(baseRow);
    // This is the assertion that would have caught the live bug: the mirrored
    // effective_c row's ytd_pct must equal period_metrics.YTD.return_pct on
    // the certified ledger for the same strategy_id/as_of_date, not some
    // independently-computed guarded-chain figure (the live bug produced
    // 17.23% here instead of 6.07%).
    expect(mirrored.ytd_pct).toBe(baseRow.period_metrics.YTD?.return_pct);
    expect(mirrored.ytd_pct).toBe(6.07);
    expect(mirrored.ytd_pct).not.toBe(17.23);
  });

  it("maps every documented period column from period_metrics, preserving the existing effective_c shape", () => {
    const mirrored = mapCertifiedRowToEffectiveRow(baseRow);
    expect(mirrored.strategy_id).toBe("yield-basket");
    expect(mirrored.as_of_date).toBe("2026-08-20");
    expect(mirrored["1d_pct"]).toBe(0.42);
    expect(mirrored["5d_pct"]).toBe(1.1); // approximated from canonical "1W"
    expect(mirrored["1m_pct"]).toBe(2.3);
    expect(mirrored.mtd_pct).toBe(2.1);
    expect(mirrored["6m_pct"]).toBe(5.9);
    expect(mirrored.all_pct).toBe(10.85); // SI -> all_pct
    expect(mirrored.source_kind).toBe(CERTIFIED_MIRROR_SOURCE_KIND);
    expect(mirrored.repair_run_id).toBeNull();
  });

  it("carries complete_value_cents into both basket_value and basket_value_cents (existing convention)", () => {
    const mirrored = mapCertifiedRowToEffectiveRow(baseRow);
    expect(mirrored.basket_value).toBe(231_209);
    expect(mirrored.basket_value_cents).toBe(231_209);
    expect(mirrored.complete_value_cents).toBe(231_209);
  });

  it("derives 1y_pct as a complete_value_cents ratio against the nearest certified row >= 1 year back", () => {
    const mirrored = mapCertifiedRowToEffectiveRow(baseRow);
    const expected = ((231_209 - 210_000) / 210_000) * 100;
    expect(mirrored["1y_pct"]).toBeCloseTo(expected, 6);
  });

  it("returns null for 1y_pct/5y_pct when no certified reference row exists that far back", () => {
    const mirrored = mapCertifiedRowToEffectiveRow({
      ...baseRow,
      oneYearReferenceCompleteValueCents: null,
      fiveYearReferenceCompleteValueCents: null,
    });
    expect(mirrored["1y_pct"]).toBeNull();
    expect(mirrored["5y_pct"]).toBeNull();
  });

  it("does not fabricate MyGrowthFund-style pre-inception ghost rows: mapping is a pure function of one certified row", () => {
    // The live MyGrowthFund bug was strategy_returns_effective_c carrying rows
    // dated 2023-04-21 for a strategy created 2026-04-19 (source_kind
    // LEGACY_PRODUCTION). The mirror only ever writes what
    // certify_strategy_canonical_daily_ledger_c just certified for one exact
    // (strategy_id, as_of_date) — there is no seeding/backfill path here that
    // could invent a row for a date before the strategy existed.
    const mirrored = mapCertifiedRowToEffectiveRow({
      ...baseRow,
      strategy_id: "my-growth-fund",
      as_of_date: "2026-04-19",
    });
    expect(mirrored.strategy_id).toBe("my-growth-fund");
    expect(mirrored.as_of_date).toBe("2026-04-19");
    expect(mirrored.source_kind).toBe(CERTIFIED_MIRROR_SOURCE_KIND);
  });
});
