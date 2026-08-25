import { describe, expect, it, vi } from "vitest";

import { settleRebalanceCashForClients } from "./settle-rebalance-cash";

function resolved(data: unknown) {
  return { data, error: null };
}

function chain(result: unknown) {
  const api: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "is", "not", "order", "limit"]) api[method] = () => api;
  api.maybeSingle = () => Promise.resolve(result);
  api.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return api;
}

/**
 * `stock_holdings_c` is queried two shapes in this module: a bulk `.in(id,
 * [...]).select(...)` owner lookup (awaited directly, expects `.data` to be
 * an array) and single-row `.eq(id).maybeSingle()` lookups (holding ->
 * transaction_id, resolveStrategyRowId's holding -> strategy_id). Both need
 * to resolve correctly from the same mocked table.
 */
function stockHoldingsChain(ownerRows: Array<{ id: string; user_id: string; family_member_id: string | null }>) {
  const api: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "is", "not", "order", "limit"]) api[method] = () => api;
  api.maybeSingle = () => Promise.resolve(resolved({ strategy_id: "strategy-1", transaction_id: null }));
  api.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolved(ownerRows)).then(resolve);
  return api;
}

/**
 * `reconcile_rebalance_ca` (wired in as part of finalizeRebalanceBoundary's
 * completion gate) requires `strategy_rebalance_cash_events_c` coverage for
 * EVERY owner named in the batch's `rebalance_event` rows — settled or
 * parked. Parked clients' real cash movement already happened, fee-free, at
 * booking time in reconcile-parked-holdings.ts, so this function must never
 * move it again; these tests prove it writes an honest zero-delta coverage
 * row for a parked owner instead (proceeds attribution stays correct: a
 * parked owner's balance is unchanged, a settled owner's reflects their
 * real proceeds), and that an owner already covered by a real settlement is
 * never double-written as a parked zero-row too (retry-safe, no double
 * credit).
 */
