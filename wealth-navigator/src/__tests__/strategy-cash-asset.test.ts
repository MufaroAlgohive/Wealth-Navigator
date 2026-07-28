import { describe, expect, it } from "vitest";

import {
  CASH_ASSET_NAME,
  CASH_ASSET_SYMBOL,
  strategyCashAsset,
  strategyCashAssetFromCanonicalReturns,
} from "@/lib/strategy-cash-asset";

describe("strategyCashAsset", () => {
  it("publishes residual cash as the CA allocation in rands", () => {
    expect(strategyCashAsset(25_000, 75_000)).toEqual({
      symbol: CASH_ASSET_SYMBOL,
      name: CASH_ASSET_NAME,
      value: 250,
      weight: 25,
    });
  });

  it("does not invent a cash asset when there is no residual", () => {
    expect(strategyCashAsset(0, 75_000)).toBeNull();
  });

  it("does not include execution reserve in the residual allocation", () => {
    const residualOnly = strategyCashAsset(8_000, 92_000);
    expect(residualOnly?.value).toBe(80);
    expect(residualOnly?.weight).toBe(8);
  });

  it("uses the latest per-strategy canonical residual without summing investors", () => {
    const cashAsset = strategyCashAssetFromCanonicalReturns([
      {
        as_of_date: "2026-07-27",
        continuity_cash_cents: 12_000,
        securities_value_cents: 90_000,
      },
      {
        as_of_date: "2026-07-28",
        continuity_cash_cents: 14_847,
        securities_value_cents: 143_123,
      },
    ]);

    expect(cashAsset?.value).toBe(148.47);
    expect(cashAsset?.value).not.toBe(296.94);
  });
});
