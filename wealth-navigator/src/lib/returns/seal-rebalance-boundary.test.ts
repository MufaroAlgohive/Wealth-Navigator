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
});
