import { describe, expect, it } from "vitest";

import {
  buildCanonicalCalendarReturns,
  buildCanonicalReturnIndex,
  buildCanonicalYtdSeries,
} from "@/lib/returns/canonical-index";

describe("buildCanonicalReturnIndex", () => {
  it("ignores rebalance-driven basket value changes and compounds approved daily returns", () => {
    const points = buildCanonicalReturnIndex([
      { as_of_date: "2026-07-01", "1d_pct": 0 },
      { as_of_date: "2026-07-02", "1d_pct": 1 },
      { as_of_date: "2026-07-03", "1d_pct": -0.5 },
    ]);

    expect(points.map((point) => point.value)).toEqual([100, 101, 100.495]);
  });

  it("fails closed when no canonical daily return exists", () => {
    expect(buildCanonicalReturnIndex([{ as_of_date: "2026-07-01", "1d_pct": null }])).toEqual([]);
  });
});

describe("factsheet canonical cumulative returns", () => {
  it("uses the latest calendar year's published YTD chain without compounding legacy resets", () => {
    const points = buildCanonicalYtdSeries([
      { as_of_date: "2025-12-31", ytd_pct: 8 },
      { as_of_date: "2026-01-02", ytd_pct: 0.25 },
      { as_of_date: "2026-07-20", ytd_pct: -2.1 },
    ]);

    expect(points.map((point) => point.asOfDate)).toEqual(["2026-01-02", "2026-07-20"]);
    expect(points[0]?.value).toBeCloseTo(100.25);
    expect(points[1]?.value).toBeCloseTo(97.9);
  });

  it("resets the monthly comparison at each year boundary", () => {
    const calendar = buildCanonicalCalendarReturns([
      { as_of_date: "2025-12-31", ytd_pct: 10 },
      { as_of_date: "2026-01-31", ytd_pct: 2 },
      { as_of_date: "2026-02-28", ytd_pct: 3.02 },
    ]);

    expect(calendar["2025"]?.[11]).toBeCloseTo(10);
    expect(calendar["2026"]?.[0]).toBeCloseTo(2);
    expect(calendar["2026"]?.[1]).toBeCloseTo(1);
  });
});
