import { describe, expect, it } from "vitest";

import { rebuildLegsAcrossSettledBoundary } from "@/lib/returns/canonical-rebalance-boundary";

const input = () => ({
  previousDate: "2026-08-13",
  previousHoldings: [
    { ticker: "OLD", units: 5 },
    { ticker: "KEEP", units: 2 },
  ],
  previousCashCents: 100,
  previousLegs: [
    {
      ticker: "OLD",
      leg: "Start",
      units: 5,
      entryDate: "2026-01-02",
      entryPriceCents: 1000,
      exitDate: null,
      exitPriceCents: null,
      sourceRef: "opening",
    },
    {
      ticker: "KEEP",
      leg: "Start",
      units: 2,
      entryDate: "2026-01-02",
      entryPriceCents: 500,
      exitDate: null,
      exitPriceCents: null,
      sourceRef: "opening",
    },
    {
      ticker: "CASH",
      leg: "CA",
      units: 1,
      entryDate: "2026-01-02",
      entryPriceCents: 100,
      exitDate: null,
      exitPriceCents: null,
      sourceRef: "rule",
    },
  ],
  currentHoldings: [
    { ticker: "OLD", units: 3 },
    { ticker: "KEEP", units: 2 },
    { ticker: "NEW", units: 1 },
  ],
  currentCashCents: 590,
  batch: {
    id: "batch-1",
    status: "SETTLED",
    settlement_state: "COMPLETE",
    effective_date: "2026-08-14",
    is_reversed: false,
    holdings_snapshot_before: [
      { symbol: "OLD", shares: 5 },
      { symbol: "KEEP", shares: 2 },
    ],
    holdings_snapshot_planned: [
      { symbol: "OLD", shares: 3 },
      { symbol: "KEEP", shares: 2 },
      { symbol: "NEW", shares: 1 },
    ],
  },
  fills: [
    { security_id: "old", trade_side: "SELL", quantity: 6, avg_fill: 400, fill_date: "2026-08-14" },
    { security_id: "new", trade_side: "BUY", quantity: 3, avg_fill: 300, fill_date: "2026-08-14" },
  ],
  securitySymbols: new Map([
    ["old", "OLD.JO"],
    ["new", "NEW.JO"],
  ]),
  reconciliation: {
    model_capital_cents: 3590,
    securities_value_cents: 3000,
    strategy_ca_cents: 590,
    affected_owner_count: 3,
    reconciled_owner_count: 3,
    capital_source: "SETTLED_FILLS",
  },
  unchangedLegCurrentPrices: undefined as Map<string, number> | undefined,
  unchangedLegPreviousPrices: undefined as Map<string, number> | undefined,
});

