import { beforeEach, describe, expect, it, vi } from "vitest";

const settlementMocks = vi.hoisted(() => ({
  finalizeRebalanceBoundary: vi.fn(),
  recordRebalanceSettlement: vi.fn(),
  recordRebalanceExecutionEvidence: vi.fn(),
}));
const cashMocks = vi.hoisted(() => ({
  settleRebalanceCashForClients: vi.fn(),
}));

vi.mock("@/lib/returns/seal-rebalance-boundary", () => ({
  finalizeRebalanceBoundary: settlementMocks.finalizeRebalanceBoundary,
  recordRebalanceSettlement: settlementMocks.recordRebalanceSettlement,
  recordRebalanceExecutionEvidence: settlementMocks.recordRebalanceExecutionEvidence,
}));
vi.mock("@/lib/rebalance/settle-rebalance-cash", () => ({
  settleRebalanceCashForClients: cashMocks.settleRebalanceCashForClients,
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
function rebalanceRequestChain(
  selectResult: { data: unknown; error: null },
  state = { status: "completing", completion_batch_id: "batch-1" },
  onUpdate?: (value: unknown) => void,
) {
  const api: Record<string, unknown> = {};
  let selected = "";
  api.select = (columns: string) => {
    selected = columns;
    return api;
  };
  for (const method of ["eq", "in"]) api[method] = () => api;
  api.update = (value: unknown) => {
    onUpdate?.(value);
    return chain({ data: { id: "claimed", completion_batch_id: state.completion_batch_id }, error: null });
  };
  api.maybeSingle = () => Promise.resolve(selected.includes("completion_batch_id") ? { data: state, error: null } : selectResult);
  api.then = (resolve: (value: unknown) => unknown) => Promise.resolve(selectResult).then(resolve);
  return api;
}

describe("maybeCompleteRebalance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cashMocks.settleRebalanceCashForClients.mockResolvedValue({ settledUserIds: [], errors: [] });
  });

  it("records execution events for a completed single-client rebalance", async () => {
    settlementMocks.recordRebalanceSettlement.mockResolvedValue({ batchId: "batch-1" });
    settlementMocks.recordRebalanceExecutionEvidence.mockResolvedValue(null);
    const retailDb = {
      from: vi.fn(() => ({ select: () => chain({ data: { id: "strategy-1" }, error: null }) })),
    };
    const updates: Array<Record<string, unknown>> = [];
    const institutionalDb = {
      from: vi.fn((table: string) => {
        if (table === "oems_order_audit") {
          return chain({ data: [{ status: "filled", side: "sell", quantity: 1, payload: { user_id: "user-1", security_id: "security-1", filled: 1, lastFillAt: "2026-08-14T12:00:00.000Z" }, result_payload: { avgFillPrice: 1000 } }], error: null });
        }
        return rebalanceRequestChain(
          { data: { strategy_id: "Strategy Name", affected_investors: { scope: "single_user" }, proposed_composition: [] }, error: null },
          { status: "executed", completion_batch_id: "batch-1" },
          (value) => updates.push(value as Record<string, unknown>),
        );
      }),
    };

    const outcome = await maybeCompleteRebalance(retailDb as never, institutionalDb as never, "request-1", "actor-1");

    expect(outcome).toMatchObject({ completed: true, scope: "single_user", settlementBatchId: "batch-1" });
    expect(updates).toContainEqual(expect.objectContaining({ status: "completing", completion_batch_id: "batch-1" }));
    expect(updates).toContainEqual(expect.objectContaining({ status: "completed" }));
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
          }, { status: "completing", completion_batch_id: "batch-child" });
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
    expect(settlementMocks.finalizeRebalanceBoundary).not.toHaveBeenCalled();
  });

  it("keeps the request completing when cash settlement fails", async () => {
    settlementMocks.recordRebalanceSettlement.mockResolvedValue({ batchId: "batch-1" });
    settlementMocks.recordRebalanceExecutionEvidence.mockResolvedValue(null);
    cashMocks.settleRebalanceCashForClients.mockResolvedValue({
      settledUserIds: [],
      errors: ["insufficient reserve"],
    });
    const updates: Array<Record<string, unknown>> = [];
    const retailDb = {
      from: vi.fn(() => ({ select: () => chain({ data: { id: "strategy-1" }, error: null }) })),
    };
    const institutionalDb = {
      from: vi.fn((table: string) => {
        if (table === "oems_order_audit") {
          return chain({ data: [{ status: "filled", side: "sell", quantity: 1, payload: { user_id: "user-1", security_id: "security-1", filled: 1, lastFillAt: "2026-08-14T12:00:00.000Z" }, result_payload: { avgFillPrice: 1000 } }], error: null });
        }
        return rebalanceRequestChain(
          { data: { strategy_id: "Strategy Name", affected_investors: { scope: "single_user" }, proposed_composition: [] }, error: null },
          { status: "completing", completion_batch_id: "batch-1" },
          (value) => updates.push(value as Record<string, unknown>),
        );
      }),
    };

    const outcome = await maybeCompleteRebalance(retailDb as never, institutionalDb as never, "request-1", "actor-1");

    expect(outcome).toMatchObject({ completed: false, error: expect.stringContaining("cash settlement failed") });
    expect(updates).toContainEqual(expect.objectContaining({ completion_error: expect.stringContaining("insufficient reserve") }));
    expect(updates).not.toContainEqual(expect.objectContaining({ status: "completed" }));
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
    expect(settlementMocks.finalizeRebalanceBoundary).not.toHaveBeenCalled();
  });

  it("never flips model holdings if sealing the return boundary (or its CA reconciliation) fails", async () => {
    settlementMocks.recordRebalanceSettlement.mockResolvedValue({ batchId: "batch-1", actorId: "user-1" });
    settlementMocks.recordRebalanceExecutionEvidence.mockResolvedValue(null);
    settlementMocks.finalizeRebalanceBoundary.mockResolvedValue({ sealed: false, error: "missing close" });
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
    expect(settlementMocks.finalizeRebalanceBoundary).toHaveBeenCalledOnce();
    expect(retailUpdate).not.toHaveBeenCalled();
  });

  it("runs cash settlement before boundary finalization, and does not finalize a strategy-wide rebalance if it fails", async () => {
    settlementMocks.recordRebalanceSettlement.mockResolvedValue({ batchId: "batch-1", actorId: "user-1" });
    settlementMocks.recordRebalanceExecutionEvidence.mockResolvedValue(null);
    cashMocks.settleRebalanceCashForClients.mockResolvedValue({ settledUserIds: [], errors: ["insufficient reserve"] });
    const retailDb = {
      from: vi.fn((table: string) => {
        if (table === "securities_c") return chain({ data: [{ symbol: "ABC.JO", last_price: 1000 }], error: null });
        if (table === "strategies_c") {
          return { select: () => chain({ data: { id: "strategy-1", holdings: [] }, error: null }) };
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
              payload: { user_id: "user-1", security_id: "security-1", filled: 2, lastFillAt: "2026-08-14T12:00:00.000Z" },
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

    expect(outcome).toMatchObject({ completed: false, error: expect.stringContaining("cash settlement failed") });
    expect(settlementMocks.finalizeRebalanceBoundary).not.toHaveBeenCalled();
    const cashCallOrder = cashMocks.settleRebalanceCashForClients.mock.invocationCallOrder[0];
    const recordCallOrder = settlementMocks.recordRebalanceSettlement.mock.invocationCallOrder[0];
    expect(cashCallOrder).toBeGreaterThan(recordCallOrder);
  });
});
