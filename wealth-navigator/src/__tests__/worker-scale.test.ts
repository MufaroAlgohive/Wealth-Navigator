import { describe, expect, it } from "vitest";

import { chooseDisplayCents } from "../../workers/iress-ingest/src/scale";

/**
 * Reference-anchored JSE price scaling. The numbers below are real cases from
 * the 2026-06-13/14 coverage probe (IRESS mapped `last` vs the existing
 * securities_c.last_price in cents), where the live.ts heuristic mis-scaled
 * sub-R45 stocks by 100×.
 */
describe("chooseDisplayCents", () => {
  it("keeps a correctly-scaled high price (AGL ~R897, ref 89726c)", () => {
    const c = chooseDisplayCents(897.26, 89726);
    expect(c.cents).toBe(89726);
    expect(c.basis).toBe("rands");
  });

  it("corrects a 100x-mis-scaled sub-R45 stock (AFT: mapped 4125, ref 3090c) → 4125c not 412500c", () => {
    const c = chooseDisplayCents(4125, 3090);
    expect(c.cents).toBe(4125);
    expect(c.basis).toBe("cents-mislabeled");
    expect(c.centsMultiplier).toBe(1);
  });

  it("corrects DCP (mapped 3809, ref 3219c) → 3809c", () => {
    expect(chooseDisplayCents(3809, 3219).cents).toBe(3809);
  });

  it("corrects BEL (mapped 4188, ref 3950c) → 4188c", () => {
    expect(chooseDisplayCents(4188, 3950).cents).toBe(4188);
  });

  it("keeps an already-correct sub-R45 mapping (R30.90 mapped, ref 3090c) → 3090c", () => {
    expect(chooseDisplayCents(30.9, 3090).cents).toBe(3090);
  });

  it("falls back to Rands→cents when there is no reference", () => {
    const c = chooseDisplayCents(41.25, 0);
    expect(c.cents).toBe(4125);
    expect(c.basis).toBe("no-reference");
  });

  it("returns 0 for an empty/zero last", () => {
    expect(chooseDisplayCents(0, 3090).cents).toBe(0);
    expect(chooseDisplayCents(Number.NaN, 3090).cents).toBe(0);
  });

  it("centsMultiplier carries the chosen scale for prevClose consistency", () => {
    // high price → multiplier 100 (value is Rands)
    expect(chooseDisplayCents(897.26, 89726).centsMultiplier).toBe(100);
    // 100x-mislabel → multiplier 1 (value is already cents)
    expect(chooseDisplayCents(4125, 3090).centsMultiplier).toBe(1);
  });
});
