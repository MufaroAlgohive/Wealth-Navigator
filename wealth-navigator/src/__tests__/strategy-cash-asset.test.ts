import { describe, expect, it } from "vitest";

import { CASH_ASSET_NAME, CASH_ASSET_SYMBOL, strategyCashAsset } from "@/lib/strategy-cash-asset";

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
});
