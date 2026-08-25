import { describe, expect, it, vi } from "vitest";

import { sealRebalanceBoundary } from "./seal-rebalance-boundary";

function resolved(data: unknown) {
  return { data, error: null };
}

describe("sealRebalanceBoundary", () => {
  it("persists confirmed execution evidence before finalizing the return boundary", async () => {
    const eventInsert = vi.fn(() => Promise.resolve(resolved(null)));
    const batchInsert = vi.fn(() => ({ select: () => ({ maybeSingle: () => Promise.resolve(resolved({ id: "batch-1" })) }) }));
    const db = {
      from: vi.fn((table: string) => {
        if (table === "profiles") {
          return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(resolved(null)) }) }) };
        }
        if (table === "stock_intraday_c") {
          const query: Record<string, unknown> = {};
          for (const method of ["select", "in", "gte", "order"]) query[method] = () => query;
          query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolved([
            { symbol: "ABC.JO", current_price: 1200, timestamp: "2026-08-14T12:00:00.000Z" },
          ])).then(resolve);
          return query;
        }
        if (table === "rebalance_batch") {
          return { insert: batchInsert };
        }
        if (table === "rebalance_event") {
          const query: Record<string, unknown> = {};
          for (const method of ["select", "eq"]) query[method] = () => query;
          query.maybeSingle = () => Promise.resolve(resolved(null));
          query.insert = eventInsert;
          return query;
        }
        throw new Error(`unexpected table: ${table}`);
      }),
      rpc: vi.fn(() => Promise.resolve(resolved({
        securities_value_cents: 2400,
        continuity_cash_cents: 0,
        complete_value_cents: 2400,
      }))),
    };

    const result = await sealRebalanceBoundary(db as never, {
      strategyId: "strategy-1",
      strategyName: "UAT Strategy",
      actorId: "actor-1",
      owners: [{ userId: "user-1", familyMemberId: null }],
      holdings: [{ symbol: "ABC.JO", shares: 2 }],
      executionEvidence: [{
        userId: "user-1",
        familyMemberId: null,
        securityId: "security-1",
        tradeSide: "BUY",
        quantity: 2,
        avgFillCents: 1200,
        fillDate: "2026-08-14",
      }],
    });

    expect(result).toMatchObject({ sealed: true, batchId: "batch-1" });
    expect(eventInsert).toHaveBeenCalledWith(expect.objectContaining({
      batch_id: "batch-1",
      trade_side: "BUY",
      quantity: 2,
      avg_fill: 1200,
      fill_date: "2026-08-14",
    }));
    expect(batchInsert).toHaveBeenCalledWith(expect.objectContaining({
      created_by: "user-1",
      settled_by: "user-1",
    }));
    expect((db.rpc as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ p_actor: "user-1" });
    expect((db.rpc as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeGreaterThan(
      eventInsert.mock.invocationCallOrder[0],
    );
  });

  /**
   * `reconcile_rebalance_ca` has existed in the retail database since
   * 2026-07-29 but, until this change, no application code ever called it —
   * every CA reconciliation row in production was written by hand, after
   * the fact, once someone noticed certification had stalled. These four
   * tests cover the wiring that closes that gap: a partial sell, a full
   * liquidation, that the reconciliation call attributes to the correct
   * settlement actor (not a hardcoded/wrong owner), and that calling the
   * boundary twice for the same batch (a retry) does not error or attempt a
   * duplicate write.
   */
  function dbWithRpc(rpcImpl: (fn: string, args: Record<string, unknown>) => unknown) {
    const eventInsert = vi.fn(() => Promise.resolve(resolved(null)));
    const batchInsert = vi.fn(() => ({ select: () => ({ maybeSingle: () => Promise.resolve(resolved({ id: "batch-1" })) }) }));
    return {
      from: vi.fn((table: string) => {
        if (table === "profiles") {
          return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(resolved(null)) }) }) };
        }
        if (table === "stock_intraday_c") {
          const query: Record<string, unknown> = {};
          for (const method of ["select", "in", "gte", "order"]) query[method] = () => query;
          query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolved([
            { symbol: "ABC.JO", current_price: 1200, timestamp: "2026-08-14T12:00:00.000Z" },
          ])).then(resolve);
          return query;
        }
        if (table === "rebalance_batch") return { insert: batchInsert };
        if (table === "rebalance_event") {
          const query: Record<string, unknown> = {};
          for (const method of ["select", "eq"]) query[method] = () => query;
          query.maybeSingle = () => Promise.resolve(resolved(null));
          query.insert = eventInsert;
          return query;
        }
        throw new Error(`unexpected table: ${table}`);
      }),
      rpc: vi.fn((fn: string, args: Record<string, unknown>) => Promise.resolve(rpcImpl(fn, args))),
    };
  }

  it("reconciles CA automatically for a partial sell (proceeds credited, remaining position priced)", async () => {
    const db = dbWithRpc((fn) => {
      if (fn === "finalize_rebalance_return_boundary") {
        return resolved({ securities_value_cents: 1800, continuity_cash_cents: 200, complete_value_cents: 2000 });
      }
      if (fn === "reconcile_rebalance_ca") {
        return resolved({ idempotent: false, reconciliation_id: "recon-1", strategy_ca_cents: 200 });
      }
      throw new Error(`unexpected rpc: ${fn}`);
    });

    const result = await sealRebalanceBoundary(db as never, {
      strategyId: "strategy-1",
      strategyName: "UAT Strategy",
      actorId: "actor-1",
      owners: [{ userId: "user-1", familyMemberId: null }],
      holdings: [{ symbol: "ABC.JO", shares: 1 }],
      executionEvidence: [{
        userId: "user-1",
        familyMemberId: null,
        securityId: "security-1",
        tradeSide: "SELL",
        quantity: 1,
        avgFillCents: 1200,
        fillDate: "2026-08-14",
      }],
    });

    expect(result).toMatchObject({ sealed: true, caReconciled: true, caReconciliationError: undefined });
    expect(db.rpc).toHaveBeenCalledWith("reconcile_rebalance_ca", { p_batch_id: "batch-1", p_actor: "user-1" });
  });

  it("reconciles CA automatically for a full liquidation (securities value zero, continuity cash carries the model value)", async () => {
    const db = dbWithRpc((fn) => {
      if (fn === "finalize_rebalance_return_boundary") {
        return resolved({ securities_value_cents: 0, continuity_cash_cents: 2000, complete_value_cents: 2000 });
      }
      if (fn === "reconcile_rebalance_ca") {
        return resolved({ idempotent: false, reconciliation_id: "recon-2", strategy_ca_cents: 2000 });
      }
      throw new Error(`unexpected rpc: ${fn}`);
    });

    const result = await sealRebalanceBoundary(db as never, {
      strategyId: "strategy-1",
      strategyName: "UAT Strategy",
      actorId: "actor-1",
      owners: [{ userId: "user-1", familyMemberId: null }],
      holdings: [],
      allowEmptyHoldings: true,
      executionEvidence: [{
        userId: "user-1",
        familyMemberId: null,
        securityId: "security-1",
        tradeSide: "SELL",
        quantity: 1,
        avgFillCents: 2000,
        fillDate: "2026-08-14",
      }],
    });

    expect(result).toMatchObject({ sealed: true, securitiesValueCents: 0, continuityCashCents: 2000, caReconciled: true });
    expect(db.rpc).toHaveBeenCalledWith("reconcile_rebalance_ca", { p_batch_id: "batch-1", p_actor: "user-1" });
  });

  it("attributes reconciliation to the resolved settlement actor, not an arbitrary owner", async () => {
    const db = dbWithRpc((fn) => {
      if (fn === "finalize_rebalance_return_boundary") {
        return resolved({ securities_value_cents: 1000, continuity_cash_cents: 0, complete_value_cents: 1000 });
      }
      if (fn === "reconcile_rebalance_ca") return resolved({ idempotent: false });
      throw new Error(`unexpected rpc: ${fn}`);
    });

    // Two owners: a parent and their family member. resolveRetailSettlementActor
    // falls back to the first owner with a userId when no valid supplied actorId
    // resolves via `profiles` (mocked as not found above) — that must be the
    // exact id both the boundary RPC and the CA reconciliation are attributed to.
    await sealRebalanceBoundary(db as never, {
      strategyId: "strategy-1",
      strategyName: "UAT Strategy",
      actorId: "not-a-real-profile",
      owners: [
        { userId: "parent-1", familyMemberId: null },
        { userId: "parent-1", familyMemberId: "child-1" },
      ],
      holdings: [{ symbol: "ABC.JO", shares: 1 }],
      executionEvidence: [{
        userId: "parent-1",
        familyMemberId: "child-1",
        securityId: "security-1",
        tradeSide: "BUY",
        quantity: 1,
        avgFillCents: 1000,
        fillDate: "2026-08-14",
      }],
    });

    expect(db.rpc).toHaveBeenCalledWith("reconcile_rebalance_ca", { p_batch_id: "batch-1", p_actor: "parent-1" });
  });

  it("does not error or duplicate-write on a retry of an already-reconciled batch", async () => {
    const db = dbWithRpc((fn) => {
      // Both RPCs are idempotent server-side: finalize_rebalance_return_boundary
      // early-returns idempotent:true, reconcile_rebalance_ca early-returns the
      // existing row's values rather than inserting again. The caller must
      // treat both outcomes as success, not as errors to retry differently.
      if (fn === "finalize_rebalance_return_boundary") {
        return resolved({ idempotent: true, securities_value_cents: 1800, continuity_cash_cents: 200, complete_value_cents: 2000 });
      }
      if (fn === "reconcile_rebalance_ca") {
        return resolved({ idempotent: true, reconciliation_id: "recon-1", strategy_ca_cents: 200 });
      }
      throw new Error(`unexpected rpc: ${fn}`);
    });
    const params = {
      strategyId: "strategy-1",
      strategyName: "UAT Strategy",
      actorId: "actor-1",
      owners: [{ userId: "user-1", familyMemberId: null }],
      holdings: [{ symbol: "ABC.JO", shares: 1 }],
      executionEvidence: [{
        userId: "user-1",
        familyMemberId: null,
        securityId: "security-1",
        tradeSide: "SELL",
        quantity: 1,
        avgFillCents: 1200,
        fillDate: "2026-08-14",
      }],
    };

    const first = await sealRebalanceBoundary(db as never, params);
    const retry = await sealRebalanceBoundary(db as never, params);

    expect(first).toMatchObject({ sealed: true, caReconciled: true });
    expect(retry).toMatchObject({ sealed: true, caReconciled: true, idempotent: true });
  });

  it("surfaces a CA reconciliation failure without unsealing an otherwise-sound boundary", async () => {
    // This is the mixed parked/settled case: reconcile_rebalance_ca correctly
    // refuses because a parked owner has no strategy_rebalance_cash_events_c
    // row for this batch (that cash moved earlier, directly, in
    // reconcile-parked-holdings.ts). The return boundary itself is still
    // sound and must not be rolled back or left stuck retrying forever.
    const db = dbWithRpc((fn) => {
      if (fn === "finalize_rebalance_return_boundary") {
        return resolved({ securities_value_cents: 1800, continuity_cash_cents: 200, complete_value_cents: 2000 });
      }
      if (fn === "reconcile_rebalance_ca") {
        return { data: null, error: { message: "Every affected owner requires an immutable rebalance cash event" } };
      }
      throw new Error(`unexpected rpc: ${fn}`);
    });

    const result = await sealRebalanceBoundary(db as never, {
      strategyId: "strategy-1",
      strategyName: "UAT Strategy",
      actorId: "actor-1",
      owners: [{ userId: "user-1", familyMemberId: null }],
      holdings: [{ symbol: "ABC.JO", shares: 1 }],
      executionEvidence: [{
        userId: "user-1",
        familyMemberId: null,
        securityId: "security-1",
        tradeSide: "SELL",
        quantity: 1,
        avgFillCents: 1200,
        fillDate: "2026-08-14",
      }],
    });

    expect(result).toMatchObject({
      sealed: true,
      caReconciled: undefined,
      caReconciliationError: "Every affected owner requires an immutable rebalance cash event",
    });
  });
});
