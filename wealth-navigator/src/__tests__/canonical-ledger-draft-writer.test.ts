import { describe, expect, it } from "vitest";

import {
  activeHoldingsFromLedger,
  appendDailyCertificationEvidence,
  buildCanonicalInceptionLegs,
  canExtendCanonicalCheckpoint,
  parseModelHoldings,
  sameModelHoldings,
} from "@/lib/returns/publish-canonical-ledger-draft";

describe("canonical ledger DRAFT writer guards", () => {
  it("normalizes model symbols and quantities", () => {
    expect(
      parseModelHoldings([
        { symbol: "SUI.JO", shares: 5 },
        { ticker: "NED", quantity: 2 },
        { symbol: "", shares: 10 },
      ]),
    ).toEqual([
      { ticker: "NED", units: 2 },
      { ticker: "SUI", units: 5 },
    ]);
  });

  it("excludes exited securities and accounting-only cash legs", () => {
    expect(
      activeHoldingsFromLedger({
        as_of_date: "2026-08-14",
        leg_snapshot: [
          { ticker: "NED", units: 2, entry_date: "2026-01-30", exit_date: null },
          { ticker: "NED", units: 1, entry_date: "2026-06-15", exit_date: null },
          { ticker: "CLI", units: 20, entry_date: "2026-01-30", exit_date: "2026-06-15" },
          { ticker: "CASH", units: 1, entry_date: "2026-06-15" },
          { ticker: "EXECUTION_COST", units: 1, entry_date: "2026-07-18" },
        ],
      }),
    ).toEqual([{ ticker: "NED", units: 3 }]);
  });

  it("detects a composition quantity change before writing", () => {
    const prior = [
      { ticker: "NED", units: 2 },
      { ticker: "SUI", units: 5 },
    ];
    expect(sameModelHoldings(prior, prior)).toBe(true);
    expect(
      sameModelHoldings(prior, [
        { ticker: "NED", units: 2 },
        { ticker: "SUI", units: 4 },
      ]),
    ).toBe(false);
  });

  it("bootstraps a new strategy with exact-close legs and explicit continuity cash", () => {
    expect(
      buildCanonicalInceptionLegs([{ ticker: "NED", units: 2, close_cents: 25_000 }], "2026-08-14", 8_000),
    ).toEqual([
      expect.objectContaining({ ticker: "NED", units: 2, entryDate: "2026-08-14", entryPriceCents: 25_000 }),
      expect.objectContaining({ ticker: "CASH", units: 1, entryPriceCents: 8_000 }),
    ]);
  });

  it("continues after certification but fails closed on rejected or unknown checkpoints", () => {
    expect(canExtendCanonicalCheckpoint("DRAFT")).toBe(true);
    expect(canExtendCanonicalCheckpoint("CERTIFIED")).toBe(true);
    expect(canExtendCanonicalCheckpoint("REJECTED")).toBe(false);
    expect(canExtendCanonicalCheckpoint("")).toBe(false);
  });

  it("hashes current exact-close and value-identity evidence into every continuation", () => {
    const evidence = appendDailyCertificationEvidence(
      {
        opening_model_snapshot: {},
        ordered_settled_batches: [],
        price_coverage: { historical: true },
        reconciliation: { historical: true },
      },
      {
        asOf: "2026-08-17",
        currentLegs: [
          {
            ticker: "NED",
            units: 2,
            close_cents: 25_000,
            price_as_of_date: "2026-08-17",
            price_fetched_at: "2026-08-17T15:45:00Z",
            source: "STORED_EOD_CLOSE",
          },
        ],
        expectedHoldings: 1,
        securitiesValueCents: 50_000,
        continuityCashCents: 8_000,
        completeValueCents: 58_000,
      },
    );
    expect(evidence.price_coverage).toEqual(
      expect.objectContaining({
        historical: true,
        latest_exact_close: expect.objectContaining({ as_of_date: "2026-08-17", covered_holdings: 1 }),
      }),
    );
    expect(evidence.reconciliation).toEqual(
      expect.objectContaining({
        historical: true,
        latest_daily_value_identity: expect.objectContaining({
          equation_passed: true,
          complete_value_cents: 58_000,
        }),
      }),
    );
  });
});
