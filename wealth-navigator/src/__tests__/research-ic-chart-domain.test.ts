import { describe, expect, it } from "vitest";

import { priceTriggerYDomain } from "@/components/research-ic/chart-domain";

describe("priceTriggerYDomain", () => {
  it("anchors on the price series and keeps nearby triggers in range", () => {
    const domain = priceTriggerYDomain([850, 900, 880], [820, 950], 880);
    expect(domain).not.toBeNull();
    expect(domain!.inRange).toEqual([820, 950]);
    expect(domain!.offScale).toEqual([]);
    expect(domain!.min).toBeLessThan(820);
    expect(domain!.max).toBeGreaterThan(950);
  });

  it("keeps far stale triggers off-scale so they do not crush the series", () => {
    // NPN-style: live ~R850–950, thesis triggers still at R3.4k–R5.1k.
    const domain = priceTriggerYDomain([952, 900, 852], [3400, 3850, 3900, 4700, 5100], 853);
    expect(domain).not.toBeNull();
    expect(domain!.offScale).toEqual([3400, 3850, 3900, 4700, 5100]);
    expect(domain!.inRange).toEqual([]);
    // Visible band stays near the live series, not stretched to R5,100.
    expect(domain!.max).toBeLessThan(1200);
    expect(domain!.min).toBeGreaterThan(700);
  });

  it("falls back to the trigger span when there is no price series yet", () => {
    const domain = priceTriggerYDomain([], [3400, 5100], null);
    expect(domain).not.toBeNull();
    expect(domain!.inRange).toEqual([3400, 5100]);
    expect(domain!.offScale).toEqual([]);
    expect(domain!.min).toBeLessThan(3400);
    expect(domain!.max).toBeGreaterThan(5100);
  });

  it("returns null when there is nothing to plot", () => {
    expect(priceTriggerYDomain([], [], null)).toBeNull();
  });
});
