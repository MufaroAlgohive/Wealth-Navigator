import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { affectedStrategyCounts } from "@/lib/returns/find-rebalanced-strategies";
import {
  CANONICAL_LEDGER_REPAIR_SHADOW_TABLE,
  computeRepairedLedgerSeries,
  runFullPlatformRepairForTesting,
} from "@/lib/returns/repair-canonical-ledger-historical";
import type { RepairInputs } from "@/lib/returns/repair-canonical-ledger-historical";

/**
 * Phase 2 (this PR): bulk historical reprocessor for the canonical-ledger YTD chain-linking fix.
 * See canonical-ledger-ytd-chain-link.test.ts for the original PR #142 regression coverage this
 * builds on (directMetric()'s chain-linked ratio vs. the old leg-sum-denominator bug).
 */

describe("findAffectedStrategies discovery (not a hardcoded list)", () => {
  it("flags a strategy with more than one composition-log row, even with zero settled batches", () => {
    const counts = affectedStrategyCounts(
      [{ strategy_id: "s1" }, { strategy_id: "s1" }, { strategy_id: "s2" }],
      [],
    );
    expect(counts.get("s1")).toEqual({
      compositionRowCount: 2,
      settledBatchCount: 0,
      reason: "MULTIPLE_COMPOSITIONS",
    });
    expect(counts.has("s2")).toBe(false);
  });

  it("flags a strategy with a SETTLED rebalance batch even with only one composition row", () => {
    const counts = affectedStrategyCounts(
      [{ strategy_id: "s3" }],
      [
        { strategy_id: "s3", status: "SETTLED" },
        { strategy_id: "s4", status: "PENDING" },
      ],
    );
    expect(counts.get("s3")).toEqual({
      compositionRowCount: 1,
      settledBatchCount: 1,
      reason: "SETTLED_REBALANCE_BATCH",
    });
    expect(counts.has("s4")).toBe(false);
  });

  it("reports BOTH when a strategy independently satisfies each condition", () => {
    const counts = affectedStrategyCounts(
      [{ strategy_id: "s5" }, { strategy_id: "s5" }],
      [{ strategy_id: "s5", status: "SETTLED" }],
    );
    expect(counts.get("s5")?.reason).toBe("BOTH");
  });

  it("never flags a strategy that has neither condition", () => {
    const counts = affectedStrategyCounts(
      [{ strategy_id: "s6" }],
      [{ strategy_id: "s6", status: "REJECTED" }],
    );
    expect(counts.size).toBe(0);
  });
});

// --- Yield Basket, real documented segment history (see canonical-ledger-ytd-chain-link.test.ts) --

const INCEPTION_DATE = "2026-01-30";
const INCEPTION_VALUE_CENTS = 208_643;
const BOUNDARY_1_DATE = "2026-06-15";
const BOUNDARY_1_VALUE_CENTS = 240_624;
const BOUNDARY_2_DATE = "2026-07-01";
const BOUNDARY_2_VALUE_CENTS = 231_556;
const BOUNDARY_3_DATE = "2026-07-14";
const BOUNDARY_3_VALUE_CENTS = 227_968;
const TODAY_DATE = "2026-08-20";
const TODAY_VALUE_CENTS = 231_209;

function fill(ticker: string, side: "BUY" | "SELL", cents: number, date: string) {
  return { security_id: ticker, trade_side: side, quantity: 1, avg_fill: cents, fill_date: date };
}

/**
 * A single-ticker-per-segment reconstruction that hits the exact real complete_value_cents at
 * every one of Yield Basket's four documented dates (inception + 3 rebalance boundaries + today),
 * with zero cash and zero execution cost throughout (each boundary's sell proceeds exactly fund
 * the buy). This is not a reconstruction of Yield's actual multi-security composition (that would
 * require per-security fill prices this task's brief does not provide for boundaries 2 and 3) -
 * it exists to prove computeRepairedLedgerSeries(), driven purely by composition/fill/reconciliation
 * inputs (not hand-fed complete_value_cents like the PR #142 unit test), reproduces the same
 * correctly chain-linked ~10.8% YTD from those real reference values, and does NOT reproduce the
 * understated 6.07% the production bug actually showed.
 */
