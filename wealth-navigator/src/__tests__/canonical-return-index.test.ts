import { describe, expect, it } from "vitest";

import {
  buildCanonicalCalendarReturns,
  buildCanonicalPeriodSeries,
  buildCanonicalReturnIndex,
  buildCanonicalYtdSeries,
  canonicalDailyPnlCents,
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

  it("rebases requested chart windows from the canonical all-time chain", () => {
    const points = buildCanonicalPeriodSeries(
      [
        { as_of_date: "2026-01-02", ytd_pct: 0, all_pct: 10 },
        { as_of_date: "2026-04-30", ytd_pct: 5, all_pct: 15.5 },
        { as_of_date: "2026-07-30", ytd_pct: 10, all_pct: 21 },
      ],
      "3M",
    );

    expect(points[0]?.value).toBe(100);
    expect(points.at(-1)?.value).toBeCloseTo((1.21 / 1.155) * 100);
  });

  it("derives monetary daily P&L from complete value and canonical 1D return", () => {
    expect(canonicalDailyPnlCents(110_000, 10)).toBe(10_000);
    expect(canonicalDailyPnlCents(110_000, null)).toBeNull();
  });
});
