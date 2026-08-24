import { describe, expect, it } from "vitest";

import { computePeriodReturns, type YahooBar } from "./returns";

function bar(iso: string, close: number): YahooBar {
  return { t: Date.parse(iso), close };
}

describe("computePeriodReturns calendar baselines", () => {
  it("uses the final prior-year close for conventional YTD", () => {
    const result = computePeriodReturns([
      bar("2025-12-31T07:00:00Z", 100),
      bar("2026-01-02T07:00:00Z", 90),
      bar("2026-08-24T07:00:00Z", 110),
    ]);

    expect(result.period.ytd_pct).toBe(10);
  });

  it("uses the final prior-month close for true calendar MTD", () => {
    const result = computePeriodReturns([
      bar("2026-07-31T07:00:00Z", 200),
      bar("2026-08-03T07:00:00Z", 180),
      bar("2026-08-24T07:00:00Z", 220),
    ]);

    expect(result.period.mtd_pct).toBe(10);
  });
});