const YIELD_REPAIR_INPUTS: RepairInputs = {
  strategyId: "yield-basket",
  strategyName: "Yield Basket",
  tradingDates: [INCEPTION_DATE, BOUNDARY_1_DATE, BOUNDARY_2_DATE, BOUNDARY_3_DATE, TODAY_DATE],
  compositions: [
    { effective_from: "2026-01-01", effective_to: "2026-06-14", holdings: [{ ticker: "SEGA", units: 1 }] },
    { effective_from: BOUNDARY_1_DATE, effective_to: "2026-06-30", holdings: [{ ticker: "SEGB", units: 1 }] },
    { effective_from: BOUNDARY_2_DATE, effective_to: "2026-07-13", holdings: [{ ticker: "SEGC", units: 1 }] },
    { effective_from: BOUNDARY_3_DATE, effective_to: null, holdings: [{ ticker: "SEGD", units: 1 }] },
  ],
  activeRules: [{ effective_from: "2026-01-01", continuity_cash_per_lot_cents: 0 }],
  settledBatches: [
    {
      id: "b1",
      status: "SETTLED",
      settlement_state: "COMPLETE",
      effective_date: BOUNDARY_1_DATE,
      is_reversed: false,
      holdings_snapshot_before: [{ ticker: "SEGA", units: 1 }],
      holdings_snapshot_after: [{ ticker: "SEGB", units: 1 }],
    },
    {
      id: "b2",
      status: "SETTLED",
      settlement_state: "COMPLETE",
      effective_date: BOUNDARY_2_DATE,
      is_reversed: false,
      holdings_snapshot_before: [{ ticker: "SEGB", units: 1 }],
      holdings_snapshot_after: [{ ticker: "SEGC", units: 1 }],
    },
    {
      id: "b3",
      status: "SETTLED",
      settlement_state: "COMPLETE",
      effective_date: BOUNDARY_3_DATE,
      is_reversed: false,
      holdings_snapshot_before: [{ ticker: "SEGC", units: 1 }],
      holdings_snapshot_after: [{ ticker: "SEGD", units: 1 }],
    },
  ],
  fillsByBatch: new Map([
    [
      "b1",
      [
        fill("SEGA", "SELL", BOUNDARY_1_VALUE_CENTS, BOUNDARY_1_DATE),
        fill("SEGB", "BUY", BOUNDARY_1_VALUE_CENTS, BOUNDARY_1_DATE),
      ],
    ],
    [
      "b2",
      [
        fill("SEGB", "SELL", BOUNDARY_2_VALUE_CENTS, BOUNDARY_2_DATE),
        fill("SEGC", "BUY", BOUNDARY_2_VALUE_CENTS, BOUNDARY_2_DATE),
      ],
    ],
    [
      "b3",
      [
        fill("SEGC", "SELL", BOUNDARY_3_VALUE_CENTS, BOUNDARY_3_DATE),
        fill("SEGD", "BUY", BOUNDARY_3_VALUE_CENTS, BOUNDARY_3_DATE),
      ],
    ],
  ]),
  reconciliationByBatch: new Map([
    [
      "b1",
      {
        model_capital_cents: BOUNDARY_1_VALUE_CENTS,
        securities_value_cents: BOUNDARY_1_VALUE_CENTS,
        strategy_ca_cents: 0,
        affected_owner_count: 1,
        reconciled_owner_count: 1,
      },
    ],
    [
      "b2",
      {
        model_capital_cents: BOUNDARY_2_VALUE_CENTS,
        securities_value_cents: BOUNDARY_2_VALUE_CENTS,
        strategy_ca_cents: 0,
        affected_owner_count: 1,
        reconciled_owner_count: 1,
      },
    ],
    [
      "b3",
      {
        model_capital_cents: BOUNDARY_3_VALUE_CENTS,
        securities_value_cents: BOUNDARY_3_VALUE_CENTS,
        strategy_ca_cents: 0,
        affected_owner_count: 1,
        reconciled_owner_count: 1,
      },
    ],
  ]),
  prices: [
    {
      symbol: "SEGA",
      as_of_date: INCEPTION_DATE,
      current_price: INCEPTION_VALUE_CENTS,
      fetched_at: "2026-01-30T18:00:00Z",
    },
    {
      symbol: "SEGB",
      as_of_date: BOUNDARY_1_DATE,
      current_price: BOUNDARY_1_VALUE_CENTS,
      fetched_at: "2026-06-15T18:00:00Z",
    },
    {
      symbol: "SEGC",
      as_of_date: BOUNDARY_2_DATE,
      current_price: BOUNDARY_2_VALUE_CENTS,
      fetched_at: "2026-07-01T18:00:00Z",
    },
    {
      symbol: "SEGD",
      as_of_date: BOUNDARY_3_DATE,
      current_price: BOUNDARY_3_VALUE_CENTS,
      fetched_at: "2026-07-14T18:00:00Z",
    },
    {
      symbol: "SEGD",
      as_of_date: TODAY_DATE,
      current_price: TODAY_VALUE_CENTS,
      fetched_at: "2026-08-20T18:00:00Z",
    },
  ],
};

