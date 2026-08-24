import { describe, expect, it } from "vitest";

import { buildWealthIndex, calculateMonthlyReturns, calculateRisk, valueWeightedReturn } from "./analytics";

describe("investor analytics", () => {
  it("chain-links daily returns into a wealth index", () => {
    expect(buildWealthIndex([{ date: "2026-01-02", dailyPct: 10 }, { date: "2026-01-03", dailyPct: -10 }])).toEqual([
      { date: "2026-01-02", value: 110.00000000000001 },
      { date: "2026-01-03", value: 99.00000000000001 },
    ]);
  });

  it("computes monthly returns from month-end wealth, not ratios of percentages", () => {
    const calendar = calculateMonthlyReturns([
      { date: "2026-01-30", value: 100 },
      { date: "2026-02-27", value: 110 },
      { date: "2026-03-31", value: 99 },
    ]);
    expect(calendar["2026"]?.[0]).toBeCloseTo(0);
    expect(calendar["2026"]?.[1]).toBeCloseTo(10);
    expect(calendar["2026"]?.[2]).toBeCloseTo(-10);
  });

  it("uses value weighting for aggregate returns", () => {
    expect(valueWeightedReturn([{ valueCents: 900, returnPct: 10 }, { valueCents: 100, returnPct: -10 }])).toBe(8);
  });

  it("derives drawdown from a positive wealth series", () => {
    const risk = calculateRisk([{ date: "1", value: 100 }, { date: "2", value: 120 }, { date: "3", value: 90 }]);
    expect(risk.maxDD).toBeCloseTo(-25);
  });
});
