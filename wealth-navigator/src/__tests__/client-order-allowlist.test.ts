import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 2026-07-23: POST /api/admin/orderbook/client-order's CLIENT-DATA GUARD —
 * a real (non-test) client's order must still be refused by default, but
 * an explicitly allowlisted user_id (MINT_CLIENT_ORDER_ALLOWLIST_USER_IDS)
 * must pass even though their profile/wallet are NOT flagged test — this
 * is the narrow bypass built for named staff acceptance-testing through
 * the real (production) mint app post-prod-switch, deliberately NOT
 * implemented by flipping is_test/wallet status on their real accounts.
 */

vi.mock("@/lib/admin/rbac", () => ({
  getAdminContext: async () => ({ status: "no-session" }),
}));

const ORIGINAL_ENV = { ...process.env };

function makeMockSupabase(opts: {
  holdingUserId: string;
  isTestProfile: boolean;
  isTestWallet: boolean;
}) {
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
        obj.maybeSingle = async () => ({ data: { id: "holding-1", user_id: opts.holdingUserId }, error: null });
        return obj;
      }
      if (table === "profiles") {
        obj.select = () => obj;
        obj.eq = () => obj;
        obj.maybeSingle = async () => ({ data: opts.isTestProfile ? { id: opts.holdingUserId } : null, error: null });
        return obj;
      }
      if (table === "wallets") {
        obj.select = () => obj;
        obj.eq = () => obj;
        obj.maybeSingle = async () => ({
          data: opts.isTestWallet ? { user_id: opts.holdingUserId } : null,
          error: null,
        });
        return obj;
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return client;
}

beforeEach(() => {
  vi.resetModules();
  process.env.IRESS_UAT_MODE = "true";
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

describe("client-order CLIENT-DATA GUARD allowlist", () => {
  it("refuses a real (non-test, non-allowlisted) client's order — unchanged default behavior", async () => {
    process.env.MINT_CLIENT_ORDER_SECRET = "test-secret";
    delete process.env.MINT_CLIENT_ORDER_ALLOWLIST_USER_IDS;
    const client = makeMockSupabase({ holdingUserId: REAL_USER_ID, isTestProfile: false, isTestWallet: false });
    vi.doMock("@/lib/orders", () => ({
      openSupabaseClients: async () => ({ retail: client, institutional: client }),
      parkOrder: async () => ({ ok: true, order_audit_id: "audit-1", order_id: "ORD-1" }),
    }));

    const res = await postClientOrder();
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/real \(non-test\) client/);
  });

  it("allows a real client's order through when their user_id is in MINT_CLIENT_ORDER_ALLOWLIST_USER_IDS", async () => {
    process.env.MINT_CLIENT_ORDER_SECRET = "test-secret";
    process.env.MINT_CLIENT_ORDER_ALLOWLIST_USER_IDS = ` fc3a74f1-eaa6-43b6-b825-2bff1487e2a4 ,${REAL_USER_ID}, 7fdd6738-19dc-4bb7-a976-7b2a8dd83aa5`;
    const client = makeMockSupabase({ holdingUserId: REAL_USER_ID, isTestProfile: false, isTestWallet: false });
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

  it("still refuses a real user NOT on the allowlist even when the allowlist is non-empty", async () => {
    process.env.MINT_CLIENT_ORDER_SECRET = "test-secret";
    process.env.MINT_CLIENT_ORDER_ALLOWLIST_USER_IDS = "fc3a74f1-eaa6-43b6-b825-2bff1487e2a4";
    const client = makeMockSupabase({ holdingUserId: REAL_USER_ID, isTestProfile: false, isTestWallet: false });
    vi.doMock("@/lib/orders", () => ({
      openSupabaseClients: async () => ({ retail: client, institutional: client }),
      parkOrder: async () => ({ ok: true, order_audit_id: "audit-1", order_id: "ORD-1" }),
    }));

    const res = await postClientOrder();
    expect(res.status).toBe(422);
  });

  it("still passes a genuine test-account holding regardless of the allowlist (unchanged existing path)", async () => {
    process.env.MINT_CLIENT_ORDER_SECRET = "test-secret";
    delete process.env.MINT_CLIENT_ORDER_ALLOWLIST_USER_IDS;
    const client = makeMockSupabase({ holdingUserId: "test-user-1", isTestProfile: true, isTestWallet: false });
    vi.doMock("@/lib/orders", () => ({
      openSupabaseClients: async () => ({ retail: client, institutional: client }),
      parkOrder: async () => ({ ok: true, order_audit_id: "audit-1", order_id: "ORD-1" }),
    }));

    const res = await postClientOrder();
    expect(res.status).toBe(200);
  });
});
