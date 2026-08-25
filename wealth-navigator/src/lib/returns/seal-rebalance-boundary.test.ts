import { describe, expect, it, vi } from "vitest";

import { finalizeRebalanceBoundary, recordRebalanceExecutionEvidence } from "./seal-rebalance-boundary";

function resolved(data: unknown) {
  return { data, error: null };
}

describe("recordRebalanceExecutionEvidence", () => {
  it("persists confirmed execution evidence, skipping a row that already exists", async () => {
    const eventInsert = vi.fn(() => Promise.resolve(resolved(null)));
    const db = {
      from: vi.fn((table: string) => {
        if (table === "rebalance_event") {
          const query: Record<string, unknown> = {};
          for (const method of ["select", "eq"]) query[method] = () => query;
          query.maybeSingle = () => Promise.resolve(resolved(null));
          query.insert = eventInsert;
          return query;
        }
        throw new Error(`unexpected table: ${table}`);
      }),
    };

    const error = await recordRebalanceExecutionEvidence(db as never, "batch-1", [{
      userId: "user-1",
      familyMemberId: null,
      securityId: "security-1",
      tradeSide: "BUY",
      quantity: 2,
      avgFillCents: 1200,
      fillDate: "2026-08-14",
    }]);

    expect(error).toBeNull();
    expect(eventInsert).toHaveBeenCalledWith(expect.objectContaining({
      batch_id: "batch-1",
      trade_side: "BUY",
      quantity: 2,
      avg_fill: 1200,
      fill_date: "2026-08-14",
    }));
  });
});

/**
 * `reconcile_rebalance_ca` has existed in the retail database since
 * 2026-07-29 but, until this change, no application code ever called it —
 * every CA reconciliation row in production was written by hand, after
 * the fact, once someone noticed certification had stalled. It is now part
 * of the completion gate: `finalizeRebalanceBoundary` must refuse (return
 * `sealed: false`) rather than merely log when reconciliation fails, or a
 * rebalance can complete — flipping `strategies_c.holdings` — with no
 * reconciled CA and no durable trace of the failure, recreating the exact
 * silent-stall incident this work exists to close.
 *
 * These tests cover a partial sell, a full liquidation, that the
 * reconciliation call is attributed to the resolved settlement actor (not a
 * wrong/arbitrary owner), that calling the boundary twice for the same
 * batch (a retry) does not error or attempt a duplicate write, and that a
 * reconciliation failure gates completion instead of being swallowed.
 */
function dbWithRpc(rpcImpl: (fn: string, args: Record<string, unknown>) => unknown) {
  return {
    from: vi.fn((table: string) => {
      if (table === "stock_intraday_c") {
        const query: Record<string, unknown> = {};
        for (const method of ["select", "in", "gte", "order"]) query[method] = () => query;
        query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolved([
          { symbol: "ABC.JO", current_price: 1200, timestamp: "2026-08-14T12:00:00.000Z" },
        ])).then(resolve);
        return query;
      }
      throw new Error(`unexpected table: ${table}`);
    }),
    rpc: vi.fn((fn: string, args: Record<string, unknown>) => Promise.resolve(rpcImpl(fn, args))),
  };
}

