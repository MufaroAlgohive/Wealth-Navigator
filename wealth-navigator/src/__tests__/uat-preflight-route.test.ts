import { describe, expect, it } from "vitest";

/**
 * BFF `/api/admin/orderbook/uat-order` — the UAT ad-hoc order tester.
 *
 * 2026-07-20 regression coverage:
 *   - The route runs a preflight BEFORE inserting the audit row, so a
 *     blocked verdict (e.g. naked-short on 150/100) returns 422 and the
 *     audit table is unchanged.
 *   - On pass, the audit row is written with the typed
 *     `broker_account_code` column stamped, the worker is fanned out to,
 *     and the resulting order number is returned.
 *
 * These tests stub both the worker `callWorker()` and the Supabase
 * client so they run hermetically without a Railway connection.
 */

// The route imports `@/lib/orders` which transitively imports
// `createInstitutionalServiceRoleClient` from `@/lib/supabase/server` —
// stub that first so the route module loads cleanly without env vars.
import { beforeEach } from "vitest";

import { vi } from "vitest";

interface InsertedRow {
  id: string;
  order_id: string;
}

let insertedRows: InsertedRow[] = [];
let auditUpdateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];
let workerResponses: Array<{ ok: boolean; body?: unknown; errorBody?: unknown; error?: string }> = [];
let lastWorkerCall: { path: string; body: unknown } | null = null;
let preflightResults: Array<unknown> = [];

