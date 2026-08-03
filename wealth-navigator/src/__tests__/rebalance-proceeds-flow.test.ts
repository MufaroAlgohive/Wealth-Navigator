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
    expect(builder).toContain("Will the sale proceeds buy another asset?");
    expect(builder).toContain("No · liquidate to cash");
    expect(builder).toContain("What should the proceeds buy?");
    expect(builder).toContain("proceedsPlanMissing");
    expect(builder).toContain("proceeds_mode: proceedsMode");
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
    expect(impactRoute).toContain('body.proceeds_mode === "reinvest"');
    expect(impactRoute).toContain("Liquidation to cash cannot contain a replacement BUY");
    expect(impactRoute).toContain('.from("strategy_rebalance_residuals")');
  });

  it("bypasses research and rationale only for an explicitly UAT strategy", () => {
    expect(builder).toContain('investorEnvironment === "UAT"');
    expect(builder).toContain("!isTestStrategy && missingResearch.length");
    expect(builder).toContain("!isTestStrategy && rationalesMissing.length");
    expect(builder).toContain("Cash, fee and proceeds checks remain");
  });
});
