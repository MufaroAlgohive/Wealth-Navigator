import { describe, expect, it } from "vitest";

import {
  interpYieldPct,
  parBondModDuration,
  computeCarryRolldown,
} from "../../workers/iress-ingest/src/timeseries";

/**
 * Unit tests for the ZAR_NSS carry/rolldown computation (worker producer for
 * oems_curve_metric_c). These are pure functions — they lock in the quant
 * conventions so the Curves page never shows a silently-wrong number.
 */

describe("interpYieldPct", () => {
  const pts = [
    { tenorYears: 2, yieldPct: 7.0 },
    { tenorYears: 5, yieldPct: 7.7 },
    { tenorYears: 10, yieldPct: 8.6 },
  ];

  it("returns the exact yield at a fitted point", () => {
    expect(interpYieldPct(pts, 5)).toBeCloseTo(7.7, 6);
  });

  it("linearly interpolates between points", () => {
    // Midpoint of 2y(7.0) and 10y(8.6) is 6y → not a fitted point; uses the
    // 5y–10y segment: 7.7 + (6-5)/(10-5)*(8.6-7.7) = 7.88.
    expect(interpYieldPct(pts, 6)).toBeCloseTo(7.88, 6);
    // 4y sits on the 2y–5y segment: 7.0 + (4-2)/(5-2)*(7.7-7.0) = 7.4667.
    expect(interpYieldPct(pts, 4)).toBeCloseTo(7.46667, 4);
  });

  it("clamps to the endpoints outside the fitted range", () => {
    expect(interpYieldPct(pts, 0.5)).toBeCloseTo(7.0, 6); // below shortest
    expect(interpYieldPct(pts, 30)).toBeCloseTo(8.6, 6); // beyond longest
  });

  it("returns null for an empty curve", () => {
    expect(interpYieldPct([], 5)).toBeNull();
  });
});

describe("parBondModDuration", () => {
  it("matches the annuity closed form at 8% / 5y (~4.0)", () => {
    // (1 - 1.08^-5) / 0.08 = 3.9927
    expect(parBondModDuration(8, 5)).toBeCloseTo(3.9927, 3);
  });

  it("rises with maturity", () => {
    expect(parBondModDuration(8, 10)).toBeGreaterThan(parBondModDuration(8, 5));
  });

  it("is finite and falls back to T at zero yield", () => {
    expect(parBondModDuration(0, 5)).toBe(5);
  });
});

describe("computeCarryRolldown", () => {
  const upward = [
    { tenorYears: 2, yieldPct: 7.0 },
    { tenorYears: 5, yieldPct: 7.7 },
    { tenorYears: 10, yieldPct: 8.6 },
  ];

  it("emits the four expected metrics at the 5Y vertex", () => {
    const rows = computeCarryRolldown("ZAR_NSS", upward, "2026-06-17T00:00:00Z");
    expect(rows.map((r) => r.metric).sort()).toEqual([
      "carry_12m",
      "carry_3m",
      "rolldown_12m",
      "rolldown_3m",
    ]);
    for (const r of rows) {
      expect(r.curve_id).toBe("ZAR_NSS");
      expect(r.tenor_label).toBe("5Y");
      expect(r.as_of).toBe("2026-06-17T00:00:00Z");
    }
  });

  it("computes carry = (y5 − front) × horizon", () => {
    const rows = computeCarryRolldown("ZAR_NSS", upward, "d");
    const carry12 = rows.find((r) => r.metric === "carry_12m")!.value;
    const carry3 = rows.find((r) => r.metric === "carry_3m")!.value;
    // (7.7 − 7.0) × 1 = 0.70 ; × 0.25 = 0.175 → 0.18 (2dp)
    expect(carry12).toBeCloseTo(0.7, 6);
    expect(carry3).toBeCloseTo(0.18, 6);
  });

  it("rolldown is positive on an upward-sloping curve", () => {
    const rows = computeCarryRolldown("ZAR_NSS", upward, "d");
    expect(rows.find((r) => r.metric === "rolldown_12m")!.value).toBeGreaterThan(0);
    expect(rows.find((r) => r.metric === "rolldown_3m")!.value).toBeGreaterThan(0);
  });

  it("is zero on a flat curve (no carry-over-funding, no roll)", () => {
    const flat = [
      { tenorYears: 2, yieldPct: 8.0 },
      { tenorYears: 5, yieldPct: 8.0 },
      { tenorYears: 10, yieldPct: 8.0 },
    ];
    const rows = computeCarryRolldown("ZAR_NSS", flat, "d");
    for (const r of rows) expect(r.value).toBeCloseTo(0, 6);
  });

  it("returns [] when the curve has fewer than two points", () => {
    expect(computeCarryRolldown("ZAR_NSS", [{ tenorYears: 5, yieldPct: 7.7 }], "d")).toEqual([]);
  });
});
