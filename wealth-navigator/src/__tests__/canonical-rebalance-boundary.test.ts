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
});
