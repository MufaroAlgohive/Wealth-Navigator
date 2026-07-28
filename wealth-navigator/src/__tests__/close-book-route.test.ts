import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * POST /api/admin/orderbook/close-book — "Move to Closed Book", mirroring
 * MyMintAdmin's shared (DB-backed, not per-browser) closed-books state.
 * Closing emails a CSV of the book's fills to admin_team recipients with
 * notifications.csv_exports enabled, then stamps closed_at regardless of
 * whether the email succeeded — email failure is tracked separately
 * (email_status/email_error) and retryable, never blocks the close.
 */

vi.mock("@/lib/admin/rbac", () => ({
  getAdminContext: async () => ({
    status: "ok",
    ctx: { email: "desk@mint.test", permissions: {}, approverTier: "master" },
  }),
  can: () => true,
}));

interface Recipient {
  email: string | null;
  permissions: Record<string, unknown> | null;
}

function makeInstitutional(members: Array<Record<string, unknown>>) {
  const updateCalls: Array<{ sequence: number; patch: Record<string, unknown> }> = [];
  const client = {
    from: (table: string) => {
      const obj: Record<string, unknown> = {};
      if (table === "oems_order_audit") {
        obj.select = () => obj;
        obj.eq = () => Promise.resolve({ data: members, error: null });
        return obj;
      }
      // oems_order_book
      obj.update = (patch: Record<string, unknown>) => ({
        eq: (_col: string, val: number) => {
          updateCalls.push({ sequence: val, patch });
          return Promise.resolve({ data: null, error: null });
        },
      });
      return obj;
    },
  } as unknown as SupabaseClient;
  return { client, updateCalls };
}

function makeRetail(recipients: Recipient[]) {
  const client = {
    from: () => ({
      select: () => Promise.resolve({ data: recipients, error: null }),
    }),
  } as unknown as SupabaseClient;
  return client;
}

let sendEmailCalls: Array<Record<string, unknown>> = [];
let sendEmailShouldThrow = false;

vi.mock("@/lib/admin/email", () => ({
  sendEmail: async (opts: Record<string, unknown>) => {
    sendEmailCalls.push(opts);
    if (sendEmailShouldThrow) throw new Error("Resend error 401");
    return { id: "resend-1" };
  },
}));

const post = async (bodyObj: Record<string, unknown>) => {
  const { POST } = await import("@/app/api/admin/orderbook/close-book/route");
  return POST(new Request("http://x/close-book", { method: "POST", body: JSON.stringify(bodyObj) }));
};

beforeEach(() => {
  vi.resetModules();
  sendEmailCalls = [];
  sendEmailShouldThrow = false;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

const member = (overrides: Record<string, unknown> = {}) => ({
  id: "audit-1", order_id: "ORD-1", client_account: "client@x.com", symbol: "NPN", side: "buy",
  quantity: 10, price_cents: null, status: "filled", source: "MINT_CLIENT_ORDER",
  payload: { order_book_seq: 5, avgPx: 20000, filled: 10 }, result_payload: {}, updated_at: "2026-07-28T09:00:00.000Z",
  ...overrides,
});

describe("POST /api/admin/orderbook/close-book", () => {
  it("closes the book and emails the CSV to csv_exports recipients", async () => {
    const inst = makeInstitutional([member()]);
    const retail = makeRetail([
      { email: "desk1@mint.test", permissions: { notifications: { csv_exports: true } } },
      { email: "ignored@mint.test", permissions: { notifications: { csv_exports: false } } },
    ]);
    vi.doMock("@/lib/supabase/server", () => ({
      createInstitutionalServiceRoleClient: () => inst.client,
      createRetailServiceRoleClient: () => retail,
    }));

    const res = await post({ sequence: 5, closed: true });
    const body = (await res.json()) as { ok: boolean; email_status?: string };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.email_status).toBe("sent");
    expect(sendEmailCalls).toHaveLength(1);
    expect(sendEmailCalls[0]?.to).toEqual(["desk1@mint.test"]);
    expect(inst.updateCalls).toHaveLength(1);
    expect(inst.updateCalls[0]?.sequence).toBe(5);
    expect(inst.updateCalls[0]?.patch.closed_at).toBeTruthy();
    expect(inst.updateCalls[0]?.patch.closed_by).toBe("desk@mint.test");
    expect(inst.updateCalls[0]?.patch.email_status).toBe("sent");
  });

  it("still closes the book when the email send fails — email_status=failed, closed_at still stamped", async () => {
    sendEmailShouldThrow = true;
    const inst = makeInstitutional([member()]);
    const retail = makeRetail([{ email: "desk1@mint.test", permissions: { notifications: { csv_exports: true } } }]);
    vi.doMock("@/lib/supabase/server", () => ({
      createInstitutionalServiceRoleClient: () => inst.client,
      createRetailServiceRoleClient: () => retail,
    }));

    const res = await post({ sequence: 5, closed: true });
    const body = (await res.json()) as { ok: boolean; email_status?: string };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.email_status).toBe("failed");
    expect(inst.updateCalls[0]?.patch.closed_at).toBeTruthy();
    expect(inst.updateCalls[0]?.patch.email_status).toBe("failed");
  });

  it("fails the email when no admin_team recipient has csv_exports enabled", async () => {
    const inst = makeInstitutional([member()]);
    const retail = makeRetail([{ email: "desk1@mint.test", permissions: { notifications: { csv_exports: false } } }]);
    vi.doMock("@/lib/supabase/server", () => ({
      createInstitutionalServiceRoleClient: () => inst.client,
      createRetailServiceRoleClient: () => retail,
    }));

    const res = await post({ sequence: 5, closed: true });
    const body = (await res.json()) as { ok: boolean; email_status?: string };

    expect(body.ok).toBe(true);
    expect(body.email_status).toBe("failed");
    expect(sendEmailCalls).toHaveLength(0);
  });

  it("retry_email resends without re-stamping closed_at/closed_by", async () => {
    const inst = makeInstitutional([member()]);
    const retail = makeRetail([{ email: "desk1@mint.test", permissions: { notifications: { csv_exports: true } } }]);
    vi.doMock("@/lib/supabase/server", () => ({
      createInstitutionalServiceRoleClient: () => inst.client,
      createRetailServiceRoleClient: () => retail,
    }));

    const res = await post({ sequence: 5, closed: true, retry_email: true });
    const body = (await res.json()) as { ok: boolean; email_status?: string };

    expect(body.ok).toBe(true);
    expect(body.email_status).toBe("sent");
    expect(inst.updateCalls[0]?.patch.closed_at).toBeUndefined();
    expect(inst.updateCalls[0]?.patch.closed_by).toBeUndefined();
  });

  it("reopen (closed=false) clears closed_at and does not touch email", async () => {
    const inst = makeInstitutional([member()]);
    vi.doMock("@/lib/supabase/server", () => ({
      createInstitutionalServiceRoleClient: () => inst.client,
      createRetailServiceRoleClient: () => makeRetail([]),
    }));

    const res = await post({ sequence: 5, closed: false });
    const body = (await res.json()) as { ok: boolean; closed: boolean };

    expect(body.ok).toBe(true);
    expect(body.closed).toBe(false);
    expect(sendEmailCalls).toHaveLength(0);
    expect(inst.updateCalls[0]?.patch).toEqual({ closed_at: null, closed_by: null });
  });

  it("400s when sequence is missing", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
  });
});