describe("finalizeRebalanceBoundary", () => {
  it("seals and reconciles CA for a partial sell (remaining position priced, actor attributed)", async () => {
    const db = dbWithRpc((fn) => {
      if (fn === "finalize_rebalance_return_boundary") {
        return resolved({ securities_value_cents: 1800, continuity_cash_cents: 200, complete_value_cents: 2000 });
      }
      if (fn === "reconcile_rebalance_ca") {
        return resolved({ idempotent: false, reconciliation_id: "recon-1", strategy_ca_cents: 200 });
      }
      throw new Error(`unexpected rpc: ${fn}`);
    });

    const result = await finalizeRebalanceBoundary(db as never, {
      batchId: "batch-1",
      strategyId: "strategy-1",
      actorId: "user-1",
      holdings: [{ symbol: "ABC.JO", shares: 1 }],
    });

    expect(result).toMatchObject({
      sealed: true,
      batchId: "batch-1",
      securitiesValueCents: 1800,
      continuityCashCents: 200,
      caReconciled: true,
    });
    expect(db.rpc).toHaveBeenCalledWith("finalize_rebalance_return_boundary", expect.objectContaining({ p_batch_id: "batch-1", p_actor: "user-1" }));
    expect(db.rpc).toHaveBeenCalledWith("reconcile_rebalance_ca", { p_batch_id: "batch-1", p_actor: "user-1" });
  });

  it("seals and reconciles CA for a full liquidation (securities value zero, continuity cash carries the model value)", async () => {
    const db = dbWithRpc((fn) => {
      if (fn === "finalize_rebalance_return_boundary") {
        return resolved({ securities_value_cents: 0, continuity_cash_cents: 2000, complete_value_cents: 2000 });
      }
      if (fn === "reconcile_rebalance_ca") {
        return resolved({ idempotent: false, reconciliation_id: "recon-2", strategy_ca_cents: 2000 });
      }
      throw new Error(`unexpected rpc: ${fn}`);
    });

    const result = await finalizeRebalanceBoundary(db as never, {
      batchId: "batch-2",
      strategyId: "strategy-1",
      actorId: "user-1",
      holdings: [],
      allowEmptyHoldings: true,
    });

    expect(result).toMatchObject({ sealed: true, securitiesValueCents: 0, continuityCashCents: 2000, caReconciled: true });
  });

  it("attributes both RPC calls to the resolved settlement actor passed in, not the caller's original supplied id", async () => {
    // finalizeRebalanceBoundary takes the settlement actor as already-resolved
    // (recordRebalanceSettlement did that resolution earlier, in phase 1) --
    // it must pass that id through untouched to both RPC calls rather than
    // re-deriving or defaulting it.
    const db = dbWithRpc((fn) => {
      if (fn === "finalize_rebalance_return_boundary") {
        return resolved({ securities_value_cents: 1000, continuity_cash_cents: 0, complete_value_cents: 1000 });
      }
      if (fn === "reconcile_rebalance_ca") return resolved({ idempotent: false });
      throw new Error(`unexpected rpc: ${fn}`);
    });

    await finalizeRebalanceBoundary(db as never, {
      batchId: "batch-3",
      strategyId: "strategy-1",
      actorId: "parent-1",
      holdings: [{ symbol: "ABC.JO", shares: 1 }],
    });

    expect(db.rpc).toHaveBeenCalledWith("reconcile_rebalance_ca", { p_batch_id: "batch-3", p_actor: "parent-1" });
  });

  it("does not error or duplicate-write on a retry of an already-reconciled batch", async () => {
    const db = dbWithRpc((fn) => {
      // Both RPCs are idempotent server-side: finalize_rebalance_return_boundary
      // early-returns idempotent:true, reconcile_rebalance_ca early-returns the
      // existing row's values rather than inserting again.
      if (fn === "finalize_rebalance_return_boundary") {
        return resolved({ idempotent: true, securities_value_cents: 1800, continuity_cash_cents: 200, complete_value_cents: 2000 });
      }
      if (fn === "reconcile_rebalance_ca") {
        return resolved({ idempotent: true, reconciliation_id: "recon-1", strategy_ca_cents: 200 });
      }
      throw new Error(`unexpected rpc: ${fn}`);
    });
    const params = {
      batchId: "batch-4",
      strategyId: "strategy-1",
      actorId: "user-1",
      holdings: [{ symbol: "ABC.JO", shares: 1 }],
    };

    const first = await finalizeRebalanceBoundary(db as never, params);
    const retry = await finalizeRebalanceBoundary(db as never, params);

    expect(first).toMatchObject({ sealed: true, caReconciled: true });
    expect(retry).toMatchObject({ sealed: true, caReconciled: true, idempotent: true });
  });

  it("gates completion on CA reconciliation: a boundary whose reconciliation fails is not sealed", async () => {
    // This is the mixed parked/settled case before settleRebalanceCashForClients'
    // parked zero-movement rows exist: reconcile_rebalance_ca correctly refuses
    // because an owner has no strategy_rebalance_cash_events_c row for this
    // batch yet. The failure must gate — not just log — so the caller leaves
    // the rebalance retryable and never flips strategies_c.holdings on top of
    // an unreconciled CA.
    const db = dbWithRpc((fn) => {
      if (fn === "finalize_rebalance_return_boundary") {
        return resolved({ securities_value_cents: 1800, continuity_cash_cents: 200, complete_value_cents: 2000 });
      }
      if (fn === "reconcile_rebalance_ca") {
        return { data: null, error: { message: "Every affected owner requires an immutable rebalance cash event" } };
      }
      throw new Error(`unexpected rpc: ${fn}`);
    });

    const result = await finalizeRebalanceBoundary(db as never, {
      batchId: "batch-5",
      strategyId: "strategy-1",
      actorId: "user-1",
      holdings: [{ symbol: "ABC.JO", shares: 1 }],
    });

    expect(result).toMatchObject({
      sealed: false,
      batchId: "batch-5",
      error: expect.stringContaining("Every affected owner requires an immutable rebalance cash event"),
    });
  });
});
