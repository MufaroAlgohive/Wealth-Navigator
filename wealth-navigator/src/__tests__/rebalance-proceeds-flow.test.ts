import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("rebalance sale-proceeds flow", () => {
  const builder = readFileSync(
    resolve("src/components/research-ic/rebalance-builder-page.tsx"),
    "utf8",
  );
  const impactRoute = readFileSync(resolve("src/app/api/rebalance/impact/route.ts"), "utf8");

  it("requires an explicit proceeds destination before IC submission", () => {
    expect(builder).toContain('title="Sale proceeds plan"');
    expect(builder).toContain("What should the sale proceeds buy?");
    expect(builder).toContain("proceedsPlanMissing");
    expect(builder).toContain("proceeds_destination: proceedsDestination");
  });

  it("shows net proceeds with an expandable fee and reserve bridge", () => {
    expect(builder).toContain("Estimated proceeds and fee bridge");
    expect(builder).toContain("Estimated sell fees");
    expect(builder).toContain("Execution reserve used");
    expect(builder).toContain("Per-investor effect");
  });

  it("loads rebalance fees from App Settings without a fallback", () => {
    expect(impactRoute).toContain('.from("app_settings")');
    expect(impactRoute).toContain("feeValue?.rebBrokerageRate");
    expect(impactRoute).toContain("feeValue?.rebCustodyFee");
    expect(impactRoute).toContain("Rebalance proceeds preview blocked");
  });
});
