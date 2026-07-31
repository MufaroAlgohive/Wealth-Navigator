import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260729000001_rebalance_ca_reconciliation.sql"),
  "utf8",
);

describe("rebalance CA reconciliation migration", () => {
  it("defines the strategy CA identity and excludes execution reserve", () => {
    expect(migration).toContain("model_capital_cents = securities_value_cents + strategy_ca_cents");
    expect(migration).toContain("execution_reserve_excluded");
    expect(migration).not.toContain("unused_reserve_cents");
  });

  it("requires an immutable cash event for every affected owner", () => {
    expect(migration).toContain("Every affected owner requires an immutable rebalance cash event");
    expect(migration).toContain("Client residual does not match the immutable cash-event closing balance");
    expect(migration).toContain("affected_owner_count = reconciled_owner_count");
  });

  it("is resumable and records a settlement-derived valuation rule", () => {
    expect(migration).toContain("batch_id uuid not null unique");
    expect(migration).toContain("'idempotent', true");
    expect(migration).toContain("SETTLEMENT_CA_RECONCILED_V2");
  });
});
