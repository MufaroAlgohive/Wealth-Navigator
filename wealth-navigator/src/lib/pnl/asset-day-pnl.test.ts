import { describe, expect, it } from "vitest";

import { calculateAssetDayPnlCents } from "./asset-day-pnl";

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
