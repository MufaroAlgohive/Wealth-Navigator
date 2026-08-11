import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 2026-07-23: CRM-style order-book numbering for release-to-market —
 * everything released together in one call gets the next sequence number
 * (an `oems_order_book` row) and every successfully-released order is
 * stamped with `payload.order_book_seq`. These tests cover the numbering
 * logic specifically (release-to-market's underlying per-order release
 * behavior already has its own coverage in orders-submit.test.ts /
 * oems-bff-routes.test.ts) — `releaseOrder` itself is mocked out here so
 * every row "releases" successfully by construction.
 */

vi.mock("@/lib/admin/rbac", () => ({
  getAdminContext: async () => ({
    status: "ok",
    ctx: { email: "desk@mint.test", permissions: {}, approverTier: "master" },
  }),
  can: () => true,
}));

// This suite tests the order-book NUMBERING logic specifically, not the
// Send to Market lock (a separate, deliberately-toggled kill-switch — see
// send-to-market-lock.ts). Force it unlocked here so these tests exercise
// release behavior regardless of the lock's current real-world value.
vi.mock("@/lib/orders/send-to-market-lock", () => ({
  SEND_TO_MARKET_LOCKED: false,
  SEND_TO_MARKET_LOCKED_MESSAGE: "locked (mocked off for this test)",
}));

// Same reasoning for the master-password step-up (lib/admin/step-up.ts): it's
// its own gate with its own concerns, and these tests are about numbering.
// Pass it here so the route reaches the logic under test.
vi.mock("@/lib/admin/step-up", () => ({
  requireMasterPassword: async () => ({ ok: true, email: "desk@mint.test" }),
}));

interface MockRow {
  id: string;
  order_id: string;
  payload: Record<string, unknown>;
}

/**
 * Builds a mock `{ retail, institutional }` pair shaped like
 * openSupabaseClients()'s return value. `insertResponses` is consumed in
 * order for each oems_order_book insert call — lets a test simulate a
 * unique-violation on the first attempt and success on the retry.
 */
function makeMockSupabase(opts: {
  parkedRows: MockRow[];
  existingMaxSequence?: number | null;
  insertResponses?: Array<{ error: { code?: string; message?: string } | null }>;
}) {
  const updateCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const insertCalls: Array<{ sequence: number; released_by: string | null; member_count: number }> = [];
  let sequenceReadCount = 0;
  const insertResponses = opts.insertResponses ?? [{ error: null }];

  const makeAuditChain = () => {
    const obj: Record<string, unknown> = {};
    obj.select = () => obj;
    obj.eq = (col: string, val: string) => {
      if (col === "id") {
        // update(...).eq("id", x) — resolve immediately, no data needed.
        return Promise.resolve({ data: null, error: null });
      }
      // select(...).eq("status", "parked")
      return Promise.resolve({ data: opts.parkedRows, error: null });
    };
    obj.update = (patch: { payload: Record<string, unknown> }) => {
      return {
        eq: (_col: string, id: string) => {
          updateCalls.push({ id, payload: patch.payload });
          return Promise.resolve({ data: null, error: null });
        },
      };
    };
    return obj;
  };

  const makeBookChain = () => {
    const obj: Record<string, unknown> = {};
    obj.select = () => obj;
    obj.order = () => obj;
    obj.limit = () => obj;
    obj.maybeSingle = async () => {
      sequenceReadCount += 1;
      const seq = opts.existingMaxSequence ?? null;
      return { data: seq == null ? null : { sequence: seq }, error: null };
    };
    obj.insert = async (row: { sequence: number; released_by: string | null; member_count: number }) => {
      insertCalls.push(row);
      const idx = Math.min(insertCalls.length - 1, insertResponses.length - 1);
      return insertResponses[idx] ?? { error: null };
    };
    return obj;
  };

  const client = {
    from: (table: string) => (table === "oems_order_book" ? makeBookChain() : makeAuditChain()),
  } as unknown as SupabaseClient;

  return {
    supabase: { retail: client, institutional: client },
    updateCalls,
    insertCalls,
    getSequenceReadCount: () => sequenceReadCount,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

beforeEach(() => {
  vi.resetModules();
});

describe("POST /api/admin/orderbook/release-to-market — order-book numbering", () => {
  it("assigns sequence 1 on a fresh release and stamps every released row's payload", async () => {
    const mock = makeMockSupabase({
      parkedRows: [{ id: "row-1", order_id: "ORD-1", payload: { book_id: "CLIENT-BUY" } }],
      existingMaxSequence: null,
    });
    vi.doMock("@/lib/orders", () => ({
      openSupabaseClients: async () => mock.supabase,
      releaseOrder: async (_supabase: unknown, id: string) => ({
        ok: true,
        order_audit_id: id,
        iress_order_number: "IRESS-1",
        status: "working",
        preflight: { ok: true, verdict: "pass", code: "pass", message: "" },
      }),
    }));

    const { POST } = await import("@/app/api/admin/orderbook/release-to-market/route");
    const res = await POST(new Request("http://x/release-to-market", { method: "POST" }));
    const body = (await res.json()) as { order_book_seq: number | null; released: number };

    expect(body.order_book_seq).toBe(1);
    expect(body.released).toBe(1);
    expect(mock.updateCalls).toHaveLength(1);
    expect(mock.updateCalls[0]?.payload).toMatchObject({ book_id: "CLIENT-BUY", order_book_seq: 1 });
  });

  it("does NOT create a book row when zero orders were successfully released", async () => {
    const mock = makeMockSupabase({ parkedRows: [], existingMaxSequence: null });
    vi.doMock("@/lib/orders", () => ({
      openSupabaseClients: async () => mock.supabase,
      releaseOrder: async () => ({
        ok: false,
        preflight: { ok: false, verdict: "blocked_unverifiable", code: "pass", message: "" },
      }),
    }));

    const { POST } = await import("@/app/api/admin/orderbook/release-to-market/route");
    const res = await POST(new Request("http://x/release-to-market", { method: "POST" }));
    const body = (await res.json()) as { order_book_seq?: number | null; released: number; notice?: string };

    // The pre-existing early-return path (no parked rows at all) returns its
    // original shape untouched — no order_book_seq key, no book row created.
    expect(body.order_book_seq).toBeUndefined();
    expect(mock.insertCalls).toHaveLength(0);
  });

  it("retries exactly once on a unique-violation and succeeds at the next sequence, without failing the underlying release", async () => {
    const mock = makeMockSupabase({
      parkedRows: [{ id: "row-1", order_id: "ORD-1", payload: {} }],
      existingMaxSequence: 4,
      insertResponses: [{ error: { code: "23505", message: "duplicate key" } }, { error: null }],
    });
    vi.doMock("@/lib/orders", () => ({
      openSupabaseClients: async () => mock.supabase,
      releaseOrder: async (_supabase: unknown, id: string) => ({
        ok: true,
        order_audit_id: id,
        iress_order_number: "IRESS-1",
        status: "working",
        preflight: { ok: true, verdict: "pass", code: "pass", message: "" },
      }),
    }));

    const { POST } = await import("@/app/api/admin/orderbook/release-to-market/route");
    const res = await POST(new Request("http://x/release-to-market", { method: "POST" }));
    const body = (await res.json()) as {
      order_book_seq: number | null;
      released: number;
      book_warning?: string;
    };

    expect(body.released).toBe(1); // the underlying release succeeded regardless of the numbering race
    expect(body.order_book_seq).toBe(5); // both reads saw max=4 -> both attempts computed nextSeq=5
    expect(body.book_warning).toBeUndefined();
    expect(mock.insertCalls).toHaveLength(2);
  });
});
