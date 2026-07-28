import { describe, expect, it } from "vitest";

/**
 * BFF `/api/admin/orderbook/uat-order` — the UAT ad-hoc order tester.
 *
 * 2026-07-28: UAT orders NEVER reach the broker. A UAT order parks in the OEM
 * (zero worker/IRESS/preflight contact) and is self-filled via
 * /api/admin/orderbook/fills — the "fill from us" model. These tests assert
 * that contract: a UAT order writes exactly one parked audit row and makes NO
 * worker call, for buys, sells, and even an oversized sell (which used to be
 * naked-short-blocked at the broker preflight — there is no broker preflight
 * for UAT any more).
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

describe("POST /api/admin/orderbook/uat-order — self-fill, never the broker", () => {
  it("parks a UAT buy with ZERO worker/broker contact", async () => {
    const res = await POST(
      new Request("http://localhost/api/admin/orderbook/uat-order", {
        method: "POST",
        body: JSON.stringify({ symbol: "SOL", side: "buy", qty: 50, price: 177 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("parked");
    expect(body.iressOrderNumber ?? null).toBeNull();
    // Exactly one parked audit row, and the worker was NEVER called.
    expect(insertedRows.length).toBe(1);
    expect(lastWorkerCall).toBeNull();
  });

  it("parks even an oversized sell — no broker naked-short preflight for UAT", async () => {
    // 150 sell vs a notional 100 held would have been naked-short-blocked (422)
    // under the old broker preflight. UAT self-fills, so it just parks.
    const res = await POST(
      new Request("http://localhost/api/admin/orderbook/uat-order", {
        method: "POST",
        body: JSON.stringify({ symbol: "SOL", side: "sell", qty: 150, price: 177 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("parked");
    expect(insertedRows.length).toBe(1);
    // Never preflighted against the broker, never dispatched.
    expect(lastWorkerCall).toBeNull();
  });

  it("never calls /uat/send-to-market for a UAT order", async () => {
    await POST(
      new Request("http://localhost/api/admin/orderbook/uat-order", {
        method: "POST",
        body: JSON.stringify({ symbol: "SOL", side: "buy", qty: 10, price: 100 }),
      }),
    );
    expect(lastWorkerCall).toBeNull();
  });
});
