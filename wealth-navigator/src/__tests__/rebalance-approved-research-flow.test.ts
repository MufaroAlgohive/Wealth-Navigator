import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("approved research rebalance flow", () => {
  const route = readFileSync(resolve("src/app/api/rebalance/requests/route.ts"), "utf8");

  it("requires approved research coverage for rebalance buys", () => {
    expect(route).toContain('.eq("status", "approved")');
    expect(route).toContain("Approved research required before creating this rebalance");
  });

  it("books an accepted proposal directly onto the Rebalance tab", () => {
    expect(route).toContain("const directExecute = true");
    expect(route).toContain('status: directExecute ? "executed" : "pending"');
    expect(route).toContain("executeRebalanceRequest(retailDb, db");
  });
});
