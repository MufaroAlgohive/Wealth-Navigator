import { beforeEach, describe, expect, it, vi } from "vitest";

const settlementMocks = vi.hoisted(() => ({
  sealRebalanceBoundary: vi.fn(),
  recordRebalanceSettlement: vi.fn(),
  recordRebalanceExecutionEvidence: vi.fn(),
}));

vi.mock("@/lib/returns/seal-rebalance-boundary", () => ({
  sealRebalanceBoundary: settlementMocks.sealRebalanceBoundary,
  recordRebalanceSettlement: settlementMocks.recordRebalanceSettlement,
  recordRebalanceExecutionEvidence: settlementMocks.recordRebalanceExecutionEvidence,
}));

import { maybeCompleteRebalance } from "./complete-rebalance";

function chain(result: unknown) {
  const api: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "update"]) api[method] = () => api;
  api.maybeSingle = () => Promise.resolve(result);
  api.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return api;
}

/** rebalance_request_c mock covering both the idempotency claim
 * (.update().eq().eq().select().maybeSingle(), needs a truthy .data) and the
 * release update (.update().eq(), bare-awaited — only .error matters). */
function rebalanceRequestChain(selectResult: { data: unknown; error: null }) {
  const api: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in"]) api[method] = () => api;
  api.update = () => chain({ data: { id: "claimed" }, error: null });
  api.maybeSingle = () => Promise.resolve(selectResult);
  api.then = (resolve: (value: unknown) => unknown) => Promise.resolve(selectResult).then(resolve);
  return api;
}