describe("canonical rebalance boundary reconstruction", () => {
  it("derives model fills, closes sold units, opens buys and carries authoritative CA", () => {
    const result = rebuildLegsAcrossSettledBoundary(input());
    expect(result.evidence).toMatchObject({
      owner_scale: 3,
      gross_cash_delta_cents: 500,
      authoritative_strategy_ca_cents: 590,
      execution_cost_cents: 10,
    });
    expect(result.legs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ticker: "OLD", units: 2, exitDate: "2026-08-14", exitPriceCents: 400 }),
        expect.objectContaining({ ticker: "OLD", units: 3, exitDate: null }),
        expect.objectContaining({ ticker: "NEW", units: 1, entryPriceCents: 300 }),
        expect.objectContaining({ ticker: "CASH", entryPriceCents: 590, exitDate: null }),
        expect.objectContaining({ ticker: "EXECUTION_COST", entryPriceCents: 10 }),
      ]),
    );
  });

  it("refuses a boundary whose post-trade composition is not evidenced", () => {
    const broken = input();
    broken.batch.holdings_snapshot_planned = [{ symbol: "OLD", shares: 4 }];
    expect(() => rebuildLegsAcrossSettledBoundary(broken)).toThrow("BOUNDARY_AFTER_SNAPSHOT_MISMATCH");
  });

  it("refuses unexplained external capital", () => {
    const broken = input();
    broken.currentCashCents = 700;
    broken.reconciliation.strategy_ca_cents = 700;
    broken.reconciliation.model_capital_cents = 3700;
    expect(() => rebuildLegsAcrossSettledBoundary(broken)).toThrow(
      "BOUNDARY_REQUIRES_UNEXPLAINED_EXTERNAL_CAPITAL",
    );
  });

  it("does not mistake real price movement on an untraded leg for unexplained capital", () => {
    // KEEP (2 units, held before AND after — never trades at this boundary)
    // drops from 500 to 400 between the previous published date and
    // settlement: a real R2.00 loss the strategy would have carried
    // regardless of this rebalance. Conservation of total value means that
    // loss legitimately shows up as MORE cash left over (790, not the base
    // case's 590) once the trade itself is accounted for — exactly the
    // 2026-08-25 Yield Basket incident (NED/SUI/DIB/TBS lost value between
    // 08-21 and 08-24, and the boundary check read the resulting cash
    // increase as capital appearing from nowhere).
    const withDrift = input();
    withDrift.currentCashCents = 790;
    withDrift.reconciliation.strategy_ca_cents = 790;
    withDrift.reconciliation.model_capital_cents = 3790;
    withDrift.unchangedLegCurrentPrices = new Map([["KEEP", 400]]);
    withDrift.unchangedLegPreviousPrices = new Map([["KEEP", 500]]);

    // Without either price map, the identical cash figure is indistinguishable
    // from genuinely unexplained capital — confirms the fix is the two maps,
    // not a loosened threshold.
    const withoutDriftMaps = {
      ...withDrift,
      unchangedLegCurrentPrices: undefined,
      unchangedLegPreviousPrices: undefined,
    };
    expect(() => rebuildLegsAcrossSettledBoundary(withoutDriftMaps)).toThrow(
      "BOUNDARY_REQUIRES_UNEXPLAINED_EXTERNAL_CAPITAL",
    );

    const result = rebuildLegsAcrossSettledBoundary(withDrift);
    expect(result.evidence).toMatchObject({
      unchanged_leg_drift_cents: -200,
      execution_cost_cents: 10,
    });
  });

  it("ignores previousLegs' entry price as a source of the untraded leg's previous price", () => {
    // The bug in the first version of this fix: KEEP's leg in previousLegs
    // carries its ORIGINAL cost basis (500, from whenever that lot opened —
    // could be months earlier), not a rolling mark. Live 2026-08-25: NED's
    // leg still carried its 2026-01-30 inception price; the real close on
    // the actual previous published date (2026-08-21) was materially
    // different, and deriving "previous price" from the leg silently
    // reintroduced the exact bug this fix exists to close. A correct
    // implementation reads ONLY unchangedLegPreviousPrices, so a wildly
    // different entryPriceCents on the leg itself (999 here, vs the "real"
    // previous close of 500 supplied via the map) must not change the
    // result at all.
    const withStaleLegEntry = input();
    withStaleLegEntry.previousLegs = withStaleLegEntry.previousLegs.map((leg) =>
      leg.ticker === "KEEP" ? { ...leg, entryPriceCents: 999 } : leg,
    );
    withStaleLegEntry.currentCashCents = 790;
    withStaleLegEntry.reconciliation.strategy_ca_cents = 790;
    withStaleLegEntry.reconciliation.model_capital_cents = 3790;
    withStaleLegEntry.unchangedLegCurrentPrices = new Map([["KEEP", 400]]);
    withStaleLegEntry.unchangedLegPreviousPrices = new Map([["KEEP", 500]]);

    const result = rebuildLegsAcrossSettledBoundary(withStaleLegEntry);
    expect(result.evidence).toMatchObject({
      unchanged_leg_drift_cents: -200,
      execution_cost_cents: 10,
    });
  });

  it("tolerates a small residual after drift adjustment (EOD close vs intraday settlement tick noise)", () => {
    // Same drift as the passing case above, but currentCashCents is 7 cents
    // short of what the drift adjustment predicts (797 instead of 790) --
    // exactly the residual reproduced live 2026-08-25 between a stored EOD
    // close and the live intraday tick the settlement RPC actually used.
    // Must still pass: this is real cross-source noise, not unexplained
    // capital.
    const withResidual = input();
    withResidual.currentCashCents = 797;
    withResidual.reconciliation.strategy_ca_cents = 797;
    withResidual.reconciliation.model_capital_cents = 3797;
    withResidual.unchangedLegCurrentPrices = new Map([["KEEP", 400]]);
    withResidual.unchangedLegPreviousPrices = new Map([["KEEP", 500]]);

    expect(() => rebuildLegsAcrossSettledBoundary(withResidual)).not.toThrow();
  });

  it("still refuses a gap far too large to be EOD-close-vs-intraday-tick noise, even with drift data supplied", () => {
    // R50 unexplained is nowhere near the few-cents-per-security noise the
    // wider tolerance exists for -- confirms drift data doesn't make the
    // guard toothless.
    const withHugeGap = input();
    withHugeGap.currentCashCents = 5790;
    withHugeGap.reconciliation.strategy_ca_cents = 5790;
    withHugeGap.reconciliation.model_capital_cents = 8790;
    withHugeGap.unchangedLegCurrentPrices = new Map([["KEEP", 400]]);
    withHugeGap.unchangedLegPreviousPrices = new Map([["KEEP", 500]]);

    expect(() => rebuildLegsAcrossSettledBoundary(withHugeGap)).toThrow(
      "BOUNDARY_REQUIRES_UNEXPLAINED_EXTERNAL_CAPITAL",
    );
  });
});
