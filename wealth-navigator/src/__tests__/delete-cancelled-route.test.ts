import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * POST /api/admin/orderbook/delete-cancelled — permanently removes a cancelled
 * order's audit row. Fenced by three checks: RBAC, an admin password re-verify,
 * and status='cancelled' (a working/filled/rejected order can never be deleted
 * here). These tests cover each fence plus the happy path.
 */

vi.mock("@/lib/admin/rbac", () => ({
  getAdminContext: async () => ({
    status: "ok",
    ctx: { email: "desk@mint.test", permissions: {}, approverTier: "master" },
  }),
  can: () => true,
}));

function makeInstitutional(row: { id: string; status: string } | null) {
  const deleteCalls: Array<{ id: string; status: string }> = [];
  const client = {
    from: () => {
      const obj: Record<string, unknown> = {};
      obj.select = () => obj;
      obj.eq = () => obj;
      obj.maybeSingle = async () => ({ data: row, error: null });
      obj.delete = () => {
        const filters: Record<string, string> = {};
        const chain = {
          eq: (col: string, val: string) => {
            filters[col] = val;
            if (Object.keys(filters).length >= 2) {
              deleteCalls.push({ id: filters.id!, status: filters.status! });
              return Promise.resolve({ data: null, error: null });
            }
            return chain;
          },
        };
        return chain;
      };
      return obj;
    },
  } as unknown as SupabaseClient;
  return { client, deleteCalls };
}

function mockServer(institutional: SupabaseClient, passwordOk: boolean) {
  vi.doMock("@/lib/supabase/server", () => ({
    createInstitutionalServiceRoleClient: () => institutional,
    createAnonServerClient: () => ({
      auth: {
        signInWithPassword: async () => ({ error: passwordOk ? null : { message: "bad" } }),
      },
    }),
  }));
}

const post = async (bodyObj: Record<string, unknown>) => {
  const { POST } = await import("@/app/api/admin/orderbook/delete-cancelled/route");
  return POST(new Request("http://x/delete-cancelled", { method: "POST", body: JSON.stringify(bodyObj) }));
};

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("POST /api/admin/orderbook/delete-cancelled", () => {
  it("deletes a cancelled row when the password verifies", async () => {
    const mock = makeInstitutional({ id: "audit-1", status: "cancelled" });
    mockServer(mock.client, true);

    const res = await post({ order_audit_id: "audit-1", password: "correct" });
    const body = (await res.json()) as { ok: boolean; deleted?: string };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe("audit-1");
    // Delete is scoped by BOTH id and status='cancelled'.
    expect(mock.deleteCalls).toEqual([{ id: "audit-1", status: "cancelled" }]);
  });

  it("403s on an incorrect password and deletes nothing", async () => {
    const mock = makeInstitutional({ id: "audit-1", status: "cancelled" });
    mockServer(mock.client, false);

    const res = await post({ order_audit_id: "audit-1", password: "wrong" });

    expect(res.status).toBe(403);
    expect(mock.deleteCalls).toHaveLength(0);
  });

  it("400s when the password is missing", async () => {
    const mock = makeInstitutional({ id: "audit-1", status: "cancelled" });
    mockServer(mock.client, true);

    const res = await post({ order_audit_id: "audit-1" });

    expect(res.status).toBe(400);
    expect(mock.deleteCalls).toHaveLength(0);
  });

  it("409s when the row is not cancelled — a working order can't be deleted", async () => {
    const mock = makeInstitutional({ id: "audit-1", status: "working" });
    mockServer(mock.client, true);

    const res = await post({ order_audit_id: "audit-1", password: "correct" });

    expect(res.status).toBe(409);
    expect(mock.deleteCalls).toHaveLength(0);
  });

  it("404s when the order doesn't exist", async () => {
    const mock = makeInstitutional(null);
    mockServer(mock.client, true);

    const res = await post({ order_audit_id: "missing", password: "correct" });

    expect(res.status).toBe(404);
    expect(mock.deleteCalls).toHaveLength(0);
  });
});
