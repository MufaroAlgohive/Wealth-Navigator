import { describe, expect, it } from "vitest";

import { isUatStrategy } from "@/lib/aum/retail-live-scope";

describe("isUatStrategy", () => {
  it("uses the explicit environment as the primary boundary", () => {
    expect(isUatStrategy({ id: "1", investor_environment: "UAT", name: "Ordinary name" })).toBe(true);
    expect(isUatStrategy({ id: "2", investor_environment: "LIVE", name: "Ordinary name" })).toBe(false);
  });

  it("recognises only narrow historical test markers", () => {
    expect(isUatStrategy({ id: "1", name: "Test Strategy" })).toBe(true);
    expect(isUatStrategy({ id: "2", slug: "UAT-ALPHA" })).toBe(true);
    expect(isUatStrategy({ id: "3", name: "Tested Income Strategy" })).toBe(false);
  });
});
