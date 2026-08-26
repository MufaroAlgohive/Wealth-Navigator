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
 * `finalize_rebalance_boundary_and_ca` (retail RPC,
 * supabase/migrations/20260825000003_finalize_rebalance_boundary_and_ca.sql)
 * wraps `finalize_rebalance_return_boundary` and `reconcile_rebalance_ca` in
 * ONE Postgres transaction. That matters, not just for tidiness: the two
 * calls write real financial state (a valuation rule + return-publication
 * audit row for the first, a CA reconciliation row for the second), and
 * calling them as two separate round-trips would leave a real window where
 * the return boundary is durably sealed against the target composition
 * while `strategies_c.holdings` still shows the old one, if reconciliation
 * failed in between — recreating the exact partial-state risk this whole
 * effort exists to close, just moved one step later. `reconcile_rebalance_ca`
 * itself has existed in the retail database since 2026-07-29 (idempotent —
 * an existing row for a batch short-circuits with its stored values, a
 * conflicting one raises) but no application code ever called it until this
 * change, so every CA reconciliation row in production was written by hand,
 * after the fact, once someone noticed certification had stalled.
 *
 * These tests cover a partial sell, a full liquidation, that the wrapper
 * call is attributed to the resolved settlement actor (not a wrong/arbitrary
 * owner), that calling the boundary twice for the same batch (a retry) does
 * not error or attempt a duplicate write, and that a reconciliation failure
 * — surfaced by Postgres as the whole wrapper call failing, since the
 * transaction rolled back — gates completion instead of being swallowed.
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
      if (fn === "finalize_rebalance_boundary_and_ca") {
        return resolved({
          boundary: { securities_value_cents: 1800, continuity_cash_cents: 200, complete_value_cents: 2000 },
          ca: { idempotent: false, reconciliation_id: "recon-1", strategy_ca_cents: 200 },
        });
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
    expect(db.rpc).toHaveBeenCalledWith(
      "finalize_rebalance_boundary_and_ca",
      expect.objectContaining({ p_batch_id: "batch-1", p_actor: "user-1" }),
    );
  });

  it("seals and reconciles CA for a full liquidation (securities value zero, continuity cash carries the model value)", async () => {
    const db = dbWithRpc((fn) => {
      if (fn === "finalize_rebalance_boundary_and_ca") {
        return resolved({
          boundary: { securities_value_cents: 0, continuity_cash_cents: 2000, complete_value_cents: 2000 },
          ca: { idempotent: false, reconciliation_id: "recon-2", strategy_ca_cents: 2000 },
        });
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

  it("attributes the wrapper call to the resolved settlement actor passed in, not a re-derived one", async () => {
    // finalizeRebalanceBoundary takes the settlement actor as already-resolved
    // (recordRebalanceSettlement did that resolution earlier, in phase 1) --
    // it must pass that id through untouched to the RPC rather than
    // re-deriving or defaulting it, since the wrapper attributes BOTH the
    // boundary seal and the CA reconciliation to this one actor.
    const db = dbWithRpc((fn) => {
      if (fn === "finalize_rebalance_boundary_and_ca") {
        return resolved({
          boundary: { securities_value_cents: 1000, continuity_cash_cents: 0, complete_value_cents: 1000 },
          ca: { idempotent: false },
        });
      }
      throw new Error(`unexpected rpc: ${fn}`);
    });

    await finalizeRebalanceBoundary(db as never, {
      batchId: "batch-3",
      strategyId: "strategy-1",
      actorId: "parent-1",
      holdings: [{ symbol: "ABC.JO", shares: 1 }],
    });

    expect(db.rpc).toHaveBeenCalledWith(
      "finalize_rebalance_boundary_and_ca",
      expect.objectContaining({ p_batch_id: "batch-3", p_actor: "parent-1" }),
    );
  });

  it("does not error or duplicate-write on a retry of an already-reconciled batch", async () => {
    const db = dbWithRpc((fn) => {
      // The wrapper's two callees are both idempotent server-side:
      // finalize_rebalance_return_boundary early-returns idempotent:true,
      // reconcile_rebalance_ca early-returns the existing row's values
      // rather than inserting again.
      if (fn === "finalize_rebalance_boundary_and_ca") {
        return resolved({
          boundary: { idempotent: true, securities_value_cents: 1800, continuity_cash_cents: 200, complete_value_cents: 2000 },
          ca: { idempotent: true, reconciliation_id: "recon-1", strategy_ca_cents: 200 },
        });
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

  it("gates completion on CA reconciliation: a wrapper call whose reconciliation fails is not sealed, and nothing is left half-written", async () => {
    // This is the mixed parked/settled case before settleRebalanceCashForClients'
    // parked zero-movement rows exist: reconcile_rebalance_ca correctly refuses
    // because an owner has no strategy_rebalance_cash_events_c row for this
    // batch yet. Because both callees run inside finalize_rebalance_boundary_and_ca's
    // single transaction, that refusal rolls back finalize_rebalance_return_boundary's
    // writes too — Postgres surfaces this as the whole RPC call erroring, not a
    // partial success — so the failure must gate, not just log: the caller
    // leaves the rebalance retryable and never flips strategies_c.holdings on
    // top of a boundary that (from the database's perspective) was never sealed.
    const db = dbWithRpc((fn) => {
      if (fn === "finalize_rebalance_boundary_and_ca") {
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
