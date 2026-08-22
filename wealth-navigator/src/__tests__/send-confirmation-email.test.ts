import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * POST /api/admin/orderbook/send-confirmation — real Resend dispatch
 * (2026-08-21). Previously this route only `console.info`'d the email
 * intent and returned `email: "logged"`; clients confirmed with a "filled"
 * status never actually got a trade-confirmation email. This now sends the
 * same MINT-branded template `manual-fill/route.ts` already uses
 * successfully, one email per distinct affected client, and must never let
 * an email failure block or roll back the confirmation-stamping / Fill_date
 * work that already happened.
 */

vi.mock("@/lib/admin/rbac", () => ({
  getAdminContext: async () => ({
    status: "ok",
    ctx: { email: "desk@mint.test", permissions: {}, approverTier: "master" },
  }),
  can: () => true,
}));

let sendEmailCalls: Array<Record<string, unknown>> = [];
let sendEmailShouldThrowFor: Set<string> = new Set();

vi.mock("@/lib/admin/email", () => ({
  sendEmail: async (opts: Record<string, unknown>) => {
    sendEmailCalls.push(opts);
    if (sendEmailShouldThrowFor.has(String(opts.to))) throw new Error("Resend error 500");
    return { id: "resend-1" };
  },
  buildTradeConfirmationHtml: (opts: Record<string, unknown>) => `<html>${JSON.stringify(opts)}</html>`,
}));

interface AuditRow {
  id: string;
  order_id: string;
  symbol: string;
  side: string;
  quantity: number;
  status: string;
  payload: Record<string, unknown>;
  result_payload: Record<string, unknown>;
}

