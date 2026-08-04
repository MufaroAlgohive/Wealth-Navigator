import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("rebalance sale-proceeds flow", () => {
  const builder = readFileSync(
    resolve("src/components/research-ic/rebalance-builder-page.tsx"),
    "utf8",
  );
  const impactRoute = readFileSync(resolve("src/app/api/rebalance/impact/route.ts"), "utf8");

  it("opens impact immediately and infers the proceeds path from the trade shape", () => {
    expect(builder).toContain("inferredProceedsMode");
    expect(builder).toContain('buyActions.length > 0 ? "reinvest" : "liquidate"');
    expect(builder).toContain("enabled: !!strategyId && changes > 0");
    expect(builder).toContain("proceeds_mode: inferredProceedsMode");
    expect(builder).toContain("proceeds_destination: inferredProceedsDestination");
    expect(builder).toContain("Automatic sequence");
    expect(builder).not.toContain("Will the sale proceeds buy another asset?");
  });

  it("shows net proceeds with an expandable fee and reserve bridge", () => {
    expect(builder).toContain("Estimated proceeds and fee bridge");
    expect(builder).toContain("Estimated sell fees");
    expect(builder).toContain("Execution reserve used");
    expect(builder).toContain("Per-investor effect");
  });

  it("separates strategy residual from wallet cash before execution", () => {
    expect(builder).toContain("Show residual view");
    expect(builder).toContain("Residual before");
    expect(builder).toContain("Wallet before");
    expect(builder).toContain("Strategy CA after");
    expect(builder).toContain("inv.residualCents + inv.walletCents");
  });

  it("presents a professional client impact table before committing", () => {
    expect(builder).toContain('title="Client impact preview"');
    expect(builder).toContain("Commit trade sequence");
    expect(builder).toContain("No market order is sent yet");
    expect(builder).toContain("line.currentQty");
    expect(builder).toContain("line.targetQty");
    expect(builder).toContain("line.currentPnlCents");
  });

  it("derives LIVE versus UAT preview scope from the persisted strategy", () => {
    expect(impactRoute).toContain("investor_environment");
    expect(impactRoute).toContain('investorEnvironment === "UAT" ? isTest : !isTest');
    expect(impactRoute).toContain("eligibleIds");
    expect(impactRoute).toContain("accountById");
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
