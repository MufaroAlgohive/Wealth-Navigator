import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `src/lib/orders/submit.ts` — the shared order-submission core.
 *
 * 2026-07-20 regression coverage:
 *   - A blocked preflight returns `{ ok: false, preflight }` with NO
 *     audit row written. This is the entire point of moving the guard
 *     in front of the INSERT.
 *   - On pass, the audit row is written with the typed
 *     `broker_account_code` column stamped AND the worker fan-out fires.
 *   - On a post-insert worker rejection, the audit row is stamped
 *     `rejected` with `result_payload.rejectReason` so the UI flips off
 *     WORKING immediately.
 */

const insertedRows: Array<Record<string, unknown>> = [];
const auditUpdateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];
const workerResponses: Array<{ ok: boolean; body?: unknown; errorBody?: unknown; error?: string }> = [];
const preflightQueue: Array<unknown> = [];

vi.mock("@/lib/supabase/server", () => ({
  createRetailServiceRoleClient: () => ({
    from(_t: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.in = chain;
      // `securities_c` lookup: return a row so the symbol resolves.
      builder.maybeSingle = () =>
        Promise.resolve({
          data: { id: "sec-1", symbol: "SOL", name: "Sasol", isin: null, last_price: 17_700 },
          error: null,
        });
      // `await supabase.from("securities_c").select(...).in(...)` resolves
      // via the builder's `then` so we can return data without a
      // terminal `maybeSingle()`.
      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: [{ id: "sec-1", symbol: "SOL", name: "Sasol", isin: null, last_price: 17_700 }],
          error: null,
        }).then(resolve);
      return builder;
    },
  }),
  createInstitutionalServiceRoleClient: () => ({
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.in = chain;
      builder.maybeSingle = () => Promise.resolve({ data: null, error: null });
      builder.insert = (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        const arr = Array.isArray(rows) ? rows : [rows];
        const next = arr.map((r, idx) => ({
          id: `audit-${insertedRows.length + idx + 1}`,
          ...r,
        }));
        insertedRows.push(...next);
        return {
          select: () => ({
            maybeSingle: () => Promise.resolve({ data: next[0], error: null }),
          }),
        };
      };
      builder.update = (patch: Record<string, unknown>) => ({
        eq: (col: string, val: string) => {
          auditUpdateCalls.push({ id: val, patch });
          return Promise.resolve({ data: null, error: null });
        },
      });
      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve);
      return builder;
    },
  }),
}));

vi.mock("@/lib/iress/worker-api", async () => {
  return {
    callWorker: async (_opts: { path: string; body: unknown }) => {
      const next = workerResponses.shift();
      if (!next)
        return { ok: true, status: 200, body: { ok: true, iressOrderNumber: "ORD-1", status: "working" } };
      if (next.ok) return { ok: true, status: 200, body: next.body };
      return {
        ok: false,
        status: 503,
        code: "upstream_error",
        error: next.error ?? "worker down",
        errorBody: next.errorBody,
      };
    },
  };
});

vi.mock("@/lib/orders/preflight", async () => {
  return {
    preflight: async (_input: unknown) => {
      const next = preflightQueue.shift();
      if (next) return next;
      return {
        ok: true,
        verdict: "pass",
        code: "pass",
        message: "default pass",
      };
    },
  };
});

const { openSupabaseClients, submitOrder, preflight } = await import("../lib/orders");

beforeEach(() => {
  insertedRows.length = 0;
  auditUpdateCalls.length = 0;
  workerResponses.length = 0;
  preflightQueue.length = 0;
  // submitOrder short-circuits the worker fan-out when neither URL is
  // set; configure it so the tests exercise the real fan-out branch.
  process.env.IRESS_WORKER_URL = "http://mock-worker.local";
});

describe("submitOrder", () => {
  it("blocks BEFORE inserting when the preflight says naked_short", async () => {
    preflightQueue.push({
      ok: false,
      verdict: "blocked_naked_short",
      code: "naked_short_blocked",
      message: "Sell blocked: 150 SOL exceeds available-to-sell 100",
      sell: { held: 100, inflight_sells: 0, available: 100, source: "ips", note: "IPS" },
    });
    const clients = await openSupabaseClients();
    const r = await submitOrder(clients, {
      account_code: "56378",
      symbol: "SOL",
      side: "sell",
      qty: 150,
      price_cents: 17_700,
      source: "BLOTTER_NEW_ORDER",
      trader_email: "trader@mint.local",
    });
    expect(r.ok).toBe(false);
    expect(r.preflight.code).toBe("naked_short_blocked");
    expect(r.order_audit_id).toBeUndefined();
    expect(insertedRows).toEqual([]);
  });

  it("writes the audit row + fans out on a passing preflight", async () => {
    preflightQueue.push({
      ok: true,
      verdict: "pass",
      code: "pass",
      message: "ok",
    });
    workerResponses.push({ ok: true, body: { ok: true, iressOrderNumber: "ORD-42", status: "working" } });
    const clients = await openSupabaseClients();
    const r = await submitOrder(clients, {
      account_code: "56378",
      symbol: "SOL",
      side: "buy",
      qty: 100,
      price_cents: 17_700,
      source: "BLOTTER_NEW_ORDER",
      trader_email: "trader@mint.local",
    });
    expect(r.ok).toBe(true);
    expect(r.iress_order_number).toBe("ORD-42");
    expect(r.status).toBe("working");
    expect(insertedRows.length).toBe(1);
    const row = insertedRows[0]!;
    expect(row.broker_account_code).toBe("56378");
    expect((row.payload as { broker_account_code?: string })?.broker_account_code).toBe("56378");
  });

  it("stamps 'rejected' on a post-insert worker reject (race condition)", async () => {
    preflightQueue.push({
      ok: true,
      verdict: "pass",
      code: "pass",
      message: "ok",
    });
    workerResponses.push({
      ok: false,
      errorBody: {
        ok: false,
        code: "order_rejected",
        message: "OrderCreate3 rejected by broker (25014): Not entitled",
      },
    });
    const clients = await openSupabaseClients();
    const r = await submitOrder(clients, {
      account_code: "56378",
      symbol: "SOL",
      side: "sell",
      qty: 50,
      price_cents: 17_700,
      source: "BLOTTER_NEW_ORDER",
      trader_email: "trader@mint.local",
    });
    expect(r.ok).toBe(false);
    expect(r.order_audit_id).toBeDefined();
    expect(r.worker_code).toBe("order_rejected");
    expect(auditUpdateCalls.length).toBe(1);
    expect(auditUpdateCalls[0]?.patch.status).toBe("rejected");
    expect((auditUpdateCalls[0]?.patch.result_payload as { rejectReason?: string })?.rejectReason).toMatch(
      /Not entitled/,
    );
  });
});

describe("preflight (lib/orders)", () => {
  it("returns the configured mock result", async () => {
    preflightQueue.push({
      ok: false,
      verdict: "blocked_naked_short",
      code: "naked_short_blocked",
      message: "Sell blocked",
      sell: { held: 100, inflight_sells: 0, available: 100, source: "ips", note: "IPS" },
    });
    const r = await preflight({
      account_code: "56378",
      symbol: "SOL",
      side: "sell",
      qty: 150,
      source: "UAT_ADHOC_ORDER",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("naked_short_blocked");
  });
});

describe("openSupabaseClients", () => {
  it("returns both retail and institutional clients", async () => {
    const clients = await openSupabaseClients();
    expect(clients.retail).toBeDefined();
    expect(clients.institutional).toBeDefined();
    expect(typeof clients.retail.from).toBe("function");
    expect(typeof clients.institutional.from).toBe("function");
  });
});