// Stub `@/lib/supabase/server` so the Supabase env isn't required.
vi.mock("@/lib/supabase/server", () => ({
  createInstitutionalServiceRoleClient: () => ({
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.in = chain;
      builder.maybeSingle = () =>
        Promise.resolve(
          table === "securities_c"
            ? {
                data: { id: "sec-1", symbol: "SOL", name: "Sasol", isin: null, last_price: 17_700 },
                error: null,
              }
            : { data: null, error: null },
        );
      builder.then = (resolve: (v: unknown) => unknown) => {
        const v =
          table === "oems_order_audit" ? { data: insertedRows, error: null } : { data: [], error: null };
        return Promise.resolve(v).then(resolve);
      };
      builder.insert = (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        const arr = Array.isArray(rows) ? rows : [rows];
        const next = arr.map((r, idx) => ({
          id: `audit-${insertedRows.length + idx + 1}`,
          order_id: (r as { order_id?: string }).order_id ?? `ord-${idx}`,
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
      return builder;
    },
  }),
  createRetailServiceRoleClient: () => ({
    from(_t: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.in = chain;
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
}));

vi.mock("@/lib/admin/rbac", () => ({
  can: () => true,
  getAdminContext: async () => ({
    status: "ok" as const,
    ctx: {
      email: "trader@mint.local",
      fullName: "Trader",
      role: "admin" as const,
      pageAccess: ["orderbook"],
      approverTier: "dev" as const,
      permissions: { orderbook: { send_to_market: true } },
    },
  }),
}));

vi.mock("@/lib/iress/worker-api", async () => {
  return {
    callWorker: async (opts: { path: string; body: unknown }) => {
      lastWorkerCall = { path: opts.path, body: opts.body };
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

vi.mock("@/lib/data-policy", () => ({
  isIressWorkerConfigured: () => true,
}));

// Mock the core preflight so the route's explicit preflight call and
// submitOrder's internal one both return the test-configured result
// instead of running the worker's /uat/preflight twice. The latter still
// runs via callWorker mocks for send-to-market.
vi.mock("@/lib/orders/preflight", async () => {
  return {
    preflight: async (_input: unknown) => {
      const next = preflightResults.shift();
      if (next) return next;
      return { ok: true, verdict: "pass", code: "pass", message: "default pass" };
    },
  };
});

// IRESS_UAT_MODE must be on for the route to accept the request.
beforeEach(() => {
  process.env.IRESS_UAT_MODE = "true";
  process.env.IRESS_ACCOUNT_CODE = "56378";
  process.env.IRESS_WORKER_URL = "http://mock-worker.local";
  insertedRows = [];
  auditUpdateCalls = [];
  workerResponses = [];
  preflightResults = [];
  lastWorkerCall = null;
});

// Import AFTER vi.mock so the mocked modules are bound.
const { POST } = await import("../app/api/admin/orderbook/uat-order/route");

describe("POST /api/admin/orderbook/uat-order — preflight gate", () => {
  it("returns 422 and writes NO audit row when the worker blocks the sell (naked short)", async () => {
    preflightResults = [
      // The route's explicit preflight returns blocked.
      {
        ok: false,
        verdict: "blocked_naked_short",
        code: "naked_short_blocked",
        message:
          "Sell blocked: 150 SOL exceeds available-to-sell 100 on account 56378 — held 100, 0 in open sells (IPS settled position 100).",
        sell: {
          held: 100,
          inflight_sells: 0,
          available: 100,
          source: "ips",
          note: "IPS settled position 100",
        },
      },
    ];
    const res = await POST(
      new Request("http://localhost/api/admin/orderbook/uat-order", {
        method: "POST",
        body: JSON.stringify({ symbol: "SOL", side: "sell", qty: 150, price: 177 }),
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("naked_short_blocked");
    expect(body.preflight?.verdict).toBe("blocked_naked_short");
    expect(body.preflight?.sell?.available).toBe(100);
    // The route calls preflight explicitly (and submitOrder internally);
    // either way the audit table MUST be empty here.
    expect(insertedRows).toEqual([]);
  });

  it("writes one audit row + fans out to /uat/send-to-market on a passing preflight", async () => {
    preflightResults = [
      // Route's explicit preflight: pass.
      { ok: true, verdict: "pass", code: "pass", message: "ok" },
      // submitOrder's internal preflight (still mocked): pass.
      { ok: true, verdict: "pass", code: "pass", message: "ok" },
    ];
    workerResponses = [
      // /uat/send-to-market response: ok with OrderNumber.
      { ok: true, body: { ok: true, iressOrderNumber: "ORD-1", status: "working" } },
    ];
    const res = await POST(
      new Request("http://localhost/api/admin/orderbook/uat-order", {
        method: "POST",
        body: JSON.stringify({ symbol: "SOL", side: "buy", qty: 50, price: 177 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.iressOrderNumber).toBe("ORD-1");
    expect(body.orderAuditId).toBeDefined();
    // Exactly one audit row inserted.
    expect(insertedRows.length).toBe(1);
    // The send-to-market call carried the audit id.
    expect(lastWorkerCall?.path).toBe("/uat/send-to-market");
    const sendBody = (lastWorkerCall?.body ?? {}) as { order_audit_id?: string };
    expect(sendBody.order_audit_id).toBe(insertedRows[0]?.id);
  });

  it("stamps the audit row 'rejected' when the worker fan-out fails post-insert", async () => {
    preflightResults = [
      { ok: true, verdict: "pass", code: "pass", message: "ok" },
      { ok: true, verdict: "pass", code: "pass", message: "ok" },
    ];
    workerResponses = [
      // Fan-out fails: worker rejects AFTER we wrote the row (e.g. race).
      {
        ok: false,
        errorBody: {
          ok: false,
          message: "OrderCreate3 rejected by broker (25014): Not entitled",
          code: "order_rejected",
        },
      },
    ];
    const res = await POST(
      new Request("http://localhost/api/admin/orderbook/uat-order", {
        method: "POST",
        body: JSON.stringify({ symbol: "SOL", side: "sell", qty: 50, price: 177 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe("rejected");
    expect(body.code).toBe("order_rejected");
    expect(body.error).toMatch(/Not entitled/);
    expect(auditUpdateCalls.length).toBe(1);
    expect(auditUpdateCalls[0]?.patch.status).toBe("rejected");
    expect(
      (auditUpdateCalls[0]?.patch.result_payload as { rejectReason?: string } | undefined)?.rejectReason,
    ).toMatch(/Not entitled/);
  });
});
