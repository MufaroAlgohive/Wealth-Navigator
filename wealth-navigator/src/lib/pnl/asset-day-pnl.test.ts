import { describe, expect, it } from "vitest";

import { calculateAssetDayPnlCents, planQuoteRefresh, resolveDayPnlStrategyId } from "./asset-day-pnl";

describe("calculateAssetDayPnlCents", () => {
  it("marks an unchanged opening holding from previous close", () => {
    expect(calculateAssetDayPnlCents({ currentQuantity: 10, currentPriceCents: 110, previousCloseCents: 100, buys: [], sells: [] })).toBe(100);
  });

  it("starts a same-day buy at its fill instead of previous close", () => {
    expect(calculateAssetDayPnlCents({ currentQuantity: 2, currentPriceCents: 105, previousCloseCents: 90, buys: [{ quantity: 2, fillPriceCents: 103 }], sells: [] })).toBe(4);
  });

  it("realises a same-day sell against previous close and keeps remaining units live", () => {
    expect(calculateAssetDayPnlCents({ currentQuantity: 6, currentPriceCents: 108, previousCloseCents: 100, buys: [], sells: [{ quantity: 4, fillPriceCents: 106 }] })).toBe(72);
  });

  it("keeps a rebalance swap neutral at unchanged fill/current prices", () => {
    const sold = calculateAssetDayPnlCents({ currentQuantity: 0, currentPriceCents: 100, previousCloseCents: 100, buys: [], sells: [{ quantity: 2, fillPriceCents: 100 }] });
    const bought = calculateAssetDayPnlCents({ currentQuantity: 2, currentPriceCents: 200, previousCloseCents: 180, buys: [{ quantity: 2, fillPriceCents: 200 }], sells: [] });
    expect(sold + bought).toBe(0);
  });
});

describe("planQuoteRefresh", () => {
  it("warms never-fetched symbols before refreshing cached symbols", () => {
    const refreshed = new Map([["NED", 100], ["MTN", 200]]);
    expect(planQuoteRefresh(["NED", "SUI", "MTN", "DIB"], refreshed, 2)).toEqual(["DIB", "SUI"]);
  });

  it("rotates the oldest cached symbols once full coverage exists", () => {
    const refreshed = new Map([["NED", 300], ["MTN", 100], ["SUI", 200]]);
    expect(planQuoteRefresh(["NED", "MTN", "SUI"], refreshed, 2)).toEqual(["MTN", "SUI"]);
  });
});

describe("resolveDayPnlStrategyId", () => {
  it("keeps a known null strategy holding in the direct book", () => {
    expect(resolveDayPnlStrategyId({ strategy_id: null }, "MANUAL")).toBeNull();
  });

  it("uses the strategy for managed holdings and payload-only fills", () => {
    expect(resolveDayPnlStrategyId({ strategy_id: "yield" }, "MANUAL")).toBe("yield");
    expect(resolveDayPnlStrategyId(undefined, "yield")).toBe("yield");
  });
});
