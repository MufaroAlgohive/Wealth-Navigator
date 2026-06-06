import { describe, expect, it } from "vitest";

import { canRebalance } from "@/lib/iress/strategy";
import type { Strategy } from "@/types/iress";

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: "test",
    name: "Test Strategy",
    kind: "equity",
    manager: "Test",
    aum: 0,
    ytd: 0,
    dayPnl: 0,
    sharpe: 0,
    maxDD: 0,
    benchmark: "JSE Top 40",
    benchmarkYtd: 0,
    investorCount: 1,
    holdingsCount: 0,
    cashWeight: 0,
    status: "live",
    lastRebalanced: "2026-01-01",
    ...overrides,
  };
}

describe("canRebalance", () => {
  it("returns false when there are no linked investors", () => {
    expect(canRebalance(makeStrategy({ investorCount: 0, status: "live" }))).toBe(false);
  });

  it("returns false when the strategy is halted by Risk", () => {
    expect(canRebalance(makeStrategy({ investorCount: 5, status: "halted" }))).toBe(false);
  });

  it("returns true for a live strategy with investors", () => {
    expect(canRebalance(makeStrategy({ investorCount: 5, status: "live" }))).toBe(true);
  });

  it("returns true for a paper strategy with investors", () => {
    expect(canRebalance(makeStrategy({ investorCount: 5, status: "paper" }))).toBe(true);
  });
});
