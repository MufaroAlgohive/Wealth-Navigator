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
}
interface AuditRow {
  status: string;
  payload: Record<string, unknown>;
}

function makeMockSupabase(books: BookRow[], members: AuditRow[]) {
  const client = {
    from: (table: string) => {
      const obj: Record<string, unknown> = {};
      if (table === "oems_order_book") {
        obj.select = () => obj;
        obj.order = () => Promise.resolve({ data: books, error: null });
        return obj;
      }
      // oems_order_audit
      obj.select = () => obj;
      obj.not = () => Promise.resolve({ data: members, error: null });
      return obj;
    },
  } as unknown as SupabaseClient;
  return client;
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("GET /api/admin/orderbook/order-books", () => {
  it("reports fully_filled: true only when every member row's status is 'filled'", async () => {
    const client = makeMockSupabase(
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
    const client = makeMockSupabase(
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
    const client = makeMockSupabase([], []);
    vi.doMock("@/lib/supabase/server", () => ({ createInstitutionalServiceRoleClient: () => client }));

    const { GET } = await import("@/app/api/admin/orderbook/order-books/route");
    const res = await GET();
    const body = (await res.json()) as { ok: boolean; books: unknown[] };

    expect(body.ok).toBe(true);
    expect(body.books).toEqual([]);
  });
});
