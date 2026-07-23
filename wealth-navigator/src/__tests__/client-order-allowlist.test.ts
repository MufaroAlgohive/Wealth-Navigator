import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 2026-07-23: POST /api/admin/orderbook/client-order no longer gates
 * parking on IRESS_UAT_MODE or a test/UAT-account check (the "CLIENT-DATA
 * GUARD" + allowlist this file used to test) — those checks were silently
 * dropping real clients' orders before they ever reached the order book.
 * The route now parks every client order (real or test) with zero broker
 * contact; the real safety boundary moved to release-to-market/route.ts's
 * RBAC-gated "Send to Market" click. These tests confirm parking now
 * succeeds unconditionally, regardless of the holding owner's test status.
 */

vi.mock("@/lib/admin/rbac", () => ({
  getAdminContext: async () => ({ status: "no-session" }),
}));

const ORIGINAL_ENV = { ...process.env };

function makeMockSupabase(opts: { holdingUserId: string }) {
  const client = {
    from: (table: string) => {
      const obj: Record<string, unknown> = {};
      if (table === "oems_order_audit") {
        // Idempotency check: no existing row for this holding_id.
        obj.select = () => obj;
        obj.eq = () => obj;
        obj.limit = () => obj;
        obj.maybeSingle = async () => ({ data: null, error: null });
        return obj;
      }
      if (table === "stock_holdings_c") {
        obj.select = () => obj;
        obj.eq = () => obj;
        obj.maybeSingle = async () => ({ data: { id: "holding-1" }, error: null });
        return obj;
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return client;
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.resetModules();
});

const REAL_USER_ID = "be89ac8b-d6ed-4cc2-a314-8c6fe34d2a68";

async function postClientOrder() {
  const { POST } = await import("@/app/api/admin/orderbook/client-order/route");
  return POST(
    new Request("http://x/client-order", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
      body: JSON.stringify({ holding_id: "holding-1", symbol: "NPN", side: "buy", qty: 1 }),
    }),
  );
}

describe("client-order parking — no CLIENT-DATA GUARD / IRESS_UAT_MODE gate", () => {
  it("parks a real (non-test) client's order", async () => {
    process.env.MINT_CLIENT_ORDER_SECRET = "test-secret";
    delete process.env.IRESS_UAT_MODE;
    const client = makeMockSupabase({ holdingUserId: REAL_USER_ID });
    vi.doMock("@/lib/orders", () => ({
      openSupabaseClients: async () => ({ retail: client, institutional: client }),
      parkOrder: async () => ({ ok: true, order_audit_id: "audit-1", order_id: "ORD-1" }),
    }));

    const res = await postClientOrder();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("parked");
  });

  it("still parks a genuine test-account holding (unchanged)", async () => {
    process.env.MINT_CLIENT_ORDER_SECRET = "test-secret";
    process.env.IRESS_UAT_MODE = "true";
    const client = makeMockSupabase({ holdingUserId: "test-user-1" });
    vi.doMock("@/lib/orders", () => ({
      openSupabaseClients: async () => ({ retail: client, institutional: client }),
      parkOrder: async () => ({ ok: true, order_audit_id: "audit-1", order_id: "ORD-1" }),
    }));

    const res = await postClientOrder();
    expect(res.status).toBe(200);
  });

  it("still requires the shared secret (or an admin session) regardless of guard removal", async () => {
    delete process.env.MINT_CLIENT_ORDER_SECRET;
    const client = makeMockSupabase({ holdingUserId: REAL_USER_ID });
    vi.doMock("@/lib/orders", () => ({
      openSupabaseClients: async () => ({ retail: client, institutional: client }),
      parkOrder: async () => ({ ok: true, order_audit_id: "audit-1", order_id: "ORD-1" }),
    }));

    const res = await postClientOrder();
    expect(res.status).toBe(403);
  });
});