describe("computeRepairedLedgerSeries - Yield Basket real segment history", () => {
  const computed = computeRepairedLedgerSeries(YIELD_REPAIR_INPUTS, "test-repair-run");

  it("walks every trading date across all three rebalance boundaries without error", () => {
    expect(computed.errors).toEqual([]);
    expect(computed.complete).toBe(true);
    expect(computed.rows).toHaveLength(5);
    expect(computed.rows.map((row) => row.as_of_date)).toEqual([
      INCEPTION_DATE,
      BOUNDARY_1_DATE,
      BOUNDARY_2_DATE,
      BOUNDARY_3_DATE,
      TODAY_DATE,
    ]);
  });

  it("reproduces the real complete_value_cents at every checkpoint", () => {
    expect(computed.rows.map((row) => row.complete_value_cents)).toEqual([
      INCEPTION_VALUE_CENTS,
      BOUNDARY_1_VALUE_CENTS,
      BOUNDARY_2_VALUE_CENTS,
      BOUNDARY_3_VALUE_CENTS,
      TODAY_VALUE_CENTS,
    ]);
  });

  it("lands the recomputed YTD near the independently-verified ~10.8% figure, not the buggy 6.07%", () => {
    const today = computed.rows.at(-1);
    if (!today) throw new Error("expected at least one computed row");
    const ytd = today.period_metrics.YTD as { return_pct: number; reference_date: string };
    expect(ytd.reference_date).toBe(INCEPTION_DATE); // no prior-year row exists; falls back to inception
    expect(ytd.return_pct).toBeGreaterThanOrEqual(10.5);
    expect(ytd.return_pct).toBeLessThanOrEqual(11.5);
    expect(ytd.return_pct).not.toBeCloseTo(6.07, 0);
  });

  it("tags every row DRAFT and with the repair-specific ledger version - never CERTIFIED", () => {
    for (const row of computed.rows) {
      expect(row.certification_status).toBe("DRAFT");
      expect(row.ledger_version).toBe("CANONICAL_REPAIR_CHAIN_LINKED_HISTORICAL_V1");
      expect(row.repair_run_id).toBe("test-repair-run");
      expect(row.calculation_notes.promotion_blocked).toBe(true);
    }
  });
});

describe("runFullPlatformRepair - never writes to strategy_canonical_daily_ledger_c", () => {
  it("discovers an affected strategy by query, computes its history, and writes only to the shadow table", async () => {
    const inceptionDate = "2026-08-20";
    const tables: Record<string, unknown[]> = {
      strategy_composition_log_c: [
        {
          strategy_id: "strat-1",
          effective_from: inceptionDate,
          effective_to: null,
          holdings: [{ ticker: "ABC", units: 1 }],
        },
        // A second row exists purely so this strategy satisfies the MULTIPLE_COMPOSITIONS
        // discovery condition; its effective_from is beyond the single trading date under test,
        // so it is never actually applied by the walk.
        {
          strategy_id: "strat-1",
          effective_from: "2099-01-01",
          effective_to: null,
          holdings: [{ ticker: "ABC", units: 1 }],
        },
      ],
      rebalance_batch: [],
      strategies_c: [
        {
          id: "strat-1",
          name: "Test Strategy One",
          created_at: `${inceptionDate}T00:00:00Z`,
          status: "active",
        },
      ],
      jse_trading_calendar: [{ trading_date: inceptionDate }],
      strategy_valuation_rules_c: [
        { effective_from: inceptionDate, continuity_cash_per_lot_cents: 0, status: "ACTIVE" },
      ],
      stock_returns_c: [
        {
          symbol: "ABC",
          as_of_date: inceptionDate,
          current_price: 10_000,
          fetched_at: `${inceptionDate}T18:00:00Z`,
        },
      ],
      [CANONICAL_LEDGER_REPAIR_SHADOW_TABLE]: [],
    };
    const calls: string[] = [];
    const inserted: Record<string, unknown[]> = {};
    const db = makeMockDb(tables, calls, inserted);

    const result = await runFullPlatformRepairForTesting(db, { apply: true, asOfDate: inceptionDate });

    expect(result.discoveredStrategyCount).toBe(1);
    expect(result.summary.written).toBe(1);
    expect(result.summary.failed).toBe(0);
    expect(inserted[CANONICAL_LEDGER_REPAIR_SHADOW_TABLE]).toHaveLength(1);
    expect(calls).not.toContain("strategy_canonical_daily_ledger_c");
  });
});

// --- minimal chainable Supabase mock, shared by the pipeline test above -------------------------

function makeMockDb(tables: Record<string, unknown[]>, calls: string[], inserted: Record<string, unknown[]>) {
  return {
    from(table: string) {
      calls.push(table);
      const rows = tables[table] ?? [];
      const result = { data: rows, error: null };
      const builder: PromiseLike<typeof result> & Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        neq: () => builder,
        in: () => builder,
        gte: () => builder,
        lte: () => builder,
        order: () => builder,
        limit: () => builder,
        range: () => builder,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        insert: async (payload: unknown) => {
          const rowsToInsert = Array.isArray(payload) ? payload : [payload];
          inserted[table] = [...(inserted[table] ?? []), ...rowsToInsert];
          return { data: null, error: null };
        },
        // biome-ignore lint/suspicious/noThenProperty: must be thenable so callers can `await db.from(...)` directly, matching the real Supabase query builder.
        then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}