function makeInstitutional(auditRow: AuditRow | null) {
  const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const client = {
    from: (table: string) => {
      if (table !== "oems_order_audit") throw new Error(`unexpected institutional table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: async () => ({ data: auditRow ? [auditRow] : [], error: null }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: async (_col: string, id: string) => {
            updateCalls.push({ id, patch });
            return { data: null, error: null };
          },
        }),
      };
    },
  } as unknown as SupabaseClient;
  return { client, updateCalls };
}

function makeRetail(opts: {
  security: { id: string } | null;
  holdIds: string[];
  holdingRows: Array<{ id: string; user_id: string; quantity: number }>;
  profiles: Record<string, { email?: string; first_name?: string; mint_number?: string } | undefined>;
}) {
  const fillDateUpdateCalls: Array<{ patch: Record<string, unknown>; ids: string[] }> = [];
  const client = {
    from: (table: string) => {
      if (table === "securities_c") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: opts.security, error: null }),
            }),
          }),
        };
      }
      if (table === "stock_holdings_c") {
        return {
          select: (cols: string) => {
            if (cols.includes("user_id")) {
              // updateHoldingsFillDate's own read: .select("id, user_id, quantity").in(ids).eq(is_active,true)
              return {
                in: (_col: string, ids: string[]) => ({
                  eq: async () => ({
                    data: opts.holdingRows.filter((h) => ids.includes(h.id)),
                    error: null,
                  }),
                }),
              };
            }
            // the OEM path's initial lookup: .select("id").eq(strategy_name_snapshot).eq(security_id).eq(is_active)
            return {
              eq: () => ({
                eq: () => ({
                  eq: async () => ({ data: opts.holdIds.map((id) => ({ id })), error: null }),
                }),
              }),
            };
          },
          update: (patch: Record<string, unknown>) => ({
            in: (_col: string, ids: string[]) => ({
              eq: async () => {
                fillDateUpdateCalls.push({ patch, ids });
                return { data: null, error: null, count: ids.length };
              },
            }),
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              limit: async () => ({ data: opts.profiles[id] ? [opts.profiles[id]] : [], error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected retail table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { client, fillDateUpdateCalls };
}

const auditRow = (overrides: Partial<AuditRow> = {}): AuditRow => ({
  id: "audit-1",
  order_id: "ORD-1",
  symbol: "NPN.JO",
  side: "buy",
  quantity: 10,
  status: "filled",
  payload: { avgPx: 20000 }, // R200.00 in cents
  result_payload: {},
  ...overrides,
});

const post = async (bodyObj: Record<string, unknown>) => {
  const { POST } = await import("@/app/api/admin/orderbook/send-confirmation/route");
  return POST(new Request("http://x/send-confirmation", { method: "POST", body: JSON.stringify(bodyObj) }));
};

beforeEach(() => {
  vi.resetModules();
  sendEmailCalls = [];
  sendEmailShouldThrowFor = new Set();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("POST /api/admin/orderbook/send-confirmation (OEM origin) — trade confirmation email", () => {
  it("sends a real trade confirmation email to the affected client and reports confirmation_email: 'sent'", async () => {
    const inst = makeInstitutional(auditRow());
    const retail = makeRetail({
      security: { id: "sec-1" },
      holdIds: ["hold-1"],
      holdingRows: [{ id: "hold-1", user_id: "user-1", quantity: 10 }],
      profiles: { "user-1": { email: "client1@x.com", first_name: "Thabo", mint_number: "AND0930090326" } },
    });
    vi.doMock("@/lib/supabase/server", () => ({
      createInstitutionalServiceRoleClient: () => inst.client,
      createRetailServiceRoleClient: () => retail.client,
    }));

    const res = await post({ order_id: "ORD-1", book_id: "STRATEGY-A" });
    const body = (await res.json()) as {
      ok: boolean;
      confirmation_email?: string;
      confirmation_email_summary?: { sent: number; skipped: number; failed: number };
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.confirmation_email).toBe("sent");
    expect(body.confirmation_email_summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(sendEmailCalls).toHaveLength(1);
    expect(sendEmailCalls[0]?.to).toBe("client1@x.com");
    expect(sendEmailCalls[0]?.emailType).toBe("trade_confirmation");
    // Confirmation stamp still applied regardless of email outcome.
    expect(inst.updateCalls).toHaveLength(1);
    expect(inst.updateCalls[0]?.patch.result_payload).toMatchObject({ confirmation_sent_by: "desk@mint.test" });
  });

  it("skips a client with no email on file without failing the request", async () => {
    const inst = makeInstitutional(auditRow());
    const retail = makeRetail({
      security: { id: "sec-1" },
      holdIds: ["hold-1", "hold-2"],
      holdingRows: [
        { id: "hold-1", user_id: "user-1", quantity: 5 },
        { id: "hold-2", user_id: "user-2", quantity: 5 },
      ],
      profiles: {
        "user-1": { email: "client1@x.com", first_name: "Thabo", mint_number: "AND0930090326" },
        // user-2 has no profile row at all — no email on file.
      },
    });
    vi.doMock("@/lib/supabase/server", () => ({
      createInstitutionalServiceRoleClient: () => inst.client,
      createRetailServiceRoleClient: () => retail.client,
    }));

    const res = await post({ order_id: "ORD-1", book_id: "STRATEGY-A" });
    const body = (await res.json()) as {
      ok: boolean;
      confirmation_email?: string;
      confirmation_email_summary?: { sent: number; skipped: number; failed: number };
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // At least one client got the email → aggregate status is "sent".
    expect(body.confirmation_email).toBe("sent");
    expect(body.confirmation_email_summary).toEqual({ sent: 1, skipped: 1, failed: 0 });
    expect(sendEmailCalls).toHaveLength(1);
    expect(sendEmailCalls[0]?.to).toBe("client1@x.com");
  });

  it("catches a sendEmail throw per-client without blocking the Fill_date/confirmation-stamp logic", async () => {
    sendEmailShouldThrowFor = new Set(["client1@x.com"]);
    const inst = makeInstitutional(auditRow());
    const retail = makeRetail({
      security: { id: "sec-1" },
      holdIds: ["hold-1"],
      holdingRows: [{ id: "hold-1", user_id: "user-1", quantity: 10 }],
      profiles: { "user-1": { email: "client1@x.com", first_name: "Thabo", mint_number: "AND0930090326" } },
    });
    vi.doMock("@/lib/supabase/server", () => ({
      createInstitutionalServiceRoleClient: () => inst.client,
      createRetailServiceRoleClient: () => retail.client,
    }));

    const res = await post({ order_id: "ORD-1", book_id: "STRATEGY-A" });
    const body = (await res.json()) as {
      ok: boolean;
      holdings_updated?: number;
      confirmation_email?: string;
      confirmation_email_summary?: { sent: number; skipped: number; failed: number };
    };

    // Request itself is still a success — the fill/holdings work is real,
    // regardless of Resend erroring.
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.holdings_updated).toBe(1);
    expect(body.confirmation_email).toBe("failed");
    expect(body.confirmation_email_summary).toEqual({ sent: 0, skipped: 0, failed: 1 });
    // Confirmation stamp and Fill_date update both still happened.
    expect(inst.updateCalls).toHaveLength(1);
    expect(retail.fillDateUpdateCalls).toHaveLength(1);
    expect(retail.fillDateUpdateCalls[0]?.ids).toEqual(["hold-1"]);
  });

  it("skips email entirely (no clients touched) when no stock_holdings_c rows match — Fill_date/confirmation stamp still apply", async () => {
    const inst = makeInstitutional(auditRow());
    const retail = makeRetail({
      security: { id: "sec-1" },
      holdIds: [],
      holdingRows: [],
      profiles: {},
    });
    vi.doMock("@/lib/supabase/server", () => ({
      createInstitutionalServiceRoleClient: () => inst.client,
      createRetailServiceRoleClient: () => retail.client,
    }));

    const res = await post({ order_id: "ORD-1", book_id: "STRATEGY-A" });
    const body = (await res.json()) as { ok: boolean; confirmation_email?: string };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.confirmation_email).toBe("skipped");
    expect(sendEmailCalls).toHaveLength(0);
    expect(inst.updateCalls).toHaveLength(1);
  });
});

describe("POST /api/admin/orderbook/send-confirmation (CRM origin) — trade confirmation email", () => {
  function makeCrmRetail(opts: {
    snapshotRows: Array<Record<string, unknown>>;
    holdingRows: Array<{ id: string; user_id: string; quantity: number }>;
    profiles: Record<string, { email?: string; first_name?: string; mint_number?: string } | undefined>;
  }) {
    const runUpdateCalls: Array<{ snapshot_rows: Array<Record<string, unknown>> }> = [];
    const fillDateUpdateCalls: Array<{ patch: Record<string, unknown>; ids: string[] }> = [];
    const client = {
      from: (table: string) => {
        if (table === "orderbook_email_runs") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { run_date: "2026-07-27", sequence_number: 1, snapshot_rows: opts.snapshotRows },
                    error: null,
                  }),
                }),
              }),
            }),
            update: (patch: { snapshot_rows: Array<Record<string, unknown>> }) => ({
              eq: () => ({
                eq: async () => {
                  runUpdateCalls.push(patch);
                  return { data: null, error: null };
                },
              }),
            }),
          };
        }
        if (table === "stock_holdings_c") {
          return {
            select: (cols: string) => {
              if (cols.includes("user_id")) {
                return {
                  in: (_col: string, ids: string[]) => ({
                    eq: async () => ({
                      data: opts.holdingRows.filter((h) => ids.includes(h.id)),
                      error: null,
                    }),
                  }),
                };
              }
              throw new Error("unexpected stock_holdings_c select in CRM path");
            },
            update: (patch: Record<string, unknown>) => ({
              in: (_col: string, ids: string[]) => ({
                eq: async () => {
                  fillDateUpdateCalls.push({ patch, ids });
                  return { data: null, error: null, count: ids.length };
                },
              }),
            }),
          };
        }
        if (table === "profiles") {
          return {
            select: () => ({
              eq: (_col: string, id: string) => ({
                limit: async () => ({ data: opts.profiles[id] ? [opts.profiles[id]] : [], error: null }),
              }),
            }),
          };
        }
        throw new Error(`unexpected CRM retail table ${table}`);
      },
    } as unknown as SupabaseClient;
    return { client, runUpdateCalls, fillDateUpdateCalls };
  }

  it("sends a trade confirmation email for a CRM-origin (BND) confirmation using snapshot-row fields", async () => {
    const retail = makeCrmRetail({
      snapshotRows: [
        {
          sourceId: "hold-crm-1",
          bndReference: "BND-20260727-4001",
          ticker: "SBK.JO",
          side: "BUY",
          avgFillNumber: 150.5,
        },
      ],
      holdingRows: [{ id: "hold-crm-1", user_id: "user-9", quantity: 20 }],
      profiles: { "user-9": { email: "crmclient@x.com", first_name: "Naledi", mint_number: "NAL0110020199" } },
    });
    vi.doMock("@/lib/supabase/server", () => ({
      createInstitutionalServiceRoleClient: () => {
        throw new Error("institutional should not be used for CRM origin");
      },
      createRetailServiceRoleClient: () => retail.client,
    }));

    const res = await post({ order_id: "BND-20260727-4001", book_id: "2026-07-27-1", origin: "crm" });
    const body = (await res.json()) as {
      ok: boolean;
      confirmation_email?: string;
      confirmation_email_summary?: { sent: number; skipped: number; failed: number };
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.confirmation_email).toBe("sent");
    expect(body.confirmation_email_summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(sendEmailCalls).toHaveLength(1);
    expect(sendEmailCalls[0]?.to).toBe("crmclient@x.com");
    expect(retail.runUpdateCalls).toHaveLength(1);
  });
});
