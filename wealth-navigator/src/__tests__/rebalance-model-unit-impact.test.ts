import { describe, expect, it } from "vitest";

import { calculateModelUnitImpact } from "@/lib/rebalance/model-unit-impact";

describe("rebalance model-unit client impact", () => {
  it("turns a 3-to-2 model decrease into one share sold per affected client", () => {
    expect(calculateModelUnitImpact({
      action: "decrease",
      currentQty: 8,
      currentModelUnits: 3,
      targetModelUnits: 2,
    })).toEqual({ lots: 2, targetQty: 7, deltaQty: -1 });
  });

  it("turns a 3-to-4 model increase into one share bought per affected client", () => {
    expect(calculateModelUnitImpact({
      action: "increase",
      currentQty: 8,
      currentModelUnits: 3,
      targetModelUnits: 4,
    })).toEqual({ lots: 2, targetQty: 9, deltaQty: 1 });
  });

  it("applies the literal model-unit difference rather than multiplying by lots", () => {
    expect(calculateModelUnitImpact({
      action: "increase",
      currentQty: 20,
      currentModelUnits: 3,
      targetModelUnits: 6,
    })).toEqual({ lots: 6, targetQty: 23, deltaQty: 3 });
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
