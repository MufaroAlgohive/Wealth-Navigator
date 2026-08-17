import { describe, expect, it } from "vitest";

import { aggregateCanonicalRetailAum } from "@/lib/aum/canonical-retail-aum";

describe("aggregateCanonicalRetailAum", () => {
  it("counts reserve and residual once per position and subtracts consumed AUM fees", () => {
    const result = aggregateCanonicalRetailAum({
      holdings: [
        {
          user_id: "u1",
          family_member_id: null,
          strategy_id: "s1",
          security_id: "a",
          quantity: 2,
          transaction_id: "tx1",
        },
        {
          user_id: "u1",
          family_member_id: null,
          strategy_id: "s1",
          security_id: "b",
          quantity: 1,
          transaction_id: "tx1",
        },
      ],
      priceCentsBySecurityId: new Map([
        ["a", 100],
        ["b", 300],
      ]),
      transactions: [
        { id: "tx1", buffer_cents: 100, buffer_consumed_cents: 20, status: "posted", reversed: false },
      ],
      residuals: [{ user_id: "u1", family_member_id: null, strategy_id: "s1", balance_cents: 50 }],
      feeStates: [{ user_id: "u1", family_member_id: null, strategy_id: "s1", aum_fee_consumed_cents: 10 }],
      asOf: "2026-08-15T00:00:00.000Z",
    });

    expect(result.totalAumCents).toBe(620);
    expect(result.totalConsumedAumFeeCents).toBe(10);
    expect(result.investorCount).toBe(1);
    expect(result.holdingCount).toBe(2);
    expect(result.byStrategy.get("s1")).toMatchObject({
      securitiesCents: 500,
      reserveCents: 80,
      residualCents: 50,
      consumedAumFeeCents: 10,
      aumCents: 620,
    });
    expect(result.byPosition.get("u1||s1")).toMatchObject({
      userId: "u1",
      strategyId: "s1",
      aumCents: 620,
    });
  });

  it("excludes test owners and UAT strategies on independent axes", () => {
    const result = aggregateCanonicalRetailAum({
      holdings: [
        {
          user_id: "real",
          family_member_id: null,
          strategy_id: "live",
          security_id: "a",
          quantity: 1,
          transaction_id: null,
        },
        {
          user_id: "test",
          family_member_id: null,
          strategy_id: "live",
          security_id: "a",
          quantity: 50,
          transaction_id: null,
        },
        {
          user_id: "real",
          family_member_id: null,
          strategy_id: "uat",
          security_id: "a",
          quantity: 50,
          transaction_id: null,
        },
      ],
      priceCentsBySecurityId: new Map([["a", 100]]),
      transactions: [],
      residuals: [],
      feeStates: [],
      excludedUserIds: new Set(["test"]),
      excludedStrategyIds: new Set(["uat"]),
      asOf: "2026-08-15T00:00:00.000Z",
    });

    expect(result.totalAumCents).toBe(100);
    expect(result.holdingCount).toBe(1);
    expect([...result.byStrategy.keys()]).toEqual(["live"]);
  });
});