describe("maybeCompleteRebalance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records execution events for a completed single-client rebalance", async () => {
    settlementMocks.recordRebalanceSettlement.mockResolvedValue({ batchId: "batch-1" });
    settlementMocks.recordRebalanceExecutionEvidence.mockResolvedValue(null);
    const retailDb = {
      from: vi.fn(() => ({ select: () => chain({ data: { id: "strategy-1" }, error: null }) })),
    };
    const institutionalDb = {
      from: vi.fn((table: string) => {
        if (table === "oems_order_audit") {
          return chain({ data: [{ status: "filled", side: "sell", quantity: 1, payload: { user_id: "user-1", security_id: "security-1", filled: 1, lastFillAt: "2026-08-14T12:00:00.000Z" }, result_payload: { avgFillPrice: 1000 } }], error: null });
        }
        return rebalanceRequestChain({ data: { strategy_id: "Strategy Name", affected_investors: { scope: "single_user" }, proposed_composition: [] }, error: null });
      }),
    };

    const outcome = await maybeCompleteRebalance(retailDb as never, institutionalDb as never, "request-1", "actor-1");

    expect(outcome).toMatchObject({ completed: true, scope: "single_user", settlementBatchId: "batch-1" });
    expect(settlementMocks.recordRebalanceExecutionEvidence).toHaveBeenCalledWith(
      retailDb,
      "batch-1",
      [expect.objectContaining({ tradeSide: "SELL", avgFillCents: 1000 })],
    );
  });

  it("takes execution owner scope from the touched holding, not a null payload family id", async () => {
    settlementMocks.recordRebalanceSettlement.mockResolvedValue({ batchId: "batch-child" });
    settlementMocks.recordRebalanceExecutionEvidence.mockResolvedValue(null);
    const retailDb = {
      from: vi.fn((table: string) => {
        if (table === "stock_holdings_c") {
          return chain({
            data: [{ id: "holding-child", user_id: "parent-1", family_member_id: "child-1" }],
            error: null,
          });
        }
        return { select: () => chain({ data: { id: "strategy-1" }, error: null }) };
      }),
    };
    const institutionalDb = {
      from: vi.fn((table: string) => {
        if (table === "oems_order_audit") {
          return chain({
            data: [{
              status: "filled",
              side: "buy",
              quantity: 2,
              payload: {
                holding_id: "holding-child",
                user_id: "parent-1",
                family_member_id: null,
                security_id: "security-1",
                filled: 2,
                lastFillAt: "2026-08-14T12:00:00.000Z",
              },
              result_payload: { avgFillPrice: 1000 },
            }],
            error: null,
          });
        }
        return rebalanceRequestChain({
            data: {
              strategy_id: "Strategy Name",
              affected_investors: { scope: "single_user" },
              proposed_composition: [],
            },
            error: null,
          });
      }),
    };

    const outcome = await maybeCompleteRebalance(
      retailDb as never,
      institutionalDb as never,
      "request-child",
      "actor-1",
    );

    expect(outcome).toMatchObject({ completed: true, scope: "single_user", settlementBatchId: "batch-child" });
    expect(settlementMocks.recordRebalanceSettlement).toHaveBeenCalledWith(
      retailDb,
      expect.objectContaining({
        owners: [{ userId: "parent-1", familyMemberId: "child-1" }],
      }),
    );
    expect(settlementMocks.recordRebalanceExecutionEvidence).toHaveBeenCalledWith(
      retailDb,
      "batch-child",
      [expect.objectContaining({ userId: "parent-1", familyMemberId: "child-1" })],
    );
  });

  it("does not complete a rebalance with no filled execution evidence", async () => {
    const retailDb = { from: vi.fn() };
    const institutionalDb = {
      from: vi.fn(() => ({
        select: () => chain({ data: [{ status: "cancelled", payload: {} }], error: null }),
      })),
    };

    const outcome = await maybeCompleteRebalance(retailDb as never, institutionalDb as never, "request-1", "actor-1");

    expect(outcome).toEqual({ completed: false });
    expect(settlementMocks.sealRebalanceBoundary).not.toHaveBeenCalled();
  });

  it("does not complete until every required order is fully filled", async () => {
    const retailDb = { from: vi.fn() };
    const institutionalDb = {
      from: vi.fn(() =>
        chain({
          data: [
            { status: "filled", quantity: 2, payload: { filled: 2 } },
            { status: "filled", quantity: 3, payload: { filled: 2 } },
          ],
          error: null,
        }),
      ),
    };

    const outcome = await maybeCompleteRebalance(
      retailDb as never,
      institutionalDb as never,
      "request-partial",
      "actor-1",
    );

    expect(outcome).toEqual({ completed: false });
    expect(settlementMocks.recordRebalanceSettlement).not.toHaveBeenCalled();
    expect(settlementMocks.sealRebalanceBoundary).not.toHaveBeenCalled();
  });

  it("never flips model holdings if sealing the return boundary fails", async () => {
    settlementMocks.sealRebalanceBoundary.mockResolvedValue({ sealed: false, error: "missing close" });
    const retailUpdate = vi.fn(() => chain({ data: null, error: null }));
    const retailDb = {
      from: vi.fn((table: string) => {
        if (table === "securities_c") return chain({ data: [{ symbol: "ABC.JO", last_price: 1000 }], error: null });
        if (table === "strategies_c") {
          return {
            select: () => chain({ data: { id: "strategy-1", holdings: [{ symbol: "OLD.JO", shares: 1 }] }, error: null }),
            update: retailUpdate,
          };
        }
        throw new Error(`unexpected retail table: ${table}`);
      }),
    };
    const institutionalDb = {
      from: vi.fn((table: string) => {
        if (table === "oems_order_audit") {
          return chain({
            data: [{
              status: "filled",
              side: "buy",
              quantity: 2,
              payload: {
                user_id: "user-1",
                security_id: "security-1",
                filled: 2,
                lastFillAt: "2026-08-14T12:00:00.000Z",
              },
              result_payload: { avgFillPrice: 1000 },
            }],
            error: null,
          });
        }
        if (table === "rebalance_request_c") {
          return rebalanceRequestChain({
              data: {
                strategy_id: "Strategy Name",
                affected_investors: { scope: "strategy" },
                proposed_composition: [{ ticker: "ABC.JO", shares: 2, action: "increase" }],
              },
              error: null,
            });
        }
        throw new Error(`unexpected institutional table: ${table}`);
      }),
    };

    const outcome = await maybeCompleteRebalance(retailDb as never, institutionalDb as never, "request-1", "actor-1");

    expect(outcome).toMatchObject({ completed: false, error: expect.stringContaining("return boundary not sealed") });
    expect(settlementMocks.sealRebalanceBoundary).toHaveBeenCalledOnce();
    expect(retailUpdate).not.toHaveBeenCalled();
  });
});
