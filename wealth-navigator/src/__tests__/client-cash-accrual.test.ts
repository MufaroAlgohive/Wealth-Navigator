import { describe, expect, it } from "vitest";

import { computeStrategyAccrual } from "@/app/api/admin/clients/cash-accrual/route";

const cfg = { strategy_id: "strategy-1", annual_fee_pct: 0.0099 };

describe("client cash accrual", () => {
  it("treats basket_value as cents exactly once", () => {
    const result = computeStrategyAccrual(
      cfg,
      [{ user_id: "u1", strategy_id: "strategy-1", as_of_date: "2026-07-01", basket_value: 630_000 }],
      new Date("2026-07-31T12:00:00Z"),
    );

    expect(result.latest_basket_value_cents).toBe(630_000);
    expect(result.months[0]?.monthly_fee_cents).toBe(520);
    expect(result.total_accrued_cents).toBe(520);
  });

  it("starts at the client's first snapshot and prorates the first month", () => {
    const result = computeStrategyAccrual(
      cfg,
      [{ user_id: "u1", strategy_id: "strategy-1", as_of_date: "2026-03-21", basket_value: 630_000 }],
      new Date("2026-03-31T12:00:00Z"),
    );

    expect(result.invest_date).toBe("2026-03-21");
    expect(result.months).toEqual([{ month: "2026-03", monthly_fee_cents: 184, cumulative_cents: 184 }]);
  });

  it("uses each month's applicable basket and prorates the current month", () => {
    const result = computeStrategyAccrual(
      cfg,
      [
        { user_id: "u1", strategy_id: "strategy-1", as_of_date: "2026-03-21", basket_value: 630_000 },
        { user_id: "u1", strategy_id: "strategy-1", as_of_date: "2026-04-30", basket_value: 650_000 },
        { user_id: "u1", strategy_id: "strategy-1", as_of_date: "2026-05-01", basket_value: 700_000 },
      ],
      new Date("2026-05-15T12:00:00Z"),
    );

    expect(result.months).toEqual([
      { month: "2026-03", monthly_fee_cents: 184, cumulative_cents: 184 },
      { month: "2026-04", monthly_fee_cents: 536, cumulative_cents: 720 },
      { month: "2026-05", monthly_fee_cents: 279, cumulative_cents: 999 },
    ]);
  });
});
