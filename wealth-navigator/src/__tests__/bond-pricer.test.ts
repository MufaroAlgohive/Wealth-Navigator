import { describe, expect, it } from "vitest";

import { parseBondDescription, priceBondFromYield } from "@/lib/iress/bond-pricer";

describe("priceBondFromYield", () => {
  it("prices a bond at par when yield == coupon and settlement is a coupon date", () => {
    // Settlement 2027-01-31 is a coupon date for a 31-Jan/31-Jul payer → f=1,
    // zero accrued. y == c ⇒ clean ≈ dirty ≈ 100.
    const a = priceBondFromYield({
      couponPct: 8,
      maturityISO: "2030-01-31",
      settlementISO: "2027-01-31",
      ytmPct: 8,
    })!;
    expect(a).not.toBeNull();
    expect(a.accruedInterest).toBeCloseTo(0, 4);
    expect(a.cleanPrice).toBeCloseTo(100, 2);
    expect(a.dirtyPrice).toBeCloseTo(100, 2);
  });

  it("trades at a discount when yield > coupon and a premium when yield < coupon", () => {
    const discount = priceBondFromYield({ couponPct: 8, maturityISO: "2035-01-31", settlementISO: "2026-06-16", ytmPct: 10 })!;
    const premium = priceBondFromYield({ couponPct: 8, maturityISO: "2035-01-31", settlementISO: "2026-06-16", ytmPct: 6 })!;
    expect(discount.cleanPrice).toBeLessThan(100);
    expect(premium.cleanPrice).toBeGreaterThan(100);
  });

  it("produces sane duration / DV01 / convexity for a long bond", () => {
    const a = priceBondFromYield({ couponPct: 8.75, maturityISO: "2048-02-28", settlementISO: "2026-06-16", ytmPct: 9 })!;
    // Long bond: positive duration, well under the ~22y maturity, positive convexity.
    expect(a.modDuration).toBeGreaterThan(7);
    expect(a.modDuration).toBeLessThan(22);
    expect(a.convexity).toBeGreaterThan(0);
    // DV01 ties out to modDur × dirty × 1bp.
    expect(a.dv01).toBeCloseTo(a.modDuration * a.dirtyPrice * 0.0001, 4);
    // Longer modified duration than a short bond at the same yield.
    const short = priceBondFromYield({ couponPct: 8, maturityISO: "2028-01-31", settlementISO: "2026-06-16", ytmPct: 9 })!;
    expect(a.modDuration).toBeGreaterThan(short.modDuration);
  });

  it("accrues interest within a coupon period (dirty > clean)", () => {
    const a = priceBondFromYield({ couponPct: 8, maturityISO: "2030-01-31", settlementISO: "2026-06-16", ytmPct: 8 })!;
    expect(a.accruedInterest).toBeGreaterThan(0);
    expect(a.dirtyPrice).toBeGreaterThan(a.cleanPrice);
    // ~4.5 months since the 31-Jan coupon → roughly 8% × (136/365) ≈ 3.0.
    expect(a.accruedInterest).toBeGreaterThan(2);
    expect(a.accruedInterest).toBeLessThan(4);
  });

  it("returns null for a matured bond or junk inputs", () => {
    expect(priceBondFromYield({ couponPct: 8, maturityISO: "2020-01-31", settlementISO: "2026-06-16", ytmPct: 8 })).toBeNull();
    expect(priceBondFromYield({ couponPct: 8, maturityISO: "2030-01-31", settlementISO: "2026-06-16", ytmPct: Number.NaN })).toBeNull();
  });
});

describe("parseBondDescription", () => {
  it("extracts coupon + maturity from a DD.MM.YYYY description", () => {
    expect(parseBondDescription("REPUBLIC OF SA 8% 31.01.2030")).toEqual({ couponPct: 8, maturityISO: "2030-01-31" });
    expect(parseBondDescription("REPUBLIC OF SA 8.875% 28.02.2035")).toEqual({ couponPct: 8.875, maturityISO: "2035-02-28" });
  });

  it("extracts the coupon even when only a year is present (maturity null)", () => {
    expect(parseBondDescription("I2033 - RSA 1.875% 2033")).toEqual({ couponPct: 1.875, maturityISO: null });
  });
});
