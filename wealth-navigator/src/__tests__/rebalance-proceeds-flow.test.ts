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
    expect(builder).toContain("proceeds_mode: effectiveProceedsMode");
    expect(builder).toContain("proceeds_destination: inferredProceedsDestination");
    expect(builder).toContain('"Liquidate to Cash" : proceedsMode === "reinvest" ? "Reinvest / Buy"');
    expect(builder).not.toContain("Will the sale proceeds buy another asset?");
  });

  it("shows net proceeds with a CRM-exact sell/buy fee breakdown", () => {
    expect(builder).toContain("Sell Execution");
    expect(builder).toContain("Total Shares to Sell");
    expect(builder).toContain("Gross Proceeds");
    expect(builder).toContain("Net Proceeds");
    expect(builder).toContain("Execution Reserve Before");
    expect(builder).toContain("Per-Client Allocation");
  });

  it("shows only strategy CA and execution reserve as rebalance funding", () => {
    expect(builder).toContain("Show residual view");
    expect(builder).toContain("CA before");
    expect(builder).toContain("Reserve before");
    expect(builder).toContain("Strategy CA after");
    expect(builder).toContain("Reserve after");
    expect(builder).not.toContain("Available cash");
    expect(builder).not.toContain("Wallet before");
    expect(impactRoute).not.toContain('select("user_id, balance")');
  });

  it("presents a professional client impact table before committing", () => {
    expect(builder).toContain('"Client impact preview"');
    expect(builder).toContain(">Lots</th>");
    expect(builder).toContain("line.lots");
    expect(builder).toContain("Commit trade sequence");
    expect(builder).toContain("No market order is sent yet");
    expect(builder).toContain("line.currentQty");
    expect(builder).toContain("line.targetQty");
    expect(builder).toContain("line.currentPnlCents");
  });

  it("derives each client's lot count from the current basket model", () => {
    expect(builder).toContain("current: baseline");
    expect(impactRoute).toContain("currentModelUnits");
    expect(impactRoute).toContain("calculateModelUnitImpact");
    expect(impactRoute).not.toContain("target.weight * basketCents");
  });

  it("does not refetch when quote-driven weights move without a model-unit change", () => {
    expect(builder).toContain("[p.ticker, p.action, p.shares]");
    expect(builder).not.toContain("[p.ticker, p.action, p.weight]");
  });

  it("keeps zero-impact strategy holders visible instead of silently dropping them", () => {
    expect(impactRoute).not.toContain('if (lines.length === 0) continue');
    expect(impactRoute).toContain('deltaQty < 0 ? "sell" : "none"');
    expect(builder).toContain('line.side === "none" ? "no trade" : line.side');
  });

  it("reads the indexed latest quote instead of scanning full intraday history", () => {
    expect(impactRoute).toContain('from("securities_with_latest_quote")');
    expect(impactRoute).not.toContain('from("stock_intraday_c")');
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
