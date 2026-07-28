import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 2026-07-23: GET /api/admin/orderbook/order-books — computes fully_filled
 * at read time from the current oems_order_audit status of each book's
 * member rows (join by payload.order_book_seq, no stored/cron-flipped
 * status column). Confirms the all-filled vs mixed vs cancelled-member
 * cases described in the plan.
 */

vi.mock("@/lib/admin/rbac", () => ({
  getAdminContext: async () => ({
    status: "ok",
    ctx: { email: "desk@mint.test", permissions: {}, approverTier: "master" },
  }),
  can: () => true,
}));

interface BookRow {
  sequence: number;
  released_at: string;
  released_by: string | null;
  member_count: number;
  closed_at?: string | null;
  closed_by?: string | null;
  email_status?: "sent" | "failed" | null;
  email_error?: string | null;
  email_sent_at?: string | null;
}
interface AuditRow {
  status: string;
  payload: Record<string, unknown>;
}

function makeMockSupabase(books: BookRow[], members: AuditRow[], opts: { columnMissing?: boolean } = {}) {
  let bookSelectCalls = 0;
  const client = {
    from: (table: string) => {
      const obj: Record<string, unknown> = {};
      if (table === "oems_order_book") {
        obj.select = (cols: string) => {
          bookSelectCalls += 1;
          const wantsClosedCols = cols.includes("closed_at");
          obj.order = () => {
            if (opts.columnMissing && wantsClosedCols) {
              return Promise.resolve({ data: null, error: { code: "42703", message: 'column "closed_at" does not exist' } });
            }
            // The fallback select (base columns only) strips closed/email fields
            // off each row, mirroring what Postgres would actually return.
            const rows = wantsClosedCols
              ? books
              : books.map(({ sequence, released_at, released_by, member_count }) => ({ sequence, released_at, released_by, member_count }));
            return Promise.resolve({ data: rows, error: null });
          };
          return obj;
        };
        return obj;
      }
      // oems_order_audit
      obj.select = () => obj;
      obj.not = () => Promise.resolve({ data: members, error: null });
      return obj;
    },
  } as unknown as SupabaseClient;
  return { client, getBookSelectCalls: () => bookSelectCalls };
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("GET /api/admin/orderbook/order-books", () => {
  it("reports fully_filled: true only when every member row's status is 'filled'", async () => {
    const { client } = makeMockSupabase(
      [
        { sequence: 1, released_at: "2026-07-23T09:00:00.000Z", released_by: "a@x.com", member_count: 2 },
        { sequence: 2, released_at: "2026-07-23T10:00:00.000Z", released_by: "a@x.com", member_count: 2 },
      ],
      [
        { status: "filled", payload: { order_book_seq: 1 } },
        { status: "filled", payload: { order_book_seq: 1 } },
        { status: "filled", payload: { order_book_seq: 2 } },
        { status: "working", payload: { order_book_seq: 2 } },
      ],
    );
    vi.doMock("@/lib/supabase/server", () => ({ createInstitutionalServiceRoleClient: () => client }));

    const { GET } = await import("@/app/api/admin/orderbook/order-books/route");
    const res = await GET();
    const body = (await res.json()) as {
      ok: boolean;
      books: Array<{ sequence: number; fully_filled: boolean; filled_count: number; total_count: number }>;
    };

    expect(body.ok).toBe(true);
    const book1 = body.books.find((b) => b.sequence === 1);
    const book2 = body.books.find((b) => b.sequence === 2);
    expect(book1).toMatchObject({ fully_filled: true, filled_count: 2, total_count: 2 });
    expect(book2).toMatchObject({ fully_filled: false, filled_count: 1, total_count: 2 });
  });

  it("a cancelled/rejected member permanently prevents fully_filled: true", async () => {
    const { client } = makeMockSupabase(
      [{ sequence: 1, released_at: "2026-07-23T09:00:00.000Z", released_by: null, member_count: 2 }],
      [
        { status: "filled", payload: { order_book_seq: 1 } },
        { status: "cancelled", payload: { order_book_seq: 1 } },
      ],
    );
    vi.doMock("@/lib/supabase/server", () => ({ createInstitutionalServiceRoleClient: () => client }));

    const { GET } = await import("@/app/api/admin/orderbook/order-books/route");
    const res = await GET();
    const body = (await res.json()) as { books: Array<{ sequence: number; fully_filled: boolean }> };

    expect(body.books.find((b) => b.sequence === 1)?.fully_filled).toBe(false);
  });

  it("returns an empty list (not a 500) when no book rows exist yet", async () => {
    const { client } = makeMockSupabase([], []);
    vi.doMock("@/lib/supabase/server", () => ({ createInstitutionalServiceRoleClient: () => client }));

    const { GET } = await import("@/app/api/admin/orderbook/order-books/route");
    const res = await GET();
    const body = (await res.json()) as { ok: boolean; books: unknown[] };

    expect(body.ok).toBe(true);
    expect(body.books).toEqual([]);
  });

  it("passes through closed_at / email_status so Active vs Closed Books can split on it", async () => {
    const { client } = makeMockSupabase(
      [
        { sequence: 1, released_at: "2026-07-28T09:00:00.000Z", released_by: "a@x.com", member_count: 1 },
        {
          sequence: 2, released_at: "2026-07-28T08:00:00.000Z", released_by: "a@x.com", member_count: 1,
          closed_at: "2026-07-28T09:30:00.000Z", closed_by: "desk@mint.test", email_status: "sent", email_sent_at: "2026-07-28T09:30:05.000Z",
        },
      ],
      [
        { status: "filled", payload: { order_book_seq: 1 } },
        { status: "filled", payload: { order_book_seq: 2 } },
      ],
    );
    vi.doMock("@/lib/supabase/server", () => ({ createInstitutionalServiceRoleClient: () => client }));

    const { GET } = await import("@/app/api/admin/orderbook/order-books/route");
    const res = await GET();
    const body = (await res.json()) as {
      books: Array<{ sequence: number; closed_at: string | null; email_status: string | null }>;
    };

    const book1 = body.books.find((b) => b.sequence === 1);
    const book2 = body.books.find((b) => b.sequence === 2);
    expect(book1?.closed_at).toBeNull();
    expect(book2?.closed_at).toBe("2026-07-28T09:30:00.000Z");
    expect(book2?.email_status).toBe("sent");
  });

  it("falls back to the base column set (no 500) when closed-books columns aren't migrated yet", async () => {
    const { client, getBookSelectCalls } = makeMockSupabase(
      [{ sequence: 1, released_at: "2026-07-28T09:00:00.000Z", released_by: "a@x.com", member_count: 1 }],
      [{ status: "filled", payload: { order_book_seq: 1 } }],
      { columnMissing: true },
    );
    vi.doMock("@/lib/supabase/server", () => ({ createInstitutionalServiceRoleClient: () => client }));

    const { GET } = await import("@/app/api/admin/orderbook/order-books/route");
    const res = await GET();
    const body = (await res.json()) as { ok: boolean; books: Array<{ sequence: number; closed_at: string | null }> };

    expect(body.ok).toBe(true);
    expect(body.books.find((b) => b.sequence === 1)?.closed_at).toBeNull();
    // Retried once after the column-missing error — first select + fallback select.
    expect(getBookSelectCalls()).toBe(2);
  });
});
