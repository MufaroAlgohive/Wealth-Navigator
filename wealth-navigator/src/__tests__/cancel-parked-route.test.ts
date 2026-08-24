import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 2026-07-23: POST /api/admin/orderbook/cancel-parked — cancelling a
 * PARKED order is a pure local status flip (no broker/worker contact,
 * since a parked row has never left our system). Fails closed if the row
 * has since been released/already cancelled (status no longer 'parked'),
 * rather than silently no-opping or cancelling something already in
 * flight at the broker.
 */

vi.mock("@/lib/admin/rbac", () => ({
  getAdminContext: async () => ({
    status: "ok",
    ctx: { email: "desk@mint.test", permissions: {}, approverTier: "master" },
  }),
  can: () => true,
}));

function makeMockSupabase(row: { id: string; status: string } | null) {
  const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const client = {
    from: () => {
      const obj: Record<string, unknown> = {};
      obj.select = () => obj;
      obj.eq = () => obj;
      obj.maybeSingle = async () => ({ data: row, error: null });
      obj.update = (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          updateCalls.push({ id, patch });
          return Promise.resolve({ data: null, error: null });
        },
      });
      return obj;
    },
  } as unknown as SupabaseClient;
  return { client, updateCalls };
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("POST /api/admin/orderbook/cancel-parked", () => {
  it("cancels a parked row with a pure local status update", async () => {
    const mock = makeMockSupabase({ id: "audit-1", status: "parked" });
    vi.doMock("@/lib/supabase/server", () => ({ createInstitutionalServiceRoleClient: () => mock.client }));

    const { POST } = await import("@/app/api/admin/orderbook/cancel-parked/route");
    const res = await POST(
      new Request("http://x/cancel-parked", { method: "POST", body: JSON.stringify({ order_audit_id: "audit-1" }) }),
    );
    const body = (await res.json()) as { ok: boolean; status?: string };

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, status: "cancelled", rebalance_request_id: null, holding_retired: false });
    expect(mock.updateCalls).toHaveLength(1);
    expect(mock.updateCalls[0]?.patch.status).toBe("cancelled");
  });

  it("refuses (409) when the row is no longer parked — e.g. already released", async () => {
    const mock = makeMockSupabase({ id: "audit-1", status: "working" });
    vi.doMock("@/lib/supabase/server", () => ({ createInstitutionalServiceRoleClient: () => mock.client }));

    const { POST } = await import("@/app/api/admin/orderbook/cancel-parked/route");
    const res = await POST(
      new Request("http://x/cancel-parked", { method: "POST", body: JSON.stringify({ order_audit_id: "audit-1" }) }),
    );

    expect(res.status).toBe(409);
    expect(mock.updateCalls).toHaveLength(0);
  });

  it("404s when the order_audit_id doesn't exist", async () => {
    const mock = makeMockSupabase(null);
    vi.doMock("@/lib/supabase/server", () => ({ createInstitutionalServiceRoleClient: () => mock.client }));

    const { POST } = await import("@/app/api/admin/orderbook/cancel-parked/route");
    const res = await POST(
      new Request("http://x/cancel-parked", { method: "POST", body: JSON.stringify({ order_audit_id: "missing" }) }),
    );

    expect(res.status).toBe(404);
  });

  it("400s when order_audit_id is missing from the body", async () => {
    const mock = makeMockSupabase({ id: "audit-1", status: "parked" });
    vi.doMock("@/lib/supabase/server", () => ({ createInstitutionalServiceRoleClient: () => mock.client }));

    const { POST } = await import("@/app/api/admin/orderbook/cancel-parked/route");
    const res = await POST(new Request("http://x/cancel-parked", { method: "POST", body: JSON.stringify({}) }));

    expect(res.status).toBe(400);
  });
});