describe("settleRebalanceCashForClients — parked/settled owner coverage", () => {
  function baseRetailDb(
    ownerRows: Array<{ id: string; user_id: string; family_member_id: string | null }>,
    overrides: { residualBalance?: number } = {},
  ) {
    const residualBalance = overrides.residualBalance ?? 5000;
    return {
      from: vi.fn((table: string) => {
        if (table === "app_settings") {
          return chain(resolved({ value: { brokerFeeRate: 0, isinFeePerAsset: 0 } }));
        }
        if (table === "stock_holdings_c") {
          return stockHoldingsChain(ownerRows);
        }
        if (table === "transactions") {
          return chain(resolved({ buffer_cents: 0, buffer_consumed_cents: 0 }));
        }
        if (table === "strategy_rebalance_residuals") {
          return chain(resolved({ balance_cents: residualBalance }));
        }
        throw new Error(`unexpected retail table: ${table}`);
      }),
      rpc: vi.fn(() => Promise.resolve(resolved({ ok: true }))),
    };
  }

  it("credits the settled owner's real proceeds and writes an honest zero-movement row for the parked owner", async () => {
    const retailDb = baseRetailDb([
      { id: "holding-settled", user_id: "user-settled", family_member_id: null },
      { id: "holding-parked", user_id: "user-parked", family_member_id: null },
    ]);
    const institutionalDb = {
      from: vi.fn((table: string) => {
        if (table === "oems_order_audit") {
          return chain(resolved([
            {
              side: "sell",
              quantity: 1,
              symbol: "ABC.JO",
              payload: {
                holding_id: "holding-settled",
                user_id: "user-settled",
                family_member_id: null,
                avgPx: 1000,
                client_treatment: "settled",
              },
            },
            {
              side: "buy",
              quantity: 1,
              symbol: "XYZ.JO",
              payload: {
                holding_id: "holding-parked",
                user_id: "user-parked",
                family_member_id: null,
                avgPx: 500,
                client_treatment: "parked",
              },
            },
          ]));
        }
        throw new Error(`unexpected institutional table: ${table}`);
      }),
    };

    const result = await settleRebalanceCashForClients(retailDb as never, institutionalDb as never, "request-1", "batch-1");

    expect(result.errors).toEqual([]);
    const rpcCall = (retailDb.rpc as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(rpcCall[0]).toBe("record_rebalance_cash_settlement");
    const settlements = rpcCall[1].p_settlements as Array<Record<string, unknown>>;
    expect(settlements).toHaveLength(2);

    // Exact residual math, not just gross_sell_cents: with zero brokerage/
    // custody fees and zero reserve mocked, the R10.00 sale's full proceeds
    // land in the owner's OWN residual (opening 5000 -> closing 6000) --
    // and the row is attributed to exactly that (user_id, family_member_id)
    // pair, not merged with the parked owner's.
    const settled = settlements.find((s) => s.user_id === "user-settled");
    expect(settled).toMatchObject({
      user_id: "user-settled",
      family_member_id: null,
      gross_sell_cents: 1000,
      gross_buy_cents: 0,
      opening_residual_cents: 5000,
      closing_residual_cents: 6000,
      reserve_before_cents: 0,
      reserve_used_cents: 0,
      reserve_after_cents: 0,
      requested_fee_cents: 0,
      fee_shortfall_cents: 0,
    });

    const parked = settlements.find((s) => s.user_id === "user-parked");
    expect(parked).toMatchObject({
      user_id: "user-parked",
      family_member_id: null,
      opening_residual_cents: 5000,
      closing_residual_cents: 5000,
      reserve_before_cents: 0,
      reserve_used_cents: 0,
      reserve_after_cents: 0,
      requested_fee_cents: 0,
      transaction_id: null,
    });
  });

  it("keeps a parent's and their family member's settlements as separate, correctly attributed rows", async () => {
    const retailDb = baseRetailDb([
      { id: "holding-parent", user_id: "parent-1", family_member_id: null },
      { id: "holding-child", user_id: "parent-1", family_member_id: "child-1" },
    ]);
    const institutionalDb = {
      from: vi.fn((table: string) => {
        if (table === "oems_order_audit") {
          return chain(resolved([
            {
              side: "sell",
              quantity: 1,
              symbol: "ABC.JO",
              payload: { holding_id: "holding-parent", user_id: "parent-1", family_member_id: null, avgPx: 1000, client_treatment: "settled" },
            },
            {
              side: "sell",
              quantity: 1,
              symbol: "DEF.JO",
              payload: { holding_id: "holding-child", user_id: "parent-1", family_member_id: "child-1", avgPx: 700, client_treatment: "settled" },
            },
          ]));
        }
        throw new Error(`unexpected institutional table: ${table}`);
      }),
    };

    const result = await settleRebalanceCashForClients(retailDb as never, institutionalDb as never, "request-1", "batch-1");

    expect(result.errors).toEqual([]);
    const settlements = (retailDb.rpc as ReturnType<typeof vi.fn>).mock.calls[0][1].p_settlements as Array<Record<string, unknown>>;
    expect(settlements).toHaveLength(2);
    // Proceeds must never cross the parent/child boundary: each pair gets
    // its own residual math from its own R10.00 / R7.00 sale, not a
    // combined R17.00.
    expect(settlements).toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: "parent-1", family_member_id: null, gross_sell_cents: 1000, closing_residual_cents: 6000 }),
      expect.objectContaining({ user_id: "parent-1", family_member_id: "child-1", gross_sell_cents: 700, closing_residual_cents: 5700 }),
    ]));
  });

  it("computes an identical settlement payload on a retry (no client-side state to drift, no second credit)", async () => {
    // settleRebalanceCashForClients recomputes everything fresh from stored
    // balances each call; it holds no client-side memory of a prior run. A
    // retry after e.g. a later phase failing must therefore ask the
    // (already idempotent, unmodified) record_rebalance_cash_settlement RPC
    // for the EXACT same operation both times -- proving retry-safety here
    // means proving determinism, since the server RPC's own opening-balance
    // check is what turns a second identical call into a no-op rather than
    // a second credit.
    const orders = [{
      side: "sell",
      quantity: 1,
      symbol: "ABC.JO",
      payload: { holding_id: "holding-settled", user_id: "user-settled", family_member_id: null, avgPx: 1000, client_treatment: "settled" },
    }];
    const institutionalDbFor = () => ({
      from: vi.fn((table: string) => {
        if (table === "oems_order_audit") return chain(resolved(orders));
        throw new Error(`unexpected institutional table: ${table}`);
      }),
    });

    const retailDbFirst = baseRetailDb([{ id: "holding-settled", user_id: "user-settled", family_member_id: null }]);
    const first = await settleRebalanceCashForClients(retailDbFirst as never, institutionalDbFor() as never, "request-1", "batch-1");
    const retailDbSecond = baseRetailDb([{ id: "holding-settled", user_id: "user-settled", family_member_id: null }]);
    const second = await settleRebalanceCashForClients(retailDbSecond as never, institutionalDbFor() as never, "request-1", "batch-1");

    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    const firstSettlements = (retailDbFirst.rpc as ReturnType<typeof vi.fn>).mock.calls[0][1].p_settlements;
    const secondSettlements = (retailDbSecond.rpc as ReturnType<typeof vi.fn>).mock.calls[0][1].p_settlements;
    expect(secondSettlements).toEqual(firstSettlements);
  });

  it("does not write a duplicate parked coverage row for an owner already covered by a real settled settlement", async () => {
    const retailDb = baseRetailDb([
      { id: "holding-1", user_id: "user-1", family_member_id: null },
      { id: "holding-2", user_id: "user-1", family_member_id: null },
    ]);
    const institutionalDb = {
      from: vi.fn((table: string) => {
        if (table === "oems_order_audit") {
          return chain(resolved([
            {
              side: "sell",
              quantity: 1,
              symbol: "ABC.JO",
              payload: {
                holding_id: "holding-1",
                user_id: "user-1",
                family_member_id: null,
                avgPx: 1000,
                client_treatment: "settled",
              },
            },
            // Same owner, a different holding, tagged parked -- should not
            // produce a second, conflicting coverage row.
            {
              side: "buy",
              quantity: 1,
              symbol: "XYZ.JO",
              payload: {
                holding_id: "holding-2",
                user_id: "user-1",
                family_member_id: null,
                avgPx: 500,
                client_treatment: "parked",
              },
            },
          ]));
        }
        throw new Error(`unexpected institutional table: ${table}`);
      }),
    };

    const result = await settleRebalanceCashForClients(retailDb as never, institutionalDb as never, "request-1", "batch-1");

    expect(result.errors).toEqual([]);
    const rpcCall = (retailDb.rpc as ReturnType<typeof vi.fn>).mock.calls[0];
    const settlements = rpcCall[1].p_settlements as Array<Record<string, unknown>>;
    expect(settlements.filter((s) => s.user_id === "user-1")).toHaveLength(1);
  });

  it("writes coverage even when there are no settled owners at all (all-parked batch)", async () => {
    const retailDb = baseRetailDb([{ id: "holding-parked", user_id: "user-parked", family_member_id: null }]);
    const institutionalDb = {
      from: vi.fn((table: string) => {
        if (table === "oems_order_audit") {
          return chain(resolved([{
            side: "buy",
            quantity: 1,
            symbol: "XYZ.JO",
            payload: {
              holding_id: "holding-parked",
              user_id: "user-parked",
              family_member_id: null,
              avgPx: 500,
              client_treatment: "parked",
            },
          }]));
        }
        throw new Error(`unexpected institutional table: ${table}`);
      }),
    };

    const result = await settleRebalanceCashForClients(retailDb as never, institutionalDb as never, "request-1", "batch-1");

    expect(result.errors).toEqual([]);
    expect(retailDb.rpc).toHaveBeenCalledOnce();
    const settlements = (retailDb.rpc as ReturnType<typeof vi.fn>).mock.calls[0][1].p_settlements as Array<Record<string, unknown>>;
    expect(settlements).toEqual([expect.objectContaining({ user_id: "user-parked", opening_residual_cents: 5000, closing_residual_cents: 5000 })]);
  });
});
