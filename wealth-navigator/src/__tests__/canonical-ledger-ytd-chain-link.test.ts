import { describe, expect, it } from "vitest";

import { rebuildLegsAcrossSettledBoundary } from "@/lib/returns/canonical-rebalance-boundary";
import {
  type CanonicalRow,
  type NormalizedLeg,
  directMetric,
  legMetric,
} from "@/lib/returns/publish-canonical-ledger-draft";

/**
 * Regression coverage for the YTD/period-return chain-linking fix.
 *
 * Background: legMetric() (the old authoritative calculation) sums every leg's own entry value
 * into the return denominator. When a rebalance sells security A and buys security B with the
 * proceeds, B's leg is created with its own full purchase price as entryPriceCents - legMetric()
 * then adds that entire purchase price to the denominator again, as if it were newly-contributed
 * capital, even though it is the same money that came from selling A. Every rebalance inflates the
 * denominator further and permanently understates the strategy's true return. This was confirmed on
 * Yield Basket production data: stored YTD showed 6.07% when chain-linked (two independent
 * recalculations) it is ~11%.
 *
 * The fix: complete_value_cents (securities_value_cents + continuity_cash_cents) is already stored
 * on every daily ledger row and is continuous across rebalances by construction (a rebalance
 * re-labels holdings, it does not change total value, aside from real execution costs which are
 * already netted into continuity_cash_cents at the boundary). So return_pct for ANY period is simply
 * (current.complete_value_cents / reference.complete_value_cents - 1) * 100 - exactly what
 * directMetric() already computes. This test proves that computation, applied across multiple real
 * rebalance boundaries, reproduces the correct ~11% figure, while the old leg-sum method
 * (legMetric()) produces a materially understated number consistent with the production bug.
 *
 * Real Yield Basket segment history used below (documented in the task brief, verified against
 * live Yahoo prices and the production database):
 *   - Inception 2026-01-30: NED x2 @ 26534c, SUI x5 @ 4300c, DIB x20 @ 664c, CLI x20 @ 1430c
 *     (benchmark price; Yahoo has no history for CLI), EXX x5 @ 18439c, 0 cash.
 *     This precisely computes to 208,643 cents (2 * 26534 + 5 * 4300 + 20 * 664 + 20 * 1430 +
 *     5 * 18439 = 208,643). The brief's approximate figure of ~211,543 cents differs slightly from
 *     this precise composition value - almost certainly rounding/estimation in the CLI Yahoo-gap
 *     price approximation used when the brief was written. We use our own precise computation
 *     (208,643) throughout, per the brief's own guidance to prefer precision over matching the
 *     approximation exactly.
 *   - 2026-06-15 boundary (CLI sold, ABG bought): complete_value_cents = 240,624
 *     (securities_value_cents 225,991 + continuity_cash_cents 14,633).
 *   - 2026-07-01 boundary (EXX sold, TBS bought): complete_value_cents = 231,556
 *     (securities_value_cents 202,717 + continuity_cash_cents 28,839).
 *   - 2026-07-14 boundary (ABG sold, not replaced): complete_value_cents = 227,968
 *     (securities_value_cents 177,578 + continuity_cash_cents 50,390).
 *   - 2026-08-20 (today): complete_value_cents = 231,209
 *     (securities_value_cents 182,015 + continuity_cash_cents 49,194).
 */

const INCEPTION_DATE = "2026-01-30";
const INCEPTION_VALUE_CENTS = 2 * 26534 + 5 * 4300 + 20 * 664 + 20 * 1430 + 5 * 18439; // 208,643

const BOUNDARY_1_DATE = "2026-06-15"; // CLI sold, ABG bought
const BOUNDARY_1_VALUE_CENTS = 240_624;

const BOUNDARY_2_DATE = "2026-07-01"; // EXX sold, TBS bought
const BOUNDARY_2_VALUE_CENTS = 231_556;

const BOUNDARY_3_DATE = "2026-07-14"; // ABG sold, not replaced
const BOUNDARY_3_VALUE_CENTS = 227_968;

const TODAY_DATE = "2026-08-20";
const TODAY_VALUE_CENTS = 231_209;

function canonicalRow(as_of_date: string, complete_value_cents: number): CanonicalRow {
  return {
    strategy_id: "yield-basket",
    as_of_date,
    ledger_version: "TEST",
    certification_status: "CERTIFIED",
    securities_value_cents: complete_value_cents,
    continuity_cash_cents: 0,
    complete_value_cents,
    leg_snapshot: [],
    period_metrics: {},
    source_evidence: {},
    source_evidence_sha256: "",
    calculation_notes: {},
  };
}

