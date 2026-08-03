import { describe, expect, it } from "vitest";

import { calculateProceedsBridge } from "@/lib/rebalance/proceeds";

describe("rebalance proceeds bridge", () => {
  it("shows gross, configured sell fees and standard net proceeds", () => {
    expect(
      calculateProceedsBridge({
        grossSellCents: 100_000,
        grossBuyCents: 0,
        sellAssetCount: 1,
        buyAssetCount: 0,
        brokerageRate: 0.005,
        custodyFeeCents: 2_500,
        reserveCents: 0,
        walletCents: 0,
      }),
    ).toMatchObject({
      sellBrokerageCents: 500,
      sellCustodyCents: 2_500,
      sellFeesCents: 3_000,
      netProceedsCents: 97_000,
      feeShortfallCents: 3_000,
      cashAfterCents: 97_000,
    });
  });

  it("uses execution reserve before reducing cash available for replacement buys", () => {
    expect(
      calculateProceedsBridge({
        grossSellCents: 100_000,
        grossBuyCents: 96_000,
        sellAssetCount: 1,
        buyAssetCount: 1,
        brokerageRate: 0.005,
        custodyFeeCents: 2_500,
        reserveCents: 7_980,
        walletCents: 0,
      }),
    ).toMatchObject({
      sellFeesCents: 3_000,
      buyFeesCents: 2_980,
      totalFeesCents: 5_980,
      reserveUsedCents: 5_980,
      feeShortfallCents: 0,
      cashAfterCents: 4_000,
      shortfall: false,
    });
  });

  it("flags only the fee amount not covered by reserve as a cash shortfall", () => {
    expect(
      calculateProceedsBridge({
        grossSellCents: 100_000,
        grossBuyCents: 100_000,
        sellAssetCount: 1,
        buyAssetCount: 1,
        brokerageRate: 0.005,
        custodyFeeCents: 2_500,
        reserveCents: 5_000,
        walletCents: 0,
      }),
    ).toMatchObject({ feeShortfallCents: 1_000, cashAfterCents: -1_000, shortfall: true });
  });
});
