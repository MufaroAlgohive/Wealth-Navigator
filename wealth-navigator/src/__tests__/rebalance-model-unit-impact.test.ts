import { describe, expect, it } from "vitest";

import { calculateModelUnitImpact } from "@/lib/rebalance/model-unit-impact";

describe("rebalance model-unit client impact", () => {
  it("turns a 3-to-2 model decrease into a sell for every full client lot", () => {
    expect(calculateModelUnitImpact({
      action: "decrease",
      currentQty: 8,
      currentModelUnits: 3,
      targetModelUnits: 2,
    })).toEqual({ lots: 2, targetQty: 6, deltaQty: -2 });
  });

  it("preserves the direction of a model increase", () => {
    expect(calculateModelUnitImpact({
      action: "increase",
      currentQty: 8,
      currentModelUnits: 3,
      targetModelUnits: 4,
    })).toEqual({ lots: 2, targetQty: 10, deltaQty: 2 });
  });

  it("fully exits a removed model holding", () => {
    expect(calculateModelUnitImpact({
      action: "remove",
      currentQty: 8,
      currentModelUnits: 3,
      targetModelUnits: 0,
    })).toEqual({ lots: 2, targetQty: 0, deltaQty: -8 });
  });
});
