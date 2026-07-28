import { describe, expect, it } from "vitest";

import { buildCanonicalReturnIndex } from "@/lib/returns/canonical-index";

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
