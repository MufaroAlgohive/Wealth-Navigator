import { describe, expect, it } from "vitest";

import { anchorHistoryToRands, chooseDisplayCents } from "../../workers/iress-ingest/src/scale";

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

/**
 * `anchorHistoryToRands` resolves an IRESS price SERIES (ambiguous rands|cents)
 * to RANDS against a known reference — the guard that stops a labelled chart
 * rendering 100× off. NPN ≈ R4,180 → ~418000c; both a cents series and a rands
 * series must resolve to the same ~R4,180 points.
 */
describe("anchorHistoryToRands", () => {
  const ref = 418_000; // securities_c.last_price for NPN, in cents

  it("resolves a CENTS series (v≈418000) to rands (~4180)", () => {
    const a = anchorHistoryToRands(
      [
        { t: 1, v: 410_000 },
        { t: 2, v: 418_000 },
        { t: 3, v: 415_000 },
      ],
      ref,
    );
    expect(a.anchored).toBe(true);
    expect(a.multiplier).toBe(0.01);
    expect(a.points.map((p) => p.c)).toEqual([4100, 4180, 4150]);
  });

  it("resolves a RANDS series (v≈4180) to the SAME rands (~4180)", () => {
    const a = anchorHistoryToRands(
      [
        { t: 1, v: 4100 },
        { t: 2, v: 4180 },
        { t: 3, v: 4150 },
      ],
      ref,
    );
    expect(a.anchored).toBe(true);
    expect(a.multiplier).toBe(1);
    expect(a.points.map((p) => p.c)).toEqual([4100, 4180, 4150]);
  });

  it("picks the series scale from the MEDIAN so one outlier can't flip it", () => {
    const a = anchorHistoryToRands(
      [
        { t: 1, v: 418_000 },
        { t: 2, v: 415_000 },
        { t: 3, v: 5 }, // a single bad tick must not flip the whole series to the wrong scale
      ],
      ref,
    );
    expect(a.multiplier).toBe(0.01); // median 415000 → cents → /100
    expect(a.points.find((p) => p.t === 2)?.c).toBe(4150);
  });

  it("reports anchored=false with no reference (caller should prefer Yahoo)", () => {
    const a = anchorHistoryToRands([{ t: 1, v: 4180 }], 0);
    expect(a.anchored).toBe(false);
    expect(a.basis).toBe("no-reference");
  });

  it("reports anchored=false + empty points for an empty series", () => {
    const a = anchorHistoryToRands([], ref);
    expect(a.anchored).toBe(false);
    expect(a.points).toEqual([]);
  });

  it("drops non-finite / non-positive points and keeps ascending time order", () => {
    const a = anchorHistoryToRands(
      [
        { t: 3, v: 415_000 },
        { t: 1, v: 410_000 },
        { t: 2, v: Number.NaN },
        { t: 4, v: -10 },
      ],
      ref,
    );
    expect(a.points.map((p) => p.t)).toEqual([1, 3]);
  });
});