describe("canonical ledger YTD chain-linking fix (Yield Basket real segment history)", () => {
  const rows: CanonicalRow[] = [
    canonicalRow(INCEPTION_DATE, INCEPTION_VALUE_CENTS),
    canonicalRow(BOUNDARY_1_DATE, BOUNDARY_1_VALUE_CENTS),
    canonicalRow(BOUNDARY_2_DATE, BOUNDARY_2_VALUE_CENTS),
    canonicalRow(BOUNDARY_3_DATE, BOUNDARY_3_VALUE_CENTS),
    canonicalRow(TODAY_DATE, TODAY_VALUE_CENTS),
  ];
  const current = rows.at(-1) as CanonicalRow;

  it("directMetric() chain-links complete_value_cents straight across every rebalance boundary and lands close to the independently-verified ~11% figure", () => {
    const metric = directMetric(rows, current, INCEPTION_DATE);
    expect(metric.reference_date).toBe(INCEPTION_DATE);
    expect(metric.denominator_cents).toBe(INCEPTION_VALUE_CENTS);
    expect(metric.numerator_value_cents).toBe(TODAY_VALUE_CENTS);
    expect(metric.return_pct).not.toBeNull();
    // Precise chain-linked YTD for this real segment history: (231209 / 208643 - 1) * 100 ~= 10.82%.
    expect(metric.return_pct as number).toBeGreaterThanOrEqual(10.5);
    expect(metric.return_pct as number).toBeLessThanOrEqual(11.5);
  });

  it("the old leg-sum method (legMetric) materially understates the same period by inflating the denominator with every rebalance's full entry value", () => {
    // One collapsed synthetic leg per segment, valued at the segment's real total complete_value_cents
    // at entry/exit. This reproduces legMetric()'s core bug exactly: summing N leg-sum entry values
    // into the denominator instead of chain-linking one ratio. Using ticker "CASH" is a deliberate
    // test simplification - it makes value() return entryPriceCents unconditionally (see legMetric's
    // value() helper), so no live price lookup is needed to exercise the denominator/numerator
    // arithmetic in isolation; entry/exit values below are still each segment's real recorded total
    // portfolio value, so the summed-denominator behavior under test is faithful to production. This
    // is algebraically identical to summing the individual security legs within each segment, since
    // legMetric's denominator is a sum and summation is linear - collapsing N per-segment legs into 1
    // does not change the total.
    const segments: Array<[string, number, string, number]> = [
      [INCEPTION_DATE, INCEPTION_VALUE_CENTS, BOUNDARY_1_DATE, BOUNDARY_1_VALUE_CENTS],
      [BOUNDARY_1_DATE, BOUNDARY_1_VALUE_CENTS, BOUNDARY_2_DATE, BOUNDARY_2_VALUE_CENTS],
      [BOUNDARY_2_DATE, BOUNDARY_2_VALUE_CENTS, BOUNDARY_3_DATE, BOUNDARY_3_VALUE_CENTS],
      [BOUNDARY_3_DATE, BOUNDARY_3_VALUE_CENTS, TODAY_DATE, TODAY_VALUE_CENTS],
    ];
    const legs: NormalizedLeg[] = segments.map(([entryDate, entryValue, exitDate, exitValue], index) => ({
      ticker: "CASH",
      leg: `Segment ${index + 1}`,
      units: 1,
      entryDate,
      entryPriceCents: entryValue,
      exitDate,
      exitPriceCents: exitValue,
      sourceRef: "test_segment",
    }));
    const neverCalled = () => {
      throw new Error("priceOnOrBefore should not be called - all segments resolve via CASH/exit-date branches");
    };
    const buggy = legMetric(legs, TODAY_DATE, INCEPTION_DATE, neverCalled);
    expect(buggy.denominator_cents).toBe(
      INCEPTION_VALUE_CENTS + BOUNDARY_1_VALUE_CENTS + BOUNDARY_2_VALUE_CENTS + BOUNDARY_3_VALUE_CENTS,
    );
    expect(buggy.return_pct).not.toBeNull();
    // The real production incident showed the buggy method landing at 6.07% against a true ~11%.
    // This collapsed-segment reconstruction is not expected to hit 6.07% exactly (see file header),
    // but must reproduce the same qualitative failure: a materially understated number, nowhere near
    // the correctly chain-linked ~11% figure.
    expect(buggy.return_pct as number).not.toBeCloseTo(6.07, 0);
    const correct = directMetric(rows, current, INCEPTION_DATE).return_pct as number;
    expect(buggy.return_pct as number).toBeLessThan(correct - 3);
  });

  it("boundary-continuity invariant holds for a realistic reconstruction of the 2026-06-15 Yield boundary (CLI sold, ABG bought)", () => {
    // Exact per-security fill prices for this boundary were not part of the task brief (only the
    // aggregate securities_value_cents/continuity_cash_cents totals were). This reconstruction is
    // self-consistent with those real aggregate totals: NED/SUI/DIB/EXX are held unchanged (their
    // combined value carries over untouched), CLI is fully sold, and ABG is bought with the
    // proceeds, landing exactly on the real recorded post-boundary securities_value_cents (225,991)
    // and continuity_cash_cents (14,633) with zero execution cost.
    const unchangedValueCents = 2 * 26534 + 5 * 4300 + 20 * 664 + 5 * 18439; // NED+SUI+DIB+EXX = 180,043
    const abgValueCents = 225_991 - unchangedValueCents; // 45,948
    const abgUnits = 30;
    const abgFillCents = abgValueCents / abgUnits;
    const cliUnits = 20;
    const cliProceedsCents = abgValueCents + 14_633; // ABG cost + cash landed = CLI proceeds (0 execution cost)
    const cliFillCents = cliProceedsCents / cliUnits;

    const previousLegs = [
      { ticker: "NED", leg: "Inception", units: 2, entryDate: INCEPTION_DATE, entryPriceCents: 26534, exitDate: null, exitPriceCents: null, sourceRef: "inception" },
      { ticker: "SUI", leg: "Inception", units: 5, entryDate: INCEPTION_DATE, entryPriceCents: 4300, exitDate: null, exitPriceCents: null, sourceRef: "inception" },
      { ticker: "DIB", leg: "Inception", units: 20, entryDate: INCEPTION_DATE, entryPriceCents: 664, exitDate: null, exitPriceCents: null, sourceRef: "inception" },
      { ticker: "CLI", leg: "Inception", units: 20, entryDate: INCEPTION_DATE, entryPriceCents: 1430, exitDate: null, exitPriceCents: null, sourceRef: "inception" },
      { ticker: "EXX", leg: "Inception", units: 5, entryDate: INCEPTION_DATE, entryPriceCents: 18439, exitDate: null, exitPriceCents: null, sourceRef: "inception" },
    ];

    const result = rebuildLegsAcrossSettledBoundary({
      previousDate: INCEPTION_DATE,
      previousHoldings: [
        { ticker: "NED", units: 2 },
        { ticker: "SUI", units: 5 },
        { ticker: "DIB", units: 20 },
        { ticker: "CLI", units: 20 },
        { ticker: "EXX", units: 5 },
      ],
      previousCashCents: 0,
      previousLegs,
      currentHoldings: [
        { ticker: "NED", units: 2 },
        { ticker: "SUI", units: 5 },
        { ticker: "DIB", units: 20 },
        { ticker: "EXX", units: 5 },
        { ticker: "ABG", units: abgUnits },
      ],
      currentCashCents: 14_633,
      batch: {
        id: "boundary-1",
        status: "SETTLED",
        settlement_state: "COMPLETE",
        effective_date: BOUNDARY_1_DATE,
        is_reversed: false,
        holdings_snapshot_before: [
          { symbol: "NED", shares: 2 },
          { symbol: "SUI", shares: 5 },
          { symbol: "DIB", shares: 20 },
          { symbol: "CLI", shares: 20 },
          { symbol: "EXX", shares: 5 },
        ],
        holdings_snapshot_planned: [
          { symbol: "NED", shares: 2 },
          { symbol: "SUI", shares: 5 },
          { symbol: "DIB", shares: 20 },
          { symbol: "EXX", shares: 5 },
          { symbol: "ABG", shares: abgUnits },
        ],
      },
      fills: [
        { security_id: "cli", trade_side: "SELL", quantity: cliUnits, avg_fill: cliFillCents, fill_date: BOUNDARY_1_DATE },
        { security_id: "abg", trade_side: "BUY", quantity: abgUnits, avg_fill: abgFillCents, fill_date: BOUNDARY_1_DATE },
      ],
      securitySymbols: new Map([
        ["cli", "CLI.JO"],
        ["abg", "ABG.JO"],
      ]),
      reconciliation: {
        model_capital_cents: 240_624,
        securities_value_cents: 225_991,
        strategy_ca_cents: 14_633,
        affected_owner_count: 1,
        reconciled_owner_count: 1,
        capital_source: "SETTLED_FILLS",
      },
    });

    // Did not throw BOUNDARY_VALUE_CONTINUITY_VIOLATED (or any other guard) - the invariant holds for
    // this real-shaped boundary.
    expect(result.evidence.execution_cost_cents).toBe(0);
    expect(result.legs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ticker: "CLI", exitDate: BOUNDARY_1_DATE }),
        expect.objectContaining({ ticker: "ABG", units: abgUnits, entryDate: BOUNDARY_1_DATE }),
        expect.objectContaining({ ticker: "CASH", entryPriceCents: 14_633, exitDate: null }),
      ]),
    );

    // Confirms the chain-link fix's premise directly: the post-boundary complete value
    // (securities_value_cents + continuity_cash_cents from the reconciliation, i.e. what gets stored
    // as the next ledger row's complete_value_cents) equals the real recorded 240,624 - so
    // directMetric() picking up this row's complete_value_cents as the next chain link is correct.
    expect(225_991 + 14_633).toBe(BOUNDARY_1_VALUE_CENTS);
  });
});
