import { describe, expect, it } from "vitest";

import { canRetryRebalanceSettlement } from "./settlement-retry-policy";

describe("canRetryRebalanceSettlement", () => {
  it("allows an authorised UAT recovery without requiring the master tier", () => {
    expect(canRetryRebalanceSettlement("uat", "dev")).toBe(true);
  });

  it("requires the master tier for LIVE recovery", () => {
    expect(canRetryRebalanceSettlement("live", "dev")).toBe(false);
    expect(canRetryRebalanceSettlement("live", "master")).toBe(true);
  });

  it("treats a missing environment as LIVE", () => {
    expect(canRetryRebalanceSettlement(null, "dev")).toBe(false);
  });
});
